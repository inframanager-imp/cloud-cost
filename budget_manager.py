"""
Budget alert engine.

Called after every cost sync.  For each enabled budget:
  1. Compute current spend for the budget's period and scope.
  2. Check which alert thresholds have been crossed.
  3. Skip if the same threshold already fired within the de-dup window (24 h).
  4. Fire notifications via email and/or Slack.
  5. Log the alert to budget_alerts table.
"""

import os
import calendar
from datetime import datetime, timedelta

from database import (
    get_db,
    get_budgets,
    log_budget_alert,
    get_recent_budget_alert,
)
from slack_notifier import send_budget_alert as slack_budget_alert

SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")


# ─── Spend calculation ────────────────────────────────────────────────────────

def _period_dates(period: str):
    """Return (start_date_str, end_date_str) for the budget period."""
    today = datetime.utcnow()
    if period == "daily":
        start = end = today
    elif period == "weekly":
        start = today - timedelta(days=today.weekday())  # Monday
        end = start + timedelta(days=6)
    elif period == "monthly":
        start = today.replace(day=1)
        days_in = calendar.monthrange(today.year, today.month)[1]
        end = today.replace(day=days_in)
    elif period == "quarterly":
        q_start_month = ((today.month - 1) // 3) * 3 + 1
        start = today.replace(month=q_start_month, day=1)
        end_month = q_start_month + 2
        days_in = calendar.monthrange(today.year, end_month)[1]
        end = today.replace(month=end_month, day=days_in)
    elif period == "annual":
        start = today.replace(month=1, day=1)
        end = today.replace(month=12, day=31)
    else:
        start = today.replace(day=1)
        end = today
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def get_current_spend(budget: dict) -> float:
    """Query cost_data for the budget's scope and period."""
    date_from, date_to = _period_dates(budget["period"])
    provider_type = budget.get("provider_type", "all")
    provider_id   = budget.get("provider_id", "")
    resource_group = budget.get("resource_group", "")
    service_name   = budget.get("service_name", "")

    conn = get_db()
    params = [date_from, date_to]
    where = "WHERE date >= ? AND date <= ?"

    if provider_type and provider_type != "all":
        where += " AND cloud_provider = ?"
        params.append(provider_type)

    if provider_id:
        where += " AND subscription_id = ?"
        params.append(provider_id)

    if resource_group:
        where += " AND LOWER(resource_group) = LOWER(?)"
        params.append(resource_group)

    if service_name:
        where += " AND LOWER(service_name) = LOWER(?)"
        params.append(service_name)

    row = conn.execute(
        f"SELECT COALESCE(SUM(cost), 0) AS total FROM cost_data {where}",
        params,
    ).fetchone()
    conn.close()
    return float(row["total"]) if row else 0.0


# ─── Notification dispatch ────────────────────────────────────────────────────

def _send_email_alert(budget: dict, threshold_pct: int, current_spend: float):
    """Send budget-breach email via the existing email_report infrastructure."""
    try:
        from email_report import send_test_email  # noqa — just import to confirm module exists
        import smtplib
        import ssl
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        smtp_host = os.getenv("SMTP_HOST", "")
        smtp_port = int(os.getenv("SMTP_PORT", 587))
        smtp_user = os.getenv("SMTP_USER", "")
        smtp_pass = os.getenv("SMTP_PASSWORD", "")
        smtp_from = os.getenv("SMTP_FROM", smtp_user)
        use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes")

        # Pull recipients from email_settings table
        from database import get_email_settings
        settings = get_email_settings()
        recipients_raw = settings.get("recipients", "")
        recipients = [r.strip() for r in recipients_raw.split(",") if r.strip()]

        if not smtp_host or not recipients:
            print("[Budget] Email not configured — skipping email alert.")
            return False

        budget_amount = budget["amount"]
        pct_used = round(current_spend / budget_amount * 100, 1) if budget_amount else 0
        remaining = max(0, budget_amount - current_spend)
        period = budget["period"].capitalize()
        provider = budget.get("provider_type", "all").upper()
        severity = "CRITICAL" if threshold_pct >= 100 else "WARNING"

        subject = (
            f"[{severity}] Budget Alert: {budget['name']} — "
            f"{pct_used}% of {period} budget used"
        )

        html = f"""
        <html><body style="font-family:Arial,sans-serif;color:#333">
        <div style="max-width:600px;margin:auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
          <div style="background:{'#E53E3E' if threshold_pct>=100 else '#D69E2E'};color:#fff;padding:20px">
            <h2 style="margin:0">{'🚨' if threshold_pct>=100 else '⚠️'} Budget Alert: {budget['name']}</h2>
            <p style="margin:8px 0 0">{pct_used}% of your {period} budget has been consumed (threshold: {threshold_pct}%)</p>
          </div>
          <div style="padding:24px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#666">Provider</td><td style="padding:8px 0;font-weight:600">{provider if provider!='ALL' else 'All Clouds'}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Period</td><td style="padding:8px 0;font-weight:600">{period}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Current Spend</td><td style="padding:8px 0;font-weight:600">${current_spend:,.2f}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Budget</td><td style="padding:8px 0;font-weight:600">${budget_amount:,.2f}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Remaining</td><td style="padding:8px 0;font-weight:600;color:{'#E53E3E' if remaining==0 else '#38A169'}">${remaining:,.2f}</td></tr>
            </table>
          </div>
          <div style="padding:16px;background:#f9f9f9;font-size:12px;color:#888">
            Cloud Cost Analyzer &mdash; {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}
          </div>
        </div>
        </body></html>
        """

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp_from
        msg["To"] = ", ".join(recipients)
        msg.attach(MIMEText(html, "html"))

        if use_tls:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=ctx) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_from, recipients, msg.as_string())
        else:
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.sendmail(smtp_from, recipients, msg.as_string())

        print(f"[Budget] Email alert sent for '{budget['name']}' threshold {threshold_pct}%")
        return True

    except Exception as e:
        print(f"[Budget] Email alert failed: {e}")
        return False


# ─── Main checker ─────────────────────────────────────────────────────────────

def check_budgets(provider_filter: str = None) -> list:
    """
    Evaluate all enabled budgets and fire alerts where needed.

    Args:
        provider_filter: If set, only evaluate budgets for this cloud_provider.

    Returns:
        List of dicts describing each alert fired.
    """
    budgets = get_budgets(enabled_only=True)
    fired = []

    for budget in budgets:
        b_provider = budget.get("provider_type", "all")

        # Skip if provider filter doesn't match
        if provider_filter and b_provider not in ("all", provider_filter):
            continue

        current_spend = get_current_spend(budget)
        budget_amount = budget["amount"]

        if budget_amount <= 0:
            continue

        pct_used = (current_spend / budget_amount) * 100

        for threshold in sorted(budget["alert_thresholds"]):
            if pct_used < threshold:
                continue  # not yet reached

            # De-dup: skip if already fired within 24 h
            if get_recent_budget_alert(budget["id"], threshold, within_hours=24):
                continue

            channels_notified = []
            channels = budget.get("alert_channels", ["email"])

            if "slack" in channels:
                ok = slack_budget_alert(
                    budget_name=budget["name"],
                    threshold_pct=threshold,
                    current_spend=current_spend,
                    budget_amount=budget_amount,
                    period=budget["period"],
                    provider=b_provider,
                    webhook_url=SLACK_WEBHOOK_URL,
                )
                if ok:
                    channels_notified.append("slack")

            if "email" in channels:
                ok = _send_email_alert(budget, threshold, current_spend)
                if ok:
                    channels_notified.append("email")

            log_budget_alert(
                budget_id=budget["id"],
                threshold_pct=threshold,
                current_spend=current_spend,
                budget_amount=budget_amount,
                notified_via=channels_notified,
            )

            fired.append({
                "budget_id": budget["id"],
                "budget_name": budget["name"],
                "threshold_pct": threshold,
                "pct_used": round(pct_used, 1),
                "current_spend": round(current_spend, 2),
                "budget_amount": budget_amount,
                "channels": channels_notified,
            })
            print(
                f"[Budget] Alert fired: '{budget['name']}' "
                f"{round(pct_used,1)}% (threshold {threshold}%) — "
                f"notified via {channels_notified}"
            )

    return fired


# ─── Freshness checker ────────────────────────────────────────────────────────

def check_data_freshness() -> list:
    """
    Check if any cloud provider's data is stale beyond its expected billing lag.
    Sends Slack alerts if SLACK_WEBHOOK_URL is set.
    Returns list of stale provider dicts.
    """
    from database import get_data_freshness
    from slack_notifier import send_data_freshness_alert

    stale = []
    for item in get_data_freshness():
        if item.get("is_stale"):
            stale.append(item)
            if SLACK_WEBHOOK_URL:
                send_data_freshness_alert(
                    provider=item["cloud_provider"],
                    lag_days=item["lag_days"],
                    expected_lag_hrs=item["expected_lag_hrs"],
                    webhook_url=SLACK_WEBHOOK_URL,
                )
    return stale
