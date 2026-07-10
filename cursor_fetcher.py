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

from database import get_db, get_integration_settings, _insert_replace_sql

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


def _sync_one_account(conn, tenant_id, acct_name, key, now):
    """Fetch + persist ONE Cursor team into the open connection. cost_data rows are
    tagged with the team's display name (subscription_id) so multiple teams stay
    separate. The caller clears prior tenant data and commits."""
    client = CursorClient(key)
    members, cycle_start = client.fetch_spend()
    # Cursor bills per billing cycle (e.g. 14th-14th), which can start in the PRIOR
    # calendar month. Members with no day-resolved on-demand events get a single
    # fallback row — stamp it within the CURRENT month (not the cycle start) so
    # low/zero-usage members still appear in monthly client reports.
    _cs = datetime.utcfromtimestamp(int(cycle_start) / 1000) if cycle_start else now.replace(day=1)
    _month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    cycle_date = max(_cs, _month_start).strftime("%Y-%m-%d")

    rows = [(
        tenant_id, acct_name, m.get("userId"), m.get("name"), m.get("email"), m.get("role"),
        float(m.get("spendCents") or 0), float(m.get("includedSpendCents") or 0),
        int(m.get("fastPremiumRequests") or 0), now.isoformat(),
    ) for m in members]
    conn.executemany(
        _insert_replace_sql(
            "cursor_users",
            ["tenant_id", "account", "user_id", "name", "email", "role", "spend_cents",
             "included_cents", "fast_premium_requests", "synced_at"],
            ("tenant_id", "user_id"),
        ), rows,
    )

    # Usage events (once) → daily on-demand split + per-(user,model) aggregation.
    events = []
    try:
        start_ms = int(cycle_start) if cycle_start else int((now.replace(day=1)).timestamp() * 1000)
        end_ms = int(now.timestamp() * 1000)
        events = client.fetch_usage_events(start_ms, end_ms)
    except Exception as ue:
        print(f"[Cursor] usage-events fetch failed for '{acct_name}' (non-fatal): {ue}")
    events_n = len(events)

    daily_od = {}  # email(lower) -> { 'YYYY-MM-DD': cents }
    for e in events:
        if not e.get("isChargeable") or (e.get("kind") or "") != "Usage-based":
            continue
        cents = float(e.get("chargedCents") or 0)
        ts = e.get("timestamp")
        if cents <= 0 or not ts:
            continue
        email = (e.get("userEmail") or "").lower()
        day = datetime.utcfromtimestamp(int(ts) / 1000).strftime("%Y-%m-%d")
        daily_od.setdefault(email, {})
        daily_od[email][day] = daily_od[email].get(day, 0.0) + cents

    cost_rows, total = [], 0.0
    for m in members:
        cost = _user_cost(m)  # authoritative on-demand (USD)
        total += cost
        email = (m.get("email") or "").lower()
        name = m.get("name") or m.get("email") or "Member"
        role = m.get("role") or ""
        tags = json.dumps({
            "spendCents": m.get("spendCents"), "includedSpendCents": m.get("includedSpendCents"),
            "role": m.get("role"), "userId": m.get("userId"), "account": acct_name,
        })
        days = daily_od.get(email, {})
        weight = sum(days.values())
        if cost > 0 and weight > 0:
            items = sorted(days.items())
            acc = 0.0
            for i, (day, cents) in enumerate(items):
                if i < len(items) - 1:
                    c = round(cost * (cents / weight), 2)
                else:
                    c = round(cost - acc, 2)
                    if c < 0:
                        c = 0.0
                acc = round(acc + c, 2)
                cost_rows.append((day, role, "Cursor", "Seat", name, "Usage", "", c,
                                  "USD", acct_name, tags, "cursor", tenant_id))
        else:
            cost_rows.append((cycle_date, role, "Cursor", "Seat", name, "Usage", "", cost,
                              "USD", acct_name, tags, "cursor", tenant_id))
    if cost_rows:
        conn.executemany(
            "INSERT INTO cost_data (date,resource_group,service_name,resource_type,resource_name,"
            "meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider,tenant_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", cost_rows,
        )

    try:
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
        conn.executemany(
            _insert_replace_sql(
                "cursor_usage",
                ["tenant_id", "account", "email", "model", "included_cents", "on_demand_cents", "tokens", "events", "synced_at"],
                ("tenant_id", "email", "model"),
            ),
            [(tenant_id, acct_name, em, mo, v["included"], v["on_demand"], v["tokens"], v["events"], now.isoformat())
             for (em, mo), v in agg.items()],
        )
    except Exception as ue:
        print(f"[Cursor] usage aggregation failed for '{acct_name}' (non-fatal): {ue}")

    return total, len(members), events_n


def sync_cursor(tenant_id):
    """Fetch ALL configured Cursor teams → cursor_users + cost_data (each team's
    cost tagged with its display name). Returns {total, members, events, accounts}.
    Raises if no account is configured or every account fails."""
    s = get_integration_settings(tenant_id or 1)
    accounts = s.get("cursor_accounts") or []
    if not accounts:
        raise RuntimeError("No Cursor API key configured")
    now = datetime.utcnow()
    conn = get_db()
    grand_total = grand_members = grand_events = 0
    errors = []
    try:
        # Clear the tenant's Cursor data once, then re-write per account.
        conn.execute("DELETE FROM cursor_users WHERE tenant_id IS ?", (tenant_id,))
        conn.execute("DELETE FROM cursor_usage WHERE tenant_id IS ?", (tenant_id,))
        conn.execute("DELETE FROM cost_data WHERE cloud_provider='cursor' AND tenant_id IS ?", (tenant_id,))
        for acct in accounts:
            try:
                t, mem, ev = _sync_one_account(conn, tenant_id, acct["name"], acct["api_key"], now)
                grand_total += t; grand_members += mem; grand_events += ev
            except Exception as ae:
                errors.append(f"{acct.get('name')}: {ae}")
                print(f"[Cursor] account '{acct.get('name')}' sync failed: {ae}")
        conn.commit()
    finally:
        conn.close()
    if errors and grand_members == 0:
        raise RuntimeError("; ".join(errors))
    return {"total": round(grand_total, 2), "members": grand_members,
            "events": grand_events, "accounts": len(accounts), "errors": errors}
