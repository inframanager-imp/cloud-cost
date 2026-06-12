import os
import json
import time
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

TENANT_ID = os.getenv("AZURE_TENANT_ID")
CLIENT_ID = os.getenv("AZURE_CLIENT_ID")
CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET")
DEFAULT_SUBSCRIPTION_ID = os.getenv("AZURE_SUBSCRIPTION_ID", "")

_token_cache = {"token": None, "expires": 0}
_graph_token_cache = {"token": None, "expires": 0}
_caller_name_cache = {}


def get_access_token():
    global _token_cache
    if _token_cache["token"] and time.time() < _token_cache["expires"]:
        return _token_cache["token"]

    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "https://management.azure.com/.default"
    }
    resp = requests.post(url, data=data)
    resp.raise_for_status()
    result = resp.json()
    _token_cache["token"] = result["access_token"]
    _token_cache["expires"] = time.time() + result.get("expires_in", 3600) - 60
    return _token_cache["token"]


_custom_token_cache = {}


def get_access_token_for(tenant_id, client_id, client_secret):
    """Get an access token using a per-provider (customer-supplied) service principal."""
    cache_key = f"{tenant_id}:{client_id}"
    cached = _custom_token_cache.get(cache_key)
    if cached and time.time() < cached["expires"]:
        return cached["token"]

    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "https://management.azure.com/.default"
    }
    resp = requests.post(url, data=data, timeout=15)
    resp.raise_for_status()
    result = resp.json()
    _custom_token_cache[cache_key] = {
        "token": result["access_token"],
        "expires": time.time() + result.get("expires_in", 3600) - 60,
    }
    return _custom_token_cache[cache_key]["token"]


def _get_graph_token():
    global _graph_token_cache
    if _graph_token_cache["token"] and time.time() < _graph_token_cache["expires"]:
        return _graph_token_cache["token"]

    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default"
    }
    try:
        resp = requests.post(url, data=data, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        _graph_token_cache["token"] = result["access_token"]
        _graph_token_cache["expires"] = time.time() + result.get("expires_in", 3600) - 60
        return _graph_token_cache["token"]
    except Exception as e:
        print(f"  [Graph] Failed to get token: {e}")
        return None


def resolve_caller_names(caller_ids):
    """Resolve caller IDs: try Graph API first, fall back to clean labeling."""
    global _caller_name_cache
    result = {}

    unknown_ids = []
    for cid in caller_ids:
        if cid in _caller_name_cache:
            result[cid] = _caller_name_cache[cid]
        elif "@" in cid:
            result[cid] = cid
            _caller_name_cache[cid] = cid
        else:
            unknown_ids.append(cid)

    if not unknown_ids:
        return result

    # Try Graph API batch resolve (requires Directory.Read.All permission)
    token = _get_graph_token()
    if token:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        try:
            resp = requests.post(
                "https://graph.microsoft.com/v1.0/directoryObjects/getByIds",
                headers=headers,
                json={"ids": unknown_ids[:100], "types": ["user", "servicePrincipal", "application"]},
                timeout=15
            )
            if resp.status_code == 200:
                for obj in resp.json().get("value", []):
                    oid = obj.get("id", "")
                    display = obj.get("displayName") or obj.get("userPrincipalName") or oid
                    obj_type = obj.get("@odata.type", "")
                    if "servicePrincipal" in obj_type:
                        display = f"{display} (SP)"
                    result[oid] = display
                    _caller_name_cache[oid] = display
                print(f"  [Graph] Resolved {len(resp.json().get('value', []))} names")
            else:
                print(f"  [Graph] Batch resolve: {resp.status_code} (may need Directory.Read.All permission)")
        except Exception as e:
            print(f"  [Graph] Error: {e}")

    # Fallback: label remaining unknowns as Service Principals
    for cid in unknown_ids:
        if cid not in result:
            if cid.startswith("Microsoft."):
                result[cid] = cid
            else:
                result[cid] = f"Service Principal ({cid[:8]})"
            _caller_name_cache[cid] = result[cid]

    return result


def _parse_resource_display(resource_id):
    """Extract a clean resource type and name from Azure resource ID."""
    if not resource_id:
        return "", ""
    parts = resource_id.strip("/").split("/")
    res_name = parts[-1] if parts else ""

    # Extract resource type: find providers/Microsoft.X/resourceType
    res_type_short = ""
    for i, p in enumerate(parts):
        if p.lower() == "providers" and i + 2 < len(parts):
            provider = parts[i + 1]
            rtype = parts[i + 2] if i + 2 < len(parts) else ""
            short_provider = provider.replace("Microsoft.", "")
            res_type_short = f"{short_provider}/{rtype}"
            # If there are nested types like .../servers/databases
            if i + 4 < len(parts) and parts[i + 3] not in ("", res_name):
                res_type_short += f"/{parts[i + 4]}" if i + 4 < len(parts) else ""
            break

    return res_type_short, res_name


def fetch_subscriptions():
    """Fetch all subscriptions accessible to the service principal."""
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}"}
    url = "https://management.azure.com/subscriptions?api-version=2022-12-01"
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        subs = []
        for s in resp.json().get("value", []):
            subs.append({
                "subscription_id": s["subscriptionId"],
                "name": s.get("displayName", s["subscriptionId"]),
                "state": s.get("state", "Unknown"),
            })
        return subs
    except Exception as e:
        print(f"  [Subscriptions] Error: {e}")
        if DEFAULT_SUBSCRIPTION_ID:
            return [{"subscription_id": DEFAULT_SUBSCRIPTION_ID, "name": "Default", "state": "Enabled"}]
        return []


def _api_post_with_retry(url, headers, body, max_retries=5):
    """POST request with retry on 429 (rate limit) and 503.
    Respects Azure's Retry-After header fully — never cap below what Azure says.
    """
    for attempt in range(max_retries):
        resp = requests.post(url, headers=headers, json=body, timeout=90)
        if resp.status_code == 429:
            # Respect Azure's Retry-After header — do not cap it
            retry_after = int(resp.headers.get("Retry-After", 60))
            retry_after = max(retry_after, 30)  # minimum 30s wait on 429
            print(f"  [Rate limited] Waiting {retry_after}s before retry {attempt+1}/{max_retries}...")
            time.sleep(retry_after)
            continue
        if resp.status_code == 503:
            print(f"  [Service unavailable] Waiting 15s before retry {attempt+1}/{max_retries}...")
            time.sleep(15)
            continue
        resp.raise_for_status()
        return resp
    resp.raise_for_status()
    return resp


def fetch_cost_data(date_from, date_to, granularity="Daily", subscription_id=None, credentials=None):
    """
    Fetch cost data from Azure Cost Management API.
    Uses multiple queries with 2 grouping dimensions each (Azure limit).
    Returns list of tuples ready for DB insertion.

    `credentials`, if provided, is a dict with tenant_id/client_id/client_secret
    for a customer-supplied service principal (used for per-tenant providers
    instead of the shared .env service principal).
    """
    sub_id = subscription_id or DEFAULT_SUBSCRIPTION_ID
    if credentials:
        token = get_access_token_for(
            credentials["tenant_id"], credentials["client_id"], credentials["client_secret"]
        )
    else:
        token = get_access_token()
    url = (
        f"https://management.azure.com/subscriptions/{sub_id}"
        f"/providers/Microsoft.CostManagement/query?api-version=2023-11-01"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    # Query 1: ResourceGroup + ServiceName
    body1 = _build_query_body(date_from, date_to, granularity, [
        {"type": "Dimension", "name": "ResourceGroup"},
        {"type": "Dimension", "name": "ServiceName"},
    ])

    # Query 2: ServiceName + ResourceId (actual resource names per service)
    body2 = _build_query_body(date_from, date_to, granularity, [
        {"type": "Dimension", "name": "ServiceName"},
        {"type": "Dimension", "name": "ResourceId"},
    ])

    print(f"  Fetching cost data (Query 1: ResourceGroup + Service)...")
    records_q1 = _fetch_all_pages(url, headers, body1)
    print(f"    -> {len(records_q1['rows'])} rows from query 1")

    # Wait 30s between Query 1 and Query 2 to avoid rate limiting
    time.sleep(30)

    print(f"  Fetching cost data (Query 2: ResourceGroup + ResourceId)...")
    try:
        records_q2 = _fetch_all_pages(url, headers, body2)
        print(f"    -> {len(records_q2['rows'])} rows from query 2")
    except Exception as e:
        # Query 2 failure (rate limit exhausted) is non-fatal
        # Return Query 1 results so we don't lose service-level data
        print(f"  [Query 2 failed, using Query 1 only] {e}")
        records_q2 = {"rows": [], "columns": records_q1.get("columns", [])}

    all_records = _merge_records(records_q1, records_q2, sub_id)
    return all_records


def fetch_azure_costs(provider, date_from, date_to, granularity="Daily"):
    """
    Fetch cost data for a per-tenant Azure cloud_providers row (self-service
    onboarding). Uses the customer's own service principal credentials stored
    in credentials_json instead of the shared .env service principal.
    """
    creds = json.loads(provider.get("credentials_json") or "{}")
    credentials = None
    if creds.get("tenant_id") and creds.get("client_id") and creds.get("client_secret"):
        credentials = creds
    sub_id = provider.get("provider_id")
    return fetch_cost_data(date_from, date_to, granularity=granularity, subscription_id=sub_id, credentials=credentials)


def _build_query_body(date_from, date_to, granularity, grouping):
    return {
        "type": "ActualCost",
        "timeframe": "Custom",
        "timePeriod": {
            "from": date_from,
            "to": date_to
        },
        "dataset": {
            "granularity": granularity,
            "aggregation": {
                "totalCost": {
                    "name": "Cost",
                    "function": "Sum"
                }
            },
            "grouping": grouping
        }
    }


def _fetch_all_pages(url, headers, body):
    """Fetch all pages of a cost query."""
    all_rows = []
    columns = []

    resp = _api_post_with_retry(url, headers, body)
    result = resp.json()
    properties = result.get("properties", result)
    columns = properties.get("columns", [])
    rows = properties.get("rows", [])
    all_rows.extend(rows)

    # Handle pagination
    next_link = properties.get("nextLink")
    while next_link:
        time.sleep(1)  # Be gentle with the API
        resp = _api_post_with_retry(next_link, headers, body)
        result = resp.json()
        properties = result.get("properties", result)
        rows = properties.get("rows", [])
        all_rows.extend(rows)
        next_link = properties.get("nextLink")

    return {"columns": columns, "rows": all_rows}


def _extract_resource_name(resource_id):
    """Extract a human-friendly resource name from an Azure ResourceId path."""
    if not resource_id:
        return ""
    parts = resource_id.strip("/").split("/")
    if len(parts) >= 2:
        return parts[-1]
    return resource_id


def _extract_resource_type(resource_id):
    """Extract resource type (e.g. 'virtualMachines') from Azure ResourceId."""
    if not resource_id:
        return ""
    parts = resource_id.strip("/").split("/")
    if len(parts) >= 4:
        return parts[-2]
    return ""


def _merge_records(q1_data, q2_data, subscription_id=None):
    """
    Produce DB-ready tuples from Q2 (resource-level), enriched with RG from Q1.
    Q1: Cost, ResourceGroup, ServiceName, UsageDate, Currency
    Q2: Cost, ServiceName, ResourceId, UsageDate, Currency

    We use Q2 as the primary source so each resource is its own row.
    Q1 provides the RG mapping via (date, service) -> RG.
    """
    sub_id = subscription_id or DEFAULT_SUBSCRIPTION_ID

    # Build RG lookup from Q1: (date, service) -> resource_group
    rg_map = {}
    if q1_data["rows"]:
        q1_cols = {col["name"].lower(): i for i, col in enumerate(q1_data["columns"])}
        for row in q1_data["rows"]:
            raw_date = row[q1_cols.get("usagedate", -1)] if "usagedate" in q1_cols else None
            date_val = _parse_date(raw_date)
            rg = row[q1_cols.get("resourcegroup", -1)] if "resourcegroup" in q1_cols else ""
            svc = row[q1_cols.get("servicename", -1)] if "servicename" in q1_cols else ""
            key = (date_val, svc)
            if key not in rg_map:
                rg_map[key] = rg

    records = []
    # Track which (date, service) combos appear in Q2 so we can supplement with Q1
    q2_service_dates = set()

    if q2_data["rows"]:
        q2_cols = {col["name"].lower(): i for i, col in enumerate(q2_data["columns"])}
        for row in q2_data["rows"]:
            cost_val = row[q2_cols.get("cost", 0)] if "cost" in q2_cols else 0
            currency = row[q2_cols.get("currency", -1)] if "currency" in q2_cols else "USD"
            raw_date = row[q2_cols.get("usagedate", -1)] if "usagedate" in q2_cols else None
            date_val = _parse_date(raw_date)
            service_name = row[q2_cols.get("servicename", -1)] if "servicename" in q2_cols else ""
            rid = row[q2_cols.get("resourceid", -1)] if "resourceid" in q2_cols else ""

            res_name = _extract_resource_name(rid)
            res_type = _extract_resource_type(rid)
            # Extract RG from ResourceId (most reliable), fallback to Q1 lookup
            resource_group = ""
            if rid:
                parts = rid.strip("/").split("/")
                try:
                    rg_idx = [p.lower() for p in parts].index("resourcegroups")
                    resource_group = parts[rg_idx + 1] if rg_idx + 1 < len(parts) else ""
                except ValueError:
                    pass
            if not resource_group:
                resource_group = rg_map.get((date_val, service_name), "")

            q2_service_dates.add((date_val, service_name))
            record = (
                date_val,
                resource_group,
                service_name,
                res_type,
                res_name if res_name else "",
                service_name,   # meter_category
                "",             # meter_subcategory
                round(cost_val, 6),
                currency if currency else "USD",
                sub_id,
                "",             # tags
                "azure",        # cloud_provider
            )
            records.append(record)

    # Supplement with Q1 rows for services that have no ResourceId in Q2
    # (e.g. Support charges, Marketplace fees, taxes — billed at account level)
    if q1_data["rows"]:
        q1_cols = {col["name"].lower(): i for i, col in enumerate(q1_data["columns"])}
        for row in q1_data["rows"]:
            cost_val = row[q1_cols.get("cost", 0)] if "cost" in q1_cols else 0
            if not cost_val or float(cost_val) == 0:
                continue
            currency = row[q1_cols.get("currency", -1)] if "currency" in q1_cols else "USD"
            raw_date = row[q1_cols.get("usagedate", -1)] if "usagedate" in q1_cols else None
            date_val = _parse_date(raw_date)
            rg = row[q1_cols.get("resourcegroup", -1)] if "resourcegroup" in q1_cols else ""
            svc = row[q1_cols.get("servicename", -1)] if "servicename" in q1_cols else ""
            # Only add if this service+date wasn't already captured by Q2
            if (date_val, svc) not in q2_service_dates:
                records.append((date_val, rg or "", svc, "", svc, svc, "",
                                round(float(cost_val), 6), currency if currency else "USD",
                                sub_id, "", "azure"))
                print(f"  [Supplement] Added Q1-only charge: {svc} ${cost_val} on {date_val}")

    return records


def _parse_date(raw_date):
    if raw_date is None:
        return datetime.utcnow().strftime("%Y-%m-%d")
    if isinstance(raw_date, int):
        date_str = str(raw_date)
        return f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    return str(raw_date)[:10]


def fetch_billing_account_costs(date_from, date_to):
    """
    Fetch costs at billing account scope to capture charges not visible at subscription level
    (e.g., Azure Support plans, Marketplace fees billed at account level).
    Requires 'Cost Management Reader' or 'Billing Account Reader' role on the billing account.

    Returns list of (date, rg, service, res_type, res_name, meter_cat, meter_sub,
                      cost, currency, subscription_id, tags) tuples ready for DB insertion.
    Only returns rows where the ServiceName has no subscription-level costs
    (i.e., truly billing-account-only charges).
    """
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Discover billing accounts
    try:
        r = requests.get(
            "https://management.azure.com/providers/Microsoft.Billing/billingAccounts?api-version=2020-05-01",
            headers=headers, timeout=15
        )
    except Exception as e:
        print(f"  [BillingAccount] Request failed: {e}")
        return [], []

    if r.status_code != 200:
        print(f"  [BillingAccount] Cannot list billing accounts ({r.status_code}) — "
              f"grant 'Cost Management Reader' on billing account to capture Support charges")
        return [], []

    accounts = r.json().get("value", [])
    if not accounts:
        print("  [BillingAccount] No billing accounts accessible with current credentials")
        return [], []

    billing_account_ids = []
    all_ba_rows = []

    for account in accounts:
        ba_id = account["name"]
        ba_name = account.get("properties", {}).get("displayName", ba_id)
        print(f"  [BillingAccount] Querying: {ba_name} ({ba_id})")

        url = (
            f"https://management.azure.com/providers/Microsoft.Billing/billingAccounts/{ba_id}"
            f"/providers/Microsoft.CostManagement/query?api-version=2023-11-01"
        )
        body = {
            "type": "ActualCost",
            "timeframe": "Custom",
            "timePeriod": {"from": date_from, "to": date_to},
            "dataset": {
                "granularity": "Monthly",
                "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
                "grouping": [{"type": "Dimension", "name": "ServiceName"}]
            }
        }
        try:
            r2 = requests.post(url, headers=headers, json=body, timeout=30)
        except Exception as e:
            print(f"  [BillingAccount] Query failed: {e}")
            continue

        if r2.status_code != 200:
            print(f"  [BillingAccount] Cost query failed: {r2.status_code} — {r2.text[:200]}")
            continue

        props = r2.json().get("properties", {})
        cols = {c["name"]: i for i, c in enumerate(props.get("columns", []))}
        rows = props.get("rows", [])
        print(f"  [BillingAccount] Got {len(rows)} service rows from billing account")

        for row in rows:
            cost = float(row[cols["Cost"]]) if "Cost" in cols else 0
            service = row[cols["ServiceName"]] if "ServiceName" in cols else ""
            currency = row[cols["Currency"]] if "Currency" in cols else "USD"
            if cost > 0:
                all_ba_rows.append({
                    "ba_id": ba_id,
                    "service_name": service,
                    "cost": cost,
                    "currency": currency,
                    "date_from": date_from,
                })
        billing_account_ids.append((ba_id, ba_name))

    return all_ba_rows, billing_account_ids


def filter_billing_only_charges(ba_rows, existing_sub_totals_by_service):
    """
    From billing account rows, return only charges for services that have
    NO corresponding subscription-level costs (truly billing-account-only charges).

    existing_sub_totals_by_service: dict of {service_name_lower: total_cost}
    """
    records = []
    for row in ba_rows:
        svc = row["service_name"]
        svc_lower = svc.lower()
        ba_cost = row["cost"]
        sub_cost = existing_sub_totals_by_service.get(svc_lower, 0)

        # Only add if this service has no subscription-level data at all
        if sub_cost == 0:
            # Use the billing account ID as the subscription_id (special marker)
            date_val = row["date_from"][:7] + "-01"  # e.g. "2026-02-01"
            records.append((
                date_val,
                "",       # resource_group
                svc,      # service_name
                "",       # res_type
                svc,      # res_name
                svc,      # meter_category
                "",       # meter_subcategory
                round(ba_cost, 6),
                row["currency"],
                row["ba_id"],  # subscription_id = billing account id
                "",       # tags
                "azure",  # cloud_provider
            ))
            print(f"  [BillingAccount] Supplementary charge: {svc} ${ba_cost:.2f}")

    return records


def fetch_resource_groups(subscription_id=None):
    """Fetch list of resource groups."""
    sub_id = subscription_id or DEFAULT_SUBSCRIPTION_ID
    token = get_access_token()
    url = (
        f"https://management.azure.com/subscriptions/{sub_id}"
        f"/resourcegroups?api-version=2022-09-01"
    )
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    rgs = resp.json().get("value", [])
    return [rg["name"] for rg in rgs]


def fetch_activity_logs(date_from, date_to, subscription_id=None):
    """Fetch activity logs from Azure Monitor Activity Log API."""
    sub_id = subscription_id or DEFAULT_SUBSCRIPTION_ID
    token = get_access_token()
    url = (
        f"https://management.azure.com/subscriptions/{sub_id}"
        f"/providers/Microsoft.Insights/eventtypes/management/values"
        f"?api-version=2015-04-01"
        f"&$filter=eventTimestamp ge '{date_from}T00:00:00Z'"
        f" and eventTimestamp le '{date_to}T23:59:59Z'"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    max_pages = 50
    all_records = []
    page = 0

    while url and page < max_pages:
        page += 1
        print(f"  Fetching activity logs page {page}...")

        for attempt in range(3):
            resp = requests.get(url, headers=headers, timeout=60)
            if resp.status_code == 429:
                retry_after = min(int(resp.headers.get("Retry-After", 10)), 15)
                print(f"    Rate limited, waiting {retry_after}s...")
                time.sleep(retry_after)
                continue
            break

        resp.raise_for_status()
        data = resp.json()
        events = data.get("value", [])

        for evt in events:
            resource_id = evt.get("resourceId", "")
            parts = resource_id.split("/") if resource_id else []

            rg = ""
            for i, p in enumerate(parts):
                if p.lower() == "resourcegroups" and i + 1 < len(parts):
                    rg = parts[i + 1]
                    break

            res_type = evt.get("resourceType", {})
            if isinstance(res_type, dict):
                res_type = res_type.get("value", "")

            res_name = parts[-1] if len(parts) > 1 else ""

            op = evt.get("operationName", {})
            if isinstance(op, dict):
                op_value = op.get("value", "")
                op_name = op.get("localizedValue", op_value)
            else:
                op_value = str(op)
                op_name = op_value

            status = evt.get("status", {})
            if isinstance(status, dict):
                status = status.get("value", "")

            level = evt.get("level")
            if isinstance(level, dict):
                level = level.get("localizedValue", "")

            category = evt.get("category", {})
            if isinstance(category, dict):
                category = category.get("value", "")

            desc = evt.get("description", "") or ""
            sub_status = evt.get("subStatus", {})
            if isinstance(sub_status, dict):
                sub_desc = sub_status.get("localizedValue", "")
                if sub_desc and not desc:
                    desc = sub_desc

            caller = evt.get("caller", "")
            claims = evt.get("claims", {})
            if isinstance(claims, dict) and caller and "@" not in caller and len(caller) > 8:
                display_name = claims.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "")
                upn = claims.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn", "")
                appid = claims.get("appid", "")
                if display_name:
                    _caller_name_cache[caller] = display_name
                elif upn:
                    _caller_name_cache[caller] = upn
                elif appid and caller not in _caller_name_cache:
                    _caller_name_cache[caller] = f"Service Principal ({appid[:8]}...)"

            record = (
                evt.get("eventDataId", ""),
                evt.get("eventTimestamp", ""),
                caller,
                op_value,
                op_name,
                rg,
                str(res_type),
                res_name,
                resource_id,
                str(status),
                str(level),
                str(category),
                desc[:500],
            )
            all_records.append(record)

        url = data.get("nextLink")
        if url:
            time.sleep(1)

    print(f"  Total activity events fetched: {len(all_records)}")
    return all_records


if __name__ == "__main__":
    print("Discovering subscriptions...")
    subs = fetch_subscriptions()
    for s in subs:
        print(f"  {s['subscription_id']} - {s['name']} ({s['state']})")

    to_date = datetime.utcnow().strftime("%Y-%m-%d")
    from_date = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%d")
    print(f"\nFetching costs from {from_date} to {to_date}...")
    records = fetch_cost_data(from_date, to_date)
    print(f"Fetched {len(records)} records total")
    for r in records[:5]:
        print(f"  Date={r[0]}, RG={r[1]}, Service={r[2]}, Cost=${r[7]}")
