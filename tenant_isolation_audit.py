"""
Tenant-isolation audit — detects cross-tenant data leaks regardless of which
query caused them, by checking data-level invariants. Run on a schedule (cron)
or on demand via /api/superadmin/isolation-audit.

Invariants checked:
  1. No NULL tenant_id in tables that must always be tenant-scoped.
  2. No cost_data / activity_logs attributed to a tenant that doesn't own the
     corresponding account (azure subscription / aws account / gcp project).
  3. No single account/subscription whose cost_data appears under more than one
     tenant (the classic cross-tenant duplication leak).

Exit code: 0 = clean, 1 = leaks found. Usage: python3 tenant_isolation_audit.py
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
load_dotenv()

from database import get_db

OWNER_TENANT_ID = int(os.getenv("OWNER_TENANT_ID", "1"))

# Tables that must always carry a non-NULL tenant_id (sync_log is excluded —
# NULL there means a legacy/system run, which is intentional).
TENANT_SCOPED_TABLES = [
    "cost_data",
    "activity_logs",
    "cloud_providers",
    "subscriptions",
    "budgets",
    "clients",
    "custom_reports",
    "email_settings",
    "email_log",
    "integration_settings",
    "users",
    "virtual_tag_rules",
    "saved_filters",
]


def _has_table(conn, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _has_column(conn, table: str, col: str) -> bool:
    return any(c[1] == col for c in conn.execute(f"PRAGMA table_info({table})").fetchall())


def audit() -> dict:
    conn = get_db()
    findings = []  # list of {check, severity, detail}

    # ── Invariant 1: no NULL tenant_id in tenant-scoped tables ────────────────
    for t in TENANT_SCOPED_TABLES:
        if not _has_table(conn, t) or not _has_column(conn, t, "tenant_id"):
            continue
        n = conn.execute(f"SELECT COUNT(*) FROM {t} WHERE tenant_id IS NULL").fetchone()[0]
        if n:
            findings.append({
                "check": "null_tenant_id",
                "severity": "high",
                "detail": f"{t}: {n} row(s) with NULL tenant_id",
            })

    # Per-tenant cloud ownership: which clouds each tenant has connected.
    # (A GCP/AWS provider's billing export spans many project/account IDs, so we
    # check ownership at the cloud level, not per individual account ID.)
    owns_cloud = {}  # tenant_id -> set(cloud)
    for r in conn.execute(
        "SELECT tenant_id, provider_type FROM cloud_providers "
        "WHERE provider_type IS NOT NULL AND provider_id IS NOT NULL AND provider_id != ''"
    ).fetchall():
        owns_cloud.setdefault(r["tenant_id"], set()).add(r["provider_type"])
    # A tenant with any Azure subscription owns the azure cloud.
    for r in conn.execute("SELECT DISTINCT tenant_id FROM subscriptions").fetchall():
        owns_cloud.setdefault(r["tenant_id"], set()).add("azure")

    # ── Invariant 2: a non-owner tenant has data for a cloud it never connected.
    # This is the classic leak (e.g. an AWS-only client showing Azure spend).
    # The owner tenant legitimately aggregates legacy/.env clouds, so skip it.
    # OpenAI is an integration (not a cloud provider) and is excluded here.
    for table in ("cost_data", "activity_logs"):
        if not _has_table(conn, table):
            continue
        rows = conn.execute(
            f"SELECT tenant_id, cloud_provider, COUNT(*) AS n FROM {table} "
            f"WHERE cloud_provider IS NOT NULL AND cloud_provider NOT IN ('openai') "
            f"GROUP BY tenant_id, cloud_provider"
        ).fetchall()
        for r in rows:
            tid, cloud, n = r["tenant_id"], r["cloud_provider"], r["n"]
            if tid == OWNER_TENANT_ID:
                continue
            if cloud in owns_cloud.get(tid, set()):
                continue
            findings.append({
                "check": "orphan_attribution",
                "severity": "high",
                "detail": f"{table}: tenant {tid} has {n} {cloud} row(s) but owns "
                          f"no {cloud} provider/subscription",
            })

    # ── Invariant 3: same account's cost_data under multiple tenants ──────────
    if _has_table(conn, "cost_data"):
        dupes = conn.execute(
            "SELECT subscription_id, cloud_provider, COUNT(DISTINCT tenant_id) AS n, "
            "       GROUP_CONCAT(DISTINCT tenant_id) AS tids "
            "FROM cost_data WHERE subscription_id IS NOT NULL AND subscription_id != '' "
            "GROUP BY subscription_id, cloud_provider HAVING n > 1"
        ).fetchall()
        for r in dupes:
            findings.append({
                "check": "cross_tenant_duplicate",
                "severity": "high",
                "detail": f"cost_data: {r['cloud_provider']} account '{r['subscription_id']}' "
                          f"appears under {r['n']} tenants ({r['tids']})",
            })

    conn.close()
    return {"clean": len(findings) == 0, "findings": findings}


def main() -> int:
    result = audit()
    if result["clean"]:
        print("✅ Tenant isolation audit: CLEAN — no cross-tenant leaks found.")
        return 0
    print(f"❌ Tenant isolation audit: {len(result['findings'])} ISSUE(S) FOUND")
    for f in result["findings"]:
        print(f"  [{f['severity'].upper()}] {f['check']}: {f['detail']}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
