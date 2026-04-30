"""
Run activity log sync in a subprocess so single-threaded Flask / thread-starved hosts stay responsive.
Invoked as: python3 activity_sync_runner.py <path-to-json-payload>
Payload: {"days": 7, "subscription_id": null | "<guid>"}
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
    insert_activity_logs,
    get_subscriptions,
    get_latest_activity_timestamp,
    update_subscription_sync_time,
    save_caller_names,
)
from azure_fetcher import fetch_activity_logs, resolve_caller_names, _caller_name_cache

SYNC_SEQUENTIAL = os.getenv("SYNC_SEQUENTIAL", "false").lower() in ("true", "1", "yes")


def _status_path() -> str:
    base = os.getenv("DB_PATH", "/app/data/azure_costs.db")
    return os.path.join(os.path.dirname(os.path.abspath(base)), ".activity_sync_status.json")


def _write_status(running: bool, message: str, progress: int) -> None:
    path = _status_path()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"running": running, "message": message, "progress": progress}, f)
    except OSError as e:
        print(f"[activity_sync_runner] status write failed: {e}")


def _fetch_one_activity(sub, days_local: int, date_to_local: str):
    sub_id = sub["subscription_id"]
    sub_name = sub.get("name", sub_id[:12])

    latest = get_latest_activity_timestamp(subscription_id=sub_id)
    if latest and days_local <= 7:
        date_from = latest[:10]
    else:
        date_from = (datetime.utcnow() - timedelta(days=days_local)).strftime("%Y-%m-%d")

    records = fetch_activity_logs(date_from, date_to_local, subscription_id=sub_id)
    count = insert_activity_logs(records, subscription_id=sub_id)
    update_subscription_sync_time(sub_id, "activity")

    caller_ids = {r[2] for r in records if r[2]}
    return sub_name, count, caller_ids


def run(payload: dict) -> None:
    init_db()
    days = int(payload.get("days", 7))
    target_sub = payload.get("subscription_id")
    date_to = datetime.utcnow().strftime("%Y-%m-%d")

    if target_sub:
        subs_to_sync = [{"subscription_id": target_sub}]
    else:
        subs_to_sync = get_subscriptions(enabled_only=True)
        if not subs_to_sync:
            subs_to_sync = [{"subscription_id": os.getenv("AZURE_SUBSCRIPTION_ID", ""), "name": "Default"}]

    total_subs = len(subs_to_sync)
    mode_lbl = "sequentially" if SYNC_SEQUENTIAL else "in parallel"
    _write_status(True, f"Starting ({total_subs} subscription(s)) {mode_lbl}...", 5)
    total_count = 0
    all_caller_ids: set = set()
    completed = 0

    try:
        def _parallel():
            nonlocal completed, total_count, all_caller_ids
            max_workers = min(total_subs, 5)
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(_fetch_one_activity, sub, days, date_to): sub
                    for sub in subs_to_sync
                }
                for future in as_completed(futures):
                    sub = futures[future]
                    sub_name = sub.get("name", sub["subscription_id"][:12])
                    try:
                        name, count, caller_ids = future.result()
                        total_count += count
                        all_caller_ids.update(caller_ids)
                        completed += 1
                        _write_status(
                            True,
                            f"{name} done ({count} events) [{completed}/{total_subs}]",
                            5 + int(75 * completed / total_subs),
                        )
                    except Exception as sub_err:
                        completed += 1
                        _write_status(
                            True,
                            f"{sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]",
                            5 + int(75 * completed / total_subs),
                        )

        def _sequential():
            nonlocal completed, total_count, all_caller_ids
            for sub in subs_to_sync:
                sub_name = sub.get("name", sub["subscription_id"][:12])
                try:
                    name, count, caller_ids = _fetch_one_activity(sub, days, date_to)
                    total_count += count
                    all_caller_ids.update(caller_ids)
                    completed += 1
                    _write_status(
                        True,
                        f"{name} done ({count} events) [{completed}/{total_subs}]",
                        5 + int(75 * completed / total_subs),
                    )
                except Exception as sub_err:
                    completed += 1
                    _write_status(
                        True,
                        f"{sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]",
                        5 + int(75 * completed / total_subs),
                    )

        if SYNC_SEQUENTIAL:
            _sequential()
        else:
            try:
                _parallel()
            except RuntimeError as re:
                if "thread" in str(re).lower():
                    print(f"[activity_sync_runner] Parallel failed ({re}), retrying sequential.")
                    completed = 0
                    total_count = 0
                    all_caller_ids = set()
                    _sequential()
                else:
                    raise

        _write_status(True, "Resolving user names...", 85)
        guid_ids = [c for c in all_caller_ids if "@" not in c and len(c) > 8]

        claims_names = {k: v for k, v in _caller_name_cache.items() if k in guid_ids and len(v) > 15}
        if claims_names:
            save_caller_names(claims_names)

        still_unknown = [c for c in guid_ids if c not in claims_names]
        if still_unknown:
            name_map = resolve_caller_names(still_unknown)
            save_caller_names(name_map)

        _write_status(
            False,
            f"Done! {total_count} events across {total_subs} subscription(s).",
            100,
        )
    except Exception as e:
        _write_status(False, f"Failed: {str(e)}", 0)
        raise


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: activity_sync_runner.py <payload.json>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        run(payload)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
