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
from datetime import datetime, timedelta

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


def _cycle_start_for(dt, cycle_day):
    """The billing-cycle-start date (the cycle_day of the month) that dt falls in."""
    if dt.day >= cycle_day:
        return dt.replace(day=cycle_day, hour=0, minute=0, second=0, microsecond=0)
    y, m = (dt.year - 1, 12) if dt.month == 1 else (dt.year, dt.month - 1)
    return dt.replace(year=y, month=m, day=cycle_day, hour=0, minute=0, second=0, microsecond=0)


def backfill_cursor_history(tenant_id, cycles=12):
    """Backfill past billing cycles' on-demand cost from usage events. Writes one
    aggregate cost_data row per completed cycle (resource_type='Cycle'), dated at
    each cycle start. The current cycle is left to the per-member sync."""
    s = get_integration_settings(tenant_id or 1)
    key = (s.get("cursor_api_key") or "").strip()
    if not key:
        raise RuntimeError("No Cursor API key configured")
    client = CursorClient(key)
    _, cycle_start = client.fetch_spend()
    now = datetime.utcnow()
    cycle_day = (datetime.utcfromtimestamp(int(cycle_start) / 1000).day if cycle_start else 1)
    cur_cs = _cycle_start_for(now, cycle_day).strftime("%Y-%m-%d")

    start_ms = int((now - timedelta(days=cycles * 31)).timestamp() * 1000)
    end_ms = int(now.timestamp() * 1000)
    events = client.fetch_usage_events(start_ms, end_ms, max_pages=200)

    buckets = {}  # cycle_start_str -> {od, inc, events}
    for e in events:
        if not e.get("isChargeable"):
            continue
        ts = datetime.utcfromtimestamp(int(e["timestamp"]) / 1000)
        cs = _cycle_start_for(ts, cycle_day).strftime("%Y-%m-%d")
        if cs == cur_cs:
            continue  # current cycle = per-member rows
        b = buckets.setdefault(cs, {"od": 0.0, "inc": 0.0, "events": 0})
        cents = float(e.get("chargedCents") or 0)
        if (e.get("kind") or "") == "Usage-based":
            b["od"] += cents
        else:
            b["inc"] += cents
        b["events"] += 1

    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM cost_data WHERE cloud_provider='cursor' AND resource_type='Cycle' AND tenant_id IS ?",
            (tenant_id,),
        )
        rows = []
        for cs, b in buckets.items():
            tags = json.dumps({"includedCents": round(b["inc"], 2), "onDemandCents": round(b["od"], 2),
                               "events": b["events"], "cycleStart": cs})
            rows.append((cs, "", "Cursor", "Cycle", "On-demand (cycle)", "Usage", "",
                         round(b["od"] / 100.0, 2), "USD", "Cursor Team", tags, "cursor", tenant_id))
        if rows:
            conn.executemany(
                "INSERT INTO cost_data (date,resource_group,service_name,resource_type,resource_name,"
                "meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider,tenant_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows,
            )
        conn.commit()
    finally:
        conn.close()
    return {"cycles": len(buckets), "events": len(events)}


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
    # Cursor bills per billing cycle (e.g. 14th-14th), not per calendar month.
    # Stamp cost_data at the cycle-start date so it's truthful.
    if cycle_start:
        cycle_date = datetime.utcfromtimestamp(int(cycle_start) / 1000).strftime("%Y-%m-%d")
    else:
        cycle_date = now.strftime("%Y-%m-01")

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

        # Mirror into cost_data: one row per member, dated at the billing-cycle start.
        conn.execute(
            "DELETE FROM cost_data WHERE cloud_provider='cursor' AND tenant_id IS ?",
            (tenant_id,),
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
                cycle_date, m.get("role") or "", "Cursor", "Seat",
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
