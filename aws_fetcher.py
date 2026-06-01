"""
AWS Cost Explorer billing ingestion.

Credentials resolution order (per provider record):
  1. credentials_json from cloud_providers table:
       { "access_key_id": "...", "secret_access_key": "...", "region": "us-east-1" }
       or { "role_arn": "arn:aws:iam::...", "external_id": "..." }  (assume-role)
  2. Environment variables: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  3. IAM instance profile (boto3 default chain)
"""

import os
import json
from datetime import datetime, timedelta

try:
    import boto3
    from botocore.exceptions import ClientError, NoCredentialsError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False

# billing lag: AWS Cost Explorer data is typically 24-48 hrs behind
BILLING_LAG_HOURS = 48
BILLING_LAG_NOTE = "AWS billing data lags up to 48 hours."


def _get_ce_client(credentials: dict):
    """Return a boto3 Cost Explorer client using explicit or default credentials."""
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed. Run: pip install boto3")

    region = credentials.get("region", "us-east-1")
    role_arn = credentials.get("role_arn")

    if role_arn:
        # Assume cross-account role
        sts = boto3.client(
            "sts",
            aws_access_key_id=credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
            region_name=region,
        )
        assume_kwargs = {
            "RoleArn": role_arn,
            "RoleSessionName": "cloud-cost-analyzer",
        }
        # Support both credentials-dict key and provider-record key
        ext_id = credentials.get("external_id") or credentials.get("ExternalId") or ""
        if ext_id:
            assume_kwargs["ExternalId"] = ext_id
        assumed = sts.assume_role(**assume_kwargs)
        creds = assumed["Credentials"]
        return boto3.client(
            "ce",
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            region_name="us-east-1",  # Cost Explorer is global, endpoint in us-east-1
        )

    # Direct credentials or env / instance-profile fallback
    return boto3.client(
        "ce",
        aws_access_key_id=credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        region_name="us-east-1",
    )


def _fetch_service_level(client, date_from: str, end_exclusive: str, account_id: str) -> list:
    """Fetch daily costs grouped by SERVICE (always available)."""
    records = []
    paginator_token = None
    while True:
        kwargs = {
            "TimePeriod": {"Start": date_from, "End": end_exclusive},
            "Granularity": "DAILY",
            "Metrics": ["UnblendedCost"],
            "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
            "Filter": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [account_id]}},
        }
        if paginator_token:
            kwargs["NextPageToken"] = paginator_token
        resp = client.get_cost_and_usage(**kwargs)
        for result_by_time in resp.get("ResultsByTime", []):
            date_str = result_by_time["TimePeriod"]["Start"]
            for group in result_by_time.get("Groups", []):
                service = group.get("Keys", ["Unknown"])[0]
                amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
                currency = group["Metrics"]["UnblendedCost"]["Unit"]
                if amount == 0:
                    continue
                records.append((
                    date_str, None, service, None, None,
                    service, None, round(amount, 6), currency,
                    account_id, None, "aws",
                ))
        paginator_token = resp.get("NextPageToken")
        if not paginator_token:
            break
    return records


def _fetch_resource_level(client, date_from: str, end_exclusive: str, account_id: str) -> list:
    """
    Fetch daily costs grouped by SERVICE + RESOURCE_ID.
    Requires 'Resource-level data' enabled in AWS Cost Management.
    API only supports 14-day windows, so we chunk automatically.
    Returns [] if resource-level data is not enabled for this account.
    """
    # Validate with a single-day probe using a guaranteed-recent date
    probe_start = (datetime.utcnow() - timedelta(days=3)).strftime("%Y-%m-%d")
    probe_end = (datetime.utcnow() - timedelta(days=2)).strftime("%Y-%m-%d")
    try:
        client.get_cost_and_usage_with_resources(
            TimePeriod={"Start": probe_start, "End": probe_end},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
            GroupBy=[
                {"Type": "DIMENSION", "Key": "SERVICE"},
                {"Type": "DIMENSION", "Key": "RESOURCE_ID"},
            ],
            Filter={"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [account_id]}},
        )
    except Exception as e:
        print(f"[AWS] Resource-level data not available for {account_id}: {e}")
        return []

    # Chunk into 14-day windows (API limit for resource-level data)
    records = []
    chunk_start = datetime.strptime(date_from, "%Y-%m-%d")
    final_end = datetime.strptime(end_exclusive, "%Y-%m-%d")

    while chunk_start < final_end:
        chunk_end = min(chunk_start + timedelta(days=14), final_end)
        chunk_start_str = chunk_start.strftime("%Y-%m-%d")
        chunk_end_str = chunk_end.strftime("%Y-%m-%d")

        try:
            paginator_token = None
            while True:
                kwargs = {
                    "TimePeriod": {"Start": chunk_start_str, "End": chunk_end_str},
                    "Granularity": "DAILY",
                    "Metrics": ["UnblendedCost"],
                    "GroupBy": [
                        {"Type": "DIMENSION", "Key": "SERVICE"},
                        {"Type": "DIMENSION", "Key": "RESOURCE_ID"},
                    ],
                    "Filter": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [account_id]}},
                }
                if paginator_token:
                    kwargs["NextPageToken"] = paginator_token
                resp = client.get_cost_and_usage_with_resources(**kwargs)
                for result_by_time in resp.get("ResultsByTime", []):
                    date_str = result_by_time["TimePeriod"]["Start"]
                    for group in result_by_time.get("Groups", []):
                        keys = group.get("Keys", [])
                        service = keys[0] if len(keys) > 0 else "Unknown"
                        resource_id = keys[1] if len(keys) > 1 else None
                        amount = float(group["Metrics"]["UnblendedCost"]["Amount"])
                        currency = group["Metrics"]["UnblendedCost"]["Unit"]
                        if amount == 0:
                            continue
                        resource_type = None
                        if resource_id:
                            if resource_id.startswith("i-"):
                                resource_type = "EC2 Instance"
                            elif resource_id.startswith("vol-"):
                                resource_type = "EBS Volume"
                            elif ":db:" in resource_id:
                                resource_type = "RDS Instance"
                            elif resource_id.startswith("arn:aws:elasticloadbalancing"):
                                resource_type = "Load Balancer"
                            elif resource_id.startswith("arn:aws:s3:::"):
                                resource_type = "S3 Bucket"
                                resource_id = resource_id.replace("arn:aws:s3:::", "")
                            elif resource_id.startswith("arn:aws:lambda"):
                                resource_type = "Lambda Function"
                                resource_id = resource_id.split(":")[-1]
                            elif resource_id.startswith("arn:aws:dynamodb"):
                                resource_type = "DynamoDB Table"
                                resource_id = resource_id.split("/")[-1]
                            elif resource_id.startswith("arn:aws:eks"):
                                resource_type = "EKS Cluster"
                                resource_id = resource_id.split("/")[-1]
                            elif resource_id.startswith("arn:aws:cloudfront"):
                                resource_type = "CloudFront Distribution"
                            elif resource_id.startswith("arn:aws:"):
                                # Generic ARN — extract last segment as friendly name
                                resource_type = "AWS Resource"
                        records.append((
                            date_str, None, service, resource_type, resource_id,
                            service, None, round(amount, 6), currency,
                            account_id, None, "aws",
                        ))
                paginator_token = resp.get("NextPageToken")
                if not paginator_token:
                    break
        except Exception as e:
            print(f"[AWS] Resource-level chunk {chunk_start_str}→{chunk_end_str} failed: {e}")

        chunk_start = chunk_end

    print(f"[AWS] Resource-level fetch: {len(records)} records for {account_id}")
    return records


def fetch_aws_costs(provider_record: dict, date_from: str, date_to: str) -> list:
    """
    Fetch daily costs from AWS Cost Explorer.

    Strategy:
    - Last 14 days: resource-level (SERVICE + RESOURCE_ID) for per-instance detail.
      Falls back to service-level if resource-level is not enabled.
    - Older data: service-level only (API limitation).

    Returns a list of tuples matching the cost_data INSERT schema:
      (date, resource_group, service_name, resource_type, resource_name,
       meter_category, meter_subcategory, cost, currency, subscription_id,
       tags, cloud_provider)
    """
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed. Run: pip install boto3")

    credentials = provider_record.get("credentials_json", {})
    if isinstance(credentials, str):
        try:
            credentials = json.loads(credentials)
        except Exception:
            credentials = {}

    account_id = provider_record.get("provider_id", "unknown")
    client = _get_ce_client(credentials)

    today = datetime.utcnow()
    resource_cutoff = today - timedelta(days=14)   # API limit for resource-level
    start = datetime.strptime(date_from, "%Y-%m-%d")
    end = datetime.strptime(date_to, "%Y-%m-%d")
    end_exclusive = (end + timedelta(days=1)).strftime("%Y-%m-%d")

    records = []

    # Older portion — service-level only
    if start < resource_cutoff:
        old_end = min(resource_cutoff, end + timedelta(days=1))
        old_end_str = old_end.strftime("%Y-%m-%d")
        records += _fetch_service_level(client, date_from, old_end_str, account_id)

    # Recent 14 days — try resource-level, fall back to service-level
    recent_start = max(start, resource_cutoff)
    if recent_start <= end:
        recent_start_str = recent_start.strftime("%Y-%m-%d")
        resource_records = _fetch_resource_level(client, recent_start_str, end_exclusive, account_id)
        if resource_records:
            records += resource_records
        else:
            records += _fetch_service_level(client, recent_start_str, end_exclusive, account_id)

    print(f"[AWS] Fetched {len(records)} records for account {account_id} "
          f"({date_from} → {date_to})")
    return records


def resolve_ec2_instance_names(credentials: dict, instance_ids: list, region: str = "us-east-1") -> dict:
    """
    Resolve EC2 instance IDs to their Name tag values.
    Returns {instance_id: name} for all instances that have a Name tag.
    Instances without a Name tag are excluded (caller keeps the raw ID).
    """
    if not BOTO3_AVAILABLE or not instance_ids:
        return {}

    if isinstance(credentials, str):
        try:
            credentials = json.loads(credentials)
        except Exception:
            credentials = {}

    sess_kwargs = {
        "aws_access_key_id": credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        "region_name": region,
    }
    role_arn = credentials.get("role_arn")
    if role_arn:
        try:
            sts = boto3.client("sts", **sess_kwargs)
            assume_kwargs = {"RoleArn": role_arn, "RoleSessionName": "ec2-name-resolver"}
            if credentials.get("external_id"):
                assume_kwargs["ExternalId"] = credentials["external_id"]
            assumed = sts.assume_role(**assume_kwargs)
            c = assumed["Credentials"]
            sess_kwargs = {
                "aws_access_key_id": c["AccessKeyId"],
                "aws_secret_access_key": c["SecretAccessKey"],
                "aws_session_token": c["SessionToken"],
                "region_name": region,
            }
        except Exception as e:
            print(f"[AWS] EC2 name resolver role assumption failed for {region}: {e}")
            return {}

    try:
        ec2 = boto3.client("ec2", **sess_kwargs)
        name_map = {}
        # describe_instances accepts max 200 IDs per call
        for i in range(0, len(instance_ids), 200):
            chunk = instance_ids[i:i + 200]
            resp = ec2.describe_instances(InstanceIds=chunk)
            for reservation in resp.get("Reservations", []):
                for inst in reservation.get("Instances", []):
                    iid = inst["InstanceId"]
                    name = next(
                        (t["Value"] for t in inst.get("Tags", []) if t["Key"] == "Name"),
                        None
                    )
                    if name:
                        name_map[iid] = name
        print(f"[AWS] Resolved {len(name_map)}/{len(instance_ids)} EC2 names in {region}")
        return name_map
    except Exception as e:
        print(f"[AWS] EC2 describe_instances failed for {region}: {e}")
        return {}


def resolve_all_ec2_names(provider_record: dict) -> dict:
    """
    Find all EC2 instance IDs stored in cost_data for this provider
    and resolve their Name tags across all regions.
    Returns combined {instance_id: name} map.
    """
    try:
        from database import get_db
        conn = get_db()
        provider_id = provider_record.get("provider_id", "")
        rows = conn.execute(
            """SELECT DISTINCT resource_name, resource_group
               FROM cost_data
               WHERE cloud_provider='aws'
                 AND subscription_id=?
                 AND resource_name LIKE 'i-%'""",
            (provider_id,)
        ).fetchall()
        conn.close()
    except Exception as e:
        print(f"[AWS] Failed to query instance IDs: {e}")
        return {}

    credentials = provider_record.get("credentials_json", {})
    if isinstance(credentials, str):
        try:
            credentials = json.loads(credentials)
        except Exception:
            credentials = {}

    # Group instance IDs by region (resource_group = region for AWS)
    by_region: dict = {}
    for row in rows:
        iid = row["resource_name"]
        region = row["resource_group"] or "us-east-1"
        by_region.setdefault(region, []).append(iid)

    combined = {}
    for region, ids in by_region.items():
        combined.update(resolve_ec2_instance_names(credentials, ids, region))
    return combined


def fetch_aws_accounts(credentials: dict) -> list:
    """
    List AWS accounts accessible via the given credentials.
    Uses Organizations API if available; falls back to STS GetCallerIdentity.
    """
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed. Run: pip install boto3")

    if isinstance(credentials, str):
        try:
            credentials = json.loads(credentials)
        except Exception:
            credentials = {}

    region = credentials.get("region", "us-east-1")
    sess_kwargs = {
        "aws_access_key_id": credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        "region_name": region,
    }

    try:
        org = boto3.client("organizations", **sess_kwargs)
        paginator = org.get_paginator("list_accounts")
        accounts = []
        for page in paginator.paginate():
            for acct in page.get("Accounts", []):
                if acct.get("Status") == "ACTIVE":
                    accounts.append({
                        "account_id": acct["Id"],
                        "name": acct.get("Name", acct["Id"]),
                        "email": acct.get("Email", ""),
                    })
        return accounts
    except Exception:
        pass  # Not an org admin — fall back to single account

    try:
        sts = boto3.client("sts", **sess_kwargs)
        identity = sts.get_caller_identity()
        return [{
            "account_id": identity["Account"],
            "name": f"Account {identity['Account']}",
            "email": "",
        }]
    except Exception as e:
        print(f"[AWS] Could not determine account: {e}")
        return []


def fetch_aws_activity(provider_record: dict, days: int = 7) -> list:
    """
    Fetch AWS CloudTrail events for the past N days using lookup_events.
    Returns tuples: (event_id, timestamp, caller, operation, operation_name,
                     resource_group, resource_type, resource_name, resource_id,
                     status, level, category, description)
    """
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed. Run: pip install boto3")

    credentials = provider_record.get("credentials_json", {})
    if isinstance(credentials, str):
        try:
            credentials = json.loads(credentials)
        except Exception:
            credentials = {}

    account_id = provider_record.get("provider_id", "unknown")
    region = credentials.get("region", "us-east-1")

    sess_kwargs = {
        "aws_access_key_id": credentials.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": credentials.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        "region_name": region,
    }
    role_arn = credentials.get("role_arn")
    if role_arn:
        try:
            sts = boto3.client("sts", **sess_kwargs)
            assume_kwargs = {"RoleArn": role_arn, "RoleSessionName": "cloud-activity-sync"}
            if credentials.get("external_id"):
                assume_kwargs["ExternalId"] = credentials["external_id"]
            assumed = sts.assume_role(**assume_kwargs)
            c = assumed["Credentials"]
            ct_client = boto3.client(
                "cloudtrail",
                aws_access_key_id=c["AccessKeyId"],
                aws_secret_access_key=c["SecretAccessKey"],
                aws_session_token=c["SessionToken"],
                region_name=region,
            )
        except Exception as e:
            print(f"[AWS CloudTrail] Role assumption failed: {e}")
            ct_client = boto3.client("cloudtrail", **sess_kwargs)
    else:
        ct_client = boto3.client("cloudtrail", **sess_kwargs)

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(days=days)
    records = []
    kwargs = {"StartTime": start_time, "EndTime": end_time, "MaxResults": 50}

    while True:
        try:
            resp = ct_client.lookup_events(**kwargs)
        except Exception as e:
            print(f"[AWS CloudTrail] lookup_events error for {account_id}: {e}")
            break

        for event in resp.get("Events", []):
            event_id = event.get("EventId", "")
            ts = event.get("EventTime")
            timestamp = ts.isoformat() if ts else ""
            caller = event.get("Username", "") or ""
            operation = event.get("EventName", "")

            resources = event.get("Resources") or []
            resource_type = resources[0].get("ResourceType", "") if resources else ""
            resource_name = resources[0].get("ResourceName", "") if resources else ""
            resource_id = resource_name

            status = "Succeeded"
            description = ""
            resource_group = region
            try:
                ct_event = json.loads(event.get("CloudTrailEvent", "{}"))
                if ct_event.get("errorCode"):
                    status = "Failed"
                    description = ct_event.get("errorMessage", ct_event.get("errorCode", ""))
                else:
                    description = ct_event.get("eventSource", "")
                if not caller:
                    uid = ct_event.get("userIdentity", {})
                    caller = uid.get("arn", uid.get("userName", ""))
                resource_group = ct_event.get("awsRegion", region)
            except Exception:
                pass

            records.append((
                event_id, timestamp, caller, operation, operation,
                resource_group, resource_type, resource_name, resource_id,
                status, "Informational", "Administrative", description[:500]
            ))

        next_token = resp.get("NextToken")
        if not next_token:
            break
        kwargs["NextToken"] = next_token

    print(f"[AWS CloudTrail] Fetched {len(records)} events for account {account_id}")
    return records


# ─── CloudFormation / Cross-Account Role helpers ──────────────────────────────

def build_credentials_for_provider(provider: dict) -> dict:
    """Build a credentials dict from a cloud_providers row.
    Prefers role_arn + external_id (CloudFormation connect) over stored access keys.
    Falls back to stored access keys for backward compatibility.
    """
    creds = {}
    try:
        raw = provider.get("credentials_json") or "{}"
        creds = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        pass

    # CloudFormation connect: role_arn column takes precedence
    if provider.get("role_arn"):
        creds["role_arn"] = provider["role_arn"]
    if provider.get("external_id"):
        creds["external_id"] = provider["external_id"]

    return creds


def assume_role_and_get_client(service: str, provider: dict, region: str = "us-east-1"):
    """Return a boto3 client for the given service using the provider's role or keys."""
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 is not installed")

    creds = build_credentials_for_provider(provider)
    role_arn = creds.get("role_arn")
    external_id = creds.get("external_id", "")

    base_kwargs = dict(
        aws_access_key_id=creds.get("access_key_id") or os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=creds.get("secret_access_key") or os.getenv("AWS_SECRET_ACCESS_KEY"),
        region_name=region,
    )

    if role_arn:
        sts = boto3.client("sts", **base_kwargs)
        assume_kwargs = {"RoleArn": role_arn, "RoleSessionName": f"cca-{service}"}
        if external_id:
            assume_kwargs["ExternalId"] = external_id
        assumed = sts.assume_role(**assume_kwargs)
        c = assumed["Credentials"]
        return boto3.client(
            service,
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
            region_name=region,
        )

    return boto3.client(service, **base_kwargs)


def verify_role_connection(provider: dict) -> tuple:
    """Try sts:AssumeRole to verify the cross-account connection.
    Returns (success: bool, message: str).
    """
    if not BOTO3_AVAILABLE:
        return False, "boto3 not available"
    try:
        client = assume_role_and_get_client("sts", provider)
        identity = client.get_caller_identity()
        account = identity.get("Account", "unknown")
        return True, f"Connected to AWS account {account}"
    except Exception as e:
        return False, str(e)[:200]
