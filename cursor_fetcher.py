"""
Cursor (Team plan) per-user cost fetcher.

Uses the Cursor Admin API (https://api.cursor.com, Basic auth: team API key as
username, empty password) to pull per-member spend, then mirrors it into
cursor_users + cost_data (cloud_provider='cursor').

Per-user "cost" = usage value the member consumed this billing cycle =
(spendCents + includedSpendCents) / 100. spendCents is overage beyond the plan;
includedSpendCents is usage covered by the subscription. Summing both gives the
true usage-based cost for showback, even when overage is zero.

The Cursor team API key is read from integration_settings.cursor_api_key
(tenant-scoped) — entered via Integrations -> Cursor -> Configure.
"""
import json
from datetime import datetime

import requests

from database import get_db, get_integration_settings

CURSOR_BASE = "https://api.cursor.com"


class CursorClient:
    def __init__(self, api_key):
        self.auth = (api_key, "")

    def fetch_spend(self):
        """All team members' spend (handles pagination). Returns list of dicts."""
        members, page, total_pages = [], 1, 1
        while page <= total_pages:
            r = requests.post(f"{CURSOR_BASE}/teams/spend", auth=self.auth,
                              json={"page": page, "pageSize": 100}, timeout=30)
            if r.status_code != 200:
                raise RuntimeError(f"Cursor spend fetch failed [{r.status_code}]: {r.text[:200]}")
            data = r.json()
            members.extend(data.get("teamMemberSpend", []))
            total_pages = data.get("totalPages") or 1
            page += 1
        return members


def _user_cost(m):
    """Usage-based cost (USD) for a member = (overage + included usage) / 100."""
    return round((float(m.get("spendCents") or 0) + float(m.get("includedSpendCents") or 0)) / 100.0, 2)


def sync_cursor(tenant_id):
    """Fetch Cursor team spend, persist per-user rows, mirror into cost_data, and
    return {total, members}. Raises if no key or the API rejects it."""
    s = get_integration_settings(tenant_id or 1)
    key = (s.get("cursor_api_key") or "").strip()
    if not key:
        raise RuntimeError("No Cursor API key configured")

    members = CursorClient(key).fetch_spend()
    now = datetime.utcnow()
    month_start = now.strftime("%Y-%m-01")

    conn = get_db()
    try:
        # Replace the per-user snapshot
        conn.execute("DELETE FROM cursor_users WHERE tenant_id IS ?", (tenant_id,))
        rows = []
        for m in members:
            rows.append((
                tenant_id, m.get("userId"), m.get("name"), m.get("email"), m.get("role"),
                float(m.get("spendCents") or 0), float(m.get("includedSpendCents") or 0),
                int(m.get("fastPremiumRequests") or 0), now.isoformat(),
            ))
        conn.executemany(
            "INSERT INTO cursor_users(tenant_id,user_id,name,email,role,spend_cents,included_cents,"
            "fast_premium_requests,synced_at) VALUES(?,?,?,?,?,?,?,?,?)", rows,
        )

        # Mirror into cost_data: one row per member for the current month.
        conn.execute(
            "DELETE FROM cost_data WHERE cloud_provider='cursor' AND date=? AND tenant_id IS ?",
            (month_start, tenant_id),
        )
        cost_rows, total = [], 0.0
        for m in members:
            cost = _user_cost(m)
            total += cost
            tags = json.dumps({
                "spendCents": m.get("spendCents"), "includedSpendCents": m.get("includedSpendCents"),
                "role": m.get("role"), "userId": m.get("userId"),
            })
            cost_rows.append((
                month_start, m.get("role") or "", "Cursor", "Seat",
                m.get("name") or m.get("email") or "Member",
                "Usage", "", cost, "USD", "Cursor Team", tags, "cursor", tenant_id,
            ))
        if cost_rows:
            conn.executemany(
                "INSERT INTO cost_data (date,resource_group,service_name,resource_type,resource_name,"
                "meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider,tenant_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", cost_rows,
            )
        conn.commit()
    finally:
        conn.close()
    return {"total": round(total, 2), "members": len(members)}
