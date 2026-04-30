"""
Slack notification helper.

Sends structured Block Kit messages to a Slack Incoming Webhook URL.
Configure SLACK_WEBHOOK_URL in .env or pass it explicitly per call.
"""

import os
import json
import requests
from datetime import datetime

SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")

# Colour palette for alert severity
_COLORS = {
    "critical": "#E53E3E",   # red
    "warning":  "#D69E2E",   # amber
    "info":     "#3182CE",   # blue
    "ok":       "#38A169",   # green
}


def _severity(threshold_pct: int) -> str:
    if threshold_pct >= 100:
        return "critical"
    if threshold_pct >= 80:
        return "warning"
    return "info"


def send_slack_message(text: str, blocks: list = None, webhook_url: str = "") -> bool:
    """
    Post a plain-text or Block Kit message to Slack.
    Returns True on success.
    """
    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        print("[Slack] SLACK_WEBHOOK_URL not configured — skipping notification.")
        return False

    payload = {"text": text}
    if blocks:
        payload["blocks"] = blocks

    try:
        resp = requests.post(url, json=payload, timeout=10)
        if resp.status_code == 200 and resp.text == "ok":
            return True
        print(f"[Slack] Unexpected response {resp.status_code}: {resp.text}")
        return False
    except requests.RequestException as e:
        print(f"[Slack] Request failed: {e}")
        return False


def send_budget_alert(
    budget_name: str,
    threshold_pct: int,
    current_spend: float,
    budget_amount: float,
    period: str = "monthly",
    provider: str = "all",
    webhook_url: str = "",
) -> bool:
    """
    Send a formatted budget alert to Slack.
    """
    severity = _severity(threshold_pct)
    color = _COLORS[severity]
    pct_used = round(current_spend / budget_amount * 100, 1) if budget_amount else 0
    remaining = max(0, budget_amount - current_spend)
    emoji = ":rotating_light:" if severity == "critical" else ":warning:" if severity == "warning" else ":bell:"

    provider_label = provider.upper() if provider != "all" else "All Clouds"
    period_label = period.capitalize()

    header_text = f"{emoji} Budget Alert: {budget_name}"
    summary = (
        f"*{pct_used}%* of your {period_label} budget has been consumed "
        f"(threshold: {threshold_pct}%)"
    )

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": header_text, "emoji": True},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": summary},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Provider*\n{provider_label}"},
                {"type": "mrkdwn", "text": f"*Period*\n{period_label}"},
                {"type": "mrkdwn", "text": f"*Current Spend*\n${current_spend:,.2f}"},
                {"type": "mrkdwn", "text": f"*Budget*\n${budget_amount:,.2f}"},
                {"type": "mrkdwn", "text": f"*Remaining*\n${remaining:,.2f}"},
                {"type": "mrkdwn", "text": f"*Triggered*\n{datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"},
            ],
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": (
                        f":chart_with_upwards_trend: "
                        f"{'Over budget!' if pct_used >= 100 else f'Projected overage if trend continues.'}"
                    ),
                }
            ],
        },
    ]

    fallback_text = (
        f"[Budget Alert] {budget_name}: ${current_spend:,.2f} / ${budget_amount:,.2f} "
        f"({pct_used}% used, threshold {threshold_pct}%)"
    )

    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        print("[Slack] No webhook URL configured — budget alert not sent to Slack.")
        return False

    return send_slack_message(fallback_text, blocks=blocks, webhook_url=url)


def send_data_freshness_alert(
    provider: str,
    lag_days: int,
    expected_lag_hrs: int,
    webhook_url: str = "",
) -> bool:
    """Alert when a cloud provider's billing data is stale beyond its expected lag."""
    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        return False

    text = (
        f":hourglass_flowing_sand: *Stale Data Alert* — {provider.upper()} billing data "
        f"is {lag_days} day(s) old (expected: ≤{expected_lag_hrs}h). "
        "Check sync status."
    )
    blocks = [
        {"type": "section", "text": {"type": "mrkdwn", "text": text}},
        {"type": "context", "elements": [
            {"type": "mrkdwn",
             "text": f"Cloud cost analyzer | {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"}
        ]},
    ]
    return send_slack_message(text, blocks=blocks, webhook_url=url)


def send_sync_summary(
    provider: str,
    records_synced: int,
    date_from: str,
    date_to: str,
    error: str = "",
    webhook_url: str = "",
) -> bool:
    """Optional: post a sync-complete summary to Slack."""
    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        return False

    if error:
        emoji, status = ":x:", f"FAILED — {error}"
    else:
        emoji, status = ":white_check_mark:", f"OK — {records_synced} records ingested"

    text = (
        f"{emoji} *{provider.upper()} Sync*: {status} "
        f"({date_from} → {date_to})"
    )
    return send_slack_message(text, webhook_url=url)


def test_webhook(webhook_url: str = "") -> bool:
    """Send a test ping to confirm the webhook is reachable."""
    url = webhook_url or SLACK_WEBHOOK_URL
    if not url:
        return False
    return send_slack_message(
        ":wave: Cloud Cost Analyzer — Slack notifications are configured correctly.",
        webhook_url=url,
    )
