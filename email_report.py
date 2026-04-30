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


def _get_all_cloud_accounts():
    """Return combined list of accounts/subscriptions from all cloud providers."""
    from database import get_db
    conn = get_db()
    accounts = []

    # Azure subscriptions
    rows = conn.execute("SELECT subscription_id, name, 'azure' as cloud FROM subscriptions WHERE enabled=1").fetchall()
    for r in rows:
        accounts.append({"id": r["subscription_id"], "name": r["name"], "cloud": "azure"})

    # AWS + GCP from cloud_providers table (use subscription_id = provider_id for cost_data lookup)
    rows2 = conn.execute(
        "SELECT provider_id, name, provider_type FROM cloud_providers WHERE enabled=1 AND provider_type IN ('aws','gcp')"
    ).fetchall()
    for r in rows2:
        accounts.append({"id": r["provider_id"], "name": r["name"], "cloud": r["provider_type"]})

    conn.close()
    return accounts


def _build_report_html(sections=None, settings=None):
    """Generate a professional multi-cloud HTML cost report."""
    if not sections:
        sections = ["summary", "subscriptions", "top_services", "top_rgs", "trend"]
    if settings is None:
        settings = get_email_settings() or {}

    now        = datetime.utcnow()
    period     = _resolve_report_period(settings)
    month_start = period["date_from"]
    today      = period["date_to"]

    # ── Data gathering ────────────────────────────────────────────────────
    top_services = get_summary("service_name",  date_from=month_start, date_to=today)[:10]
    top_rgs      = get_summary("resource_group", date_from=month_start, date_to=today)[:10]
    trend        = get_daily_trend(date_from=month_start, date_to=today)
    monthly      = get_monthly_summary()

    total_this_month = sum(r["total_cost"] for r in top_services) if top_services else 0
    last_month_data  = [m for m in monthly if m["month"] != now.strftime("%Y-%m")]
    last_month_total = last_month_data[-1]["total_cost"] if last_month_data else 0
    mom_change = ((total_this_month - last_month_total) / last_month_total * 100) if last_month_total > 0 else 0
    avg_daily  = total_this_month / max(1, len(set(r["date"] for r in trend))) if trend else 0

    from database import get_db
    conn = get_db()
    cloud_rows = conn.execute(
        "SELECT cloud_provider, SUM(cost) as total FROM cost_data WHERE date>=? AND date<=? GROUP BY cloud_provider ORDER BY total DESC",
        (month_start, today)
    ).fetchall()
    conn.close()

    cloud_totals = [{"cloud": r["cloud_provider"] or "unknown", "total": r["total"] or 0} for r in cloud_rows]
    grand_total  = sum(c["total"] for c in cloud_totals) or 1

    CLOUD_COLOR  = {"azure": "#0078d4", "aws": "#f90",    "gcp": "#4285f4"}
    CLOUD_LABEL  = {"azure": "Azure",   "aws": "AWS",     "gcp": "GCP"}
    CLOUD_ICON   = {"azure": "&#9632;", "aws": "&#9650;", "gcp": "&#11044;"}

    all_accounts = _get_all_cloud_accounts()
    sub_costs = []
    for acct in all_accounts:
        svcs = get_summary("service_name", date_from=month_start, date_to=today, subscription_id=acct["id"])
        cost = sum(r["total_cost"] for r in svcs)
        if cost > 0:
            sub_costs.append({"name": acct["name"], "cost": cost, "cloud": acct["cloud"]})
    sub_costs.sort(key=lambda x: x["cost"], reverse=True)

    month_label  = period["label"]
    up           = mom_change > 0
    change_color = "#e53e3e" if up else "#38a169"
    change_arrow = "&#9650;" if up else "&#9660;"

    # ── Email wrapper ─────────────────────────────────────────────────────
    html = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef0f5;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f5;padding:32px 16px">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

  <!-- ── HEADER ── -->
  <tr><td style="background:linear-gradient(135deg,#0f1117 0%,#1e2235 60%,#252d45 100%);border-radius:16px 16px 0 0;padding:36px 40px 28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#6b7aad;text-transform:uppercase;margin-bottom:8px">Multi-Cloud Cost Report</div>
          <div style="font-size:32px;font-weight:800;color:#ffffff;line-height:1.1">{month_label}</div>
          <div style="font-size:13px;color:#8892b0;margin-top:6px">Generated {now.strftime('%d %B %Y at %H:%M UTC')}</div>
        </td>
        <td align="right" style="vertical-align:top">
          <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px 20px;text-align:center">
            <div style="font-size:11px;color:#8892b0;margin-bottom:4px">TOTAL SPEND</div>
            <div style="font-size:28px;font-weight:800;color:#4ade80">${total_this_month:,.0f}</div>
            <div style="font-size:12px;font-weight:600;color:{change_color};margin-top:4px">{change_arrow} {abs(mom_change):.1f}% vs last month</div>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- ── KPI STRIP ── -->
  <tr><td style="background:#1a1f35;padding:0 40px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:18px 0;border-right:1px solid rgba(255,255,255,0.08);text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6b7aad;text-transform:uppercase">This Month</div>
          <div style="font-size:22px;font-weight:800;color:#fff;margin-top:4px">${total_this_month:,.2f}</div>
        </td>
        <td style="padding:18px 0;border-right:1px solid rgba(255,255,255,0.08);text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6b7aad;text-transform:uppercase">Last Month</div>
          <div style="font-size:22px;font-weight:800;color:#fff;margin-top:4px">${last_month_total:,.2f}</div>
        </td>
        <td style="padding:18px 0;border-right:1px solid rgba(255,255,255,0.08);text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6b7aad;text-transform:uppercase">Avg / Day</div>
          <div style="font-size:22px;font-weight:800;color:#fff;margin-top:4px">${avg_daily:,.2f}</div>
        </td>
        <td style="padding:18px 0;text-align:center">
          <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#6b7aad;text-transform:uppercase">MoM Change</div>
          <div style="font-size:22px;font-weight:800;color:{change_color};margin-top:4px">{change_arrow} {abs(mom_change):.1f}%</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- ── BODY ── -->
  <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px 40px">
"""

    # ── Cloud provider breakdown cards ────────────────────────────────────
    if "summary" in sections and cloud_totals:
        cards = ""
        for c in cloud_totals:
            col   = CLOUD_COLOR.get(c["cloud"], "#888")
            lbl   = CLOUD_LABEL.get(c["cloud"], c["cloud"].upper())
            icon  = CLOUD_ICON.get(c["cloud"], "&#9679;")
            pct   = c["total"] / grand_total * 100
            bar_w = max(4, int(pct))
            cards += f"""
            <td style="padding:0 6px;vertical-align:top;width:33%">
              <div style="border:1.5px solid {col}33;border-top:3px solid {col};border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:13px;font-weight:700;color:{col};margin-bottom:8px">{icon} {lbl}</div>
                <div style="font-size:22px;font-weight:800;color:#1a202c">${c['total']:,.0f}</div>
                <div style="font-size:11px;color:#718096;margin:4px 0 10px">{pct:.1f}% of total</div>
                <div style="background:#f0f0f0;border-radius:4px;height:5px;overflow:hidden">
                  <div style="background:{col};width:{bar_w}%;height:5px;border-radius:4px"></div>
                </div>
              </div>
            </td>"""

        html += f"""
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a0aec0;text-transform:uppercase;margin-bottom:14px">Cloud Provider Breakdown</div>
      <table width="100%" cellpadding="0" cellspacing="0"><tr style="margin:0 -6px">{cards}</tr></table>
    </div>
"""

    # ── Trend chart (bar sparkline) ───────────────────────────────────────
    if "trend" in sections and trend:
        recent  = trend[-30:]
        max_val = max((r["total_cost"] for r in recent), default=1) or 1
        bar_h   = 70
        bar_w_each = max(6, 580 // max(1, len(recent)))
        bars = ""
        for r in recent:
            h   = max(3, int(r["total_cost"] / max_val * bar_h))
            dt  = r["date"][5:]  # MM-DD
            bars += (
                f'<td style="vertical-align:bottom;padding:0 1px;text-align:center">'
                f'<div title="${r["total_cost"]:,.2f} on {r["date"]}" '
                f'style="background:linear-gradient(180deg,#667eea,#4f6ef7);width:{bar_w_each-2}px;height:{h}px;'
                f'border-radius:3px 3px 0 0;display:inline-block"></div></td>'
            )
        first_date = recent[0]["date"][5:] if recent else ""
        last_date  = recent[-1]["date"][5:] if recent else ""
        html += f"""
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a0aec0;text-transform:uppercase;margin-bottom:14px">Daily Spend — Last 30 Days</div>
      <div style="background:#f7f8fc;border-radius:10px;padding:16px 16px 8px;overflow:hidden">
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
          <tr style="height:{bar_h}px;vertical-align:bottom">{bars}</tr>
        </table>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#a0aec0;margin-top:6px;padding:0 2px">
          <span>{first_date}</span><span style="color:#667eea;font-weight:600">Daily Cost</span><span>{last_date}</span>
        </div>
      </div>
    </div>
"""

    # ── Top services ──────────────────────────────────────────────────────
    if "top_services" in sections and top_services:
        max_svc = top_services[0]["total_cost"] or 1
        SVC_COLORS = ["#667eea","#48bb78","#ed8936","#e53e3e","#9f7aea","#38b2ac","#f6ad55","#fc8181","#76e4f7","#b794f4"]
        rows = ""
        for i, s in enumerate(top_services[:10]):
            pct   = s["total_cost"] / max_svc * 100
            bar_w = max(3, int(pct * 0.55))  # max ~55% of cell
            col   = SVC_COLORS[i % len(SVC_COLORS)]
            bg    = "#fafbff" if i % 2 == 0 else "#ffffff"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;font-size:13px;color:#2d3748;font-weight:500;width:36%">{s['service_name'] or 'Unknown'}</td>
              <td style="padding:10px 8px;width:44%">
                <div style="background:#edf2f7;border-radius:4px;height:8px;overflow:hidden">
                  <div style="background:{col};width:{bar_w}%;height:8px;border-radius:4px"></div>
                </div>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:700;color:{col};text-align:right;width:20%">${s['total_cost']:,.2f}</td>
            </tr>"""

        html += f"""
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a0aec0;text-transform:uppercase;margin-bottom:14px">Top 10 Services — All Clouds</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e8ecf0">
        <tr style="background:#2d3748">
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">SERVICE</th>
          <th style="padding:10px 8px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">USAGE</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:right;letter-spacing:.5px">COST</th>
        </tr>
        {rows}
      </table>
    </div>
"""

    # ── Account / Subscription breakdown ─────────────────────────────────
    if "subscriptions" in sections and sub_costs:
        max_acct = sub_costs[0]["cost"] or 1
        rows = ""
        for i, sc in enumerate(sub_costs[:12]):
            col   = CLOUD_COLOR.get(sc["cloud"], "#888")
            lbl   = CLOUD_LABEL.get(sc["cloud"], sc["cloud"].upper())
            pct   = sc["cost"] / max_acct * 100
            bar_w = max(3, int(pct * 0.5))
            bg    = "#fafbff" if i % 2 == 0 else "#ffffff"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;width:32%">
                <span style="display:inline-block;font-size:9px;font-weight:800;color:{col};background:{col}18;border:1px solid {col}44;border-radius:4px;padding:2px 6px;margin-right:6px;letter-spacing:.5px">{lbl}</span>
                <span style="font-size:13px;color:#2d3748;font-weight:500">{sc['name']}</span>
              </td>
              <td style="padding:10px 8px;width:46%">
                <div style="background:#edf2f7;border-radius:4px;height:8px;overflow:hidden">
                  <div style="background:{col};width:{bar_w}%;height:8px;border-radius:4px"></div>
                </div>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:700;color:#38a169;text-align:right;width:22%">${sc['cost']:,.2f}</td>
            </tr>"""

        html += f"""
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a0aec0;text-transform:uppercase;margin-bottom:14px">Cost by Account / Subscription / Project</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e8ecf0">
        <tr style="background:#2d3748">
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">ACCOUNT</th>
          <th style="padding:10px 8px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">SHARE</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:right;letter-spacing:.5px">COST</th>
        </tr>
        {rows}
      </table>
    </div>
"""

    # ── Top resource groups ───────────────────────────────────────────────
    if "top_rgs" in sections and top_rgs:
        max_rg  = top_rgs[0]["total_cost"] or 1
        RG_COLS = ["#9f7aea","#667eea","#48bb78","#ed8936","#e53e3e","#38b2ac","#f6ad55","#fc8181","#b794f4","#76e4f7"]
        rows = ""
        for i, r in enumerate(top_rgs[:10]):
            pct   = r["total_cost"] / max_rg * 100
            bar_w = max(3, int(pct * 0.55))
            col   = RG_COLS[i % len(RG_COLS)]
            bg    = "#fafbff" if i % 2 == 0 else "#ffffff"
            rows += f"""<tr style="background:{bg}">
              <td style="padding:10px 14px;font-size:13px;color:#2d3748;font-weight:500;width:36%">{r['resource_group'] or 'Unknown'}</td>
              <td style="padding:10px 8px;width:44%">
                <div style="background:#edf2f7;border-radius:4px;height:8px;overflow:hidden">
                  <div style="background:{col};width:{bar_w}%;height:8px;border-radius:4px"></div>
                </div>
              </td>
              <td style="padding:10px 14px;font-size:13px;font-weight:700;color:{col};text-align:right;width:20%">${r['total_cost']:,.2f}</td>
            </tr>"""

        html += f"""
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a0aec0;text-transform:uppercase;margin-bottom:14px">Top 10 Resource Groups / Regions / Projects</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:10px;overflow:hidden;border:1px solid #e8ecf0">
        <tr style="background:#2d3748">
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">GROUP / REGION / PROJECT</th>
          <th style="padding:10px 8px;font-size:11px;font-weight:600;color:#a0aec0;text-align:left;letter-spacing:.5px">SHARE</th>
          <th style="padding:10px 14px;font-size:11px;font-weight:600;color:#a0aec0;text-align:right;letter-spacing:.5px">COST</th>
        </tr>
        {rows}
      </table>
    </div>
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
                WHERE date >= ? AND date <= ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                GROUP BY subscription_id, resource_group, resource_name
            """, (month_start, today)).fetchall()
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
                WHERE date >= ? AND date <= ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                GROUP BY subscription_id, rg, resource_name, date
            """, (lb_start, today)).fetchall()
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
                    WHERE timestamp >= ? AND timestamp <= ?
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
            """, (start_ts, end_ts)).fetchall()

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
                    WHERE timestamp >= ? AND timestamp <= ?
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
            """, (start_ts, end_ts)).fetchall()

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
                WHERE timestamp >= ? AND timestamp <= ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                  AND (operation_name LIKE 'Create%' OR operation LIKE '%/write')
            """, (start_ts, end_ts)).fetchone()["cnt"]
            total_deleted = conn.execute("""
                SELECT COUNT(DISTINCT subscription_id || '|' || resource_group || '|' || resource_name) as cnt
                FROM activity_logs
                WHERE timestamp >= ? AND timestamp <= ?
                  AND resource_name IS NOT NULL AND resource_name != ''
                  AND (operation_name LIKE 'Delete%' OR operation LIKE '%/delete')
            """, (start_ts, end_ts)).fetchone()["cnt"]
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
            # Don't render the detailed section if data is unavailable.
            return html

        def _rows_to_html_created(rows):
            out = ""
            # Collapse noisy containerGroups into one total row
            cg_rows = []
            other_rows = []
            for r in rows:
                rt = (r["resource_type"] or "")
                rt_short = rt.split("/")[-1] if rt else ""
                if rt_short == "containerGroups":
                    cg_rows.append(r)
                else:
                    other_rows.append(r)

            if cg_rows:
                seen = set()
                total_cost = 0.0
                for r in cg_rows:
                    key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                    if key in seen:
                        continue
                    seen.add(key)
                    total_cost += float(cost_map.get(key, 0) or 0)
                out += f"""<tr style="background:#f8f9fc">
                    <td style="padding:8px 10px;font-size:13px;color:#1a1d2e"><strong>containerGroups</strong> ({len(seen):,} resources)</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">containerGroups</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280;white-space:nowrap">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">—</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#2ecc71;text-align:right">${total_cost:,.2f}</td>
                </tr>"""

            for i, r in enumerate(other_rows):
                bg = "#ffffff" if i % 2 == 0 else "#f8f9fc"
                key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                est_cost = cost_map.get(key, 0)
                created_date = _safe_date(r["first_ts"] if "first_ts" in r.keys() else None)
                raw_actor = (r["actor"] if "actor" in r.keys() else None) or ""
                actor = actor_map.get(raw_actor, raw_actor) if raw_actor else "-"
                out += f"""<tr style="background:{bg}">
                    <td style="padding:8px 10px;font-size:13px;color:#1a1d2e">{r["resource_name"]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{(r["resource_group"] or "-")}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{(r["resource_type"] or "").split("/")[-1]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280;white-space:nowrap">{created_date or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{actor}</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#2ecc71;text-align:right">${est_cost:,.2f}</td>
                </tr>"""
            return out or '<tr><td colspan="6" style="padding:10px 12px;color:#6b7280">No data</td></tr>'

        def _rows_to_html_deleted(rows):
            out = ""
            # Collapse noisy containerGroups into one total row
            cg_rows = []
            other_rows = []
            for r in rows:
                rt = (r["resource_type"] or "")
                rt_short = rt.split("/")[-1] if rt else ""
                if rt_short == "containerGroups":
                    cg_rows.append(r)
                else:
                    other_rows.append(r)

            if cg_rows:
                seen = set()
                total_incurred = 0.0
                total_savings = 0.0
                for r in cg_rows:
                    key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                    if key in seen:
                        continue
                    seen.add(key)
                    total_incurred += float(cost_map.get(key, 0) or 0)
                    del_date = _safe_date(r["last_ts"] if "last_ts" in r.keys() else None)
                    avg_daily = _avg_daily_cost_before(r["subscription_id"], r["resource_group"], r["resource_name"], del_date, lookback_days=7)
                    days_after = _days_between(del_date, today)
                    total_savings += avg_daily * days_after
                out += f"""<tr style="background:#f8f9fc">
                    <td style="padding:8px 10px;font-size:13px;color:#1a1d2e"><strong>containerGroups</strong> ({len(seen):,} resources)</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">containerGroups</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280;white-space:nowrap">—</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">—</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#e74c3c;text-align:right">${total_incurred:,.2f}</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#4f6ef7;text-align:right">${total_savings:,.2f}</td>
                </tr>"""

            for i, r in enumerate(other_rows):
                bg = "#ffffff" if i % 2 == 0 else "#f8f9fc"
                key = (r["subscription_id"], _norm_rg(r["resource_group"]), r["resource_name"])
                incurred = float(cost_map.get(key, 0) or 0)
                del_date = _safe_date(r["last_ts"] if "last_ts" in r.keys() else None)
                avg_daily = _avg_daily_cost_before(r["subscription_id"], r["resource_group"], r["resource_name"], del_date, lookback_days=7)
                days_after = _days_between(del_date, today)
                savings = avg_daily * days_after
                raw_actor = (r["actor"] if "actor" in r.keys() else None) or ""
                actor = actor_map.get(raw_actor, raw_actor) if raw_actor else "-"
                out += f"""<tr style="background:{bg}">
                    <td style="padding:8px 10px;font-size:13px;color:#1a1d2e">{r["resource_name"]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{(r["resource_group"] or "-")}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{(r["resource_type"] or "").split("/")[-1]}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280;white-space:nowrap">{del_date or "-"}</td>
                    <td style="padding:8px 10px;font-size:12px;color:#6b7280">{actor}</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#e74c3c;text-align:right">${incurred:,.2f}</td>
                    <td style="padding:8px 10px;font-size:13px;font-weight:600;color:#4f6ef7;text-align:right">${savings:,.2f}</td>
                </tr>"""
            return out or '<tr><td colspan="7" style="padding:10px 12px;color:#6b7280">No data</td></tr>'

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

        if int(total_created or 0) == 0 and int(total_deleted or 0) == 0:
            html += f"""
            <div style="margin-bottom:20px">
                <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Resource Changes ({month_label})</h2>
                <div style="font-size:12px;color:#6b7280">
                    No resource create/delete events found for this period.
                </div>
            </div>
            """
        else:
            html += f"""
        <div style="margin-bottom:20px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Resource Changes ({month_label})</h2>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
                <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;min-width:180px">
                    <div style="font-size:12px;color:#6b7280">Resources Created</div>
                    <div style="font-size:22px;font-weight:700;color:#2ecc71">{int(total_created or 0):,}</div>
                </div>
                <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;min-width:180px">
                    <div style="font-size:12px;color:#6b7280">Resources Deleted</div>
                    <div style="font-size:22px;font-weight:700;color:#e74c3c">{int(total_deleted or 0):,}</div>
                </div>
                <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;min-width:180px">
                    <div style="font-size:12px;color:#6b7280">Created Cost (est.)</div>
                    <div style="font-size:22px;font-weight:700;color:#2ecc71">${created_cost_est:,.2f}</div>
                </div>
                <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;min-width:180px">
                    <div style="font-size:12px;color:#6b7280">Deleted Cost (incurred)</div>
                    <div style="font-size:22px;font-weight:700;color:#e74c3c">${deleted_cost_est:,.2f}</div>
                </div>
                <div style="background:#f8f9fc;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;min-width:220px">
                    <div style="font-size:12px;color:#6b7280">Estimated Savings After Delete</div>
                    <div style="font-size:22px;font-weight:700;color:#4f6ef7">${deleted_savings_est:,.2f}</div>
                </div>
            </div>

            <div style="margin-top:6px">
                <div style="font-size:13px;font-weight:600;color:#1a1d2e;margin-bottom:8px">Created (with estimated cost in this period)</div>
                <div style="width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #e5e7eb;border-radius:8px">
                    <table style="width:100%;min-width:1020px;border-collapse:collapse">
                        <tr style="background:#1a1d2e">
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Resource</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">RG</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Type</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Created</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">User</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:right">Cost</th>
                        </tr>
                        {_rows_to_html_created(created)}
                    </table>
                </div>
            </div>

            <div style="margin-top:16px">
                <div style="font-size:13px;font-weight:600;color:#1a1d2e;margin-bottom:8px">Deleted (cost incurred + savings estimate)</div>
                <div style="width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #e5e7eb;border-radius:8px">
                    <table style="width:100%;min-width:1160px;border-collapse:collapse">
                        <tr style="background:#1a1d2e">
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Resource</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">RG</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Type</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">Deleted</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:left">User</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:right">Cost</th>
                            <th style="padding:8px 10px;font-size:12px;color:#a0a3b5;text-align:right">Savings</th>
                        </tr>
                        {_rows_to_html_deleted(deleted)}
                    </table>
                </div>
            </div>
            <div style="font-size:11px;color:#6b7280;margin-top:8px">
                Cost is best-effort and based on matching cost records by subscription + resource group + resource name for the same period.
                Savings is estimated using the average daily cost in the 7 days before deletion, multiplied by the remaining days in the report period.
            </div>
        </div>
        """

    if monthly and "monthly_comparison" in sections:
        rows = ""
        for i, m in enumerate(monthly[-6:]):
            bg = "#ffffff" if i % 2 == 0 else "#f8f9fc"
            rows += f'<tr style="background:{bg}"><td style="padding:8px 12px;font-size:13px">{m["month"]}</td><td style="padding:8px 12px;font-size:13px;font-weight:600;color:#2ecc71;text-align:right">${m["total_cost"]:,.2f}</td><td style="padding:8px 12px;font-size:13px;text-align:right">{m["record_count"]:,}</td></tr>'
        html += f"""
        <div style="margin-bottom:20px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Monthly History</h2>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
                <tr style="background:#1a1d2e"><th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:left">Month</th><th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">Cost</th><th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">Records</th></tr>
                {rows}
            </table>
        </div>
        """

    html += f"""
    <div style="border-top:1px solid #e8ecf0;padding-top:20px;margin-top:8px;text-align:center">
      <div style="font-size:11px;color:#a0aec0">Generated automatically by <strong style="color:#667eea">Cloud Cost Analyzer</strong></div>
      <div style="font-size:10px;color:#cbd5e0;margin-top:4px">{now.strftime('%d %B %Y at %H:%M UTC')}</div>
    </div>

  </td></tr>
</table>
</td></tr></table>
</body></html>"""
    return html


def _build_custom_report_html(report):
    """Generate HTML for a custom report based on saved filters and sections."""
    filters = report.get("filters", {})
    sections = report.get("sections", ["summary", "by_service", "by_rg", "trend"])
    report_name = report.get("name", "Custom Report")

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
    )

    total_cost = data.get("total_cost", 0)
    total_records = data.get("total_records", 0)
    by_rg = data.get("by_rg", [])
    by_service = data.get("by_service", [])
    daily_trend = data.get("daily_trend", [])

    # Resolve subscription names
    subs = get_subscriptions()
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

    html = f"""
    <div style="background:#f3f4f6;padding:20px">
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:1200px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
        <div style="background:linear-gradient(135deg,#1a1d2e,#2d3148);padding:28px 32px;color:#ffffff">
            <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:600">{report_name}</h1>
            <p style="margin:0;font-size:13px;color:#a0a3b5">Custom Cost Report &bull; Generated {now.strftime('%d %b %Y, %H:%M UTC')}</p>
        </div>
        <div style="padding:24px 32px">

        <!-- Filter Summary -->
        <div style="background:#f0f1f5;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:12px;color:#4a5568;line-height:1.8">
            {'<br>'.join(filter_tags)}
        </div>
    """

    if "summary" in sections:
        html += f"""
        <div style="background:#f8f9fc;border-radius:10px;padding:20px;margin-bottom:20px;text-align:center">
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px">Total Cost</div>
            <div style="font-size:36px;font-weight:700;color:#2ecc71">${total_cost:,.2f}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:6px">{total_records:,} records &bull; {len(by_rg)} resource groups &bull; {len(by_service)} services</div>
        </div>
        """

    if "by_service" in sections and by_service:
        rows = ""
        for i, s in enumerate(by_service[:15]):
            bg = "#ffffff" if i % 2 == 0 else "#f8f9fc"
            pct = (s["cost"] / total_cost * 100) if total_cost > 0 else 0
            bar_w = max(2, min(120, int(pct * 1.2)))
            rows += f'''<tr style="background:{bg}">
                <td style="padding:8px 12px;font-size:13px;color:#1a1d2e">{s["name"]}</td>
                <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#4f6ef7;text-align:right">${s["cost"]:,.2f}</td>
                <td style="padding:8px 12px;font-size:12px;color:#6b7280;text-align:right">{pct:.1f}%</td>
                <td style="padding:8px 12px"><div style="background:#4f6ef7;height:8px;width:{bar_w}px;border-radius:4px"></div></td>
            </tr>'''
        html += f"""
        <div style="margin-bottom:20px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Cost by Service</h2>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
                <tr style="background:#1a1d2e">
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:left">Service</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">Cost</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">%</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5"></th>
                </tr>
                {rows}
            </table>
        </div>
        """

    if "by_rg" in sections and by_rg:
        rows = ""
        for i, r in enumerate(by_rg[:15]):
            bg = "#ffffff" if i % 2 == 0 else "#f8f9fc"
            pct = (r["cost"] / total_cost * 100) if total_cost > 0 else 0
            bar_w = max(2, min(120, int(pct * 1.2)))
            rows += f'''<tr style="background:{bg}">
                <td style="padding:8px 12px;font-size:13px;color:#1a1d2e">{r["name"]}</td>
                <td style="padding:8px 12px;font-size:13px;font-weight:600;color:#9b59b6;text-align:right">${r["cost"]:,.2f}</td>
                <td style="padding:8px 12px;font-size:12px;color:#6b7280;text-align:right">{pct:.1f}%</td>
                <td style="padding:8px 12px"><div style="background:#9b59b6;height:8px;width:{bar_w}px;border-radius:4px"></div></td>
            </tr>'''
        html += f"""
        <div style="margin-bottom:20px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Cost by Resource Group</h2>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
                <tr style="background:#1a1d2e">
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:left">Resource Group</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">Cost</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5;text-align:right">%</th>
                    <th style="padding:8px 12px;font-size:12px;color:#a0a3b5"></th>
                </tr>
                {rows}
            </table>
        </div>
        """

    if "trend" in sections and daily_trend:
        max_cost = max((d["cost"] for d in daily_trend), default=1)
        count = min(30, len(daily_trend))
        recent = daily_trend[-count:]
        bars = ""
        for d in recent:
            pct = max(2, d["cost"] / max_cost * 100) if max_cost > 0 else 2
            bars += f'<div style="display:inline-block;width:{100/count:.1f}%;vertical-align:bottom;text-align:center;padding:0 1px"><div style="background:#4f6ef7;height:{pct:.0f}px;border-radius:2px 2px 0 0;min-height:2px" title="${d["cost"]:.2f} on {d["date"]}"></div></div>'
        html += f"""
        <div style="margin-bottom:20px">
            <h2 style="margin:0 0 12px 0;font-size:16px;color:#1a1d2e">Daily Spend Trend</h2>
            <div style="background:#f8f9fc;border-radius:8px;padding:16px;height:120px;display:flex;align-items:flex-end">
                {bars}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#6b7280;margin-top:4px;padding:0 4px">
                <span>{recent[0]["date"]}</span><span>{recent[-1]["date"]}</span>
            </div>
        </div>
        """

    html += """
        <div style="border-top:1px solid #e5e7eb;padding-top:16px;margin-top:8px;font-size:11px;color:#9ca3af;text-align:center">
            This report was generated by Azure Cost Analyzer.
        </div>
        </div>
    </div>
    </div>
    """
    return html


def send_custom_report(report_id, report_type="manual"):
    """Send a custom report by ID."""
    report = get_custom_report(report_id)
    if not report:
        raise ValueError(f"Report #{report_id} not found")

    recipients = report.get("recipients", "")
    if not recipients:
        settings = get_email_settings()
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
    )
    update_custom_report(report_id, {"last_sent": datetime.utcnow().isoformat()})
    return True


def preview_custom_report(report_id):
    """Generate preview HTML for a custom report."""
    report = get_custom_report(report_id)
    if not report:
        raise ValueError(f"Report #{report_id} not found")
    return _build_custom_report_html(report)


def send_report_email(recipients=None, subject=None, html_body=None, report_type="scheduled"):
    """Send an HTML email report using configured SMTP settings."""
    settings = get_email_settings()

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
        subject = f"Azure Cost Report — {label}"

    if not html_body:
        sections = settings.get("report_sections", ["summary", "subscriptions", "top_services", "top_rgs", "trend"])
        html_body = _build_report_html(sections, settings=settings)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
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

        log_email(", ".join(recipients), subject, "sent", report_type=report_type)
        return True

    except Exception as e:
        log_email(", ".join(recipients), subject, "failed", str(e), report_type=report_type)
        raise


def send_test_email(recipient):
    """Send a short test email to verify SMTP configuration."""
    html = """
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:500px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e0e0e0">
        <div style="background:linear-gradient(135deg,#1a1d2e,#2d3148);padding:24px 28px;color:#ffffff">
            <h1 style="margin:0;font-size:20px">Azure Cost Analyzer</h1>
        </div>
        <div style="padding:24px 28px;text-align:center">
            <div style="font-size:48px;margin-bottom:12px">&#9989;</div>
            <h2 style="margin:0 0 8px 0;font-size:18px;color:#1a1d2e">SMTP Configuration Verified!</h2>
            <p style="color:#6b7280;font-size:14px;margin:0">Email delivery is working correctly.<br>You can now schedule automated cost reports.</p>
        </div>
    </div>
    """
    send_report_email(
        recipients=[recipient],
        subject="Azure Cost Analyzer — Test Email",
        html_body=html,
        report_type="test"
    )
