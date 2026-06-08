import sqlite3, os
db = os.path.join(os.path.dirname(__file__), 'data', 'azure_costs.db')
conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row
print("=== Data in Local DB ===")
rows = conn.execute("SELECT cloud_provider, COUNT(*) as cnt, MIN(date) as earliest, MAX(date) as latest FROM cost_data GROUP BY cloud_provider").fetchall()
for r in rows:
    print(f"  {r['cloud_provider']}: {r['cnt']} records | {r['earliest']} → {r['latest']}")
total = conn.execute("SELECT COUNT(*) FROM cost_data").fetchone()[0]
print(f"  Total: {total} records")

print("\n=== Recent Azure records ===")
recent = conn.execute("SELECT subscription_id, date, SUM(cost) as total FROM cost_data WHERE cloud_provider='azure' GROUP BY subscription_id, date ORDER BY date DESC LIMIT 10").fetchall()
for r in recent:
    print(f"  {r['subscription_id'][:20]} | {r['date']} | ${r['total']:.2f}")

print("\n=== Sync log (last 5) ===")
logs = conn.execute("SELECT sync_start, status, records_fetched, error_message FROM sync_log ORDER BY id DESC LIMIT 5").fetchall()
for r in logs:
    print(f"  {r['sync_start'][:16]} | {r['status']} | {r['records_fetched']} records | {r['error_message'] or ''}")
conn.close()
