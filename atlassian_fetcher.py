"""
Atlassian (Jira / Confluence / JSM) cost fetcher.

Mirrors the other cloud fetchers (aws_fetcher / gcp_fetcher / azure_fetcher):
`fetch_atlassian_costs(provider, date_from, date_to)` returns a list of 12-column
cost_data tuples that the generic sync path inserts into cost_data.

Cost model
----------
Atlassian bills per active user per product, per month. So for each product the
customer subscribes to we:
  1. fetch all users from the Atlassian Admin API,
  2. count users that are `active` AND have access to that product,
  3. multiply by the cached per-user price for that product+plan.

Pricing is read from the local `atlassian_pricing` cache table (refreshed
out-of-band by atlassian_pricing_sync.py) — we never scrape on the sync path.

Credentials (provider.credentials_json):
  { "orgId": "...", "directoryId": "...", "accessToken": "...",
    "products": [ {"productName": "jira-software", "plan": "standard"}, ... ] }
"""
import json
import time
from collections import Counter
from datetime import datetime

import requests

from database import get_db

ATLASSIAN_BASE = "https://api.atlassian.com"

# Atlassian product keys → display names shown in the Product column.
PRODUCT_DISPLAY = {
    "jira-software":            "Jira Software",
    "jira-core":               "Jira Work Management",
    "jira-work-management":    "Jira Work Management",
    "jira-servicedesk":        "Jira Service Management",
    "jira-service-management": "Jira Service Management",
    "confluence":              "Confluence",
}


def _display(product_key: str) -> str:
    return PRODUCT_DISPLAY.get(product_key, product_key.replace("-", " ").title())


def _derive_status(u: dict) -> str:
    """Map Atlassian's raw user fields to the status shown in Atlassian Admin:
    active / suspended / deactivated / invited / for_deletion.

    The API's `status` field is only active/for_deletion; the rest are derived.
    The "invited" case can't be decided from the directory object alone (an
    invited user can have emailVerified true) — it's refined in the sync loop
    once we know whether the user has ever been active / holds a product seat.
      - suspended    : membershipStatus == suspended
      - deactivated  : accountStatus inactive/deactivated, or deactivatedOn set
      - invited      : email not verified (clearly never accepted)
    """
    if u.get("forDeletion") or (u.get("status") or "").lower() == "for_deletion":
        return "for_deletion"
    if (u.get("membershipStatus") or "").lower() == "suspended":
        return "suspended"
    if (u.get("accountStatus") or "").lower() in ("inactive", "deactivated") or u.get("deactivatedOn"):
        return "deactivated"
    if u.get("emailVerified") is False:
        return "invited"
    return "active"


# ─── Atlassian Admin API client ────────────────────────────────────────────────

class AtlassianClient:
    def __init__(self, org_id, directory_id, access_token):
        self.org_id       = org_id
        self.directory_id = directory_id
        self.headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept":        "application/json",
        }

    def _get(self, url, params=None, retries=3):
        """GET with simple 429/5xx backoff."""
        for attempt in range(retries):
            resp = requests.get(url, headers=self.headers, params=params, timeout=30)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", 5))
                time.sleep(min(wait, 30))
                continue
            if 500 <= resp.status_code < 600 and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return resp
        return resp

    def fetch_all_users(self):
        """Paginated directory fetch — returns ALL users of every status."""
        url    = (f"{ATLASSIAN_BASE}/admin/v2/orgs/{self.org_id}"
                  f"/directories/{self.directory_id}/users")
        params = {"limit": 100}
        users  = []
        while url:
            resp = self._get(url, params=params)
            if resp.status_code != 200:
                raise RuntimeError(f"Atlassian user fetch failed [{resp.status_code}]: {resp.text[:300]}")
            data  = resp.json()
            users.extend(data.get("data", []))
            next_url = data.get("links", {}).get("next")
            url, params = (next_url, None) if next_url else (None, None)
        return users

    def fetch_user_activity(self, account_id):
        """Returns (last_active_date_or_None, [product_key, ...]) for a user."""
        url  = (f"{ATLASSIAN_BASE}/admin/v1/orgs/{self.org_id}"
                f"/directory/users/{account_id}/last-active-dates")
        resp = self._get(url)
        if resp.status_code != 200:
            return None, []
        access       = resp.json().get("data", {}).get("product_access", [])
        product_keys = [p["key"] for p in access if p.get("key")]
        dates        = [p["last_active"] for p in access if p.get("last_active")]
        return (max(dates) if dates else None), product_keys


# ─── Pricing cache ─────────────────────────────────────────────────────────────

def get_cached_price(product_name: str, plan: str):
    """Per-user monthly price from the atlassian_pricing cache, or None."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT price_per_user, currency FROM atlassian_pricing "
            "WHERE product_name=? AND plan=? ORDER BY scraped_at DESC LIMIT 1",
            (product_name, (plan or "").lower()),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None, "USD"
    return row["price_per_user"], (row["currency"] or "USD")


# ─── User directory sync ────────────────────────────────────────────────────────

def sync_atlassian_users(client, org_id, tenant_id):
    """
    Fetch every user + their activity, persist to atlassian_users, and return
    (active_by_product Counter, [user_record, ...]). One activity call per user.
    """
    raw_users = client.fetch_all_users()
    active_by_product = Counter()
    records = []

    for u in raw_users:
        account_id = u.get("accountId")
        if not account_id:
            continue
        status = _derive_status(u)
        last_active, product_keys = client.fetch_user_activity(account_id)
        # Refine "invited": a user that has never been active and holds no product
        # seat hasn't accepted the invite (Atlassian shows "Invited"), even if the
        # email is verified. Users with a product seat or real activity stay active.
        if status == "active" and not last_active and not product_keys:
            status = "invited"
        if status == "active":
            for key in product_keys:
                active_by_product[key] += 1
        records.append({
            "account_id":        account_id,
            "name":              u.get("name"),
            "email":             u.get("email"),
            "status":            status,
            "membership_status": u.get("membershipStatus"),
            "last_active":       last_active,
            "products":          product_keys,
        })

    # Replace this org's user snapshot (fresh each sync).
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM atlassian_users WHERE tenant_id IS ? AND org_id=?",
            (tenant_id, org_id),
        )
        now = datetime.utcnow().isoformat()
        conn.executemany(
            "INSERT INTO atlassian_users(tenant_id,org_id,account_id,name,email,status,"
            "membership_status,last_active,products,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [(tenant_id, org_id, r["account_id"], r["name"], r["email"], r["status"],
              r["membership_status"], r["last_active"], json.dumps(r["products"]), now)
             for r in records],
        )
        conn.commit()
    finally:
        conn.close()
    return active_by_product, records


# ─── Main entry point (matches the other fetchers' signature) ───────────────────

def fetch_atlassian_costs(provider, date_from, date_to):
    """
    Build a current-month cost snapshot for one Atlassian org.

    Returns 12-column tuples:
      (date, resource_group, service_name, resource_type, resource_name,
       meter_category, meter_subcategory, cost, currency, subscription_id,
       tags, cloud_provider)
    `date` is the first of the current month so each sync overwrites that
    month's snapshot while older months are preserved (history).
    """
    creds = provider.get("credentials_json", {})
    if isinstance(creds, str):
        try:
            creds = json.loads(creds)
        except Exception:
            creds = {}

    org_id       = creds.get("orgId") or provider.get("provider_id")
    directory_id = creds.get("directoryId")
    access_token = creds.get("accessToken")
    products     = creds.get("products") or []
    if not (org_id and directory_id and access_token):
        raise RuntimeError("Atlassian provider missing orgId / directoryId / accessToken")
    if not products:
        raise RuntimeError("No products configured for this Atlassian org")

    client = AtlassianClient(org_id, directory_id, access_token)
    tenant_id = provider.get("tenant_id")

    # Fetch the full directory + per-user activity, persist users, and count
    # active users per product in one pass.
    active_by_product, _ = sync_atlassian_users(client, org_id, tenant_id)

    snapshot_date = datetime.utcnow().strftime("%Y-%m-01")
    rows = []
    for p in products:
        product_name = p.get("productName")
        plan         = (p.get("plan") or "standard").lower()
        if not product_name:
            continue
        active_count = active_by_product.get(product_name, 0)
        price, currency = get_cached_price(product_name, plan)
        price = price or 0.0
        cost  = round(active_count * price, 2)

        tags = json.dumps({
            "activeUsers":   active_count,
            "pricePerUser":  price,
            "plan":          plan,
            "pricedFromCache": price > 0,
        })
        rows.append((
            snapshot_date,                       # date
            plan.capitalize(),                   # resource_group  → "Plan" column
            _display(product_name),              # service_name    → "Product" column
            plan.capitalize(),                   # resource_type
            f"{active_count} active users",      # resource_name   → "Resource" column
            product_name,                        # meter_category
            "",                                  # meter_subcategory
            cost,                                # cost
            currency,                            # currency
            org_id,                              # subscription_id → "Organization" column
            tags,                                # tags
            "atlassian",                         # cloud_provider
        ))
    return rows
