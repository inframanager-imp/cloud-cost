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
        """All team members' spend (handles pagination). Returns (members, cycle_start_ms)."""
        members, page, total_pages, cycle_start = [], 1, 1, None
        while page <= total_pages:
            r = requests.post(f"{CURSOR_BASE}/teams/spend", auth=self.auth,
                              json={"page": page, "pageSize": 100}, timeout=30)
            if r.status_code != 200:
                raise RuntimeError(f"Cursor spend fetch failed [{r.status_code}]: {r.text[:200]}")
            data = r.json()
            members.extend(data.get("teamMemberSpend", []))
            total_pages = data.get("totalPages") or 1
            cycle_start = data.get("subscriptionCycleStart") or cycle_start
            page += 1
        return members, cycle_start

    def fetch_usage_events(self, start_ms, end_ms, max_pages=40):
        """Granular per-event usage for the window (paginated)."""
        events, page = [], 1
        while page <= max_pages:
            r = requests.post(f"{CURSOR_BASE}/teams/filtered-usage-events", auth=self.auth,
                              json={"startDate": int(start_ms), "endDate": int(end_ms),
                                    "page": page, "pageSize": 250}, timeout=45)
            if r.status_code != 200:
                raise RuntimeError(f"Cursor usage-events fetch failed [{r.status_code}]: {r.text[:200]}")
            data = r.json()
            events.extend(data.get("usageEvents", []))
            if not data.get("pagination", {}).get("hasNextPage"):
                break
            page += 1
        return events


def _user_cost(m):
    """Billable cost (USD) for a member = ON-DEMAND spend only (spendCents).
    Included/plan usage (includedSpendCents) is covered by the seat subscription,
    so it is tracked separately for showback, not counted as cost."""
    return round(float(m.get("spendCents") or 0) / 100.0, 2)


def sync_cursor(tenant_id):
    """Fetch Cursor team spend, persist per-user rows, mirror into cost_data, and
    return {total, members}. Raises if no key or the API rejects it."""
    s = get_integration_settings(tenant_id or 1)
    key = (s.get("cursor_api_key") or "").strip()
    if not key:
        raise RuntimeError("No Cursor API key configured")

    client = CursorClient(key)
    members, cycle_start = client.fetch_spend()
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

        # ── Usage events → aggregate per (user, model): included vs on-demand ──
        events_n = 0
        try:
            start_ms = int(cycle_start) if cycle_start else int((now.replace(day=1)).timestamp() * 1000)
            end_ms = int(now.timestamp() * 1000)
            events = client.fetch_usage_events(start_ms, end_ms)
            events_n = len(events)
            agg = {}  # (email, model) -> {included, on_demand, tokens, events}
            for e in events:
                if not e.get("isChargeable"):
                    continue
                email = e.get("userEmail") or "unknown"
                model = e.get("model") or "unknown"
                kind = (e.get("kind") or "")
                cents = float(e.get("chargedCents") or 0)
                tu = e.get("tokenUsage") or {}
                toks = int((tu.get("inputTokens") or 0) + (tu.get("outputTokens") or 0))
                a = agg.setdefault((email, model), {"included": 0.0, "on_demand": 0.0, "tokens": 0, "events": 0})
                if kind == "Usage-based":
                    a["on_demand"] += cents
                else:
                    a["included"] += cents
                a["tokens"] += toks
                a["events"] += 1
            conn.execute("DELETE FROM cursor_usage WHERE tenant_id IS ?", (tenant_id,))
            conn.executemany(
                "INSERT INTO cursor_usage(tenant_id,email,model,included_cents,on_demand_cents,tokens,events,synced_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                [(tenant_id, em, mo, v["included"], v["on_demand"], v["tokens"], v["events"], now.isoformat())
                 for (em, mo), v in agg.items()],
            )
        except Exception as ue:
            print(f"[Cursor] usage-events aggregation failed (non-fatal): {ue}")

        conn.commit()
    finally:
        conn.close()
    return {"total": round(total, 2), "members": len(members), "events": events_n}
