import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from database import (
    get_email_settings, get_subscriptions, get_summary,
    get_daily_trend, get_monthly_summary, log_email,
    get_custom_cost, get_custom_report, update_custom_report
)
import os
import sqlite3


def _resolve_report_period(settings):
    now = datetime.utcnow()
    rng = (settings.get("report_date_range") or "this_month").strip()
    df = (settings.get("report_date_from") or "").strip()
    dt = (settings.get("report_date_to") or "").strip()

    if rng == "last_month":
        first_this = now.replace(day=1)
        last_month_end = first_this - timedelta(days=1)
        date_from = last_month_end.replace(day=1).strftime("%Y-%m-%d")
        date_to = last_month_end.strftime("%Y-%m-%d")
        label = last_month_end.strftime("%B %Y")
    elif rng == "last_30":
        date_from = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        label = "Last 30 Days"
    elif rng == "last_90":
        date_from = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        label = "Last 90 Days"
    elif rng == "custom" and df and dt:
        date_from = df
        date_to = dt
        label = f"{df} to {dt}"
    else:
        date_from = now.replace(day=1).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        label = now.strftime("%B %Y")

    return {"date_from": date_from, "date_to": date_to, "label": label}


def _get_all_cloud_accounts(tenant_id=1):
    """Return combined list of accounts/subscriptions from all cloud providers."""
    from database import get_db
    conn = get_db()
    accounts = []

    # Azure subscriptions
    rows = conn.execute("SELECT subscription_id, name, 'azure' as cloud FROM subscriptions WHERE enabled=1 AND tenant_id=?", (tenant_id,)).fetchall()
    for r in rows:
        accounts.append({"id": r["subscription_id"], "name": r["name"], "cloud": "azure"})

    # AWS + GCP from cloud_providers table (use subscription_id = provider_id for cost_data lookup)
    rows2 = conn.execute(
        "SELECT provider_id, name, provider_type FROM cloud_providers WHERE enabled=1 AND provider_type IN ('aws','gcp') AND tenant_id=?", (tenant_id,)
    ).fetchall()
    for r in rows2:
        accounts.append({"id": r["provider_id"], "name": r["name"], "cloud": r["provider_type"]})

    conn.close()
    return accounts


def _build_report_html(sections=None, settings=None, cloud_provider=None, tenant_id=1):
    """Generate a professional multi-cloud HTML cost report."""
    if not sections:
        sections = ["summary", "subscriptions", "top_services", "top_rgs", "trend"]
    if settings is None:
        settings = get_email_settings(tenant_id) or {}

    # Cloud provider filter: explicit arg overrides saved setting
    if cloud_provider is None:
        cloud_provider = settings.get("report_cloud_provider") or ""
    cloud_provider = (cloud_provider or "").strip().lower()

    now        = datetime.utcnow()
    period     = _resolve_report_period(settings)
    month_start = period["date_from"]
    today      = period["date_to"]

    # ── Data gathering (filtered by cloud_provider if set) ────────────────
    cp_filter = cloud_provider if cloud_provider else None
    top_services = get_summary("service_name",  date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)[:10]
    top_rgs      = get_summary("resource_group", date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)[:10]
    trend        = get_daily_trend(date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)
    monthly      = get_monthly_summary(tenant_id=tenant_id, cloud_provider=cp_filter)

    total_this_month = sum(r["total_cost"] for r in top_services) if top_services else 0
    last_month_data  = [m for m in monthly if m["month"] != now.strftime("%Y-%m")]
    last_month_total = last_month_data[-1]["total_cost"] if last_month_data else 0
    mom_change = ((total_this_month - last_month_total) / last_month_total * 100) if last_month_total > 0 else 0
    avg_daily  = total_this_month / max(1, len(set(r["date"] for r in trend))) if trend else 0

    from database import get_db
    conn = get_db()
    if cp_filter:
        cloud_rows = conn.execute(
            "SELECT cloud_provider, SUM(cost) as total FROM cost_data WHERE date>=? AND date<=? AND tenant_id=? AND cloud_provider=? GROUP BY cloud_provider ORDER BY total DESC",
            (month_start, today, tenant_id, cp_filter)
        ).fetchall()
    else:
        cloud_rows = conn.execute(
            "SELECT cloud_provider, SUM(cost) as total FROM cost_data WHERE date>=? AND date<=? AND tenant_id=? GROUP BY cloud_provider ORDER BY total DESC",
            (month_start, today, tenant_id)
        ).fetchall()
    conn.close()

    cloud_totals = [{"cloud": r["cloud_provider"] or "unknown", "total": r["total"] or 0} for r in cloud_rows]
    grand_total  = sum(c["total"] for c in cloud_totals) or 1

    CLOUD_LABEL  = {"azure": "Azure",   "aws": "AWS",     "gcp": "GCP"}
    CLOUD_BG     = {"azure": "#0078D4", "aws": "#FF9900", "gcp": "#4285F4"}
    CLOUD_ABBR   = {"azure": "Az",      "aws": "AW",      "gcp": "GC"}
    CLOUD_BADGE_BG = {"azure": "#E6F1FB", "aws": "#FFF3E0", "gcp": "#E8F0FE"}
    CLOUD_BADGE_FG = {"azure": "#0C447C", "aws": "#7D4600", "gcp": "#1A56A3"}
    # Rank-based bar colors: single accent hue at decreasing opacity on white
    RANK_COLS = ["#185FA5", "#3A77B2", "#5E8FC0", "#80A7CE", "#A3BFDB", "#BACFE5"]
    ACCENT = "#185FA5"
    ACCENT_MUTED = "#A3BFDB"

    all_accounts = _get_all_cloud_accounts(tenant_id)
    # Filter accounts by cloud provider if set
    if cp_filter:
        all_accounts = [a for a in all_accounts if a["cloud"] == cp_filter]
    sub_costs = []
    for acct in all_accounts:
        svcs = get_summary("service_name", date_from=month_start, date_to=today, subscription_id=acct["id"], tenant_id=tenant_id)
        cost = sum(r["total_cost"] for r in svcs)
        if cost > 0:
            sub_costs.append({"name": acct["name"], "cost": cost, "cloud": acct["cloud"]})
    sub_costs.sort(key=lambda x: x["cost"], reverse=True)

    month_label  = period["label"]
    up           = mom_change > 0
    delta_color  = "#A32D2D" if up else "#3B6D11"
    delta_arrow  = "&#9650;" if up else "&#9660;"
    delta_sign   = "+" if up else ""

    # Preheader text
    preheader_top = f"Total ${total_this_month:,.0f} this period"
    if cloud_totals:
        top_cloud = cloud_totals[0]
        top_lbl   = CLOUD_LABEL.get(top_cloud["cloud"], top_cloud["cloud"])
        top_pct   = top_cloud["total"] / grand_total * 100
        preheader_top += f". {top_lbl} leads at ${top_cloud['total']:,.0f} ({top_pct:.1f}%)."

    # ── Email wrapper ─────────────────────────────────────────────────────
    font_stack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Cost report — {month_label}</title>
</head>
<body style="margin:0;padding:0;background:#FAFAF9;font-family:{font_stack}">

<!-- Preheader (hidden preview text) -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#FAFAF9;mso-hide:all;">{preheader_top}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAF9">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;width:100%">

<!-- ── HEADER ── -->
<tr><td style="padding-bottom:12px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
    <tr><td style="padding:24px 28px">
      <div style="font-size:11px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">Cost report</div>
      <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:3px">{month_label} overview</div>
      <div style="font-size:12px;color:#8A8A8A;margin-top:5px">Generated {now.strftime('%-d %B %Y at %H:%M UTC')}</div>
    </td></tr>
  </table>
</td></tr>

<!-- ── KPI STRIP ── -->
<tr><td style="padding-bottom:12px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
    <tr>
      <td width="25%" style="padding:18px 16px;border-right:1px solid #F0F0EE;text-align:center;vertical-align:top">
        <div style="font-size:10px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">This period</div>
        <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:5px">${total_this_month:,.0f}</div>
        <div style="font-size:11px;color:{delta_color};margin-top:3px">{delta_arrow} {abs(mom_change):.1f}% vs last</div>
      </td>
      <td width="25%" style="padding:18px 16px;border-right:1px solid #F0F0EE;text-align:center;vertical-align:top">
        <div style="font-size:10px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">Last period</div>
        <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:5px">${last_month_total:,.0f}</div>
      </td>
      <td width="25%" style="padding:18px 16px;border-right:1px solid #F0F0EE;text-align:center;vertical-align:top">
        <div style="font-size:10px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">Avg / day</div>
        <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:5px">${avg_daily:,.0f}</div>
      </td>
      <td width="25%" style="padding:18px 16px;text-align:center;vertical-align:top">
        <div style="font-size:10px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">MoM change</div>
        <div style="font-size:22px;color:{delta_color};font-weight:500;letter-spacing:-0.02em;margin-top:5px">{delta_arrow} {abs(mom_change):.1f}%</div>
      </td>
    </tr>
  </table>
</td></tr>

<!-- ── BODY START (white card) ── -->
<tr><td>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
  <tr><td style="padding:24px 28px">
"""

    # ── Cloud provider breakdown cards ────────────────────────────────────
    if "summary" in sections and cloud_totals:
        cards = ""
        for c in cloud_totals:
            lbl        = CLOUD_LABEL.get(c["cloud"], c["cloud"].upper())
            bg         = CLOUD_BG.get(c["cloud"], "#555555")
            abbr       = CLOUD_ABBR.get(c["cloud"], c["cloud"][:2].upper())
            badge_bg   = CLOUD_BADGE_BG.get(c["cloud"], "#F0F0F0")
            badge_fg   = CLOUD_BADGE_FG.get(c["cloud"], "#333333")
            pct        = c["total"] / grand_total * 100
            bar_w      = max(4, int(pct))
            cards += f"""
            <td valign="top" style="padding:0 5px;width:33%">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                     style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:10px">
                <tr><td style="padding:14px 16px">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                    <tr>
                      <td style="width:26px;height:26px;background:{bg};border-radius:6px;text-align:center;vertical-align:middle;font-size:10px;font-weight:600;color:#FFFFFF;line-height:26px">{abbr}</td>
                      <td style="padding-left:8px;font-size:13px;color:#1A1A1A;font-weight:500">{lbl}</td>
                      <td align="right"><span style="font-size:10px;color:{badge_fg};background:{badge_bg};border-radius:4px;padding:2px 7px;font-weight:500">{pct:.1f}%</span></td>
                    </tr>
                  </table>
                  <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:10px">${c['total']:,.0f}</div>
                  <!-- bar -->
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px">
                    <tr>
                      <td bgcolor="#185FA5" width="{bar_w}%" height="4" style="background:#185FA5;border-radius:3px;line-height:4px;font-size:1px">&nbsp;</td>
                      <td bgcolor="#F0F0EE" width="{100-bar_w}%" height="4" style="background:#F0F0EE;border-radius:3px;line-height:4px;font-size:1px">&nbsp;</td>
                    </tr>
                  </table>
                </td></tr>
              </table>
            </td>"""

        html += f"""
    <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:4px">Cloud provider breakdown</div>
    <div style="font-size:11px;color:#8A8A8A;margin-bottom:14px">{month_label}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 -5px;margin-bottom:28px"><tr>{cards}</tr></table>
"""

    # ── Trend chart (bar sparkline) ───────────────────────────────────────
    if "trend" in sections and trend:
        recent    = trend[-30:]
        max_val   = max((r["total_cost"] for r in recent), default=1) or 1
        today_str = now.strftime("%Y-%m-%d")
        rows = ""
        for i, r in enumerate(recent):
            bg      = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
            bar_w   = max(4, int(r["total_cost"] / max_val * 100))
            is_today = r["date"][:10] == today_str
            bar_col = "#185FA5" if is_today else ACCENT
            bold    = "font-weight:700;" if is_today else ""
            rows += f"""
<tr style="background:{bg}">
  <td style="padding:6px 12px;font-size:12px;color:#525252;white-space:nowrap;{bold}">{r["date"][:10]}</td>
  <td style="padding:6px 8px;font-size:12px;color:#1A1A1A;font-weight:500;text-align:right;white-space:nowrap">${r["total_cost"]:,.2f}</td>
  <td style="padding:6px 12px;width:40%">
    <div style="background:{bar_col};height:8px;border-radius:4px;width:{bar_w}%"></div>
  </td>
</tr>"""
        html += f"""
    <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:4px">Daily spend</div>
    <div style="font-size:11px;color:#8A8A8A;margin-bottom:14px">Last 30 days</div>
    <div style="background:#F7F7F5;border-radius:10px;overflow:hidden;margin-bottom:28px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        <tr style="background:#EEEDE8">
          <td style="padding:7px 12px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A">Date</td>
          <td style="padding:7px 12px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A;text-align:right">Cost</td>
          <td style="padding:7px 12px;font-size:10px;color:#8A8A8A"></td>
        </tr>
        {rows}
      </table>
    </div>
"""

    # ── Top services ──────────────────────────────────────────────────────
    if "top_services" in sections and top_services:
        # Cap at 5 + "Other"
        top5      = top_services[:5]
        other_svs = top_services[5:]
        max_svc   = top5[0]["total_cost"] or 1
        rows = ""
        for i, s in enumerate(top5):
            pct    = s["total_cost"] / max_svc * 100
            bar_w  = max(3, int(pct * 0.6))
            col    = RANK_COLS[min(i, len(RANK_COLS)-1)]
            bg     = "#F7F7F5" if i % 2 == 0 else "#FFFFFF"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;font-size:13px;color:#1A1A1A;font-weight:400;width:36%">{s['service_name'] or 'Unknown'}</td>
              <td style="padding:10px 8px;width:44%">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                  <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                </tr></table>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right;width:20%">${s['total_cost']:,.2f}</td>
            </tr>"""
        if other_svs:
            other_total = sum(x["total_cost"] for x in other_svs)
            pct    = other_total / max_svc * 100
            bar_w  = max(3, int(pct * 0.6))
            col    = RANK_COLS[5]
            bg     = "#F7F7F5" if len(top5) % 2 == 0 else "#FFFFFF"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;font-size:13px;color:#525252;font-style:italic;width:36%">Other ({len(other_svs)})</td>
              <td style="padding:10px 8px;width:44%">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                  <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                </tr></table>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:500;color:#525252;text-align:right;width:20%">${other_total:,.2f}</td>
            </tr>"""

        cloud_sub = CLOUD_LABEL.get(cloud_provider, "All clouds") if cloud_provider else "All clouds"
        html += f"""
    <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:4px">Top services</div>
    <div style="font-size:11px;color:#8A8A8A;margin-bottom:14px">{cloud_sub}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:28px">
      <tr style="background:#F0F0EE">
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Service</th>
        <th style="padding:9px 8px;font-size:11px;font-weight:500;color:#525252;text-align:left">Share</th>
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
      </tr>
      {rows}
    </table>
"""

    # ── Account / Subscription breakdown ─────────────────────────────────
    if "subscriptions" in sections and sub_costs:
        max_acct = sub_costs[0]["cost"] or 1
        rows = ""
        for i, sc in enumerate(sub_costs[:12]):
            lbl       = CLOUD_LABEL.get(sc["cloud"], sc["cloud"].upper())
            badge_bg  = CLOUD_BADGE_BG.get(sc["cloud"], "#F0F0F0")
            badge_fg  = CLOUD_BADGE_FG.get(sc["cloud"], "#333")
            pct       = sc["cost"] / max_acct * 100
            bar_w     = max(3, int(pct * 0.55))
            col       = RANK_COLS[min(i, len(RANK_COLS)-1)]
            bg        = "#F7F7F5" if i % 2 == 0 else "#FFFFFF"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;width:34%">
                <span style="font-size:9px;font-weight:500;color:{badge_fg};background:{badge_bg};border-radius:3px;padding:2px 5px;margin-right:6px">{lbl}</span>
                <span style="font-size:13px;color:#1A1A1A">{sc['name']}</span>
              </td>
              <td style="padding:10px 8px;width:44%">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                  <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                </tr></table>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right;width:22%">${sc['cost']:,.2f}</td>
            </tr>"""

        html += f"""
    <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Cost by account / subscription / project</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:28px">
      <tr style="background:#F0F0EE">
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Account</th>
        <th style="padding:9px 8px;font-size:11px;font-weight:500;color:#525252;text-align:left">Share</th>
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
      </tr>
      {rows}
    </table>
"""

    # ── Top resource groups ───────────────────────────────────────────────
    if "top_rgs" in sections and top_rgs:
        max_rg  = top_rgs[0]["total_cost"] or 1
        rows = ""
        for i, r in enumerate(top_rgs[:10]):
            pct   = r["total_cost"] / max_rg * 100
            bar_w = max(3, int(pct * 0.55))
            col   = RANK_COLS[min(i, len(RANK_COLS)-1)]
            bg    = "#F7F7F5" if i % 2 == 0 else "#FFFFFF"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;font-size:13px;color:#1A1A1A;width:36%">{r['resource_group'] or 'Unknown'}</td>
              <td style="padding:10px 8px;width:44%">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                  <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                </tr></table>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right;width:20%">${r['total_cost']:,.2f}</td>
            </tr>"""

        html += f"""
    <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Top resource groups / regions / projects</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:28px">
      <tr style="background:#F0F0EE">
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Group / region / project</th>
        <th style="padding:9px 8px;font-size:11px;font-weight:500;color:#525252;text-align:left">Share</th>
        <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
      </tr>
      {rows}
    </table>
"""

    if "resource_changes" in sections:
        # Resource changes for selected period (best-effort). Keep robust if tables are missing.
        resource_changes_available = True
        try:
            db_path = os.getenv("DB_PATH") or os.path.join(os.path.dirname(__file__), "azure_costs.db")
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            # Build cost map for the period
            cost_rows = conn.execute("""
                SELECT subscription_id, resource_group, resource_name, SUM(cost) as total_cost
                FROM cost_data
                WHERE date >= ? AND date <= ? AND tenant_id = ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                GROUP BY subscription_id, resource_group, resource_name
            """, (month_start, today, tenant_id)).fetchall()
            def _norm_rg(x):
                return (x or "").strip().lower()

            cost_map = {(r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"]): (r["total_cost"] or 0) for r in cost_rows}

            # Preload daily costs for savings calculations (avoid per-row DB queries)
            lookback_days_default = 7
            try:
                lb_start = (datetime.strptime(month_start, "%Y-%m-%d") - timedelta(days=lookback_days_default)).strftime("%Y-%m-%d")
            except Exception:
                lb_start = month_start
            daily_rows = conn.execute("""
                SELECT subscription_id, lower(resource_group) as rg, resource_name, date, SUM(cost) as day_cost
                FROM cost_data
                WHERE date >= ? AND date <= ? AND tenant_id = ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                GROUP BY subscription_id, rg, resource_name, date
            """, (lb_start, today, tenant_id)).fetchall()
            daily_costs = {}
            for r in daily_rows:
                key = (r["subscription_id"], (r["rg"] or ""), r["resource_name"])
                dm = daily_costs.get(key)
                if dm is None:
                    dm = {}
                    daily_costs[key] = dm
                dm[r["date"]] = float(r["day_cost"] or 0)

            # Activity create/delete events
            start_ts = month_start + "T00:00:00"
            end_ts = today + "T23:59:59"
            created = conn.execute("""
                WITH ranked AS (
                    SELECT
                        subscription_id,
                        resource_group,
                        resource_type,
                        resource_name,
                        caller,
                        timestamp,
                        id,
                        ROW_NUMBER() OVER (
                            PARTITION BY subscription_id, resource_group, resource_name
                            ORDER BY timestamp ASC, id ASC
                        ) as rn
                    FROM activity_logs
                    WHERE timestamp >= ? AND timestamp <= ? AND tenant_id = ?
                      AND resource_name IS NOT NULL AND resource_name != ''
                      AND (operation_name LIKE 'Create%' OR operation LIKE '%/write')
                )
                SELECT
                    subscription_id,
                    resource_group,
                    resource_type,
                    resource_name,
                    MIN(timestamp) as first_ts,
                    MAX(CASE WHEN rn = 1 THEN caller END) as actor,
                    COUNT(*) as cnt
                FROM ranked
                GROUP BY subscription_id, resource_group, resource_name
                ORDER BY first_ts DESC
            """, (start_ts, end_ts, tenant_id)).fetchall()

            deleted = conn.execute("""
                WITH ranked AS (
                    SELECT
                        subscription_id,
                        resource_group,
                        resource_type,
                        resource_name,
                        caller,
                        timestamp,
                        id,
                        ROW_NUMBER() OVER (
                            PARTITION BY subscription_id, resource_group, resource_name
                            ORDER BY timestamp DESC, id DESC
                        ) as rn
                    FROM activity_logs
                    WHERE timestamp >= ? AND timestamp <= ? AND tenant_id = ?
                      AND resource_name IS NOT NULL AND resource_name != ''
                      AND (operation_name LIKE 'Delete%' OR operation LIKE '%/delete')
                )
                SELECT
                    subscription_id,
                    resource_group,
                    resource_type,
                    resource_name,
                    MAX(timestamp) as last_ts,
                    MIN(timestamp) as first_ts,
                    MAX(CASE WHEN rn = 1 THEN caller END) as actor,
                    COUNT(*) as cnt
                FROM ranked
                GROUP BY subscription_id, resource_group, resource_name
                ORDER BY last_ts DESC
            """, (start_ts, end_ts, tenant_id)).fetchall()

            # Resolve actor IDs to display names in bulk (best-effort)
            actor_ids = sorted({(r["actor"] or "").strip() for r in (created + deleted) if (r["actor"] or "").strip()})
            actor_map = {}
            if actor_ids:
                q = "SELECT caller_id, display_name FROM caller_names WHERE caller_id IN (%s)" % ",".join(["?"] * len(actor_ids))
                for row in conn.execute(q, actor_ids).fetchall():
                    actor_map[row["caller_id"]] = row["display_name"]

            total_created = conn.execute("""
                SELECT COUNT(DISTINCT subscription_id || '|' || resource_group || '|' || resource_name) as cnt
                FROM activity_logs
                WHERE timestamp >= ? AND timestamp <= ? AND tenant_id = ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                  AND (operation_name LIKE 'Create%' OR operation LIKE '%/write')
            """, (start_ts, end_ts, tenant_id)).fetchone()["cnt"]
            total_deleted = conn.execute("""
                SELECT COUNT(DISTINCT subscription_id || '|' || resource_group || '|' || resource_name) as cnt
                FROM activity_logs
                WHERE timestamp >= ? AND timestamp <= ? AND tenant_id = ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                  AND (operation_name LIKE 'Delete%' OR operation LIKE '%/delete')
            """, (start_ts, end_ts, tenant_id)).fetchone()["cnt"]
            conn.close()
        except Exception as e:
            resource_changes_available = False
            try:
                import traceback as _tb
                print("[EmailReport] Resource changes section failed:", repr(e))
                _tb.print_exc()
            except Exception:
                pass
            html += """
            <div style="margin-bottom:20px">
                <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Resource Changes</h2>
                <div style="font-size:12px;color:#6b7280">
                    Resource change data is not available yet (missing activity log data or tables). Run Activity Sync and try again.
                </div>
            </div>
            """
            created = []
            deleted = []
            total_created = 0
            total_deleted = 0
            cost_map = {}
            daily_costs = {}

        if not resource_changes_available:
            pass  # error message already added above, continue building rest of report

        def _rows_to_html_created(rows):
            out = ""
            cg_rows = []
            other_rows = []
            for r in rows:
                rt_short = (r["resource_type"] or "").split("/")[-1]
                (cg_rows if rt_short == "containerGroups" else other_rows).append(r)

            if cg_rows:
                seen = set(); total_cost = 0.0
                for r in cg_rows:
                    key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                    if key in seen: continue
                    seen.add(key); total_cost += float(cost_map.get(key, 0) or 0)
                out += f"""<tr style="background:#F7F7F5">
                    <td style="padding:8px 10px;font-size:12px;color:#1A1A1A;font-weight:500">containerGroups ({len(seen):,} resources)</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">containerGroups</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#1A1A1A;text-align:right">${total_cost:,.2f}</td>
                </tr>"""

            for i, r in enumerate(other_rows):
                bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
                key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                est_cost = cost_map.get(key, 0)
                created_date = _safe_date(r["first_ts"] if "first_ts" in r.keys() else None)
                raw_actor = (r["actor"] if "actor" in r.keys() else None) or ""
                actor = actor_map.get(raw_actor, raw_actor) if raw_actor else "-"
                out += f"""<tr style="background:{bg}">
                    <td style="padding:8px 10px;font-size:12px;color:#1A1A1A">{r["resource_name"]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{r["resource_group"] or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{(r["resource_type"] or "").split("/")[-1]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252;white-space:nowrap">{created_date or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{actor}</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#1A1A1A;text-align:right">${est_cost:,.2f}</td>
                </tr>"""
            return out or '<tr><td colspan="6" style="padding:10px 12px;color:#8A8A8A">No data</td></tr>'

        def _rows_to_html_deleted(rows):
            out = ""
            cg_rows = []
            other_rows = []
            for r in rows:
                rt_short = (r["resource_type"] or "").split("/")[-1]
                (cg_rows if rt_short == "containerGroups" else other_rows).append(r)

            if cg_rows:
                seen = set(); total_incurred = 0.0; total_savings = 0.0
                for r in cg_rows:
                    key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                    if key in seen: continue
                    seen.add(key)
                    total_incurred += float(cost_map.get(key, 0) or 0)
                    del_date = _safe_date(r["last_ts"] if "last_ts" in r.keys() else None)
                    avg_d = _avg_daily_cost_before(r["subscription_id"], r["resource_group"], r["resource_name"], del_date, lookback_days=7)
                    total_savings += avg_d * _days_between(del_date, today)
                out += f"""<tr style="background:#F7F7F5">
                    <td style="padding:8px 10px;font-size:12px;color:#1A1A1A;font-weight:500">containerGroups ({len(seen):,} resources)</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">containerGroups</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#8A8A8A">—</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#1A1A1A;text-align:right">${total_incurred:,.2f}</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#3B6D11;text-align:right">${total_savings:,.2f}</td>
                </tr>"""

            for i, r in enumerate(other_rows):
                bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
                key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                incurred = float(cost_map.get(key, 0) or 0)
                del_date = _safe_date(r["last_ts"] if "last_ts" in r.keys() else None)
                avg_d = _avg_daily_cost_before(r["subscription_id"], r["resource_group"], r["resource_name"], del_date, lookback_days=7)
                savings = avg_d * _days_between(del_date, today)
                raw_actor = (r["actor"] if "actor" in r.keys() else None) or ""
                actor = actor_map.get(raw_actor, raw_actor) if raw_actor else "-"
                out += f"""<tr style="background:{bg}">
                    <td style="padding:8px 10px;font-size:12px;color:#1A1A1A">{r["resource_name"]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{r["resource_group"] or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{(r["resource_type"] or "").split("/")[-1]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252;white-space:nowrap">{del_date or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#525252">{actor}</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#1A1A1A;text-align:right">${incurred:,.2f}</td>
                    <td style="padding:8px 10px;font-size:12px;font-weight:500;color:#3B6D11;text-align:right">${savings:,.2f}</td>
                </tr>"""
            return out or '<tr><td colspan="7" style="padding:10px 12px;color:#8A8A8A">No data</td></tr>'

        def _safe_date(ts):
            if not ts:
                return ""
            # activity timestamps are ISO-like; keep YYYY-MM-DD
            return str(ts)[:10]

        def _avg_daily_cost_before(sub_id, rg, res_name, delete_date, lookback_days=7):
            if not delete_date:
                return 0.0
            try:
                d = datetime.strptime(delete_date, "%Y-%m-%d")
            except Exception:
                return 0.0
            start = (d - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
            end = (d - timedelta(days=1)).strftime("%Y-%m-%d")
            if end < start:
                return 0.0
            key = (sub_id, _norm_rg(rg), res_name)
            dm = daily_costs.get(key) or {}
            total = 0.0
            cur = datetime.strptime(start, "%Y-%m-%d")
            end_dt = datetime.strptime(end, "%Y-%m-%d")
            while cur <= end_dt:
                ds = cur.strftime("%Y-%m-%d")
                total += float(dm.get(ds, 0) or 0)
                cur += timedelta(days=1)
            return total / float(lookback_days)

        def _days_between(d1, d2):
            try:
                a = datetime.strptime(d1, "%Y-%m-%d")
                b = datetime.strptime(d2, "%Y-%m-%d")
                return max(0, (b - a).days)
            except Exception:
                return 0

        def _sum_est_cost(rows):
            seen = set()
            total = 0.0
            for r in rows:
                key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                if key in seen:
                    continue
                seen.add(key)
                total += float(cost_map.get(key, 0) or 0)
            return total

        created_cost_est = _sum_est_cost(created)
        deleted_cost_est = _sum_est_cost(deleted)

        # Deleted "savings" estimate: avg daily cost before delete * days after delete (within report period)
        deleted_savings_est = 0.0
        for r in deleted:
            del_date = _safe_date(r["last_ts"] if "last_ts" in r.keys() else None)
            avg_daily = _avg_daily_cost_before(r["subscription_id"], r["resource_group"], r["resource_name"], del_date, lookback_days=7)
            days_after = _days_between(del_date, today)
            deleted_savings_est += avg_daily * days_after

        # Azure-only notice shown in all resource_changes states
        azure_only_note = """
            <div style="display:inline-flex;align-items:center;gap:6px;background:#fffbeb;border:1px solid #f59e0b;border-radius:6px;padding:5px 10px;font-size:11px;color:#92400e;margin-bottom:10px">
                <span style="font-size:13px">&#9888;</span>
                Resource Changes data is sourced from <strong>Azure Activity Logs only</strong>. AWS &amp; GCP create/delete events are not yet tracked.
            </div>
        """

        if not resource_changes_available:
            pass  # error message already in html, skip rendering
        elif int(total_created or 0) == 0 and int(total_deleted or 0) == 0:
            html += f"""
            <div style="margin-bottom:20px">
                <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:4px">Resource changes</div>
                <div style="font-size:11px;color:#8A8A8A;margin-bottom:10px">{month_label} · Azure activity logs only</div>
                <div style="font-size:12px;color:#8A8A8A">No resource create/delete events found for this period.</div>
            </div>
            """
        else:
            # Stat boxes via table cells (email-safe, no flexbox)
            html += f"""
        <div style="margin-bottom:24px">
            <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:4px">Resource changes</div>
            <div style="font-size:11px;color:#8A8A8A;margin-bottom:14px">{month_label} · Azure activity logs only</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px">
              <tr>
                <td width="20%" style="padding:0 4px 0 0;vertical-align:top">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px">
                    <tr><td style="padding:12px 14px">
                      <div style="font-size:11px;color:#8A8A8A">Resources created</div>
                      <div style="font-size:22px;font-weight:500;color:#1A1A1A;margin-top:4px">{int(total_created or 0):,}</div>
                    </td></tr>
                  </table>
                </td>
                <td width="20%" style="padding:0 4px;vertical-align:top">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px">
                    <tr><td style="padding:12px 14px">
                      <div style="font-size:11px;color:#8A8A8A">Resources deleted</div>
                      <div style="font-size:22px;font-weight:500;color:#1A1A1A;margin-top:4px">{int(total_deleted or 0):,}</div>
                    </td></tr>
                  </table>
                </td>
                <td width="20%" style="padding:0 4px;vertical-align:top">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px">
                    <tr><td style="padding:12px 14px">
                      <div style="font-size:11px;color:#8A8A8A">Created cost (est.)</div>
                      <div style="font-size:22px;font-weight:500;color:#1A1A1A;margin-top:4px">${created_cost_est:,.0f}</div>
                    </td></tr>
                  </table>
                </td>
                <td width="20%" style="padding:0 4px;vertical-align:top">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px">
                    <tr><td style="padding:12px 14px">
                      <div style="font-size:11px;color:#8A8A8A">Deleted cost (incurred)</div>
                      <div style="font-size:22px;font-weight:500;color:#1A1A1A;margin-top:4px">${deleted_cost_est:,.0f}</div>
                    </td></tr>
                  </table>
                </td>
                <td width="20%" style="padding:0 0 0 4px;vertical-align:top">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px">
                    <tr><td style="padding:12px 14px">
                      <div style="font-size:11px;color:#8A8A8A">Est. savings after delete</div>
                      <div style="font-size:22px;font-weight:500;color:#3B6D11;margin-top:4px">${deleted_savings_est:,.0f}</div>
                    </td></tr>
                  </table>
                </td>
              </tr>
            </table>

            <div style="margin-top:12px">
                <div style="font-size:13px;font-weight:500;color:#1A1A1A;margin-bottom:2px">Resources created</div>
                <div style="font-size:11px;color:#8A8A8A;margin-bottom:8px">with estimated cost in this period</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden">
                    <tr style="background:#F0F0EE">
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Resource</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">RG</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Type</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Created</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">User</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
                    </tr>
                    {_rows_to_html_created(created)}
                </table>
            </div>

            <div style="margin-top:16px">
                <div style="font-size:13px;font-weight:500;color:#1A1A1A;margin-bottom:2px">Resources deleted</div>
                <div style="font-size:11px;color:#8A8A8A;margin-bottom:8px">cost incurred + estimated savings after deletion</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden">
                    <tr style="background:#F0F0EE">
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Resource</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">RG</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Type</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">Deleted</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:left">User</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
                        <th style="padding:8px 10px;font-size:11px;font-weight:500;color:#525252;text-align:right">Savings</th>
                    </tr>
                    {_rows_to_html_deleted(deleted)}
                </table>
            </div>
            <div style="font-size:11px;color:#8A8A8A;margin-top:10px;line-height:1.5">
                Cost is best-effort based on matching records by subscription + resource group + resource name.
                Savings is estimated using average daily cost in the 7 days before deletion × remaining days in the period.
            </div>
        </div>
        """

    if monthly and "monthly_comparison" in sections:
        rows = ""
        for i, m in enumerate(monthly[-6:]):
            bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
            rows += f'<tr style="background:{bg}"><td style="padding:9px 14px;font-size:13px;color:#1A1A1A">{m["month"]}</td><td style="padding:9px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right">${m["total_cost"]:,.2f}</td><td style="padding:9px 14px;font-size:13px;color:#525252;text-align:right">{m["record_count"]:,}</td></tr>'
        html += f"""
        <div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Monthly history</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:24px">
            <tr style="background:#F0F0EE">
              <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Month</th>
              <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
              <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Records</th>
            </tr>
            {rows}
        </table>
        """

    # ── Close body card ──────────────────────────────────────────────────
    html += """
  </td></tr>
  </table>
</td></tr>

<!-- ── FOOTER ── -->
<tr><td style="padding-top:16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr><td align="center" style="padding:16px;font-size:11px;color:#8A8A8A;line-height:1.6">
      Cloud Cost Analyzer
      <br>
      This report was generated automatically based on your cost sync data.
    </td></tr>
  </table>
</td></tr>

</table><!-- /680 container -->
</td></tr></table><!-- /full-width wrapper -->
</body></html>"""
    return html


def _build_custom_report_html(report):
    """Generate HTML for a custom report based on saved filters and sections."""
    filters = report.get("filters", {})
    sections = report.get("sections", ["summary", "by_service", "by_rg", "trend"])
    report_name = report.get("name", "Custom Report")
    tenant_id = report.get("tenant_id") or 1

    sub_ids = filters.get("subscription_ids", [])
    rgs = filters.get("resource_groups", [])
    services = filters.get("services", [])
    date_range = filters.get("date_range", "this_month")
    date_from = filters.get("date_from", "")
    date_to = filters.get("date_to", "")

    now = datetime.utcnow()
    if date_range == "this_month":
        date_from = now.replace(day=1).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        period_label = now.strftime("%B %Y")
    elif date_range == "last_month":
        first_this = now.replace(day=1)
        last_month_end = first_this - timedelta(days=1)
        date_from = last_month_end.replace(day=1).strftime("%Y-%m-%d")
        date_to = last_month_end.strftime("%Y-%m-%d")
        period_label = last_month_end.strftime("%B %Y")
    elif date_range == "last_30":
        date_from = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        period_label = "Last 30 Days"
    elif date_range == "last_90":
        date_from = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        date_to = now.strftime("%Y-%m-%d")
        period_label = "Last 90 Days"
    else:
        period_label = f"{date_from} to {date_to}" if date_from and date_to else "All Time"

    data = get_custom_cost(
        subscription_ids=sub_ids if sub_ids else None,
        resource_groups=rgs if rgs else None,
        services=services if services else None,
        date_from=date_from or None,
        date_to=date_to or None,
        tenant_id=tenant_id,
    )

    total_cost = data.get("total_cost", 0)
    total_records = data.get("total_records", 0)
    by_rg = data.get("by_rg", [])
    by_service = data.get("by_service", [])
    daily_trend = data.get("daily_trend", [])

    # Resolve subscription names
    subs = get_subscriptions(tenant_id=tenant_id)
    sub_map = {s["subscription_id"]: s["name"] for s in subs}
    sub_names = [sub_map.get(sid, sid[:12]) for sid in sub_ids] if sub_ids else ["All Subscriptions"]

    # Filter summary tags
    filter_tags = []
    filter_tags.append(f"<strong>Period:</strong> {period_label}")
    filter_tags.append(f"<strong>Subscriptions:</strong> {', '.join(sub_names)}")
    if rgs:
        filter_tags.append(f"<strong>Resource Groups:</strong> {', '.join(rgs[:5])}{'...' if len(rgs) > 5 else ''}")
    if services:
        filter_tags.append(f"<strong>Services:</strong> {', '.join(services[:5])}{'...' if len(services) > 5 else ''}")

    font_stack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    ACCENT = "#185FA5"
    RANK_COLS = ["#185FA5", "#3A77B2", "#5E8FC0", "#80A7CE", "#A3BFDB", "#BACFE5"]

    # Manually-added costs (tools/subscriptions not visible to cloud APIs)
    manual = data.get("manual_costs") or {}
    manual_items = manual.get("items", [])
    manual_total = manual.get("total", 0)
    manual_sym = manual.get("symbol", "$")
    manual_rows = ""
    for i, m in enumerate(manual_items):
        bg = "#F7F7F5" if i % 2 == 0 else "#FFFFFF"
        rec_badge = '<span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;background:#E6F1FB;color:#0C447C;margin-left:6px">RECURRING</span>' if m.get("recurring") else ""
        manual_rows += f"""<tr style="background:{bg}">
            <td style="padding:9px 14px;font-size:13px;color:#1A1A1A">{m['item_name']}{rec_badge}</td>
            <td style="padding:9px 14px;font-size:12px;color:#525252">{m.get('category','Other')}</td>
            <td style="padding:9px 14px;font-size:13px;font-weight:500;text-align:right">{manual_sym}{m['amount_converted']:,.2f}</td>
        </tr>"""
    manual_section = ""
    if manual_rows:
        manual_section = ('<div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Other Tools & Subscriptions (Manually Tracked)</div>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:10px">'
            '<tr style="background:#F0F0EE"><th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Item</th>'
            '<th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Category</th>'
            '<th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th></tr>'
            + manual_rows + '</table>'
            f'<div style="font-size:12px;color:#525252;margin-bottom:28px">Other tools/subscriptions total: <strong>{manual_sym}{manual_total:,.2f}</strong></div>')

    html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAFAF9;font-family:{font_stack}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#FAFAF9">{report_name} — ${total_cost:,.0f} total · Generated {now.strftime('%-d %b %Y')}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAF9">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;width:100%">

<!-- Header -->
<tr><td style="padding-bottom:12px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
    <tr><td style="padding:24px 28px">
      <div style="font-size:11px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500">Custom report</div>
      <div style="font-size:22px;color:#1A1A1A;font-weight:500;letter-spacing:-0.02em;margin-top:3px">{report_name}</div>
      <div style="font-size:12px;color:#8A8A8A;margin-top:5px">Generated {now.strftime('%-d %B %Y at %H:%M UTC')}</div>
    </td></tr>
  </table>
</td></tr>

<!-- Body card -->
<tr><td>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
       style="background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
<tr><td style="padding:24px 28px">

<!-- Filter summary -->
<div style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:12px;color:#525252;line-height:1.8">
  {'<br>'.join(filter_tags)}
</div>
"""

    if "summary" in sections:
        html += f"""
<div style="background:#F7F7F5;border:1px solid #E8E8E4;border-radius:10px;padding:20px;margin-bottom:20px;text-align:center">
  <div style="font-size:11px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;margin-bottom:6px">Total cost</div>
  <div style="font-size:32px;font-weight:500;color:#1A1A1A;letter-spacing:-0.02em">${total_cost:,.2f}</div>
  <div style="font-size:12px;color:#8A8A8A;margin-top:6px">{total_records:,} records &bull; {len(by_rg)} resource groups &bull; {len(by_service)} services</div>
</div>
"""

    if "by_service" in sections and by_service:
        rows = ""
        max_svc = by_service[0]["cost"] if by_service else 1
        for i, s in enumerate(by_service[:15]):
            bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
            pct = (s["cost"] / total_cost * 100) if total_cost > 0 else 0
            bar_w = max(3, int((s["cost"] / (max_svc or 1)) * 55))
            col = RANK_COLS[min(i, len(RANK_COLS)-1)]
            rows += f'''<tr style="background:{bg}">
                <td style="padding:9px 14px;font-size:13px;color:#1A1A1A">{s["name"]}</td>
                <td style="padding:9px 8px;width:44%">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                    <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                    <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  </tr></table>
                </td>
                <td style="padding:9px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right">${s["cost"]:,.2f}</td>
                <td style="padding:9px 14px;font-size:12px;color:#8A8A8A;text-align:right">{pct:.1f}%</td>
            </tr>'''
        html += f"""
<div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Cost by service</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:24px">
  <tr style="background:#F0F0EE">
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Service</th>
    <th style="padding:9px 8px;font-size:11px;font-weight:500;color:#525252;text-align:left">Share</th>
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">%</th>
  </tr>
  {rows}
</table>
"""

    if "by_rg" in sections and by_rg:
        rows = ""
        max_rg_cost = by_rg[0]["cost"] if by_rg else 1
        for i, r in enumerate(by_rg[:15]):
            bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
            pct = (r["cost"] / total_cost * 100) if total_cost > 0 else 0
            bar_w = max(3, int((r["cost"] / (max_rg_cost or 1)) * 55))
            col = RANK_COLS[min(i, len(RANK_COLS)-1)]
            rows += f'''<tr style="background:{bg}">
                <td style="padding:9px 14px;font-size:13px;color:#1A1A1A">{r["name"]}</td>
                <td style="padding:9px 8px;width:44%">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
                    <td bgcolor="{col}" width="{bar_w}%" height="7" style="background:{col};border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                    <td bgcolor="#EBEBEB" height="7" style="background:#EBEBEB;border-radius:3px;line-height:7px;font-size:1px">&nbsp;</td>
                  </tr></table>
                </td>
                <td style="padding:9px 14px;font-size:13px;font-weight:500;color:#1A1A1A;text-align:right">${r["cost"]:,.2f}</td>
                <td style="padding:9px 14px;font-size:12px;color:#8A8A8A;text-align:right">{pct:.1f}%</td>
            </tr>'''
        html += f"""
<div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Cost by resource group</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:24px">
  <tr style="background:#F0F0EE">
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Resource group</th>
    <th style="padding:9px 8px;font-size:11px;font-weight:500;color:#525252;text-align:left">Share</th>
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th>
    <th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">%</th>
  </tr>
  {rows}
</table>
"""

    if "trend" in sections and daily_trend:
        count = min(30, len(daily_trend))
        recent = daily_trend[-count:]
        max_cost_t = max((d["cost"] for d in recent), default=1) or 1
        rows = ""
        for i, d in enumerate(recent):
            bg = "#FFFFFF" if i % 2 == 0 else "#F7F7F5"
            bar_w = max(4, int(d["cost"] / max_cost_t * 100))
            rows += f"""
<tr style="background:{bg}">
  <td style="padding:6px 12px;font-size:12px;color:#525252;white-space:nowrap">{d["date"]}</td>
  <td style="padding:6px 8px;font-size:12px;color:#1A1A1A;font-weight:500;text-align:right;white-space:nowrap">${d["cost"]:,.2f}</td>
  <td style="padding:6px 12px;width:40%">
    <div style="background:{ACCENT};height:8px;border-radius:4px;width:{bar_w}%"></div>
  </td>
</tr>"""
        html += f"""
<div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Daily spend</div>
<div style="background:#F7F7F5;border-radius:10px;overflow:hidden;margin-bottom:24px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
    <tr style="background:#EEEDE8">
      <td style="padding:7px 12px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A">Date</td>
      <td style="padding:7px 12px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A;text-align:right">Cost</td>
      <td style="padding:7px 12px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A"></td>
    </tr>
    {rows}
  </table>
</div>
"""

    html += """
<div style="border-top:1px solid #E8E8E4;padding-top:16px;margin-top:8px;font-size:11px;color:#8A8A8A;text-align:center">
  This report was generated automatically by Cloud Cost Analyzer.
</div>
</td></tr>
</table>
</td></tr>
</table>
</td></tr></table>
</body></html>
"""
    return html


def send_custom_report(report_id, report_type="manual", tenant_id=1):
    """Send a custom report by ID."""
    report = get_custom_report(report_id, tenant_id)
    if not report:
        raise ValueError(f"Report #{report_id} not found")

    recipients = report.get("recipients", "")
    if not recipients:
        settings = get_email_settings(tenant_id)
        recipients = settings.get("recipients", "")
    if not recipients:
        raise ValueError("No recipients configured for this report")

    html = _build_custom_report_html(report)
    subject = f"{report['name']} — {datetime.utcnow().strftime('%d %b %Y')}"

    send_report_email(
        recipients=recipients,
        subject=subject,
        html_body=html,
        report_type=report_type,
        tenant_id=tenant_id,
    )
    update_custom_report(report_id, {"last_sent": datetime.utcnow().isoformat()}, tenant_id)
    return True


def preview_custom_report(report_id, tenant_id=1):
    """Generate preview HTML for a custom report."""
    report = get_custom_report(report_id, tenant_id)
    if not report:
        raise ValueError(f"Report #{report_id} not found")
    return _build_custom_report_html(report)


def _build_report_text(sections=None, settings=None, cloud_provider=None, tenant_id=1):
    """Generate a plain-text fallback for the cost report."""
    if not sections:
        sections = ["summary", "subscriptions", "top_services", "top_rgs", "trend"]
    if settings is None:
        settings = get_email_settings(tenant_id) or {}
    if cloud_provider is None:
        cloud_provider = settings.get("report_cloud_provider") or ""
    cloud_provider = (cloud_provider or "").strip().lower()

    now    = datetime.utcnow()
    period = _resolve_report_period(settings)
    month_start = period["date_from"]
    today  = period["date_to"]
    cp_filter = cloud_provider if cloud_provider else None

    top_services = get_summary("service_name",  date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)[:5]
    top_rgs      = get_summary("resource_group", date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)[:5]
    trend        = get_daily_trend(date_from=month_start, date_to=today, tenant_id=tenant_id, cloud_provider=cp_filter)
    monthly      = get_monthly_summary(tenant_id=tenant_id, cloud_provider=cp_filter)

    total_this_month = sum(r["total_cost"] for r in top_services) if top_services else 0
    last_month_data  = [m for m in monthly if m["month"] != now.strftime("%Y-%m")]
    last_month_total = last_month_data[-1]["total_cost"] if last_month_data else 0
    mom_change = ((total_this_month - last_month_total) / last_month_total * 100) if last_month_total > 0 else 0
    avg_daily  = total_this_month / max(1, len(set(r["date"] for r in trend))) if trend else 0

    from database import get_db
    conn = get_db()
    if cp_filter:
        cloud_rows = conn.execute(
            "SELECT cloud_provider, SUM(cost) as total FROM cost_data WHERE date>=? AND date<=? AND tenant_id=? AND cloud_provider=? GROUP BY cloud_provider ORDER BY total DESC",
            (month_start, today, tenant_id, cp_filter)
        ).fetchall()
    else:
        cloud_rows = conn.execute(
            "SELECT cloud_provider, SUM(cost) as total FROM cost_data WHERE date>=? AND date<=? AND tenant_id=? GROUP BY cloud_provider ORDER BY total DESC",
            (month_start, today, tenant_id)
        ).fetchall()
    conn.close()
    cloud_totals = [{"cloud": r["cloud_provider"] or "unknown", "total": r["total"] or 0} for r in cloud_rows]
    grand_total  = sum(c["total"] for c in cloud_totals) or 1

    sep = "-" * 50
    arrow = "▲" if mom_change > 0 else "▼"
    lines = [
        f"Cloud Cost Report — {period['label']}",
        f"Generated {now.strftime('%-d %B %Y at %H:%M UTC')}",
        sep,
        f"Total:      ${total_this_month:>10,.2f}  ({arrow} {abs(mom_change):.1f}% vs last period)",
        f"Last period:${last_month_total:>10,.2f}",
        f"Avg / day:  ${avg_daily:>10,.2f}",
        sep,
    ]
    if cloud_totals:
        lines.append("By provider:")
        for c in cloud_totals:
            lbl = {"azure":"Azure","aws":"AWS","gcp":"GCP"}.get(c["cloud"], c["cloud"].upper())
            pct = c["total"] / grand_total * 100
            lines.append(f"  {lbl:<8} ${c['total']:>10,.2f}  ({pct:.1f}%)")
        lines.append(sep)
    if top_services:
        lines.append("Top services:")
        for s in top_services:
            lines.append(f"  {(s['service_name'] or 'Unknown'):<30} ${s['total_cost']:>10,.2f}")
        lines.append(sep)
    if top_rgs:
        lines.append("Top resource groups / regions:")
        for r in top_rgs:
            lines.append(f"  {(r['resource_group'] or 'Unknown'):<30} ${r['total_cost']:>10,.2f}")
        lines.append(sep)
    lines.append("This report was generated automatically by Cloud Cost Analyzer.")
    return "\n".join(lines)


def send_report_email(recipients=None, subject=None, html_body=None, report_type="scheduled", tenant_id=1):
    """Send an HTML email report using configured SMTP settings."""
    settings = get_email_settings(tenant_id)

    host = settings.get("smtp_host", "")
    port = settings.get("smtp_port", 587)
    user = settings.get("smtp_user", "")
    password = settings.get("smtp_password", "")
    from_addr = settings.get("smtp_from", "") or user
    use_tls = settings.get("smtp_use_tls", True)

    if not host or not user or not password:
        raise ValueError("SMTP settings not configured. Set host, user, and password first.")

    if not recipients:
        recipients = settings.get("recipients", "")
    if isinstance(recipients, str):
        recipients = [r.strip() for r in recipients.split(",") if r.strip()]
    if not recipients:
        raise ValueError("No recipients configured.")

    if not subject:
        label = _resolve_report_period(settings).get("label") if isinstance(settings, dict) else datetime.utcnow().strftime("%B %Y")
        subject = f"Cloud Cost Report — {label}"

    sections = settings.get("report_sections", ["summary", "subscriptions", "top_services", "top_rgs", "trend"])
    if not html_body:
        html_body = _build_report_html(sections, settings=settings, tenant_id=tenant_id)

    text_body = _build_report_text(sections, settings=settings, tenant_id=tenant_id)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=30, context=ssl.create_default_context())
        elif use_tls:
            server = smtplib.SMTP(host, port, timeout=30)
            server.ehlo()
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
        else:
            server = smtplib.SMTP(host, port, timeout=30)

        server.login(user, password)
        server.sendmail(from_addr, recipients, msg.as_string())
        server.quit()

        log_email(", ".join(recipients), subject, "sent", report_type=report_type, tenant_id=tenant_id)
        return True

    except Exception as e:
        log_email(", ".join(recipients), subject, "failed", str(e), report_type=report_type, tenant_id=tenant_id)
        raise


def send_test_email(recipient, tenant_id=1):
    """Send a short test email to verify SMTP configuration."""
    font_stack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    now_str = datetime.utcnow().strftime("%-d %B %Y at %H:%M UTC")
    html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAFAF9;font-family:{font_stack}">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#FAFAF9">SMTP configuration verified — email delivery is working correctly.</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAF9">
<tr><td align="center" style="padding:40px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480"
         style="max-width:480px;background:#FFFFFF;border:1px solid #E8E8E4;border-radius:12px">
    <tr><td style="padding:28px 32px">
      <div style="font-size:11px;color:#8A8A8A;letter-spacing:0.06em;text-transform:uppercase;font-weight:500;margin-bottom:3px">Cloud Cost Analyzer</div>
      <div style="font-size:20px;color:#1A1A1A;font-weight:500;letter-spacing:-0.01em;margin-bottom:20px">SMTP verified &#10003;</div>
      <div style="font-size:14px;color:#525252;line-height:1.6;margin-bottom:16px">
        Email delivery is working correctly. You can now schedule automated cost reports from the Email Reports page.
      </div>
      <div style="font-size:11px;color:#8A8A8A">Sent {now_str}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>"""
    text = f"Cloud Cost Analyzer — SMTP Verified\n\nEmail delivery is working correctly.\nYou can now schedule automated cost reports.\n\nSent {now_str}"
    send_report_email(
        recipients=[recipient],
        subject="Cloud Cost Analyzer — SMTP verified",
        html_body=html,
        report_type="test",
        tenant_id=tenant_id
    )


def build_client_report_html(client: dict, cost_data: dict, date_from: str, date_to: str) -> str:
    """Generate an HTML cost report for a single client."""
    font_stack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    ACCENT = "#185FA5"
    RANK_COLS = ["#185FA5","#3A77B2","#5E8FC0","#80A7CE","#A3BFDB","#BACFE5"]
    CLOUD_COLORS = {"azure": "#0078d4", "aws": "#ff9900", "gcp": "#4285f4"}
    CLOUD_BADGE_BG = {"azure": "#E6F1FB", "aws": "#FFF3E0", "gcp": "#E8F0FE"}
    CLOUD_BADGE_FG = {"azure": "#0C447C", "aws": "#7D4600", "gcp": "#1A56A3"}

    now = datetime.utcnow()
    total = cost_data.get("total", 0)
    by_service = cost_data.get("by_service", [])[:8]
    by_sub = cost_data.get("by_subscription", [])
    # Only show the per-user/resource breakdown when the client is explicitly mapped
    # by resource_name (e.g. Cursor by User). Subscription/RG/service-mapped clients
    # (Azure/AWS) would otherwise dump hundreds of raw resource IDs — unwanted noise.
    _has_resource_mapping = any(m.get("filter_type") == "resource_name" for m in client.get("mappings", []))
    by_resource = sorted(cost_data.get("by_resource", []),
                         key=lambda r: r.get("total", r.get("cost", 0)), reverse=True)[:50] if _has_resource_mapping else []
    trend = cost_data.get("trend", [])
    mappings = client.get("mappings", [])

    n_days  = len(trend) or 1
    avg_day = total / n_days if n_days else 0
    # Previous-period comparison is not computed for the client report yet.
    compare_note = "Compared to previous period: N/A"

    PALETTE = ["#185FA5","#2E6DB0","#E8821E","#5E8FC0","#80A7CE","#A3BFDB","#C2D4E8","#9AA7B5"]

    # ── Top services: stacked bar + table with share % ──────────────────────
    svc_total = sum(s["cost"] for s in by_service) or 1
    seg_cells = ""
    for i, s in enumerate(by_service):
        col = PALETTE[min(i, len(PALETTE)-1)]
        w = max(1, round(s["cost"] / svc_total * 100))
        seg_cells += f'<td bgcolor="{col}" width="{w}%" height="14" style="background:{col};line-height:14px;font-size:1px">&nbsp;</td>'
    svc_bar = (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
               f'style="border-radius:6px;overflow:hidden;margin-bottom:16px"><tr>{seg_cells}</tr></table>') if seg_cells else ""
    svc_rows = ""
    for i, s in enumerate(by_service):
        pct = s["cost"] / total * 100 if total else 0
        col = PALETTE[min(i, len(PALETTE)-1)]
        bg = "#F7F9FC" if i % 2 == 0 else "#FFFFFF"
        svc_rows += f"""<tr style="background:{bg}">
            <td style="padding:8px 14px;font-size:13px;color:#1A1A1A"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:{col};margin-right:8px"></span>{s['name']}</td>
            <td style="padding:8px 14px;font-size:13px;font-weight:600;text-align:right;white-space:nowrap">${s['cost']:,.2f}</td>
            <td style="padding:8px 14px;font-size:12px;color:#525252;text-align:right;white-space:nowrap">{pct:.0f}%</td>
        </tr>"""

    # ── By cloud provider with share % ──────────────────────────────────────
    # Use the real cloud_provider from the data (by_cloud) rather than inferring it
    # from subscription mappings (which mislabels User/Service-mapped clouds as azure).
    cloud_totals = {c["cloud"]: c["cost"] for c in cost_data.get("by_cloud", [])}
    if not cloud_totals:  # fallback for older callers
        sub_map = {m.get("value",""): m for m in mappings if m.get("filter_type") == "subscription_id"}
        for s in by_sub:
            m = sub_map.get(s.get("subscription_id",""), {})
            cloud = (m.get("cloud") or "azure").lower()
            cloud_totals[cloud] = cloud_totals.get(cloud, 0) + s["cost"]
    cloud_totals = sorted(cloud_totals.items(), key=lambda x: x[1], reverse=True)
    max_cloud = cloud_totals[0][1] if cloud_totals else 1
    CLOUD_LABELS = {"azure": "Microsoft Azure", "aws": "Amazon AWS", "gcp": "Google Cloud",
                    "openai": "OpenAI", "atlassian": "Atlassian", "cursor": "Cursor"}
    cloud_rows = ""
    for i, (cloud, cost) in enumerate(cloud_totals):
        pct = cost / total * 100 if total else 0
        bar = max(3, int(cost / max_cloud * 100))
        col = CLOUD_COLORS.get(cloud, PALETTE[min(i, len(PALETTE)-1)])
        bg_b = CLOUD_BADGE_BG.get(cloud, "#F0F0F0")
        fg_b = CLOUD_BADGE_FG.get(cloud, "#333")
        label = CLOUD_LABELS.get(cloud, cloud.upper())
        cloud_rows += f"""<tr>
            <td style="padding:8px 14px;white-space:nowrap"><span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;background:{bg_b};color:{fg_b};margin-right:6px">{cloud.upper()[:3]}</span><span style="font-size:13px;color:#1A1A1A">{label}</span></td>
            <td style="padding:8px 8px;width:38%"><div style="background:#EBEBEB;border-radius:4px;height:8px"><div style="background:{col};height:8px;border-radius:4px;width:{bar}%"></div></div></td>
            <td style="padding:8px 14px;font-size:13px;font-weight:600;text-align:right;white-space:nowrap">${cost:,.2f}</td>
            <td style="padding:8px 14px;font-size:12px;color:#525252;text-align:right;white-space:nowrap">{pct:.0f}%</td>
        </tr>"""

    # ── Daily trend (full selected period) with spike detection ─────────────
    recent = trend
    costs = [r["cost"] for r in recent]
    max_t = max(costs, default=1) or 1
    _sorted = sorted(costs)
    median = _sorted[len(_sorted)//2] if _sorted else 0
    spike_threshold = median * 1.6 if median else float("inf")
    trend_rows = ""
    for i, r in enumerate(recent):
        is_spike = len(costs) >= 5 and r["cost"] >= spike_threshold and r["cost"] > avg_day
        bar = max(4, int(r["cost"] / max_t * 100))
        bg = "#FDECEC" if is_spike else ("#FFFFFF" if i % 2 == 0 else "#F7F9FC")
        barcol = "#D64545" if is_spike else ACCENT
        spike_badge = '<span style="font-size:9px;font-weight:700;color:#D64545;margin-left:8px">SPIKE</span>' if is_spike else ""
        trend_rows += f"""<tr style="background:{bg}">
            <td style="padding:6px 14px;font-size:12px;color:#525252;white-space:nowrap">{r['date']}</td>
            <td style="padding:6px 8px;font-size:12px;font-weight:600;text-align:right;white-space:nowrap">${r['cost']:,.2f}{spike_badge}</td>
            <td style="padding:6px 14px;width:38%"><div style="background:{barcol};height:8px;border-radius:4px;width:{bar}%"></div></td>
        </tr>"""

    # Manually-tracked costs — present when called from send-report (cost_data
    # carries "manual_costs"); absent in the live preview, in which case the
    # section renders empty.
    manual_data  = cost_data.get("manual_costs") or {}
    manual_items = manual_data.get("items", [])
    manual_sym   = manual_data.get("symbol", "$")
    manual_total = manual_data.get("total", 0)
    manual_rows = ""
    for i, m in enumerate(manual_items):
        bg = "#F7F7F5" if i % 2 == 0 else "#FFFFFF"
        rec_badge = '<span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;background:#E6F1FB;color:#0C447C;margin-left:6px">RECURRING</span>' if m.get("recurring") else ""
        manual_rows += f"""<tr style="background:{bg}">
            <td style="padding:9px 14px;font-size:13px;color:#1A1A1A">{m['item_name']}{rec_badge}</td>
            <td style="padding:9px 14px;font-size:12px;color:#525252">{m.get('category','Other')}</td>
            <td style="padding:9px 14px;font-size:13px;font-weight:500;text-align:right">{manual_sym}{m['amount_converted']:,.2f}</td>
        </tr>"""
    manual_section = ""
    if manual_rows:
        manual_section = ('<div style="font-size:14px;font-weight:500;color:#1A1A1A;margin-bottom:14px">Other Tools & Subscriptions (Manually Tracked)</div>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;margin-bottom:10px">'
            '<tr style="background:#F0F0EE"><th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Item</th>'
            '<th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:left">Category</th>'
            '<th style="padding:9px 14px;font-size:11px;font-weight:500;color:#525252;text-align:right">Cost</th></tr>'
            + manual_rows + '</table>'
            f'<div style="font-size:12px;color:#525252;margin-bottom:28px">Other tools/subscriptions total: <strong>{manual_sym}{manual_total:,.2f}</strong></div>')

    svc_section = (
        '<tr><td style="padding-bottom:14px"><table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:22px 24px">'
        '<div style="font-size:15px;font-weight:600;color:#1A1A1A;margin-bottom:14px">Top Services Breakdown</div>'
        + svc_bar +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
        '<tr style="border-bottom:1px solid #E8ECF1"><th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:left;text-transform:uppercase">Service</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">Cost</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">Share</th></tr>'
        + svc_rows + '</table></td></tr></table></td></tr>'
    ) if svc_rows else ''

    cloud_section = (
        '<tr><td style="padding-bottom:14px"><table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:22px 24px">'
        '<div style="font-size:15px;font-weight:600;color:#1A1A1A;margin-bottom:14px">By Cloud Provider</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
        + cloud_rows + '</table></td></tr></table></td></tr>'
    ) if cloud_rows else ''

    # By user / resource (e.g. Cursor per-user). When included (plan-covered) cost
    # is available, show Included + On-Demand + Total; otherwise just the cost.
    has_incl = any(r.get("included", 0) for r in by_resource)
    res_rows = ""
    for i, r in enumerate(by_resource):
        bg = "#F7F9FC" if i % 2 == 0 else "#FFFFFF"
        if has_incl:
            _free = r.get('free_usage', 0)
            free_disp = "$20+" if _free > 20 else (f"${_free:,.2f}" if _free > 0 else "—")
            res_rows += f"""<tr style="background:{bg}">
                <td style="padding:8px 14px;font-size:13px;color:#1A1A1A">{r['name']}</td>
                <td style="padding:8px 14px;font-size:12px;color:#525252;text-align:right;white-space:nowrap">${r.get('included_usage',0):,.2f}</td>
                <td style="padding:8px 14px;font-size:12px;color:#525252;text-align:right;white-space:nowrap">{free_disp}</td>
                <td style="padding:8px 14px;font-size:13px;font-weight:600;text-align:right;white-space:nowrap">${r.get('ondemand',r['cost']):,.2f}</td>
            </tr>"""
        else:
            pct = r["cost"] / total * 100 if total else 0
            res_rows += f"""<tr style="background:{bg}">
                <td style="padding:8px 14px;font-size:13px;color:#1A1A1A">{r['name']}</td>
                <td style="padding:8px 14px;font-size:13px;font-weight:600;text-align:right;white-space:nowrap">${r['cost']:,.2f}</td>
                <td style="padding:8px 14px;font-size:12px;color:#525252;text-align:right;white-space:nowrap">{pct:.0f}%</td>
            </tr>"""
    res_header = (
        '<tr style="border-bottom:1px solid #E8ECF1">'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:left;text-transform:uppercase">User / Resource</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">Included Usage</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">Free Usage</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">On-Demand</th></tr>'
    ) if has_incl else ''
    resource_section = (
        '<tr><td style="padding-bottom:14px"><table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:22px 24px">'
        '<div style="font-size:15px;font-weight:600;color:#1A1A1A;margin-bottom:14px">By User / Resource</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
        + res_header + res_rows + '</table></td></tr></table></td></tr>'
    ) if res_rows else ''

    trend_section = (
        '<tr><td style="padding-bottom:14px"><table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:22px 24px">'
        f'<div style="font-size:15px;font-weight:600;color:#1A1A1A;margin-bottom:14px">Daily Cost Trends <span style="font-size:11px;font-weight:400;color:#8A95A1">({date_from} to {date_to})</span></div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">'
        '<tr style="border-bottom:1px solid #E8ECF1"><th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:left;text-transform:uppercase">Date</th>'
        '<th style="padding:6px 8px;font-size:10px;font-weight:600;color:#6B7785;text-align:right;text-transform:uppercase">Cost</th>'
        '<th style="padding:6px 14px;font-size:10px;font-weight:600;color:#6B7785;text-align:left;text-transform:uppercase">Trend</th></tr>'
        + trend_rows + '</table></td></tr></table></td></tr>'
    ) if trend_rows else ''

    manual_block = (
        '<tr><td style="padding-bottom:14px"><table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:22px 24px">'
        + manual_section + '</td></tr></table></td></tr>'
    ) if manual_section else ''

    html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Executive Cost Overview — {client.get('name','')}</title></head>
<body style="margin:0;padding:0;background:#EEF1F5;font-family:{font_stack}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EEF1F5">
<tr><td align="center" style="padding:28px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;width:100%">

<!-- Header banner -->
<tr><td style="padding-bottom:14px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
         style="background-color:#0E4C8A;background-image:linear-gradient(135deg,#0E4C8A,#1A6FB5);border-radius:12px">
    <tr><td style="padding:26px 30px">
      <div style="font-size:12px;color:#BBD6F0;letter-spacing:0.12em;text-transform:uppercase;font-weight:600">&#9729; Cloud Cost Analyzer</div>
      <div style="font-size:26px;color:#FFFFFF;font-weight:700;letter-spacing:-0.01em;margin-top:6px">Executive Cost Overview</div>
      <div style="font-size:13px;color:#D6E6F6;margin-top:6px">{client.get('name','')} &middot; Period: {date_from} to {date_to}</div>
    </td></tr>
  </table>
</td></tr>

<!-- KPI cards -->
<tr><td style="padding-bottom:0">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td width="50%" style="padding:0 7px 14px 0;vertical-align:top">
      <table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:20px 22px;text-align:center">
        <div style="font-size:10px;color:#6B7785;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Total Cloud Spend</div>
        <div style="font-size:30px;color:#0E4C8A;font-weight:700;margin-top:8px">${total:,.2f}</div>
        <div style="font-size:11px;color:#8A95A1;margin-top:6px">{compare_note}</div>
      </td></tr></table>
    </td>
    <td width="50%" style="padding:0 0 14px 7px;vertical-align:top">
      <table role="presentation" width="100%" style="background:#FFFFFF;border:1px solid #DCE3EC;border-radius:12px"><tr><td style="padding:20px 22px;text-align:center">
        <div style="font-size:10px;color:#6B7785;letter-spacing:0.08em;text-transform:uppercase;font-weight:600">Average Daily Spend</div>
        <div style="font-size:30px;color:#1A1A1A;font-weight:700;margin-top:8px">${avg_day:,.2f}</div>
        <div style="font-size:11px;color:#8A95A1;margin-top:6px">Based on {n_days} days with data</div>
      </td></tr></table>
    </td>
  </tr></table>
</td></tr>

{svc_section}
{cloud_section}
{resource_section}
{trend_section}
{manual_block}

<!-- Footer -->
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr><td align="center" style="padding:14px;font-size:11px;color:#8A95A1;line-height:1.6">
    Cloud Cost Analyzer &middot; Executive Report &middot; Generated {now.strftime('%-d %B %Y at %H:%M UTC')}
  </td></tr>
</table></td></tr>

</table></td></tr></table>
</body></html>"""
    return html
