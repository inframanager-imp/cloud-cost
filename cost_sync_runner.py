"""
Run cost sync in a separate process so Flask can stay single-threaded (thread-starved hosts).
Invoked as: python3 cost_sync_runner.py <path-to-json-payload>
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from dotenv import load_dotenv

load_dotenv()

from database import (
    init_db,
    insert_cost_records,
    clear_cost_data,
    delete_cost_data_by_date,
    get_latest_cost_date,
    log_sync,
    update_sync_log,
    get_subscriptions,
    update_subscription_sync_time,
    get_cloud_providers,
    get_cloud_provider,
    update_cloud_provider_sync_time,
    get_db,
)
from azure_fetcher import fetch_cost_data

SYNC_SEQUENTIAL = os.getenv("SYNC_SEQUENTIAL", "false").lower() in ("true", "1", "yes")


def _status_path() -> str:
    base = os.getenv("DB_PATH", "/app/data/azure_costs.db")
    return os.path.join(os.path.dirname(os.path.abspath(base)), ".cost_sync_status.json")


def _write_status(running: bool, message: str, progress: int) -> None:
    path = _status_path()
    try:
        with open(path, "w") as f:
            json.dump({"running": running, "message": message, "progress": progress}, f)
    except OSError as e:
        print(f"[cost_sync_runner] status write failed: {e}")


def _fetch_one_subscription(sub, is_full: bool, months: int, date_to: str):
    sub_id = sub["subscription_id"]
    sub_name = sub.get("name", sub_id[:12])

    if is_full:
        date_from = (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")
        clear_cost_data(subscription_id=sub_id)
    else:
        latest = get_latest_cost_date(subscription_id=sub_id)
        if latest:
            date_from = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=2)).strftime("%Y-%m-%d")
            delete_cost_data_by_date(date_from, date_to, subscription_id=sub_id)
        else:
            date_from = (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")

    all_records = []
    current_from = datetime.strptime(date_from, "%Y-%m-%d")
    final_to = datetime.strptime(date_to, "%Y-%m-%d")
    total_days = (final_to - current_from).days
    total_chunks = max(1, total_days // 30 + (1 if total_days % 30 else 0))

    for chunk in range(1, total_chunks + 1):
        chunk_to = min(current_from + timedelta(days=30), final_to)
        records = fetch_cost_data(
            current_from.strftime("%Y-%m-%d"),
            chunk_to.strftime("%Y-%m-%d"),
            subscription_id=sub_id,
        )
        all_records.extend(records)
        current_from = chunk_to + timedelta(days=1)

    count = insert_cost_records(all_records, tenant_id=sub.get("tenant_id", 1))
    update_subscription_sync_time(sub_id, "cost")
    return sub_name, count


def run_cost_sync_from_payload(payload: dict) -> None:
    init_db()
    mode = payload.get("mode", "incremental")
    target_sub = payload.get("subscription_id")
    payload_tid = payload.get("tenant_id")
    months = int(os.getenv("COST_HISTORY_MONTHS", "3"))
    date_to = payload.get("date_to") or datetime.utcnow().strftime("%Y-%m-%d")

    # Owner tenant (default 1) drives the global/legacy Azure sync; client
    # tenants are scoped to their own subscriptions only.
    owner_tid = int(os.getenv("OWNER_TENANT_ID", "1"))
    is_owner = payload_tid in (None, owner_tid)

    if target_sub:
        all_subs = get_subscriptions()
        match = [s for s in all_subs if s["subscription_id"] == target_sub]
        subs_to_sync = match if match else [{"subscription_id": target_sub, "name": target_sub[:12]}]
    else:
        subs_to_sync = get_subscriptions(enabled_only=True, tenant_id=payload_tid if not is_owner else None)
        # Only the owner tenant falls back to the shared .env Azure subscription.
        if not subs_to_sync and is_owner:
            subs_to_sync = [{"subscription_id": os.getenv("AZURE_SUBSCRIPTION_ID", ""), "name": "Default"}]

    is_full = mode == "full"
    mode_label = "Full sync" if is_full else "Quick sync"
    total_subs = len(subs_to_sync)
    _write_status(True, f"{mode_label}: Starting ({total_subs} subscription(s))...", 5)
    sync_id = log_sync(datetime.utcnow().isoformat(), "", date_to, tenant_id=payload_tid)
    total_records = 0

    try:
        completed = 0
        if SYNC_SEQUENTIAL:
            for sub in subs_to_sync:
                sub_name = sub.get("name", sub["subscription_id"][:12])
                try:
                    name, count = _fetch_one_subscription(sub, is_full, months, date_to)
                    total_records += count
                    completed += 1
                    _write_status(
                        True,
                        f"{mode_label}: {name} done ({count} records) [{completed}/{total_subs}]",
                        5 + int(90 * completed / total_subs),
                    )
                except Exception as sub_err:
                    completed += 1
                    _write_status(
                        True,
                        f"{mode_label}: {sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]",
                        5 + int(90 * completed / total_subs),
                    )
        else:
            max_workers = min(total_subs, 5)
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(_fetch_one_subscription, sub, is_full, months, date_to): sub
                    for sub in subs_to_sync
                }
                for future in as_completed(futures):
                    sub = futures[future]
                    sub_name = sub.get("name", sub["subscription_id"][:12])
                    try:
                        name, count = future.result()
                        total_records += count
                        completed += 1
                        _write_status(
                            True,
                            f"{mode_label}: {name} done ({count} records) [{completed}/{total_subs}]",
                            5 + int(90 * completed / total_subs),
                        )
                    except Exception as sub_err:
                        completed += 1
                        _write_status(
                            True,
                            f"{mode_label}: {sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]",
                            5 + int(90 * completed / total_subs),
                        )

        # Sync AWS/GCP cloud providers (only when not targeting a specific Azure subscription)
        if not target_sub:
            try:
                from aws_fetcher import fetch_aws_costs
                from gcp_fetcher import fetch_gcp_costs, GCPExportPending
                from azure_fetcher import fetch_azure_costs
                cp_providers = get_cloud_providers(enabled_only=True)
                cp_providers = [p for p in cp_providers if p.get("provider_type") in ("aws", "gcp", "azure")]
                total_cp = len(cp_providers)
                for idx, provider in enumerate(cp_providers, start=1):
                    # Re-fetch with credentials (get_cloud_providers() omits credentials_json)
                    provider = get_cloud_provider(provider["id"]) or provider
                    ptype = provider.get("provider_type")
                    pid = provider.get("provider_id")
                    pname = provider.get("name") or pid or ptype
                    _write_status(True, f"{mode_label}: syncing {ptype.upper()} provider {pname} [{idx}/{total_cp}]", 95)
                    try:
                        provider_tenant_id = provider.get("tenant_id", 1)
                        # Determine date range
                        conn = get_db()
                        row = conn.execute(
                            "SELECT MAX(substr(date,1,10)) AS latest FROM cost_data WHERE cloud_provider=? AND subscription_id=? AND tenant_id=?",
                            (ptype, pid, provider_tenant_id),
                        ).fetchone()
                        conn.close()
                        latest = row["latest"] if row and row["latest"] else None
                        if is_full:
                            p_from = (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")
                        elif latest:
                            p_from = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=2)).strftime("%Y-%m-%d")
                        else:
                            p_from = (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")

                        if ptype == "aws":
                            records = fetch_aws_costs(provider, p_from, date_to)
                        elif ptype == "azure":
                            records = fetch_azure_costs(provider, p_from, date_to)
                        else:
                            records = fetch_gcp_costs(provider, p_from, date_to)

                        conn = get_db()
                        if ptype == "gcp":
                            # Only delete project IDs returned — never wipe other GCP projects
                            project_ids = list({r[9] for r in (records or []) if r[9]})
                            for proj_id in project_ids:
                                conn.execute(
                                    "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider='gcp' AND subscription_id=? AND tenant_id=?",
                                    (p_from, date_to, proj_id, provider_tenant_id),
                                )
                        else:
                            conn.execute(
                                "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider=? AND subscription_id=? AND tenant_id=?",
                                (p_from, date_to, ptype, pid, provider_tenant_id),
                            )
                        if records:
                            records = [r + (provider_tenant_id,) for r in records]
                            conn.executemany(
                                """
                                INSERT INTO cost_data
                                  (date,resource_group,service_name,resource_type,resource_name,
                                   meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider,tenant_id)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                                """,
                                records,
                            )
                        conn.commit()
                        conn.close()
                        total_records += len(records or [])
                        update_cloud_provider_sync_time(provider["id"], error=None)
                    except GCPExportPending as pe:
                        update_cloud_provider_sync_time(provider["id"], error=f"[PENDING] {pe}")
                        print(f"[cost_sync_runner] GCP provider '{pname}' pending: {pe}")
                    except Exception as cp_err:
                        update_cloud_provider_sync_time(provider["id"], error=str(cp_err))
                        print(f"[cost_sync_runner] {ptype.upper()} provider '{pname}' failed: {cp_err}")
            except Exception as cp_outer_err:
                print(f"[cost_sync_runner] Cloud providers sync error (non-fatal): {cp_outer_err}")

        _write_status(
            False,
            f"{mode_label} complete! {total_records} records across {total_subs} subscription(s).",
            100,
        )
        update_sync_log(sync_id, "success", total_records)
    except Exception as e:
        _write_status(False, f"{mode_label} failed: {str(e)}", 0)
        update_sync_log(sync_id, "failed", total_records, str(e))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: cost_sync_runner.py <payload.json>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        run_cost_sync_from_payload(payload)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
