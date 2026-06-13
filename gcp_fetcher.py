"""
GCP Cloud Billing ingestion via the Cloud Billing Budget / BigQuery Export REST APIs.

Two modes:
  A) BigQuery export (recommended for production):
       credentials_json = {
           "mode": "bigquery",
           "project_id": "my-billing-project",
           "dataset": "my_billing_dataset",

           # Standard export table:
           "table": "gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX",

           # Detailed export table (auto-detected by 'resource' in name):
           "table": "gcp_billing_export_resource_v1_XXXXXX_XXXXXX_XXXXXX",

           "service_account_json": { ... }   # or omit to use ADC
       }

       Detailed export differences vs standard:
         - Net cost = cost + credits (credits array is summed automatically)
         - rounding_error rows are excluded
         - Uses _PARTITIONTIME for efficient partition pruning
         - resource.name / resource.global_name resolved with COALESCE

  B) Cloud Billing API (summary only, no line-item detail):
       credentials_json = {
           "mode": "billing_api",
           "billing_account_id": "XXXXXX-XXXXXX-XXXXXX",
           "service_account_json": { ... }
       }

  If google-cloud-bigquery / google-auth are not installed the fetcher raises
  ImportError with an install hint.

Billing lag: GCP typically delays billing data by 24-72 hours.
"""

import json
import os
from datetime import datetime, timedelta

BILLING_LAG_HOURS = 72
BILLING_LAG_NOTE = "GCP billing data lags up to 72 hours."


class GCPExportPending(Exception):
    """Raised when a GCP provider is connected but its BigQuery billing export
    isn't usable yet (no dataset/table configured, or the export table hasn't
    been created/populated). This is a *pending* state, not a real failure."""
    pass


def _build_credentials(service_account_json: dict):
    """Build google.oauth2 service account credentials from a dict."""
    try:
        from google.oauth2 import service_account
    except ImportError:
        raise ImportError(
            "google-auth is not installed. Run: pip install google-auth google-auth-httplib2"
        )
    scopes = [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/bigquery.readonly",
    ]
    return service_account.Credentials.from_service_account_info(
        service_account_json, scopes=scopes
    )


# ─── Mode A: BigQuery export ──────────────────────────────────────────────────

def _fetch_via_bigquery(credentials_cfg: dict, date_from: str, date_to: str, project_id: str) -> list:
    # Check configuration first — a connected provider with no dataset/table is
    # "pending" (export not set up yet), not a failure. Do this before touching
    # google libs or creating a client.
    dataset = (credentials_cfg.get("dataset") or "").strip()
    table = (credentials_cfg.get("table") or "").strip()
    if not dataset or not table:
        raise GCPExportPending(
            "BigQuery billing export not configured yet — set the dataset and "
            "table once Billing export to BigQuery is enabled."
        )

    try:
        from google.cloud import bigquery
    except ImportError:
        raise ImportError(
            "google-cloud-bigquery is not installed. Run: pip install google-cloud-bigquery"
        )

    bq_project = credentials_cfg.get("project_id", project_id)
    sa_json = credentials_cfg.get("service_account_json")
    if sa_json:
        creds = _build_credentials(sa_json)
        client = bigquery.Client(project=bq_project, credentials=creds)
    else:
        client = bigquery.Client(project=bq_project)

    full_table = f"`{bq_project}.{dataset}.{table}`"

    # Detailed export tables contain 'resource' in the name:
    # gcp_billing_export_resource_v1_XXXXXX_XXXXXX_XXXXXX
    is_detailed = "resource" in table.lower()

    if is_detailed:
        # Net cost = cost + credits (credits.amount values are negative = savings).
        # Partition scan is widened by +4 days beyond date_to because GCP billing
        # data for a given usage day can arrive in BigQuery up to 72-96 hours later.
        # usage_start_time filter ensures we only return rows for the requested range.
        query = f"""
            SELECT
              DATE(usage_start_time)                                     AS date,
              service.description                                        AS service_name,
              sku.description                                            AS meter_subcategory,
              COALESCE(resource.name, resource.global_name, '')         AS resource_name,
              project.id                                                 AS linked_project,
              SUM(cost) + SUM(IFNULL(
                (SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0
              ))                                                         AS total_cost,
              currency
            FROM {full_table}
            WHERE DATE(_PARTITIONTIME) BETWEEN '{date_from}'
                AND DATE_ADD('{date_to}', INTERVAL 4 DAY)
              AND DATE(usage_start_time) BETWEEN '{date_from}' AND '{date_to}'
              AND cost_type != 'rounding_error'
            GROUP BY 1,2,3,4,5,7
            HAVING SUM(cost) + SUM(IFNULL(
              (SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0
            )) > 0
            ORDER BY 1
        """
    else:
        query = f"""
            SELECT
              DATE(usage_start_time)  AS date,
              service.description     AS service_name,
              sku.description         AS meter_subcategory,
              resource.name           AS resource_name,
              project.id              AS linked_project,
              SUM(cost)               AS total_cost,
              currency
            FROM {full_table}
            WHERE DATE(usage_start_time) BETWEEN '{date_from}' AND '{date_to}'
              AND cost > 0
            GROUP BY 1,2,3,4,5,7
            ORDER BY 1
        """

    print(f"[GCP] Running {'detailed' if is_detailed else 'standard'} export query "
          f"on {full_table} ({date_from} → {date_to})")

    records = []
    try:
        query_rows = list(client.query(query))
    except Exception as e:
        msg = str(e)
        # Table not created/populated yet, or query references a missing table —
        # this is the normal state right after enabling Billing export to BigQuery.
        if any(s in msg.lower() for s in ("not found", "was not found", "must be qualified")):
            raise GCPExportPending(
                "Waiting for BigQuery billing export data — the export table "
                "isn't available yet (can take a few hours after enabling)."
            )
        raise
    for row in query_rows:
        project = row.linked_project or None
        records.append((
            str(row.date),
            project,           # resource_group = project ID (shows in Project column)
            row.service_name,
            None,
            row.resource_name,
            row.service_name,
            row.meter_subcategory,
            round(float(row.total_cost), 6),
            row.currency or "USD",
            project,           # subscription_id = project ID (for subscription filter)
            None,
            "gcp",
        ))
    return records


# ─── Mode B: Cloud Billing API ────────────────────────────────────────────────

def _fetch_via_billing_api(credentials_cfg: dict, date_from: str, date_to: str) -> list:
    """
    Uses the Cloud Billing Budgets API to pull budget+spend info.
    Note: this gives budget-level aggregates, not daily line items.
    For real line-item data, BigQuery export (Mode A) is required.
    """
    import requests as _requests

    billing_account = credentials_cfg.get("billing_account_id", "")
    sa_json = credentials_cfg.get("service_account_json")

    if sa_json:
        creds = _build_credentials(sa_json)
        creds.refresh(__import__("google.auth.transport.requests", fromlist=["Request"]).Request())
        token = creds.token
    else:
        # Try ADC via metadata server
        resp = _requests.get(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
            timeout=5,
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]

    headers = {"Authorization": f"Bearer {token}"}
    url = (f"https://cloudbilling.googleapis.com/v1/billingAccounts/"
           f"{billing_account}/budgets")
    resp = _requests.get(url, headers=headers, timeout=15)
    resp.raise_for_status()
    budgets = resp.json().get("budgets", [])

    # Return placeholder records (billing API gives budget metadata, not cost rows)
    # Production setups should use BigQuery export for real cost rows.
    print(f"[GCP] Billing API returned {len(budgets)} budget(s). "
          "Use BigQuery export mode for line-item cost data.")
    return []


# ─── Public interface ─────────────────────────────────────────────────────────

def fetch_gcp_costs(provider_record: dict, date_from: str, date_to: str) -> list:
    """
    Fetch daily costs from GCP and return standardised cost_data tuples.
    """
    credentials_cfg = provider_record.get("credentials_json", {})
    if isinstance(credentials_cfg, str):
        try:
            credentials_cfg = json.loads(credentials_cfg)
        except Exception:
            credentials_cfg = {}

    project_id = provider_record.get("provider_id", "")
    mode = credentials_cfg.get("mode", "bigquery")

    if mode == "bigquery":
        records = _fetch_via_bigquery(credentials_cfg, date_from, date_to, project_id)
    elif mode == "billing_api":
        records = _fetch_via_billing_api(credentials_cfg, date_from, date_to)
    else:
        raise ValueError(f"Unknown GCP mode '{mode}'. Use 'bigquery' or 'billing_api'.")

    print(f"[GCP] Fetched {len(records)} records for project {project_id} "
          f"({date_from} → {date_to})")
    return records


def fetch_gcp_projects(credentials_cfg: dict) -> list:
    """List GCP projects accessible with the given service account."""
    import requests as _requests

    if isinstance(credentials_cfg, str):
        try:
            credentials_cfg = json.loads(credentials_cfg)
        except Exception:
            credentials_cfg = {}

    sa_json = credentials_cfg.get("service_account_json")
    if sa_json:
        creds = _build_credentials(sa_json)
        try:
            import google.auth.transport.requests as g_req
            creds.refresh(g_req.Request())
            token = creds.token
        except Exception as e:
            raise RuntimeError(f"[GCP] Token refresh failed: {e}")
    else:
        resp = _requests.get(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
            timeout=5,
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]

    headers = {"Authorization": f"Bearer {token}"}
    projects = []
    url = "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE"
    while url:
        resp = _requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        for p in data.get("projects", []):
            projects.append({
                "project_id": p["projectId"],
                "name": p.get("name", p["projectId"]),
                "project_number": p.get("projectNumber", ""),
            })
        next_token = data.get("nextPageToken")
        if next_token:
            base = "https://cloudresourcemanager.googleapis.com/v1/projects"
            url = f"{base}?filter=lifecycleState:ACTIVE&pageToken={next_token}"
        else:
            url = None
    return projects


def fetch_gcp_activity(provider_record: dict, days: int = 7) -> list:
    """
    Fetch GCP Admin Activity audit logs for the past N days via Cloud Logging API.
    Returns tuples: (event_id, timestamp, caller, operation, operation_name,
                     resource_group, resource_type, resource_name, resource_id,
                     status, level, category, description)
    """
    credentials_cfg = provider_record.get("credentials_json", {})
    if isinstance(credentials_cfg, str):
        try:
            credentials_cfg = json.loads(credentials_cfg)
        except Exception:
            credentials_cfg = {}

    project_id = provider_record.get("provider_id", "")
    sa_json = credentials_cfg.get("service_account_json")

    try:
        from google.cloud import logging as gcloud_logging
        from google.oauth2 import service_account as gcp_sa
    except ImportError:
        raise ImportError(
            "google-cloud-logging is not installed. Run: pip install google-cloud-logging"
        )

    if sa_json:
        creds = gcp_sa.Credentials.from_service_account_info(
            sa_json, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        client = gcloud_logging.Client(project=project_id, credentials=creds)
    else:
        client = gcloud_logging.Client(project=project_id)

    from datetime import timezone
    end_time = datetime.utcnow().replace(tzinfo=timezone.utc)
    start_time = end_time - timedelta(days=days)

    filter_str = (
        f'logName="projects/{project_id}/logs/cloudaudit.googleapis.com%2Factivity" '
        f'timestamp>="{start_time.isoformat()}" '
        f'timestamp<="{end_time.isoformat()}"'
    )

    records = []
    try:
        for entry in client.list_entries(filter_=filter_str, page_size=500):
            event_id = getattr(entry, "insert_id", "") or ""
            ts = getattr(entry, "timestamp", None)
            timestamp = ts.isoformat() if ts else ""

            payload = getattr(entry, "payload", {}) or {}
            method_name = ""
            caller = ""
            status = "Succeeded"
            description = ""
            resource_name_str = ""

            if isinstance(payload, dict):
                method_name = payload.get("methodName", "")
                caller = (payload.get("authenticationInfo") or {}).get("principalEmail", "")
                svc_status = payload.get("status") or {}
                if isinstance(svc_status, dict) and svc_status.get("code", 0) != 0:
                    status = "Failed"
                    description = svc_status.get("message", "")
                resource_name_str = payload.get("resourceName", "")
                description = description or payload.get("serviceName", "")

            resource = getattr(entry, "resource", None)
            resource_type = resource.type if resource else ""
            resource_labels = resource.labels if resource else {}
            resource_group = resource_labels.get("zone",
                resource_labels.get("region", resource_labels.get("location", "")))
            resource_name = (
                resource_labels.get("instance_id") or
                resource_labels.get("topic_id") or
                resource_labels.get("database_id") or
                (resource_name_str.split("/")[-1] if resource_name_str else "")
            )

            severity = str(getattr(entry, "severity", "INFO")).upper()
            if severity in ("ERROR", "CRITICAL", "ALERT", "EMERGENCY"):
                level = "Error"
                if status != "Failed":
                    status = "Failed"
            elif severity == "WARNING":
                level = "Warning"
            else:
                level = "Informational"

            records.append((
                event_id, timestamp, caller, method_name, method_name,
                resource_group, resource_type, resource_name, resource_name_str,
                status, level, "Administrative", description[:500]
            ))
    except Exception as e:
        print(f"[GCP Audit Log] Error for project {project_id}: {e}")

    print(f"[GCP Audit Log] Fetched {len(records)} events for project {project_id}")
    return records
