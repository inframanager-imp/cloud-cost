"""
AWS Cost and Usage Report (CUR) importer.
Supports both local .csv.gz files and S3 bucket fetching.

CUR column mapping:
  lineItem/UsageStartDate        → date
  product/ProductName            → service_name + meter_category
  lineItem/LineItemDescription   → meter_subcategory
  lineItem/ResourceId            → resource_name  (e.g. i-0abc1234 for EC2)
  product/instanceType           → resource_type
  lineItem/UnblendedCost         → cost
  lineItem/CurrencyCode          → currency
  lineItem/UsageAccountId        → subscription_id
  product/region                 → resource_group
  resourceTags/aws:cloudformation:stack-name → tags
"""

import io
import gzip
import json
import csv
import os
from datetime import datetime, timezone

try:
    import boto3
    from botocore.exceptions import ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False


# Actual CUR column names (case-insensitive match)
_COL_DATE        = "lineitem/usagestartdate"
_COL_ACCOUNT     = "lineitem/usageaccountid"
_COL_LINE_TYPE   = "lineitem/lineitemtype"
_COL_PRODUCT     = "product/productname"
_COL_PRODUCTCODE = "lineitem/productcode"
_COL_DESC        = "lineitem/lineitemdescription"
_COL_RESOURCE    = "lineitem/resourceid"
_COL_COST        = "lineitem/unblendedcost"
_COL_CURRENCY    = "lineitem/currencycode"
_COL_INST_TYPE   = "product/instancetype"
_COL_REGION      = "product/region"
_COL_USAGE_TYPE  = "lineitem/usagetype"
_COL_STACK_TAG   = "resourcetags/aws:cloudformation:stack-name"
_COL_CLUSTER_TAG = "resourcetags/aws:ecs:clustername"


def _s3_client(credentials: dict):
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed")
    role_arn = credentials.get("role_arn")
    sess_kwargs = dict(
        aws_access_key_id=credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        region_name=credentials.get("region", "us-east-1"),
    )
    if role_arn:
        import boto3 as _b3
        sts = _b3.client("sts", **sess_kwargs)
        assumed = sts.assume_role(RoleArn=role_arn, RoleSessionName="cur-importer")
        c = assumed["Credentials"]
        sess_kwargs = dict(
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
            region_name=credentials.get("region", "us-east-1"),
        )
    return boto3.client("s3", **sess_kwargs)


def list_cur_manifests(s3, bucket: str, prefix: str) -> list[dict]:
    """
    List all manifest JSON files under prefix.
    Returns list of {key, period} sorted newest-first.
    """
    manifests = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("Manifest.json") or key.endswith("-Manifest.json"):
                # Extract period from path e.g. .../20260401-20260501/...
                parts = key.split("/")
                period = next((p for p in parts if "-2026" in p or "202" in p and len(p) == 17), key)
                manifests.append({"key": key, "period": period, "last_modified": obj["LastModified"]})
    manifests.sort(key=lambda x: x["last_modified"], reverse=True)
    return manifests


def _parse_manifest(s3, bucket: str, manifest_key: str) -> list[str]:
    """Return list of S3 keys for the CSV gz files in this manifest."""
    obj = s3.get_object(Bucket=bucket, Key=manifest_key)
    manifest = json.loads(obj["Body"].read())
    report_keys = manifest.get("reportKeys", [])
    if not report_keys:
        # Some CUR formats use 'billingPeriod' + 'assemblyId' pattern
        assembly = manifest.get("assemblyId", "")
        prefix = "/".join(manifest_key.split("/")[:-1])
        report_keys = [f"{prefix}/{assembly}-{i:05d}.csv.gz"
                       for i in range(1, manifest.get("totalRecords", 1) + 1)]
    return report_keys


def _stream_csv_gz(s3, bucket: str, key: str):
    """Stream-decompress a .csv.gz from S3 and yield rows as dicts."""
    obj = s3.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    with gzip.open(io.BytesIO(raw), "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        reader.fieldnames = [h.lower().strip() for h in (reader.fieldnames or [])]
        for row in reader:
            yield {k.lower().strip(): v for k, v in row.items()}


def _stream_local_csv_gz(path: str):
    """Stream-decompress a local .csv.gz file and yield rows as dicts."""
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        reader.fieldnames = [h.lower().strip() for h in (reader.fieldnames or [])]
        for row in reader:
            yield {k.lower().strip(): v for k, v in row.items()}


def _safe_float(val: str) -> float:
    try:
        return float(val or 0)
    except (ValueError, TypeError):
        return 0.0


def _parse_date(val: str) -> str:
    """Return YYYY-MM-DD from ISO datetime string like 2026-04-01T00:00:00Z."""
    if not val:
        return ""
    return val[:10]


def _process_row(row: dict, account_id: str, date_from: str, date_to: str, seen: set):
    """Parse a single CUR row into a cost_data tuple. Returns None if row should be skipped."""
    line_type = row.get(_COL_LINE_TYPE, "")
    if line_type in ("Tax", "Credit", "Refund", "RIFee", "SavingsPlanRecurringFee"):
        return None

    cost = _safe_float(row.get(_COL_COST, "0"))
    if cost == 0:
        return None

    date_str = _parse_date(row.get(_COL_DATE, ""))
    if not date_str:
        return None
    if date_from and date_str < date_from:
        return None
    if date_to and date_str > date_to:
        return None

    acct = row.get(_COL_ACCOUNT, account_id or "")
    if account_id and acct and acct != account_id:
        return None

    service     = (row.get(_COL_PRODUCT) or row.get(_COL_PRODUCTCODE) or "Unknown").strip()
    description = (row.get(_COL_DESC, "") or "").strip()
    resource_id = (row.get(_COL_RESOURCE, "") or "").strip() or None
    inst_type   = (row.get(_COL_INST_TYPE, "") or "").strip() or None
    region      = (row.get(_COL_REGION, "") or "").strip() or None
    currency    = row.get(_COL_CURRENCY, "USD") or "USD"
    usage_type  = row.get(_COL_USAGE_TYPE, "") or ""

    # Use region as resource_group for AWS (meaningful grouping)
    rg = region or None

    # Derive resource_type and remap service_name based on resource pattern
    if resource_id:
        if resource_id.startswith("i-"):
            if not inst_type:
                inst_type = "EC2 Instance"
            service = "Amazon EC2"
        elif resource_id.startswith("vol-"):
            inst_type = "EBS Volume"
            service = "EBS Storage"
        elif "natgateway" in resource_id:
            inst_type = "NAT Gateway"
            service = "NAT Gateway"
        elif resource_id.startswith("arn:aws:elasticloadbalancing") or "loadbalancer" in resource_id.lower():
            inst_type = "Load Balancer"
            service = "Elastic Load Balancing"
        elif "network-interface" in resource_id:
            inst_type = "Network Interface"
            service = "Network Interface"
        elif ":rds:" in resource_id and ":db:" in resource_id:
            db_id = resource_id.split(":")[-1]
            if inst_type and inst_type.startswith("db."):
                service = "RDS Instances"
                # keep inst_type as db class
            elif "iops" in description.lower() or "storage" in description.lower() or "backup" in description.lower():
                inst_type = "RDS Storage"
                service = "RDS Storage"
            elif "data transfer" in description.lower():
                inst_type = "RDS Data Transfer"
                service = "RDS Data Transfer"
            else:
                service = "RDS Instances"
                inst_type = inst_type or "RDS Instance"
    # Snapshots (no resource_id, description contains snapshot)
    if not resource_id and "snapshot" in description.lower():
        inst_type = "Snapshot"
        service = "EBS Snapshots"

    # Build tags from stack/cluster tags
    stack = (row.get(_COL_STACK_TAG, "") or "").strip()
    cluster = (row.get(_COL_CLUSTER_TAG, "") or "").strip()
    tags = None
    if stack or cluster:
        import json as _json
        tags = _json.dumps({k: v for k, v in {"stack": stack, "cluster": cluster}.items() if v})

    # Deduplicate within import
    dedup_key = (date_str, acct, resource_id or usage_type, service)
    if dedup_key in seen:
        return None
    seen.add(dedup_key)

    return (
        date_str,
        rg,                                          # resource_group = AWS region
        service,                                     # service_name
        inst_type,                                   # resource_type (instance type)
        resource_id,                                 # resource_name = EC2 i-xxx, RDS arn etc.
        service,                                     # meter_category
        description[:200] if description else None,  # meter_subcategory
        round(cost, 6),
        currency,
        acct,                                        # subscription_id = AWS account ID
        tags,
        "aws",
    )


def parse_local_cur_files(
    file_paths: list[str],
    account_id: str = None,
    date_from: str = None,
    date_to: str = None,
) -> tuple[list, int]:
    """
    Parse local .csv.gz CUR files into cost_data records.
    Aggregates hourly rows into daily totals per (date, account, resource, service).
    Returns (records, skipped_count).
    """
    # Aggregation: key → (cost, meta)
    # key = (date, acct, resource_id_or_usage_type, service)
    agg = {}   # key → cost
    meta = {}  # key → (rg, service, inst_type, resource_id, desc, currency, acct, tags)
    skipped = 0

    for path in file_paths:
        print(f"[CUR] Parsing local file: {path}")
        row_count = 0
        for row in _stream_local_csv_gz(path):
            row_count += 1

            line_type = row.get(_COL_LINE_TYPE, "")
            if line_type in ("Tax", "Credit", "Refund", "RIFee", "SavingsPlanRecurringFee"):
                skipped += 1
                continue

            cost = _safe_float(row.get(_COL_COST, "0"))
            if cost == 0:
                skipped += 1
                continue

            date_str = _parse_date(row.get(_COL_DATE, ""))
            if not date_str:
                skipped += 1
                continue
            if date_from and date_str < date_from:
                skipped += 1
                continue
            if date_to and date_str > date_to:
                skipped += 1
                continue

            acct = row.get(_COL_ACCOUNT, account_id or "")
            if account_id and acct and acct != account_id:
                skipped += 1
                continue

            service     = (row.get(_COL_PRODUCT) or row.get(_COL_PRODUCTCODE) or "Unknown").strip()
            description = (row.get(_COL_DESC, "") or "").strip()
            resource_id = (row.get(_COL_RESOURCE, "") or "").strip() or None
            inst_type   = (row.get(_COL_INST_TYPE, "") or "").strip() or None
            region      = (row.get(_COL_REGION, "") or "").strip() or None
            currency    = row.get(_COL_CURRENCY, "USD") or "USD"
            usage_type  = row.get(_COL_USAGE_TYPE, "") or ""
            stack       = (row.get(_COL_STACK_TAG, "") or "").strip()
            cluster     = (row.get(_COL_CLUSTER_TAG, "") or "").strip()

            if resource_id:
                if resource_id.startswith("i-"):
                    if not inst_type:
                        inst_type = "EC2 Instance"
                    service = "Amazon EC2"
                elif resource_id.startswith("vol-"):
                    inst_type = "EBS Volume"
                    service = "EBS Storage"
                elif "natgateway" in resource_id:
                    inst_type = "NAT Gateway"
                    service = "NAT Gateway"
                elif resource_id.startswith("arn:aws:elasticloadbalancing") or "loadbalancer" in resource_id.lower():
                    inst_type = "Load Balancer"
                    service = "Elastic Load Balancing"
                elif "network-interface" in resource_id:
                    inst_type = "Network Interface"
                    service = "Network Interface"
                elif ":rds:" in resource_id and ":db:" in resource_id:
                    if inst_type and inst_type.startswith("db."):
                        service = "RDS Instances"
                    elif "iops" in description.lower() or "storage" in description.lower() or "backup" in description.lower():
                        inst_type = "RDS Storage"
                        service = "RDS Storage"
                    elif "data transfer" in description.lower():
                        inst_type = "RDS Data Transfer"
                        service = "RDS Data Transfer"
                    else:
                        service = "RDS Instances"
                        inst_type = inst_type or "RDS Instance"
            if not resource_id and "snapshot" in description.lower():
                inst_type = "Snapshot"
                service = "EBS Snapshots"

            tags = None
            if stack or cluster:
                import json as _json
                tags = _json.dumps({k: v for k, v in {"stack": stack, "cluster": cluster}.items() if v})

            # Aggregate key: one entry per day per (account + resource + service)
            agg_key = (date_str, acct, resource_id or usage_type, service)
            agg[agg_key] = agg.get(agg_key, 0.0) + cost
            if agg_key not in meta:
                meta[agg_key] = (region, service, inst_type, resource_id,
                                 description[:200] if description else None,
                                 currency, acct, tags)

        print(f"[CUR] {path}: {row_count} rows processed, {len(agg)} unique day-records so far")

    # Build final records list
    records = []
    for agg_key, total_cost in agg.items():
        date_str, acct, _, service = agg_key
        rg, svc, inst_type, resource_id, desc, currency, account, tags = meta[agg_key]
        records.append((
            date_str,
            rg,           # resource_group = AWS region
            svc,          # service_name
            inst_type,    # resource_type
            resource_id,  # resource_name (EC2 i-xxx etc.)
            svc,          # meter_category
            desc,         # meter_subcategory
            round(total_cost, 6),
            currency,
            account,      # subscription_id
            tags,
            "aws",        # cloud_provider
        ))

    print(f"[CUR] Total: {len(records)} daily records, {skipped} rows skipped")
    return records, skipped


def fetch_cur_records(
    credentials: dict,
    bucket: str,
    prefix: str,
    date_from: str = None,
    date_to: str = None,
    manifest_key: str = None,
    account_id: str = None,
) -> tuple[list, int]:
    """Download and parse CUR CSV files from S3."""
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed — run: pip install boto3")

    s3 = _s3_client(credentials)
    prefix = prefix.rstrip("/") + "/"

    if not manifest_key:
        manifests = list_cur_manifests(s3, bucket, prefix)
        if not manifests:
            raise ValueError(f"No CUR manifests found in s3://{bucket}/{prefix}")
        manifest_key = manifests[0]["key"]
        print(f"[CUR] Using manifest: {manifest_key}")

    csv_keys = _parse_manifest(s3, bucket, manifest_key)
    if not csv_keys:
        raise ValueError(f"Manifest {manifest_key} contains no CSV file references")

    print(f"[CUR] Manifest lists {len(csv_keys)} CSV file(s)")

    records = []
    skipped = 0
    seen = set()

    for csv_key in csv_keys:
        print(f"[CUR] Parsing s3://{bucket}/{csv_key} ...")
        row_count = 0
        for row in _stream_csv_gz(s3, bucket, csv_key):
            row_count += 1
            result = _process_row(row, account_id, date_from, date_to, seen)
            if result is None:
                skipped += 1
            else:
                records.append(result)
        print(f"[CUR] {csv_key}: {row_count} rows → {len(records)} kept so far")

    print(f"[CUR] Total: {len(records)} records, {skipped} skipped")
    return records, skipped


def get_available_manifests(credentials: dict, bucket: str, prefix: str) -> list[dict]:
    """Return list of available CUR billing periods from S3."""
    s3 = _s3_client(credentials)
    prefix = prefix.rstrip("/") + "/"
    manifests = list_cur_manifests(s3, bucket, prefix)
    result = []
    for m in manifests:
        result.append({
            "manifest_key": m["key"],
            "period": m["period"],
            "last_modified": m["last_modified"].isoformat() if hasattr(m["last_modified"], "isoformat") else str(m["last_modified"]),
        })
    return result


# ─── CloudFormation auto-connect CUR import ──────────────────────────────────

def import_from_s3_bucket(provider: dict, credentials: dict = None,
                          bucket: str = None, date_from: str = None,
                          date_to: str = None, tenant_id: int = None) -> dict:
    """
    High-level: assume cross-account role, list CUR manifests in the provider's
    cur_bucket, download + parse the latest month, insert into cost_data.

    provider: cloud_providers row dict (must have role_arn + external_id or keys)
    Returns: {"records": N, "skipped": N, "period": "..."}
    """
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed")

    # Build credentials from provider record
    if credentials is None:
        try:
            raw = provider.get("credentials_json") or "{}"
            credentials = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            credentials = {}

    # Prefer role_arn column over credentials_json
    if provider.get("role_arn"):
        credentials["role_arn"]   = provider["role_arn"]
    if provider.get("external_id"):
        credentials["external_id"] = provider["external_id"]

    # Determine bucket
    if not bucket:
        bucket = provider.get("cur_bucket", "")
    if not bucket:
        raise ValueError("No CUR bucket configured for this provider")

    # Determine prefix. Our one-click setup script delivers CUR under "cur/<report>",
    # but older/CloudFormation setups use "reports/<report>". Try the likely prefixes
    # and use whichever actually contains a manifest.
    report_name = provider.get("cur_report_name", "")
    stored_prefix = (provider.get("cur_report_prefix") or "").strip().strip("/")
    candidate_prefixes = []
    if stored_prefix and report_name:
        candidate_prefixes.append(f"{stored_prefix}/{report_name}")
    if stored_prefix:
        candidate_prefixes.append(stored_prefix)
    if report_name:
        candidate_prefixes += [f"cur/{report_name}", f"reports/{report_name}"]
    candidate_prefixes += ["cur", "reports", ""]
    # de-dupe preserving order
    candidate_prefixes = list(dict.fromkeys(candidate_prefixes))

    account_id = provider.get("provider_id", "")
    tid = tenant_id or provider.get("tenant_id", 1)

    # Default: current month
    now = datetime.utcnow()
    if not date_from:
        date_from = now.replace(day=1).strftime("%Y-%m-%d")
    if not date_to:
        date_to = now.strftime("%Y-%m-%d")

    records, skipped, used_prefix, last_err = [], 0, None, None
    for pfx in candidate_prefixes:
        print(f"[CUR] import_from_s3_bucket: trying s3://{bucket}/{pfx} for {account_id} ({date_from}→{date_to})")
        try:
            records, skipped = fetch_cur_records(
                credentials=credentials,
                bucket=bucket,
                prefix=pfx,
                date_from=date_from,
                date_to=date_to,
                account_id=account_id,
            )
            used_prefix = pfx
            break
        except ValueError as e:
            last_err = e  # no manifest under this prefix — try the next
            continue
    if used_prefix is None:
        raise last_err or ValueError(f"No CUR manifests found in s3://{bucket}")

    period = f"{date_from} to {date_to}"
    if not records:
        print(f"[CUR] No records found for {period}")
        return {"records": 0, "skipped": skipped, "period": period}

    # Stamp tenant_id on each record before inserting
    stamped = []
    for r in records:
        row_list = list(r)
        # schema: (date, rg, svc, rtype, rname, meter_cat, meter_sub, cost, currency, sub_id, tags, cloud_provider)
        # insert_cost_records_with_tenant expects tenant_id as 13th element
        stamped.append(tuple(row_list))

    from database import insert_cost_records, get_db
    conn = get_db()
    # Use executemany directly so we can inject tenant_id
    conn.executemany("""
        INSERT INTO cost_data
            (date, resource_group, service_name, resource_type, resource_name,
             meter_category, meter_subcategory, cost, currency, subscription_id,
             tags, cloud_provider, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, [r + (tid,) for r in stamped])
    conn.commit()
    inserted = len(stamped)
    conn.close()

    print(f"[CUR] Inserted {inserted} records for {account_id}, period {period}")
    return {"records": inserted, "skipped": skipped, "period": period}
