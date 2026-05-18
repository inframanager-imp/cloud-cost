import sqlite3
import os
import json
import hashlib
import secrets
from datetime import datetime

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "azure_costs.db"))


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA cache_size=-10000")   # 10 MB page cache
    conn.execute("PRAGMA temp_store=MEMORY")   # temp tables in RAM
    conn.execute("PRAGMA synchronous=NORMAL")  # faster writes, still safe
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS cost_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            resource_group TEXT,
            service_name TEXT,
            resource_type TEXT,
            resource_name TEXT,
            meter_category TEXT,
            meter_subcategory TEXT,
            cost REAL NOT NULL DEFAULT 0,
            currency TEXT DEFAULT 'USD',
            subscription_id TEXT,
            tags TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sync_start TEXT NOT NULL,
            sync_end TEXT,
            status TEXT DEFAULT 'running',
            records_fetched INTEGER DEFAULT 0,
            date_from TEXT,
            date_to TEXT,
            error_message TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS subscriptions (
            subscription_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            state TEXT DEFAULT 'Enabled',
            enabled INTEGER DEFAULT 1,
            last_cost_sync TEXT,
            last_activity_sync TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS caller_names (
            caller_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS aws_resource_names (
            resource_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            provider_id TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE,
            subscription_id TEXT,
            timestamp TEXT NOT NULL,
            caller TEXT,
            operation TEXT,
            operation_name TEXT,
            resource_group TEXT,
            resource_type TEXT,
            resource_name TEXT,
            resource_id TEXT,
            status TEXT,
            level TEXT,
            category TEXT,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migration: add columns to activity_logs if missing
    for col, ddl in [
        ("subscription_id", "ALTER TABLE activity_logs ADD COLUMN subscription_id TEXT"),
        ("cloud_provider",  "ALTER TABLE activity_logs ADD COLUMN cloud_provider TEXT DEFAULT 'azure'"),
    ]:
        try:
            cursor.execute(f"SELECT {col} FROM activity_logs LIMIT 1")
        except Exception:
            cursor.execute(ddl)
            print(f"[DB] Migrated activity_logs: added {col} column")

    # Indexes for fast searching
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_date ON cost_data(date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_rg ON cost_data(resource_group)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_service ON cost_data(service_name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_resource_type ON cost_data(resource_type)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_meter ON cost_data(meter_category)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_sub ON cost_data(subscription_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_logs(timestamp)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_activity_caller ON activity_logs(caller)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_activity_rg ON activity_logs(resource_group)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_activity_status ON activity_logs(status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_activity_sub ON activity_logs(subscription_id)")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS saved_filters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filters TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            smtp_host TEXT DEFAULT '',
            smtp_port INTEGER DEFAULT 587,
            smtp_user TEXT DEFAULT '',
            smtp_password TEXT DEFAULT '',
            smtp_from TEXT DEFAULT '',
            smtp_use_tls INTEGER DEFAULT 1,
            recipients TEXT DEFAULT '',
            schedule TEXT DEFAULT 'weekly',
            schedule_day INTEGER DEFAULT 1,
            schedule_hour INTEGER DEFAULT 8,
            report_date_range TEXT DEFAULT 'this_month',
            report_date_from TEXT DEFAULT '',
            report_date_to TEXT DEFAULT '',
            report_sections TEXT DEFAULT '["summary","subscriptions","top_services","top_rgs","trend"]',
            enabled INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migration: add any missing email_settings columns (safe to run repeatedly)
    # Note: SQLite ALTER TABLE cannot use CURRENT_TIMESTAMP as default, use '' for updated_at
    for col, ddl in [
        ("smtp_host",            "ALTER TABLE email_settings ADD COLUMN smtp_host TEXT DEFAULT ''"),
        ("smtp_port",            "ALTER TABLE email_settings ADD COLUMN smtp_port INTEGER DEFAULT 587"),
        ("smtp_user",            "ALTER TABLE email_settings ADD COLUMN smtp_user TEXT DEFAULT ''"),
        ("smtp_password",        "ALTER TABLE email_settings ADD COLUMN smtp_password TEXT DEFAULT ''"),
        ("smtp_from",            "ALTER TABLE email_settings ADD COLUMN smtp_from TEXT DEFAULT ''"),
        ("smtp_use_tls",         "ALTER TABLE email_settings ADD COLUMN smtp_use_tls INTEGER DEFAULT 1"),
        ("recipients",           "ALTER TABLE email_settings ADD COLUMN recipients TEXT DEFAULT ''"),
        ("schedule",             "ALTER TABLE email_settings ADD COLUMN schedule TEXT DEFAULT 'weekly'"),
        ("schedule_day",         "ALTER TABLE email_settings ADD COLUMN schedule_day INTEGER DEFAULT 1"),
        ("schedule_hour",        "ALTER TABLE email_settings ADD COLUMN schedule_hour INTEGER DEFAULT 8"),
        ("enabled",              "ALTER TABLE email_settings ADD COLUMN enabled INTEGER DEFAULT 0"),
        ("updated_at",           "ALTER TABLE email_settings ADD COLUMN updated_at TEXT DEFAULT ''"),
        ("report_sections",      "ALTER TABLE email_settings ADD COLUMN report_sections TEXT DEFAULT '[\"summary\",\"subscriptions\",\"top_services\",\"top_rgs\",\"trend\"]'"),
        ("report_date_range",    "ALTER TABLE email_settings ADD COLUMN report_date_range TEXT DEFAULT 'this_month'"),
        ("report_date_from",     "ALTER TABLE email_settings ADD COLUMN report_date_from TEXT DEFAULT ''"),
        ("report_date_to",       "ALTER TABLE email_settings ADD COLUMN report_date_to TEXT DEFAULT ''"),
        ("report_cloud_provider","ALTER TABLE email_settings ADD COLUMN report_cloud_provider TEXT DEFAULT ''"),
    ]:
        try:
            cursor.execute(f"SELECT {col} FROM email_settings LIMIT 1")
        except Exception:
            try:
                cursor.execute(ddl)
                print(f"[DB] Migrated email_settings: added {col} column")
            except Exception as e2:
                print(f"[DB] email_settings migration skipped {col}: {e2}")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            recipients TEXT,
            subject TEXT,
            status TEXT DEFAULT 'sent',
            error TEXT,
            report_type TEXT DEFAULT 'scheduled'
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS custom_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            recipients TEXT DEFAULT '',
            filters TEXT NOT NULL DEFAULT '{}',
            sections TEXT NOT NULL DEFAULT '["summary","by_service","by_rg","trend"]',
            schedule TEXT DEFAULT 'none',
            schedule_day INTEGER DEFAULT 1,
            schedule_hour INTEGER DEFAULT 8,
            enabled INTEGER DEFAULT 0,
            last_sent TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS resource_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id TEXT,
            resource_group TEXT,
            resource_type TEXT,
            resource_name TEXT,
            location TEXT,
            sku_name TEXT,
            config_json TEXT,
            power_state TEXT DEFAULT '',
            last_synced TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(subscription_id, resource_group, resource_name)
        )
    """)

    # Migration: add power_state to existing resource_configs if missing
    try:
        cursor.execute("SELECT power_state FROM resource_configs LIMIT 1")
    except Exception:
        cursor.execute("ALTER TABLE resource_configs ADD COLUMN power_state TEXT DEFAULT ''")
        print("[DB] Migrated resource_configs: added power_state column")

    cursor.execute("INSERT OR IGNORE INTO email_settings (id) VALUES (1)")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS integration_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            jira_url TEXT DEFAULT '',
            jira_email TEXT DEFAULT '',
            jira_token TEXT DEFAULT '',
            jira_project TEXT DEFAULT '',
            jira_issue_type TEXT DEFAULT 'Task',
            jira_enabled INTEGER DEFAULT 0,
            jira_admin_token TEXT DEFAULT '',
            jira_mode TEXT DEFAULT 'cloud',
            jira_server_user TEXT DEFAULT '',
            jira_server_password TEXT DEFAULT '',
            bitbucket_workspace TEXT DEFAULT '',
            bitbucket_repo TEXT DEFAULT '',
            bitbucket_token TEXT DEFAULT '',
            bitbucket_enabled INTEGER DEFAULT 0,
            cursor_api_key TEXT DEFAULT '',
            cursor_enabled INTEGER DEFAULT 0,
            openai_api_key TEXT DEFAULT '',
            openai_org_id TEXT DEFAULT '',
            openai_enabled INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("INSERT OR IGNORE INTO integration_settings (id) VALUES (1)")

    for _col, _ddl in [
        ("jira_admin_token",    "ALTER TABLE integration_settings ADD COLUMN jira_admin_token TEXT DEFAULT ''"),
        ("jira_admin_org_id",   "ALTER TABLE integration_settings ADD COLUMN jira_admin_org_id TEXT DEFAULT ''"),
        ("jira_mode",           "ALTER TABLE integration_settings ADD COLUMN jira_mode TEXT DEFAULT 'cloud'"),
        ("jira_server_user",    "ALTER TABLE integration_settings ADD COLUMN jira_server_user TEXT DEFAULT ''"),
        ("jira_server_password","ALTER TABLE integration_settings ADD COLUMN jira_server_password TEXT DEFAULT ''"),
    ]:
        try:
            cursor.execute(f"SELECT {_col} FROM integration_settings LIMIT 1")
        except Exception:
            cursor.execute(_ddl)

    # ── SaaS: tenants ────────────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tenants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            plan TEXT DEFAULT 'free' CHECK(plan IN ('free','starter','pro','enterprise')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','cancelled')),
            max_users INTEGER DEFAULT 3,
            max_cloud_providers INTEGER DEFAULT 2,
            owner_email TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # ── SaaS: users ──────────────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT DEFAULT '',
            role TEXT DEFAULT 'viewer' CHECK(role IN ('admin','editor','viewer')),
            invite_token TEXT,
            invite_accepted INTEGER DEFAULT 0,
            last_login TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, email)
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email)")

    def _table_exists(tbl):
        r = cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (tbl,)).fetchone()
        return r is not None

    # ── Migration: tenant_id on cost_data ────────────────────────────────────
    if _table_exists("cost_data"):
        try:
            cursor.execute("SELECT tenant_id FROM cost_data LIMIT 1")
        except Exception:
            cursor.execute("ALTER TABLE cost_data ADD COLUMN tenant_id INTEGER DEFAULT 1")
            print("[DB] Migrated cost_data: added tenant_id column")

    # ── Migration: tenant_id on cloud_providers ──────────────────────────────
    if _table_exists("cloud_providers"):
        try:
            cursor.execute("SELECT tenant_id FROM cloud_providers LIMIT 1")
        except Exception:
            cursor.execute("ALTER TABLE cloud_providers ADD COLUMN tenant_id INTEGER DEFAULT 1")
            cursor.execute("DROP INDEX IF EXISTS idx_cp_type_id")
            print("[DB] Migrated cloud_providers: added tenant_id column")

    # ── Migration: tenant_id on budgets ──────────────────────────────────────
    if _table_exists("budgets"):
        try:
            cursor.execute("SELECT tenant_id FROM budgets LIMIT 1")
        except Exception:
            cursor.execute("ALTER TABLE budgets ADD COLUMN tenant_id INTEGER DEFAULT 1")
            print("[DB] Migrated budgets: added tenant_id column")

    # ── Migration: tenant_id on subscriptions ────────────────────────────────
    if _table_exists("subscriptions"):
        try:
            cursor.execute("SELECT tenant_id FROM subscriptions LIMIT 1")
        except Exception:
            cursor.execute("ALTER TABLE subscriptions ADD COLUMN tenant_id INTEGER DEFAULT 1")
            print("[DB] Migrated subscriptions: added tenant_id column")

    # ── Migration: tenant_id on activity_logs ────────────────────────────────
    if _table_exists("activity_logs"):
        try:
            cursor.execute("SELECT tenant_id FROM activity_logs LIMIT 1")
        except Exception:
            cursor.execute("ALTER TABLE activity_logs ADD COLUMN tenant_id INTEGER DEFAULT 1")
            print("[DB] Migrated activity_logs: added tenant_id column")

    # ── Seed: default tenant for existing single-tenant data ─────────────────
    cursor.execute("""
        INSERT OR IGNORE INTO tenants (id, slug, name, plan, owner_email)
        VALUES (1, 'default', 'Default Organization', 'pro', 'admin@localhost')
    """)

    # ── Multi-cloud: cloud_providers ─────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS cloud_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_type TEXT NOT NULL CHECK(provider_type IN ('aws','gcp','azure')),
            name TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            credentials_json TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER DEFAULT 1,
            last_sync TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_type_id ON cloud_providers(provider_type, provider_id)")

    # ── Budget alerts ────────────────────────────────────────────────────────
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider_type TEXT DEFAULT 'all',
            provider_id TEXT DEFAULT '',
            amount REAL NOT NULL,
            period TEXT DEFAULT 'monthly',
            alert_thresholds TEXT DEFAULT '[80,100]',
            alert_channels TEXT DEFAULT '["email"]',
            enabled INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS budget_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            budget_id INTEGER NOT NULL REFERENCES budgets(id),
            threshold_pct INTEGER NOT NULL,
            current_spend REAL NOT NULL,
            budget_amount REAL NOT NULL,
            notified_via TEXT DEFAULT '[]',
            triggered_at TEXT DEFAULT CURRENT_TIMESTAMP,
            resolved_at TEXT
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ba_budget ON budget_alerts(budget_id)")

    # ── Migration: cloud_provider column on cost_data ────────────────────────
    try:
        cursor.execute("SELECT cloud_provider FROM cost_data LIMIT 1")
    except Exception:
        cursor.execute("ALTER TABLE cost_data ADD COLUMN cloud_provider TEXT DEFAULT 'azure'")
        cursor.execute("UPDATE cost_data SET cloud_provider='azure' WHERE cloud_provider IS NULL")
        print("[DB] Migrated cost_data: added cloud_provider column")

    # ── Indexes for cost_data (safe to re-run — IF NOT EXISTS) ──────────────
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_date       ON cost_data(date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_cloud      ON cost_data(cloud_provider)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_sub        ON cost_data(subscription_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_cloud_date ON cost_data(cloud_provider, date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_sub_date   ON cost_data(subscription_id, date)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_rg         ON cost_data(resource_group)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_cost_service    ON cost_data(service_name)")
    print("[DB] cost_data indexes ensured.")

    # ── Remove old CHECK constraint on budgets.period (blocks daily/weekly) ──
    try:
        row = cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='budgets'").fetchone()
        if row and "CHECK" in (row[0] or ""):
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS budgets_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    provider_type TEXT DEFAULT 'all',
                    provider_id TEXT DEFAULT '',
                    amount REAL NOT NULL,
                    period TEXT DEFAULT 'monthly',
                    alert_thresholds TEXT DEFAULT '[80,100]',
                    alert_channels TEXT DEFAULT '["email"]',
                    enabled INTEGER DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    resource_group TEXT DEFAULT '',
                    service_name TEXT DEFAULT '',
                    scope_label TEXT DEFAULT '',
                    tenant_id INTEGER DEFAULT 1
                )
            """)
            cursor.execute("""
                INSERT INTO budgets_new
                    (id,name,provider_type,provider_id,amount,period,
                     alert_thresholds,alert_channels,enabled,created_at,updated_at,tenant_id)
                SELECT id,name,provider_type,provider_id,amount,period,
                       alert_thresholds,alert_channels,enabled,created_at,updated_at,
                       COALESCE(tenant_id,1)
                FROM budgets
            """)
            cursor.execute("DROP TABLE budgets")
            cursor.execute("ALTER TABLE budgets_new RENAME TO budgets")
            print("[DB] budgets: removed CHECK constraint, added daily/weekly period support")
    except Exception as e:
        print(f"[DB] budgets migration: {e}")

    # ── Budget granular filters migration ────────────────────────────────────
    for col, ddl in [
        ("resource_group", "ALTER TABLE budgets ADD COLUMN resource_group TEXT DEFAULT ''"),
        ("service_name",   "ALTER TABLE budgets ADD COLUMN service_name TEXT DEFAULT ''"),
        ("scope_label",    "ALTER TABLE budgets ADD COLUMN scope_label TEXT DEFAULT ''"),
        ("alert_emails",   "ALTER TABLE budgets ADD COLUMN alert_emails TEXT DEFAULT ''"),
    ]:
        try:
            cursor.execute(f"SELECT {col} FROM budgets LIMIT 1")
        except Exception:
            try:
                cursor.execute(ddl)
                print(f"[DB] budgets: added {col} column")
            except Exception as e2:
                print(f"[DB] budgets migration skipped {col}: {e2}")

    # ── Clean up zombie "running" sync_log entries left by killed/restarted workers
    cursor.execute("""
        UPDATE sync_log SET status='abandoned', sync_end=CURRENT_TIMESTAMP,
               error_message='Process killed or restarted before completion'
        WHERE status='running'
    """)

    conn.commit()
    conn.close()
    print("[DB] Database initialized successfully.")


def upsert_subscriptions(subs):
    """Insert or update subscriptions from Azure discovery."""
    conn = get_db()
    for s in subs:
        conn.execute("""
            INSERT INTO subscriptions (subscription_id, name, state)
            VALUES (?, ?, ?)
            ON CONFLICT(subscription_id) DO UPDATE SET name=excluded.name, state=excluded.state
        """, (s["subscription_id"], s["name"], s["state"]))
    conn.commit()
    conn.close()


def get_subscriptions(enabled_only=False, tenant_id=None):
    conn = get_db()
    params = []
    conditions = []
    if enabled_only:
        conditions.append("enabled = 1")
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    query = "SELECT * FROM subscriptions"
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY name"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def toggle_subscription(subscription_id, enabled):
    conn = get_db()
    conn.execute("UPDATE subscriptions SET enabled = ? WHERE subscription_id = ?", (1 if enabled else 0, subscription_id))
    conn.commit()
    conn.close()


def update_subscription_sync_time(subscription_id, sync_type="cost"):
    conn = get_db()
    col = "last_cost_sync" if sync_type == "cost" else "last_activity_sync"
    conn.execute(f"UPDATE subscriptions SET {col} = ? WHERE subscription_id = ?",
                 (datetime.utcnow().isoformat(), subscription_id))
    conn.commit()
    conn.close()


def insert_cost_records(records):
    if not records:
        return 0

    conn = get_db()
    cursor = conn.cursor()
    cursor.executemany("""
        INSERT INTO cost_data (date, resource_group, service_name, resource_type,
                               resource_name, meter_category, meter_subcategory,
                               cost, currency, subscription_id, tags, cloud_provider)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, records)
    conn.commit()
    count = cursor.rowcount
    conn.close()
    return count


def clear_cost_data(subscription_id=None):
    conn = get_db()
    if subscription_id:
        conn.execute("DELETE FROM cost_data WHERE subscription_id = ?", (subscription_id,))
    else:
        conn.execute("DELETE FROM cost_data")
    conn.commit()
    conn.close()


def delete_cost_data_by_date(date_from, date_to, subscription_id=None):
    conn = get_db()
    cursor = conn.cursor()
    if subscription_id:
        cursor.execute("DELETE FROM cost_data WHERE date >= ? AND date <= ? AND subscription_id = ?",
                        (date_from, date_to, subscription_id))
    else:
        cursor.execute("DELETE FROM cost_data WHERE date >= ? AND date <= ?", (date_from, date_to))
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    return deleted


def get_latest_cost_date(subscription_id=None):
    conn = get_db()
    if subscription_id:
        row = conn.execute("SELECT MAX(date) as max_date FROM cost_data WHERE subscription_id = ?",
                           (subscription_id,)).fetchone()
    else:
        row = conn.execute("SELECT MAX(date) as max_date FROM cost_data").fetchone()
    conn.close()
    return row["max_date"] if row and row["max_date"] else None


def log_sync(sync_start, date_from, date_to):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO sync_log (sync_start, date_from, date_to, status)
        VALUES (?, ?, ?, 'running')
    """, (sync_start, date_from, date_to))
    conn.commit()
    sync_id = cursor.lastrowid
    conn.close()
    return sync_id


def update_sync_log(sync_id, status, records_fetched=0, error_message=None):
    conn = get_db()
    conn.execute("""
        UPDATE sync_log SET sync_end=?, status=?, records_fetched=?, error_message=?
        WHERE id=?
    """, (datetime.utcnow().isoformat(), status, records_fetched, error_message, sync_id))
    conn.commit()
    conn.close()


def query_costs(filters=None, tenant_id=None):
    conn = get_db()
    # Aggregate SKU-level rows into one row per day/cloud/project/service/resource
    # so the Cost Data table shows one line per logical grouping, not per billing SKU.
    granularity = (filters or {}).get("granularity", "daily")
    date_expr = "substr(date,1,7)" if granularity == "monthly" else "substr(date,1,10)"
    where = "WHERE 1=1"
    params = []

    if filters:
        if filters.get("subscription_ids"):
            sub_ids = filters["subscription_ids"]
            placeholders = ",".join(["?"] * len(sub_ids))
            cond = f"subscription_id IN ({placeholders})"
            params.extend(sub_ids)
            if filters.get("include_blank_subscription"):
                cond = f"({cond} OR subscription_id IS NULL OR subscription_id='')"
            where += f" AND {cond}"
        elif filters.get("include_blank_subscription"):
            where += " AND (subscription_id IS NULL OR subscription_id='')"
        elif filters.get("subscription_id"):
            where += " AND subscription_id = ?"
            params.append(filters["subscription_id"])
        if filters.get("date_from"):
            where += " AND date >= ?"
            params.append(filters["date_from"])
        if filters.get("date_to"):
            where += " AND date <= ?"
            params.append(filters["date_to"])
        if filters.get("resource_groups"):
            vals = filters["resource_groups"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"resource_group IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_resource_group"):
                cond = f"({cond} OR resource_group IS NULL OR resource_group='')"
            where += f" AND {cond}"
        elif filters.get("include_blank_resource_group"):
            where += " AND (resource_group IS NULL OR resource_group='')"
        elif filters.get("resource_group"):
            where += " AND resource_group LIKE ?"
            params.append(f"%{filters['resource_group']}%")
        if filters.get("service_names"):
            vals = filters["service_names"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"service_name IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_service"):
                cond = f"({cond} OR service_name IS NULL OR service_name='')"
            where += f" AND {cond}"
        elif filters.get("include_blank_service"):
            where += " AND (service_name IS NULL OR service_name='')"
        elif filters.get("service_name"):
            where += " AND service_name = ?"
            params.append(filters['service_name'])
        if filters.get("resource_type"):
            where += " AND resource_type LIKE ?"
            params.append(f"%{filters['resource_type']}%")
        if filters.get("meter_category"):
            where += " AND meter_category LIKE ?"
            params.append(f"%{filters['meter_category']}%")
        if filters.get("search"):
            where += """ AND (resource_group LIKE ? OR service_name LIKE ?
                         OR resource_type LIKE ? OR resource_name LIKE ?
                         OR meter_category LIKE ?)"""
            s = f"%{filters['search']}%"
            params.extend([s, s, s, s, s])
        if filters.get("cloud_provider"):
            where += " AND cloud_provider = ?"
            params.append(filters["cloud_provider"])

    if tenant_id is not None:
        where += " AND tenant_id = ?"
        params.append(tenant_id)

    query = f"""
        SELECT
            {date_expr} AS date,
            cloud_provider,
            resource_group,
            service_name,
            resource_type,
            resource_name,
            subscription_id,
            SUM(cost)   AS cost,
            currency,
            MAX(tags)   AS tags,
            tenant_id
        FROM cost_data
        {where}
        GROUP BY {date_expr}, cloud_provider, resource_group, service_name,
                 resource_type, resource_name, subscription_id, currency, tenant_id
        ORDER BY {date_expr} DESC, cost DESC
    """

    if filters and filters.get("limit"):
        query += " LIMIT ?"
        params.append(filters["limit"])
        if filters.get("offset") is not None:
            query += " OFFSET ?"
            params.append(filters["offset"])

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_cost_total(filters=None, tenant_id=None, cloud_provider=None):
    """Get total cost for current filters (without row limit)."""
    conn = get_db()
    query = "SELECT SUM(cost) as total_cost, COUNT(*) as total_records FROM cost_data WHERE 1=1"
    params = []

    if filters:
        if filters.get("subscription_ids"):
            sub_ids = filters["subscription_ids"]
            placeholders = ",".join(["?"] * len(sub_ids))
            cond = f"subscription_id IN ({placeholders})"
            params.extend(sub_ids)
            if filters.get("include_blank_subscription"):
                cond = f"({cond} OR subscription_id IS NULL OR subscription_id='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_subscription"):
            query += " AND (subscription_id IS NULL OR subscription_id='')"
        elif filters.get("subscription_id"):
            query += " AND subscription_id = ?"
            params.append(filters["subscription_id"])
        if filters.get("date_from"):
            query += " AND date >= ?"
            params.append(filters["date_from"])
        if filters.get("date_to"):
            query += " AND date <= ?"
            params.append(filters["date_to"])
        if filters.get("resource_groups"):
            vals = filters["resource_groups"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"resource_group IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_resource_group"):
                cond = f"({cond} OR resource_group IS NULL OR resource_group='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_resource_group"):
            query += " AND (resource_group IS NULL OR resource_group='')"
        elif filters.get("resource_group"):
            query += " AND resource_group LIKE ?"
            params.append(f"%{filters['resource_group']}%")
        if filters.get("service_names"):
            vals = filters["service_names"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"service_name IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_service"):
                cond = f"({cond} OR service_name IS NULL OR service_name='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_service"):
            query += " AND (service_name IS NULL OR service_name='')"
        elif filters.get("service_name"):
            query += " AND service_name = ?"
            params.append(filters['service_name'])
        if filters.get("resource_type"):
            query += " AND resource_type LIKE ?"
            params.append(f"%{filters['resource_type']}%")
        if filters.get("meter_category"):
            query += " AND meter_category LIKE ?"
            params.append(f"%{filters['meter_category']}%")
        if filters.get("search"):
            query += """ AND (resource_group LIKE ? OR service_name LIKE ?
                         OR resource_type LIKE ? OR resource_name LIKE ?
                         OR meter_category LIKE ?)"""
            s = f"%{filters['search']}%"
            params.extend([s, s, s, s, s])

    if tenant_id is not None:
        query += " AND tenant_id = ?"
        params.append(tenant_id)

    if cloud_provider is not None:
        query += " AND cloud_provider = ?"
        params.append(cloud_provider)

    row = conn.execute(query, params).fetchone()
    conn.close()
    return {
        "total_cost": round((row["total_cost"] or 0), 2),
        "total_records": row["total_records"] or 0
    }


def get_cost_totals_by_subscription(filters=None, tenant_id=None, cloud_provider=None):
    """Get total cost grouped by subscription for current filters (no subscription_id filter)."""
    conn = get_db()
    query = """
        SELECT
            cd.subscription_id as subscription_id,
            cd.cloud_provider as cloud_provider,
            s.name as subscription_name,
            cp.name as provider_name,
            SUM(cd.cost) as total_cost,
            COUNT(*) as total_records
        FROM cost_data cd
        LEFT JOIN subscriptions s ON s.subscription_id = cd.subscription_id
        LEFT JOIN cloud_providers cp ON cp.provider_id = cd.subscription_id
        WHERE 1=1
    """
    params = []

    if filters:
        if filters.get("subscription_ids"):
            vals = filters["subscription_ids"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"cd.subscription_id IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_subscription"):
                cond = f"({cond} OR cd.subscription_id IS NULL OR cd.subscription_id='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_subscription"):
            query += " AND (cd.subscription_id IS NULL OR cd.subscription_id='')"
        if filters.get("date_from"):
            query += " AND cd.date >= ?"
            params.append(filters["date_from"])
        if filters.get("date_to"):
            query += " AND cd.date <= ?"
            params.append(filters["date_to"])
        if filters.get("resource_groups"):
            vals = filters["resource_groups"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"cd.resource_group IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_resource_group"):
                cond = f"({cond} OR cd.resource_group IS NULL OR cd.resource_group='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_resource_group"):
            query += " AND (cd.resource_group IS NULL OR cd.resource_group='')"
        elif filters.get("resource_group"):
            query += " AND cd.resource_group LIKE ?"
            params.append(f"%{filters['resource_group']}%")
        if filters.get("service_names"):
            vals = filters["service_names"]
            placeholders = ",".join(["?"] * len(vals))
            cond = f"cd.service_name IN ({placeholders})"
            params.extend(vals)
            if filters.get("include_blank_service"):
                cond = f"({cond} OR cd.service_name IS NULL OR cd.service_name='')"
            query += f" AND {cond}"
        elif filters.get("include_blank_service"):
            query += " AND (cd.service_name IS NULL OR cd.service_name='')"
        elif filters.get("service_name"):
            query += " AND cd.service_name = ?"
            params.append(filters['service_name'])
        if filters.get("resource_type"):
            query += " AND cd.resource_type LIKE ?"
            params.append(f"%{filters['resource_type']}%")
        if filters.get("meter_category"):
            query += " AND cd.meter_category LIKE ?"
            params.append(f"%{filters['meter_category']}%")
        if filters.get("search"):
            query += """ AND (cd.resource_group LIKE ? OR cd.service_name LIKE ?
                              OR cd.resource_type LIKE ? OR cd.resource_name LIKE ?
                              OR cd.meter_category LIKE ?)"""
            s = f"%{filters['search']}%"
            params.extend([s, s, s, s, s])

    if tenant_id is not None:
        query += " AND cd.tenant_id = ?"
        params.append(tenant_id)

    if cloud_provider is not None:
        query += " AND cd.cloud_provider = ?"
        params.append(cloud_provider)

    query += " GROUP BY cd.subscription_id, s.name, cp.name, cd.cloud_provider ORDER BY total_cost DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()

    cloud_icons = {"azure": "⊞", "aws": "⚙", "gcp": "◉"}
    result = []
    for r in rows:
        raw_id = r["subscription_id"] or ""
        cloud = r["cloud_provider"] or "azure"
        # Prefer registered name (Azure subscriptions → subscriptions table, AWS/GCP → cloud_providers table)
        if r["subscription_name"]:
            name = r["subscription_name"]
        elif r["provider_name"]:
            name = r["provider_name"]
        elif raw_id and raw_id.isdigit() and len(raw_id) > 6:
            label = "Project" if cloud == "gcp" else "Account"
            name = f"{label} ···{raw_id[-4:]}"
        else:
            name = raw_id[:24] or "Unknown"
        result.append({
            "subscription_id": raw_id,
            "subscription_name": f"{cloud_icons.get(cloud, '☁')} {name}",
            "cloud": cloud,
            "total_cost": round((r["total_cost"] or 0), 2),
            "total_records": r["total_records"] or 0,
        })
    return result


def get_summary(group_by="service_name", date_from=None, date_to=None, subscription_id=None, tenant_id=None, cloud_provider=None):
    conn = get_db()
    valid_groups = ["service_name", "resource_group", "resource_type", "meter_category", "date"]
    if group_by not in valid_groups:
        group_by = "service_name"

    query = f"""
        SELECT {group_by}, SUM(cost) as total_cost, COUNT(*) as record_count,
               currency
        FROM cost_data WHERE 1=1
    """
    params = []
    if subscription_id:
        query += " AND subscription_id = ?"
        params.append(subscription_id)
    if date_from:
        query += " AND date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND date <= ?"
        params.append(date_to)
    if tenant_id is not None:
        query += " AND tenant_id = ?"
        params.append(tenant_id)
    if cloud_provider:
        query += " AND cloud_provider = ?"
        params.append(cloud_provider)

    query += f" GROUP BY {group_by} ORDER BY total_cost DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_daily_trend(date_from=None, date_to=None, resource_group=None, service_name=None, subscription_id=None, tenant_id=None, cloud_provider=None):
    conn = get_db()
    query = """
        SELECT SUBSTR(date, 1, 10) AS date, SUM(cost) as total_cost, currency
        FROM cost_data WHERE 1=1
    """
    params = []
    if subscription_id:
        query += " AND subscription_id = ?"
        params.append(subscription_id)
    if date_from:
        query += " AND SUBSTR(date, 1, 10) >= ?"
        params.append(date_from)
    if date_to:
        query += " AND SUBSTR(date, 1, 10) <= ?"
        params.append(date_to)
    if resource_group:
        query += " AND resource_group LIKE ?"
        params.append(f"%{resource_group}%")
    if service_name:
        query += " AND service_name = ?"
        params.append(service_name)
    if tenant_id is not None:
        query += " AND tenant_id = ?"
        params.append(tenant_id)
    if cloud_provider is not None:
        query += " AND cloud_provider = ?"
        params.append(cloud_provider)

    query += " GROUP BY SUBSTR(date, 1, 10) ORDER BY date ASC"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_comparison_data(group_by, date_from_1, date_to_1, date_from_2, date_to_2, subscription_id=None, resource_groups=None, tenant_id=None, cloud_provider=None, subscription_ids=None):
    """Get cost grouped by a dimension for two periods side-by-side."""
    conn = get_db()
    valid_groups = ["service_name", "resource_group", "meter_category", "subscription_id", "resource_name"]
    if group_by not in valid_groups:
        group_by = "service_name"

    query = f"""
        SELECT
            {group_by} as name,
            SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as period1_cost,
            SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as period2_cost,
            SUM(cost) as total_cost
        FROM cost_data
    """
    query += " WHERE ((date >= ? AND date <= ?) OR (date >= ? AND date <= ?))"
    if subscription_ids:
        placeholders = ','.join('?' for _ in subscription_ids)
        query += f" AND subscription_id IN ({placeholders})"
    elif subscription_id:
        query += " AND subscription_id = ?"
    if resource_groups:
        placeholders = ','.join('?' for _ in resource_groups)
        query += f" AND resource_group IN ({placeholders})"
    if tenant_id is not None:
        query += " AND tenant_id = ?"
    if cloud_provider:
        query += " AND cloud_provider = ?"
    query += f" GROUP BY {group_by} ORDER BY total_cost DESC"
    params = [
        date_from_1, date_to_1,
        date_from_2, date_to_2,
        date_from_1, date_to_1,
        date_from_2, date_to_2,
    ]
    if subscription_ids:
        params.extend(subscription_ids)
    elif subscription_id:
        params.append(subscription_id)
    if resource_groups:
        params.extend(resource_groups)
    if tenant_id is not None:
        params.append(tenant_id)
    if cloud_provider:
        params.append(cloud_provider)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_comparison_data_multi(group_by, periods, subscription_id=None, resource_groups=None, tenant_id=None, cloud_provider=None, subscription_ids=None):
    """Get cost grouped by a dimension for 2–6 periods side-by-side.
    periods: list of (date_from, date_to) strings, same length as number of periods."""
    conn = get_db()
    valid_groups = ["service_name", "resource_group", "meter_category", "subscription_id", "resource_name"]
    if group_by not in valid_groups:
        group_by = "service_name"

    n = len(periods)
    if n < 2 or n > 6:
        conn.close()
        return []

    case_cols = ", ".join(
        f"SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as p{i}" for i in range(n)
    )
    date_or = " OR ".join("(date >= ? AND date <= ?)" for _ in periods)

    query = f"""
        SELECT
            {group_by} as name,
            {case_cols},
            SUM(cost) as total_cost
        FROM cost_data
        WHERE ({date_or})
    """
    if subscription_ids:
        placeholders = ",".join("?" for _ in subscription_ids)
        query += f" AND subscription_id IN ({placeholders})"
    elif subscription_id:
        query += " AND subscription_id = ?"
    if resource_groups:
        placeholders = ",".join("?" for _ in resource_groups)
        query += f" AND resource_group IN ({placeholders})"
    if tenant_id is not None:
        query += " AND tenant_id = ?"
    if cloud_provider:
        query += " AND cloud_provider = ?"
    query += f" GROUP BY {group_by} ORDER BY total_cost DESC"

    params = []
    for df, dt in periods:
        params.extend([df, dt])
    for df, dt in periods:
        params.extend([df, dt])
    if subscription_ids:
        params.extend(subscription_ids)
    elif subscription_id:
        params.append(subscription_id)
    if resource_groups:
        params.extend(resource_groups)
    if tenant_id is not None:
        params.append(tenant_id)
    if cloud_provider:
        params.append(cloud_provider)

    rows = conn.execute(query, params).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        name = d["name"]
        costs = [float(d[f"p{i}"] or 0) for i in range(n)]
        out.append({"name": name, "costs": costs, "total_cost": float(d["total_cost"] or 0)})
    return out


def get_comparison_drilldown(group_by, group_value, date_from_1, date_to_1, date_from_2, date_to_2, subscription_id=None, resource_groups=None, tenant_id=None):
    """Get detailed breakdown for a specific item (e.g. a specific RG) across two periods.
    Returns sub-items grouped by the other dimensions."""
    conn = get_db()

    # Determine sub-group columns based on what we're drilling into
    if group_by == "resource_group":
        sub_groups = [
            ("service_name", "Service"),
            ("meter_category", "Meter Category"),
        ]
    elif group_by == "service_name":
        sub_groups = [
            ("resource_group", "Resource Group"),
            ("meter_category", "Meter Category"),
        ]
    else:  # meter_category
        sub_groups = [
            ("service_name", "Service"),
            ("resource_group", "Resource Group"),
        ]

    result = {}
    for sub_col, sub_label in sub_groups:
        query = f"""
            SELECT
                {sub_col} as name,
                SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as period1_cost,
                SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as period2_cost,
                SUM(cost) as total_cost
            FROM cost_data
            WHERE {group_by} = ?
              AND ((date >= ? AND date <= ?) OR (date >= ? AND date <= ?))
        """
        if subscription_id:
            query += " AND subscription_id = ?"
        if resource_groups:
            placeholders = ','.join('?' for _ in resource_groups)
            query += f" AND resource_group IN ({placeholders})"
        if tenant_id is not None:
            query += " AND tenant_id = ?"
        query += f" GROUP BY {sub_col} ORDER BY total_cost DESC"
        params = [
            date_from_1, date_to_1,
            date_from_2, date_to_2,
            group_value,
            date_from_1, date_to_1,
            date_from_2, date_to_2,
        ]
        if subscription_id:
            params.append(subscription_id)
        if resource_groups:
            params.extend(resource_groups)
        if tenant_id is not None:
            params.append(tenant_id)
        rows = conn.execute(query, params).fetchall()
        result[sub_label] = [dict(r) for r in rows]

    # Also get daily trend for this item in both periods
    daily_query = f"""
        SELECT date, SUM(cost) as total_cost
        FROM cost_data
        WHERE {group_by} = ?
          AND ((date >= ? AND date <= ?) OR (date >= ? AND date <= ?))
    """
    if subscription_id:
        daily_query += " AND subscription_id = ?"
    if resource_groups:
        placeholders = ','.join('?' for _ in resource_groups)
        daily_query += f" AND resource_group IN ({placeholders})"
    if tenant_id is not None:
        daily_query += " AND tenant_id = ?"
    daily_query += " GROUP BY date ORDER BY date ASC"
    daily_params = [group_value, date_from_1, date_to_1, date_from_2, date_to_2]
    if subscription_id:
        daily_params.append(subscription_id)
    if resource_groups:
        daily_params.extend(resource_groups)
    if tenant_id is not None:
        daily_params.append(tenant_id)
    daily_rows = conn.execute(daily_query, daily_params).fetchall()
    result["daily_trend"] = [dict(r) for r in daily_rows]

    conn.close()
    return result


def get_comparison_drilldown_multi(group_by, group_value, periods, subscription_id=None, resource_groups=None, tenant_id=None):
    """Drilldown for 2–6 periods: sub-groups and daily trend for one group value."""
    conn = get_db()
    n = len(periods)
    if n < 2 or n > 6:
        conn.close()
        return {}

    if group_by == "resource_group":
        sub_groups = [
            ("service_name", "Service"),
            ("meter_category", "Meter Category"),
        ]
    elif group_by == "service_name":
        sub_groups = [
            ("resource_group", "Resource Group"),
            ("meter_category", "Meter Category"),
        ]
    else:
        sub_groups = [
            ("service_name", "Service"),
            ("resource_group", "Resource Group"),
        ]

    case_cols = ", ".join(
        f"SUM(CASE WHEN date >= ? AND date <= ? THEN cost ELSE 0 END) as p{i}" for i in range(n)
    )
    date_or = " OR ".join("(date >= ? AND date <= ?)" for _ in periods)

    def params_for_subquery():
        p = []
        for df, dt in periods:
            p.extend([df, dt])
        p.append(group_value)
        for df, dt in periods:
            p.extend([df, dt])
        if subscription_id:
            p.append(subscription_id)
        if resource_groups:
            p.extend(resource_groups)
        if tenant_id is not None:
            p.append(tenant_id)
        return p

    result = {}
    for sub_col, sub_label in sub_groups:
        query = f"""
            SELECT
                {sub_col} as name,
                {case_cols},
                SUM(cost) as total_cost
            FROM cost_data
            WHERE {group_by} = ?
              AND ({date_or})
        """
        if subscription_id:
            query += " AND subscription_id = ?"
        if resource_groups:
            placeholders = ",".join("?" for _ in resource_groups)
            query += f" AND resource_group IN ({placeholders})"
        if tenant_id is not None:
            query += " AND tenant_id = ?"
        query += f" GROUP BY {sub_col} ORDER BY total_cost DESC"
        rows = conn.execute(query, params_for_subquery()).fetchall()
        result[sub_label] = []
        for r in rows:
            d = dict(r)
            costs = [float(d[f"p{i}"] or 0) for i in range(n)]
            result[sub_label].append({"name": d["name"], "costs": costs, "total_cost": float(d["total_cost"] or 0)})

    daily_query = f"""
        SELECT date, SUM(cost) as total_cost
        FROM cost_data
        WHERE {group_by} = ?
          AND ({date_or})
    """
    if subscription_id:
        daily_query += " AND subscription_id = ?"
    if resource_groups:
        placeholders = ",".join("?" for _ in resource_groups)
        daily_query += f" AND resource_group IN ({placeholders})"
    if tenant_id is not None:
        daily_query += " AND tenant_id = ?"
    daily_query += " GROUP BY date ORDER BY date ASC"
    daily_params = [group_value]
    for df, dt in periods:
        daily_params.extend([df, dt])
    if subscription_id:
        daily_params.append(subscription_id)
    if resource_groups:
        daily_params.extend(resource_groups)
    if tenant_id is not None:
        daily_params.append(tenant_id)
    daily_rows = conn.execute(daily_query, daily_params).fetchall()
    result["daily_trend"] = [dict(r) for r in daily_rows]

    conn.close()
    return result


def get_weekly_breakdown(group_by, date_from=None, date_to=None, subscription_id=None, resource_groups=None):
    """Get cost grouped by week and a dimension."""
    conn = get_db()
    valid_groups = ["service_name", "resource_group", "meter_category"]
    if group_by not in valid_groups:
        group_by = "service_name"

    query = f"""
        SELECT
            strftime('%Y-W%W', date) as week,
            MIN(date) as week_start,
            MAX(date) as week_end,
            {group_by} as name,
            SUM(cost) as total_cost
        FROM cost_data
        WHERE 1=1
    """
    params = []
    if subscription_id:
        query += " AND subscription_id = ?"
        params.append(subscription_id)
    if date_from:
        query += " AND date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND date <= ?"
        params.append(date_to)
    if resource_groups:
        placeholders = ','.join('?' for _ in resource_groups)
        query += f" AND resource_group IN ({placeholders})"
        params.extend(resource_groups)

    query += f" GROUP BY week, {group_by} ORDER BY week ASC, total_cost DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_available_periods(subscription_id=None):
    """Get list of available months and weeks for comparison dropdowns."""
    conn = get_db()
    month_query = """
        SELECT strftime('%Y-%m', date) as month, MIN(date) as start_date, MAX(date) as end_date,
               SUM(cost) as total_cost
        FROM cost_data
    """
    week_query = """
        SELECT strftime('%Y-W%W', date) as week, MIN(date) as start_date, MAX(date) as end_date,
               SUM(cost) as total_cost
        FROM cost_data
    """
    params = []
    if subscription_id:
        month_query += " WHERE subscription_id = ?"
        week_query += " WHERE subscription_id = ?"
        params = [subscription_id]
    month_query += " GROUP BY month ORDER BY month ASC"
    week_query += " GROUP BY week ORDER BY week ASC"
    months = conn.execute(month_query, params).fetchall()
    weeks = conn.execute(week_query, params).fetchall()
    conn.close()
    return {
        "months": [dict(r) for r in months],
        "weeks": [dict(r) for r in weeks]
    }


def get_distinct_values(column, subscription_id=None, subscription_ids=None, cloud_provider=None):
    conn = get_db()
    valid = ["resource_group", "service_name", "resource_type", "meter_category"]
    if column not in valid:
        return []
    conditions = [f"{column} IS NOT NULL"]
    params = []
    if subscription_ids:
        placeholders = ",".join(["?"] * len(subscription_ids))
        conditions.append(f"subscription_id IN ({placeholders})")
        params.extend(subscription_ids)
    elif subscription_id:
        conditions.append("subscription_id = ?")
        params.append(subscription_id)
    if cloud_provider:
        conditions.append("cloud_provider = ?")
        params.append(cloud_provider)
    where = " AND ".join(conditions)
    rows = conn.execute(
        f"SELECT DISTINCT {column} FROM cost_data WHERE {where} ORDER BY {column}",
        params
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def get_custom_cost(subscription_id=None, subscription_ids=None, resource_groups=None, services=None, date_from=None, date_to=None, tenant_id=None, cloud_provider=None):
    """Calculate cost for a custom combination of subscriptions, RGs, and services."""
    conn = get_db()
    query = "SELECT SUM(cost) as total_cost, COUNT(*) as records FROM cost_data WHERE 1=1"
    params = []

    if subscription_ids and len(subscription_ids) > 0:
        placeholders = ",".join(["?"] * len(subscription_ids))
        query += f" AND subscription_id IN ({placeholders})"
        params.extend(subscription_ids)
    elif subscription_id:
        query += " AND subscription_id = ?"
        params.append(subscription_id)
    if date_from:
        query += " AND date >= ?"
        params.append(date_from)
    if date_to:
        query += " AND date <= ?"
        params.append(date_to)
    if resource_groups:
        placeholders = ",".join(["?"] * len(resource_groups))
        query += f" AND resource_group IN ({placeholders})"
        params.extend(resource_groups)
    if services:
        placeholders = ",".join(["?"] * len(services))
        query += f" AND service_name IN ({placeholders})"
        params.extend(services)
    if tenant_id is not None:
        query += " AND tenant_id = ?"
        params.append(tenant_id)
    if cloud_provider is not None:
        query += " AND cloud_provider = ?"
        params.append(cloud_provider)

    row = conn.execute(query, params).fetchone()
    total = round((row["total_cost"] or 0), 2)
    records = row["records"] or 0

    # Breakdown by RG
    rg_query = query.replace("SUM(cost) as total_cost, COUNT(*) as records",
                              "resource_group, SUM(cost) as total_cost, COUNT(*) as records")
    rg_query += " GROUP BY resource_group ORDER BY total_cost DESC"
    rg_rows = conn.execute(rg_query, params).fetchall()

    # Breakdown by service
    svc_query = query.replace("SUM(cost) as total_cost, COUNT(*) as records",
                               "service_name, SUM(cost) as total_cost, COUNT(*) as records")
    svc_query += " GROUP BY service_name ORDER BY total_cost DESC"
    svc_rows = conn.execute(svc_query, params).fetchall()

    # Daily trend
    trend_query = query.replace("SUM(cost) as total_cost, COUNT(*) as records",
                                 "date, SUM(cost) as total_cost")
    trend_query += " GROUP BY date ORDER BY date ASC"
    trend_rows = conn.execute(trend_query, params).fetchall()

    # Breakdown by logical Azure resource (sums all meter lines for that resource)
    res_query = query.replace(
        "SUM(cost) as total_cost, COUNT(*) as records",
        "resource_group, COALESCE(resource_type,'') as resource_type, COALESCE(resource_name,'') as resource_name, "
        "SUM(cost) as total_cost, COUNT(*) as records",
    )
    res_query += (
        " GROUP BY resource_group, COALESCE(resource_type,''), COALESCE(resource_name,'') "
        "ORDER BY total_cost DESC LIMIT 500"
    )
    res_rows = conn.execute(res_query, params).fetchall()
    by_resource_truncated = len(res_rows) >= 500

    conn.close()
    return {
        "total_cost": total,
        "total_records": records,
        "by_rg": [{"name": r["resource_group"] or "Unknown", "cost": round(r["total_cost"], 2), "records": r["records"]} for r in rg_rows],
        "by_service": [{"name": r["service_name"] or "Unknown", "cost": round(r["total_cost"], 2), "records": r["records"]} for r in svc_rows],
        "by_resource": [
            {
                "resource_group": r["resource_group"] or "Unknown",
                "resource_type": r["resource_type"] or "",
                "resource_name": r["resource_name"] or "",
                "cost": round(r["total_cost"], 2),
                "records": r["records"],
            }
            for r in res_rows
        ],
        "by_resource_truncated": by_resource_truncated,
        "daily_trend": [{"date": r["date"], "cost": round(r["total_cost"], 2)} for r in trend_rows],
    }


def save_custom_report(data):
    conn = get_db()
    conn.execute(
        """INSERT INTO custom_reports (name, recipients, filters, sections, schedule, schedule_day, schedule_hour, enabled)
           VALUES (?,?,?,?,?,?,?,?)""",
        (data["name"], data.get("recipients", ""),
         json.dumps(data.get("filters", {})),
         json.dumps(data.get("sections", ["summary", "by_service", "by_rg", "trend"])),
         data.get("schedule", "none"),
         data.get("schedule_day", 1),
         data.get("schedule_hour", 8),
         1 if data.get("enabled") else 0)
    )
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return rid


def get_custom_reports():
    conn = get_db()
    rows = conn.execute("SELECT * FROM custom_reports ORDER BY updated_at DESC").fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["filters"] = json.loads(d["filters"])
        except Exception:
            d["filters"] = {}
        try:
            d["sections"] = json.loads(d["sections"])
        except Exception:
            d["sections"] = []
        d["enabled"] = bool(d.get("enabled", 0))
        result.append(d)
    return result


def get_custom_report(rid):
    conn = get_db()
    row = conn.execute("SELECT * FROM custom_reports WHERE id=?", (rid,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["filters"] = json.loads(d["filters"])
    except Exception:
        d["filters"] = {}
    try:
        d["sections"] = json.loads(d["sections"])
    except Exception:
        d["sections"] = []
    d["enabled"] = bool(d.get("enabled", 0))
    return d


def update_custom_report(rid, data):
    conn = get_db()
    fields = []
    params = []
    allowed = ["name", "recipients", "filters", "sections", "schedule",
               "schedule_day", "schedule_hour", "enabled", "last_sent"]
    for key in allowed:
        if key in data:
            val = data[key]
            if key in ("filters", "sections") and isinstance(val, (dict, list)):
                val = json.dumps(val)
            elif key == "enabled":
                val = 1 if val else 0
            fields.append(f"{key}=?")
            params.append(val)
    if not fields:
        conn.close()
        return
    fields.append("updated_at=CURRENT_TIMESTAMP")
    params.append(rid)
    conn.execute(f"UPDATE custom_reports SET {', '.join(fields)} WHERE id=?", params)
    conn.commit()
    conn.close()


def delete_custom_report(rid):
    conn = get_db()
    conn.execute("DELETE FROM custom_reports WHERE id=?", (rid,))
    conn.commit()
    conn.close()


def get_email_settings():
    conn = get_db()
    row = conn.execute("SELECT * FROM email_settings WHERE id=1").fetchone()
    conn.close()
    if not row:
        return {}
    d = dict(row)
    d["smtp_use_tls"] = bool(d.get("smtp_use_tls", 1))
    d["enabled"] = bool(d.get("enabled", 0))
    d["recipients"] = d.get("recipients", "")
    d["report_date_range"] = d.get("report_date_range") or "this_month"
    d["report_date_from"] = d.get("report_date_from") or ""
    d["report_date_to"] = d.get("report_date_to") or ""
    d["report_cloud_provider"] = d.get("report_cloud_provider") or ""
    try:
        d["report_sections"] = json.loads(d.get("report_sections", "[]"))
    except Exception:
        d["report_sections"] = ["summary", "subscriptions", "top_services", "top_rgs", "trend"]
    return d


def update_email_settings(settings):
    conn = get_db()
    fields = []
    params = []
    allowed = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_from",
               "smtp_use_tls", "recipients", "schedule", "schedule_day", "schedule_hour",
               "report_date_range", "report_date_from", "report_date_to",
               "report_cloud_provider", "report_sections", "enabled"]
    for key in allowed:
        if key in settings:
            val = settings[key]
            if key == "smtp_use_tls" or key == "enabled":
                val = 1 if val else 0
            elif key == "report_sections":
                val = json.dumps(val) if isinstance(val, list) else val
            fields.append(f"{key}=?")
            params.append(val)

    if not fields:
        conn.close()
        return
    fields.append("updated_at=CURRENT_TIMESTAMP")
    params.append(1)
    conn.execute(f"UPDATE email_settings SET {', '.join(fields)} WHERE id=?", params)
    conn.commit()
    conn.close()


def get_integration_settings():
    conn = get_db()
    row = conn.execute("SELECT * FROM integration_settings WHERE id=1").fetchone()
    conn.close()
    if not row:
        return {}
    d = dict(row)
    for k in ("jira_enabled", "bitbucket_enabled", "cursor_enabled", "openai_enabled"):
        d[k] = bool(d.get(k, 0))
    return d


def update_integration_settings(settings):
    conn = get_db()
    allowed = [
        "jira_url", "jira_email", "jira_token", "jira_project", "jira_issue_type", "jira_enabled",
        "jira_admin_token", "jira_admin_org_id",
        "jira_mode", "jira_server_user", "jira_server_password",
        "bitbucket_workspace", "bitbucket_repo", "bitbucket_token", "bitbucket_enabled",
        "cursor_api_key", "cursor_enabled",
        "openai_api_key", "openai_org_id", "openai_enabled",
    ]
    fields, params = [], []
    for key in allowed:
        if key in settings:
            val = settings[key]
            if key.endswith("_enabled"):
                val = 1 if val else 0
            fields.append(f"{key}=?")
            params.append(val)
    if not fields:
        conn.close()
        return
    fields.append("updated_at=CURRENT_TIMESTAMP")
    params.append(1)
    conn.execute(f"UPDATE integration_settings SET {', '.join(fields)} WHERE id=?", params)
    conn.commit()
    conn.close()


def log_email(recipients, subject, status="sent", error=None, report_type="scheduled"):
    conn = get_db()
    conn.execute(
        "INSERT INTO email_log (recipients, subject, status, error, report_type) VALUES (?,?,?,?,?)",
        (recipients, subject, status, error, report_type)
    )
    conn.commit()
    conn.close()


def get_email_log(limit=20):
    conn = get_db()
    rows = conn.execute("SELECT * FROM email_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def save_filter(name, filters):
    conn = get_db()
    conn.execute(
        "INSERT INTO saved_filters (name, filters) VALUES (?, ?)",
        (name, json.dumps(filters))
    )
    conn.commit()
    fid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return fid


def get_saved_filters():
    conn = get_db()
    rows = conn.execute("SELECT * FROM saved_filters ORDER BY updated_at DESC").fetchall()
    conn.close()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "name": r["name"],
            "filters": json.loads(r["filters"]),
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        })
    return result


def update_saved_filter(fid, name=None, filters=None):
    conn = get_db()
    if name and filters:
        conn.execute(
            "UPDATE saved_filters SET name=?, filters=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (name, json.dumps(filters), fid)
        )
    elif name:
        conn.execute("UPDATE saved_filters SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (name, fid))
    elif filters:
        conn.execute("UPDATE saved_filters SET filters=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(filters), fid))
    conn.commit()
    conn.close()


def delete_saved_filter(fid):
    conn = get_db()
    conn.execute("DELETE FROM saved_filters WHERE id=?", (fid,))
    conn.commit()
    conn.close()


def get_sync_history():
    conn = get_db()
    rows = conn.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT 20").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_monthly_summary(subscription_id=None, tenant_id=None, cloud_provider=None):
    conn = get_db()
    query = """
        SELECT
            strftime('%Y-%m', date) as month,
            SUM(cost) as total_cost,
            COUNT(*) as record_count,
            COUNT(DISTINCT resource_group) as rg_count,
            COUNT(DISTINCT service_name) as service_count,
            currency
        FROM cost_data
    """
    params = []
    conditions = []
    if subscription_id:
        conditions.append("subscription_id = ?")
        params.append(subscription_id)
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    if cloud_provider is not None:
        conditions.append("cloud_provider = ?")
        params.append(cloud_provider)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " GROUP BY strftime('%Y-%m', date) ORDER BY month ASC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_monthly_service_breakdown(subscription_id=None, tenant_id=None, cloud_provider=None):
    conn = get_db()
    query = """
        SELECT
            strftime('%Y-%m', date) as month,
            service_name,
            SUM(cost) as total_cost,
            currency
        FROM cost_data
    """
    params = []
    conditions = []
    if subscription_id:
        conditions.append("subscription_id = ?")
        params.append(subscription_id)
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    if cloud_provider is not None:
        conditions.append("cloud_provider = ?")
        params.append(cloud_provider)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " GROUP BY strftime('%Y-%m', date), service_name ORDER BY month ASC, total_cost DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_monthly_rg_breakdown(subscription_id=None, tenant_id=None, cloud_provider=None):
    conn = get_db()
    query = """
        SELECT
            strftime('%Y-%m', date) as month,
            resource_group,
            SUM(cost) as total_cost,
            currency
        FROM cost_data
    """
    params = []
    conditions = []
    if subscription_id:
        conditions.append("subscription_id = ?")
        params.append(subscription_id)
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    if cloud_provider is not None:
        conditions.append("cloud_provider = ?")
        params.append(cloud_provider)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " GROUP BY strftime('%Y-%m', date), resource_group ORDER BY month ASC, total_cost DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_monthly_subscription_breakdown(subscription_id=None, tenant_id=None, cloud_provider=None):
    """Per month, per subscription totals (with display name from subscriptions and cloud_providers tables)."""
    conn = get_db()
    query = """
        SELECT
            strftime('%Y-%m', cd.date) as month,
            cd.subscription_id,
            cd.cloud_provider,
            s.name as subscription_name,
            cp.name as provider_name,
            SUM(cd.cost) as total_cost
        FROM cost_data cd
        LEFT JOIN subscriptions s ON s.subscription_id = cd.subscription_id
        LEFT JOIN cloud_providers cp ON cp.provider_id = cd.subscription_id
    """
    params = []
    conditions = []
    if subscription_id:
        conditions.append("cd.subscription_id = ?")
        params.append(subscription_id)
    if tenant_id is not None:
        conditions.append("cd.tenant_id = ?")
        params.append(tenant_id)
    if cloud_provider is not None:
        conditions.append("cd.cloud_provider = ?")
        params.append(cloud_provider)
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += """
        GROUP BY strftime('%Y-%m', cd.date), cd.subscription_id, s.name, cp.name, cd.cloud_provider
        ORDER BY month ASC, total_cost DESC
    """
    rows = conn.execute(query, params).fetchall()
    conn.close()

    result = []
    for r in rows:
        raw_id = r["subscription_id"] or ""
        cloud = r["cloud_provider"] or "azure"
        if r["subscription_name"]:
            name = r["subscription_name"]
        elif r["provider_name"]:
            name = r["provider_name"]
        elif raw_id and raw_id.isdigit() and len(raw_id) > 6:
            label = "Project" if cloud == "gcp" else "Account"
            name = f"{label} ···{raw_id[-4:]}"
        else:
            name = raw_id[:24] or "Unknown"
        result.append({
            "month": r["month"],
            "subscription_id": raw_id,
            "subscription_name": name,
            "cloud_provider": cloud,
            "total_cost": round(r["total_cost"] or 0, 2),
        })
    return result


def get_stats(subscription_id=None):
    conn = get_db()
    stats = {}
    if subscription_id:
        row = conn.execute("SELECT COUNT(*) as cnt, SUM(cost) as total, MIN(date) as min_date, MAX(date) as max_date FROM cost_data WHERE subscription_id = ?",
                           (subscription_id,)).fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) as cnt, SUM(cost) as total, MIN(date) as min_date, MAX(date) as max_date FROM cost_data").fetchone()
    stats["total_records"] = row["cnt"]
    stats["total_cost"] = round(row["total"] or 0, 2)
    stats["date_range_from"] = row["min_date"]
    stats["date_range_to"] = row["max_date"]
    conn.close()
    return stats


def insert_activity_logs(logs, subscription_id=None, cloud_provider="azure"):
    if not logs:
        return 0
    conn = get_db()
    cursor = conn.cursor()
    inserted = 0
    sub = subscription_id or ""
    cp = cloud_provider or "azure"
    for log in logs:
        try:
            t = list(log)
            eid = (t[0] or "").strip()
            if not eid:
                h = hashlib.sha256(
                    "|".join(
                        str(x) for x in (sub, cp, t[1], t[2], t[3], t[8], t[4])
                    ).encode("utf-8", errors="replace")
                ).hexdigest()[:48]
                eid = f"synth:{h}"
            cursor.execute("""
                INSERT OR IGNORE INTO activity_logs
                (event_id, subscription_id, cloud_provider, timestamp, caller, operation, operation_name,
                 resource_group, resource_type, resource_name, resource_id,
                 status, level, category, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (eid, sub, cp, *t[1:]))
            inserted += cursor.rowcount
        except Exception:
            pass
    conn.commit()
    conn.close()
    return inserted


def query_activity_logs(filters=None):
    conn = get_db()
    # Join subscriptions so API/UI get subscription_name (activity_logs only stores subscription_id)
    query = """
        SELECT al.id, al.event_id, al.subscription_id, al.timestamp, al.caller, al.operation,
               al.operation_name, al.resource_group, al.resource_type, al.resource_name,
               al.resource_id, al.status, al.level, al.category, al.description, al.created_at,
               COALESCE(s.name, al.subscription_id, '') AS subscription_name
        FROM activity_logs al
        LEFT JOIN subscriptions s ON s.subscription_id = al.subscription_id
        WHERE 1=1
    """
    params = []

    if filters:
        if filters.get("subscription_id"):
            query += " AND al.subscription_id = ?"
            params.append(filters["subscription_id"])
        if filters.get("date_from"):
            query += " AND al.timestamp >= ?"
            params.append(filters["date_from"])
        if filters.get("date_to"):
            query += " AND al.timestamp <= ?"
            params.append(filters["date_to"] + "T23:59:59")
        if filters.get("caller"):
            query += " AND al.caller LIKE ?"
            params.append(f"%{filters['caller']}%")
        if filters.get("resource_group"):
            query += " AND al.resource_group LIKE ?"
            params.append(f"%{filters['resource_group']}%")
        if filters.get("status"):
            query += " AND al.status = ?"
            params.append(filters["status"])
        if filters.get("level"):
            query += " AND al.level = ?"
            params.append(filters["level"])
        if filters.get("cloud_provider"):
            query += " AND al.cloud_provider = ?"
            params.append(filters["cloud_provider"])
        if filters.get("search"):
            query += """ AND (al.caller LIKE ? OR al.operation_name LIKE ?
                         OR al.resource_name LIKE ? OR al.resource_group LIKE ?
                         OR al.description LIKE ?)"""
            s = f"%{filters['search']}%"
            params.extend([s, s, s, s, s])

    query += " ORDER BY al.timestamp DESC"
    limit = filters.get("limit", 200) if filters else 200
    query += " LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_activity_stats():
    conn = get_db()
    stats = {}
    row = conn.execute("SELECT COUNT(*) as cnt, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM activity_logs").fetchone()
    stats["total_events"] = row["cnt"]
    stats["earliest"] = row["min_ts"]
    stats["latest"] = row["max_ts"]

    callers = conn.execute("SELECT DISTINCT caller FROM activity_logs WHERE caller IS NOT NULL AND caller != '' ORDER BY caller").fetchall()
    stats["callers"] = [r[0] for r in callers]

    statuses = conn.execute("SELECT status, COUNT(*) as cnt FROM activity_logs GROUP BY status ORDER BY cnt DESC").fetchall()
    stats["by_status"] = {r["status"]: r["cnt"] for r in statuses}

    recent = conn.execute("""
        SELECT caller, operation_name, resource_name, resource_group, status, level, timestamp
        FROM activity_logs ORDER BY timestamp DESC LIMIT 10
    """).fetchall()
    stats["recent"] = [dict(r) for r in recent]

    return stats


def get_latest_activity_timestamp(subscription_id=None):
    conn = get_db()
    if subscription_id:
        row = conn.execute("SELECT MAX(timestamp) as max_ts FROM activity_logs WHERE subscription_id = ?",
                           (subscription_id,)).fetchone()
    else:
        row = conn.execute("SELECT MAX(timestamp) as max_ts FROM activity_logs").fetchone()
    conn.close()
    return row["max_ts"] if row and row["max_ts"] else None


def save_caller_names(name_map):
    if not name_map:
        return
    conn = get_db()
    for cid, name in name_map.items():
        conn.execute(
            "INSERT OR REPLACE INTO caller_names (caller_id, display_name, updated_at) VALUES (?, ?, ?)",
            (cid, name, datetime.utcnow().isoformat())
        )
    conn.commit()
    conn.close()


def get_caller_names():
    conn = get_db()
    rows = conn.execute("SELECT caller_id, display_name FROM caller_names").fetchall()
    conn.close()
    return {r["caller_id"]: r["display_name"] for r in rows}


def save_aws_resource_names(name_map: dict, provider_id: str = None):
    """Cache AWS resource ID → display name (e.g. EC2 instance Name tag)."""
    if not name_map:
        return
    conn = get_db()
    now = datetime.utcnow().isoformat()
    for resource_id, display_name in name_map.items():
        conn.execute(
            "INSERT OR REPLACE INTO aws_resource_names (resource_id, display_name, provider_id, updated_at) VALUES (?, ?, ?, ?)",
            (resource_id, display_name, provider_id, now)
        )
    conn.commit()
    conn.close()


def get_aws_resource_names() -> dict:
    """Return all cached AWS resource ID → display name mappings."""
    conn = get_db()
    rows = conn.execute("SELECT resource_id, display_name FROM aws_resource_names").fetchall()
    conn.close()
    return {r["resource_id"]: r["display_name"] for r in rows}

def upsert_resource_configs(configs):
    """Insert or update resource configuration from ARG."""
    conn = get_db()
    args = []
    for c in configs:
        args.append((
            c.get("subscription_id"),
            c.get("resource_group"),
            c.get("resource_type"),
            c.get("resource_name"),
            c.get("location"),
            c.get("sku_name"),
            json.dumps(c.get("config_json", {})),
            c.get("power_state") or "",
            datetime.utcnow().isoformat()
        ))
    if not args:
        conn.close()
        return 0

    conn.executemany("""
        INSERT INTO resource_configs
        (subscription_id, resource_group, resource_type, resource_name, location, sku_name, config_json, power_state, last_synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id, resource_group, resource_name)
        DO UPDATE SET
            resource_type=excluded.resource_type,
            location=excluded.location,
            sku_name=excluded.sku_name,
            config_json=excluded.config_json,
            power_state=excluded.power_state,
            last_synced=excluded.last_synced
    """, args)
    conn.commit()
    count = conn.total_changes
    conn.close()
    return count

def get_resource_config(subscription_id, resource_group, resource_name):
    conn = get_db()
    row = conn.execute("""
        SELECT * FROM resource_configs 
        WHERE subscription_id = ? AND resource_group = ? AND resource_name = ?
    """, (subscription_id, resource_group, resource_name)).fetchone()
    conn.close()
    if row:
        d = dict(row)
        d["config_json"] = json.loads(d["config_json"]) if d["config_json"] else {}
        return d
    return None

def get_all_resource_configs(
    subscription_id=None,
    resource_group=None,
    resource_type=None,
    search=None,
    limit=500,
):
    conn = get_db()
    query = """
        SELECT rc.*, COALESCE(s.name, rc.subscription_id, '') AS subscription_name
        FROM resource_configs rc
        LEFT JOIN subscriptions s ON s.subscription_id = rc.subscription_id
        WHERE 1=1
    """
    params = []
    if subscription_id:
        query += " AND rc.subscription_id = ?"
        params.append(subscription_id)
    if resource_group:
        query += " AND rc.resource_group = ?"
        params.append(resource_group)
    if resource_type:
        query += " AND rc.resource_type = ?"
        params.append(resource_type)
    if search:
        query += """ AND (
            rc.resource_group LIKE ? OR rc.resource_name LIKE ? OR rc.resource_type LIKE ?
            OR IFNULL(rc.sku_name,'') LIKE ? OR IFNULL(s.name,'') LIKE ?
        )"""
        s = f"%{search}%"
        params.extend([s, s, s, s, s])

    query += " ORDER BY rc.resource_name ASC LIMIT ?"
    params.append(min(max(1, int(limit)), 2000))

    rows = conn.execute(query, params).fetchall()
    conn.close()

    results = []
    for r in rows:
        d = dict(r)
        d["config_json"] = json.loads(d["config_json"]) if d["config_json"] else {}
        results.append(d)
    return results


def get_resource_config_filter_options():
    """Distinct subscriptions, resource groups and resource types across all configs."""
    conn = get_db()
    subs = conn.execute("""
        SELECT DISTINCT rc.subscription_id AS v, COALESCE(s.name, rc.subscription_id, '') AS label
        FROM resource_configs rc
        LEFT JOIN subscriptions s ON s.subscription_id = rc.subscription_id
        WHERE rc.subscription_id IS NOT NULL AND trim(rc.subscription_id) != ''
        ORDER BY label
    """).fetchall()
    rgs = conn.execute("""
        SELECT DISTINCT resource_group AS v FROM resource_configs
        WHERE resource_group IS NOT NULL AND trim(resource_group) != ''
        ORDER BY resource_group
    """).fetchall()
    types = conn.execute("""
        SELECT DISTINCT resource_type AS v FROM resource_configs
        WHERE resource_type IS NOT NULL AND trim(resource_type) != ''
        ORDER BY resource_type
    """).fetchall()
    conn.close()
    return {
        "subscriptions": [{"id": r["v"], "name": r["label"]} for r in subs if r["v"]],
        "resource_groups": [r["v"] for r in rgs if r["v"]],
        "resource_types": [r["v"] for r in types if r["v"]],
    }


def get_activity_distinct(column):
    conn = get_db()
    valid = ["caller", "resource_group", "status", "level", "operation_name"]
    if column not in valid:
        return []
    rows = conn.execute(f"SELECT DISTINCT {column} FROM activity_logs WHERE {column} IS NOT NULL AND {column} != '' ORDER BY {column}").fetchall()
    conn.close()
    return [r[0] for r in rows]


# ─── Cloud Providers ──────────────────────────────────────────────────────────

def get_cloud_providers(enabled_only=False, tenant_id=None):
    conn = get_db()
    params = []
    conditions = []
    if enabled_only:
        conditions.append("enabled=1")
    if tenant_id is not None:
        conditions.append("tenant_id=?")
        params.append(tenant_id)
    q = "SELECT id,provider_type,name,provider_id,enabled,last_sync,sync_error,created_at FROM cloud_providers"
    if conditions:
        q += " WHERE " + " AND ".join(conditions)
    q += " ORDER BY provider_type, name"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_cloud_provider(provider_id_pk):
    conn = get_db()
    row = conn.execute("SELECT * FROM cloud_providers WHERE id=?", (provider_id_pk,)).fetchone()
    conn.close()
    if row:
        d = dict(row)
        try:
            d["credentials_json"] = json.loads(d["credentials_json"])
        except Exception:
            d["credentials_json"] = {}
        return d
    return None


def upsert_cloud_provider(provider_type, name, provider_id, credentials, enabled=True, tenant_id=None):
    conn = get_db()
    creds_str = json.dumps(credentials) if isinstance(credentials, dict) else credentials
    if tenant_id is not None:
        existing = conn.execute(
            "SELECT id FROM cloud_providers WHERE provider_type=? AND provider_id=? AND tenant_id=?",
            (provider_type, provider_id, tenant_id)
        ).fetchone()
    else:
        existing = conn.execute(
            "SELECT id FROM cloud_providers WHERE provider_type=? AND provider_id=?",
            (provider_type, provider_id)
        ).fetchone()
    if existing:
        conn.execute("""
            UPDATE cloud_providers SET name=?,credentials_json=?,enabled=?
            WHERE provider_type=? AND provider_id=?
        """, (name, creds_str, 1 if enabled else 0, provider_type, provider_id))
        row_id = existing["id"]
    else:
        if tenant_id is not None:
            cur = conn.execute("""
                INSERT INTO cloud_providers(provider_type,name,provider_id,credentials_json,enabled,tenant_id)
                VALUES(?,?,?,?,?,?)
            """, (provider_type, name, provider_id, creds_str, 1 if enabled else 0, tenant_id))
        else:
            cur = conn.execute("""
                INSERT INTO cloud_providers(provider_type,name,provider_id,credentials_json,enabled)
                VALUES(?,?,?,?,?)
            """, (provider_type, name, provider_id, creds_str, 1 if enabled else 0))
        row_id = cur.lastrowid
    conn.commit()
    conn.close()
    return row_id


def toggle_cloud_provider(pk, enabled):
    conn = get_db()
    conn.execute("UPDATE cloud_providers SET enabled=? WHERE id=?", (1 if enabled else 0, pk))
    conn.commit()
    conn.close()


def delete_cloud_provider(pk):
    conn = get_db()
    conn.execute("DELETE FROM cloud_providers WHERE id=?", (pk,))
    conn.commit()
    conn.close()


def update_cloud_provider_sync_time(pk, error=None):
    conn = get_db()
    conn.execute("UPDATE cloud_providers SET last_sync=?, sync_error=? WHERE id=?",
                 (datetime.utcnow().isoformat(), error, pk))
    conn.commit()
    conn.close()


# ─── Budgets ──────────────────────────────────────────────────────────────────

def get_budgets(enabled_only=False, tenant_id=None):
    conn = get_db()
    params = []
    conditions = []
    if enabled_only:
        conditions.append("enabled=1")
    if tenant_id is not None:
        conditions.append("tenant_id=?")
        params.append(tenant_id)
    q = "SELECT * FROM budgets"
    if conditions:
        q += " WHERE " + " AND ".join(conditions)
    q += " ORDER BY name"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["alert_thresholds"] = json.loads(d["alert_thresholds"]) if d["alert_thresholds"] else [80, 100]
        d["alert_channels"] = json.loads(d["alert_channels"]) if d["alert_channels"] else ["email"]
        result.append(d)
    return result


def create_budget(name, amount, provider_type="all", provider_id="",
                  period="monthly", alert_thresholds=None, alert_channels=None,
                  tenant_id=None, resource_group="", service_name="", scope_label="",
                  alert_emails=""):
    if alert_thresholds is None:
        alert_thresholds = [80, 100]
    if alert_channels is None:
        alert_channels = ["email"]
    conn = get_db()
    if tenant_id is not None:
        cur = conn.execute("""
            INSERT INTO budgets(name,provider_type,provider_id,amount,period,
                                alert_thresholds,alert_channels,tenant_id,
                                resource_group,service_name,scope_label,alert_emails)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """, (name, provider_type, provider_id, amount, period,
              json.dumps(alert_thresholds), json.dumps(alert_channels), tenant_id,
              resource_group, service_name, scope_label, alert_emails))
    else:
        cur = conn.execute("""
            INSERT INTO budgets(name,provider_type,provider_id,amount,period,
                                alert_thresholds,alert_channels,
                                resource_group,service_name,scope_label,alert_emails)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
        """, (name, provider_type, provider_id, amount, period,
              json.dumps(alert_thresholds), json.dumps(alert_channels),
              resource_group, service_name, scope_label, alert_emails))
    budget_id = cur.lastrowid
    conn.commit()
    conn.close()
    return budget_id


def update_budget(budget_id, **kwargs):
    conn = get_db()
    fields = []
    params = []
    for k, v in kwargs.items():
        if k in ("name", "amount", "provider_type", "provider_id", "period", "enabled"):
            fields.append(f"{k}=?")
            params.append(v)
        elif k in ("alert_thresholds", "alert_channels"):
            fields.append(f"{k}=?")
            params.append(json.dumps(v) if isinstance(v, list) else v)
    if not fields:
        conn.close()
        return
    fields.append("updated_at=?")
    params.append(datetime.utcnow().isoformat())
    params.append(budget_id)
    conn.execute(f"UPDATE budgets SET {', '.join(fields)} WHERE id=?", params)
    conn.commit()
    conn.close()


def delete_budget(budget_id):
    conn = get_db()
    conn.execute("DELETE FROM budget_alerts WHERE budget_id=?", (budget_id,))
    conn.execute("DELETE FROM budgets WHERE id=?", (budget_id,))
    conn.commit()
    conn.close()


# ─── Budget Alerts ────────────────────────────────────────────────────────────

def log_budget_alert(budget_id, threshold_pct, current_spend, budget_amount, notified_via=None):
    conn = get_db()
    conn.execute("""
        INSERT INTO budget_alerts(budget_id,threshold_pct,current_spend,budget_amount,notified_via)
        VALUES(?,?,?,?,?)
    """, (budget_id, threshold_pct, current_spend, budget_amount,
          json.dumps(notified_via or [])))
    conn.commit()
    conn.close()


def get_budget_alerts(budget_id=None, limit=50, tenant_id=None):
    conn = get_db()
    if budget_id:
        if tenant_id is not None:
            rows = conn.execute("""
                SELECT ba.*, b.name AS budget_name FROM budget_alerts ba
                JOIN budgets b ON b.id=ba.budget_id
                WHERE ba.budget_id=? AND b.tenant_id=? ORDER BY ba.triggered_at DESC LIMIT ?
            """, (budget_id, tenant_id, limit)).fetchall()
        else:
            rows = conn.execute("""
                SELECT ba.*, b.name AS budget_name FROM budget_alerts ba
                JOIN budgets b ON b.id=ba.budget_id
                WHERE ba.budget_id=? ORDER BY ba.triggered_at DESC LIMIT ?
            """, (budget_id, limit)).fetchall()
    else:
        if tenant_id is not None:
            rows = conn.execute("""
                SELECT ba.*, b.name AS budget_name FROM budget_alerts ba
                JOIN budgets b ON b.id=ba.budget_id
                WHERE b.tenant_id=? ORDER BY ba.triggered_at DESC LIMIT ?
            """, (tenant_id, limit)).fetchall()
        else:
            rows = conn.execute("""
                SELECT ba.*, b.name AS budget_name FROM budget_alerts ba
                JOIN budgets b ON b.id=ba.budget_id
                ORDER BY ba.triggered_at DESC LIMIT ?
            """, (limit,)).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["notified_via"] = json.loads(d["notified_via"]) if d["notified_via"] else []
        result.append(d)
    return result


def get_recent_budget_alert(budget_id, threshold_pct, within_hours=24):
    """Return True if an alert for this budget+threshold already fired within the window."""
    conn = get_db()
    cutoff = (datetime.utcnow() - __import__("datetime").timedelta(hours=within_hours)).isoformat()
    row = conn.execute("""
        SELECT id FROM budget_alerts
        WHERE budget_id=? AND threshold_pct=? AND triggered_at>=?
        LIMIT 1
    """, (budget_id, threshold_pct, cutoff)).fetchone()
    conn.close()
    return row is not None


# ─── Data Freshness ───────────────────────────────────────────────────────────

def get_data_freshness(tenant_id=None):
    """Return last-sync time and latest data date per cloud_provider."""
    conn = get_db()
    if tenant_id is not None:
        rows = conn.execute("""
            SELECT cloud_provider,
                   MAX(date)       AS latest_date,
                   MAX(created_at) AS last_ingested,
                   COUNT(*)        AS record_count
            FROM cost_data
            WHERE tenant_id=?
            GROUP BY cloud_provider
        """, (tenant_id,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT cloud_provider,
                   MAX(date)       AS latest_date,
                   MAX(created_at) AS last_ingested,
                   COUNT(*)        AS record_count
            FROM cost_data
            GROUP BY cloud_provider
        """).fetchall()
    conn.close()
    result = []
    now = datetime.utcnow()
    for r in rows:
        d = dict(r)
        # billing lag: cloud providers typically have 24-72 hr data lag
        lag_map = {"aws": 48, "gcp": 72, "azure": 24}
        expected_lag_hrs = lag_map.get(d["cloud_provider"], 24)
        if d["latest_date"]:
            from datetime import date as _date
            try:
                latest = datetime.strptime(d["latest_date"], "%Y-%m-%d")
                lag_days = (now - latest).days
                d["lag_days"] = lag_days
                d["expected_lag_hrs"] = expected_lag_hrs
                d["is_stale"] = lag_days > (expected_lag_hrs / 24 + 1)
            except Exception:
                d["lag_days"] = None
                d["is_stale"] = False
        result.append(d)
    return result


def get_cost_by_cloud(tenant_id=None, date_from=None, date_to=None):
    """Total cost grouped by cloud_provider for the dashboard cloud breakdown card."""
    conn = get_db()
    conditions = ["1=1"]
    params = []
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    if date_from:
        conditions.append("date >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("date <= ?")
        params.append(date_to)
    query = f"""
        SELECT cloud_provider, SUM(cost) as total_cost, COUNT(*) as records
        FROM cost_data WHERE {' AND '.join(conditions)}
        GROUP BY cloud_provider ORDER BY total_cost DESC
    """
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_distinct_cloud_providers_in_data(tenant_id=None):
    """Return list of cloud providers that have cost data for this tenant."""
    conn = get_db()
    conditions = ["cloud_provider IS NOT NULL"]
    params = []
    if tenant_id is not None:
        conditions.append("tenant_id = ?")
        params.append(tenant_id)
    rows = conn.execute(
        f"SELECT DISTINCT cloud_provider FROM cost_data WHERE {' AND '.join(conditions)} ORDER BY cloud_provider",
        params
    ).fetchall()
    conn.close()
    return [r["cloud_provider"] for r in rows]


# ─── SaaS: Tenant management ──────────────────────────────────────────────────

def create_tenant(name: str, slug: str, owner_email: str, plan: str = "free") -> int:
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO tenants(name,slug,owner_email,plan) VALUES(?,?,?,?)",
        (name, slug.lower().replace(" ", "-"), owner_email, plan)
    )
    tenant_id = cur.lastrowid
    conn.commit()
    conn.close()
    return tenant_id


def get_tenant(tenant_id: int = None, slug: str = None) -> dict:
    conn = get_db()
    if slug:
        row = conn.execute("SELECT * FROM tenants WHERE slug=?", (slug,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM tenants WHERE id=?", (tenant_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_tenants() -> list:
    conn = get_db()
    rows = conn.execute("""
        SELECT t.*,
               (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) AS user_count,
               (SELECT COUNT(*) FROM cloud_providers cp WHERE cp.tenant_id=t.id) AS provider_count,
               (SELECT COUNT(*) FROM cost_data cd WHERE cd.tenant_id=t.id) AS cost_rows
        FROM tenants t ORDER BY t.created_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_tenant(tenant_id: int, **kwargs):
    conn = get_db()
    allowed = {"name", "plan", "status", "max_users", "max_cloud_providers", "owner_email"}
    fields = [f"{k}=?" for k in kwargs if k in allowed]
    vals = [v for k, v in kwargs.items() if k in allowed]
    if fields:
        vals.append(datetime.utcnow().isoformat())
        vals.append(tenant_id)
        conn.execute(f"UPDATE tenants SET {','.join(fields)},updated_at=? WHERE id=?", vals)
        conn.commit()
    conn.close()


def slugify(name: str) -> str:
    import re
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    conn = get_db()
    base, n = slug, 1
    while conn.execute("SELECT 1 FROM tenants WHERE slug=?", (slug,)).fetchone():
        slug, n = f"{base}-{n}", n + 1
    conn.close()
    return slug


# ─── SaaS: User management ────────────────────────────────────────────────────

def create_user(tenant_id: int, email: str, password: str,
                full_name: str = "", role: str = "admin") -> int:
    from werkzeug.security import generate_password_hash
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO users(tenant_id,email,password_hash,full_name,role,invite_accepted) VALUES(?,?,?,?,?,1)",
        (tenant_id, email.lower(), generate_password_hash(password), full_name, role)
    )
    user_id = cur.lastrowid
    conn.commit()
    conn.close()
    return user_id


def get_user_by_email(email: str, tenant_id: int = None) -> dict:
    conn = get_db()
    if tenant_id:
        row = conn.execute(
            "SELECT u.*,t.name AS tenant_name,t.slug AS tenant_slug,t.plan,t.status AS tenant_status "
            "FROM users u JOIN tenants t ON t.id=u.tenant_id "
            "WHERE u.email=? AND u.tenant_id=?",
            (email.lower(), tenant_id)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT u.*,t.name AS tenant_name,t.slug AS tenant_slug,t.plan,t.status AS tenant_status "
            "FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.email=?",
            (email.lower(),)
        ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_tenant_users(tenant_id: int) -> list:
    conn = get_db()
    rows = conn.execute(
        "SELECT id,email,full_name,role,last_login,invite_accepted,created_at "
        "FROM users WHERE tenant_id=? ORDER BY created_at",
        (tenant_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_user_last_login(user_id: int):
    conn = get_db()
    conn.execute("UPDATE users SET last_login=? WHERE id=?",
                 (datetime.utcnow().isoformat(), user_id))
    conn.commit()
    conn.close()


def update_user_role(user_id: int, tenant_id: int, role: str):
    conn = get_db()
    conn.execute("UPDATE users SET role=? WHERE id=? AND tenant_id=?",
                 (role, user_id, tenant_id))
    conn.commit()
    conn.close()


def delete_user(user_id: int, tenant_id: int):
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id=? AND tenant_id=?", (user_id, tenant_id))
    conn.commit()
    conn.close()


def create_invite(tenant_id: int, email: str, role: str = "viewer") -> str:
    token = secrets.token_urlsafe(32)
    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM users WHERE tenant_id=? AND email=?",
        (tenant_id, email.lower())
    ).fetchone()
    if existing:
        conn.execute("UPDATE users SET invite_token=?,role=? WHERE id=?",
                     (token, role, existing["id"]))
    else:
        conn.execute(
            "INSERT INTO users(tenant_id,email,password_hash,role,invite_token,invite_accepted) "
            "VALUES(?,?,?,?,?,0)",
            (tenant_id, email.lower(), "", role, token)
        )
    conn.commit()
    conn.close()
    return token


def accept_invite(token: str, password: str, full_name: str = "") -> dict:
    from werkzeug.security import generate_password_hash
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE invite_token=? AND invite_accepted=0", (token,)
    ).fetchone()
    if not row:
        conn.close()
        return None
    conn.execute(
        "UPDATE users SET password_hash=?,full_name=?,invite_accepted=1,invite_token=NULL WHERE id=?",
        (generate_password_hash(password), full_name, row["id"])
    )
    conn.commit()
    conn.close()
    return dict(row)


def email_exists_in_platform(email: str) -> bool:
    conn = get_db()
    row = conn.execute("SELECT 1 FROM users WHERE email=?", (email.lower(),)).fetchone()
    conn.close()
    return row is not None


# ─── SaaS: tenant-scoped data-freshness ──────────────────────────────────────

def get_data_freshness_for_tenant(tenant_id: int) -> list:
    conn = get_db()
    rows = conn.execute("""
        SELECT cloud_provider,
               MAX(date)       AS latest_date,
               MAX(created_at) AS last_ingested,
               COUNT(*)        AS record_count
        FROM cost_data WHERE tenant_id=?
        GROUP BY cloud_provider
    """, (tenant_id,)).fetchall()
    conn.close()
    now = datetime.utcnow()
    result = []
    lag_map = {"aws": 48, "gcp": 72, "azure": 24}
    for r in rows:
        d = dict(r)
        expected_lag_hrs = lag_map.get(d["cloud_provider"], 24)
        d["expected_lag_hrs"] = expected_lag_hrs
        if d["latest_date"]:
            try:
                latest = datetime.strptime(d["latest_date"], "%Y-%m-%d")
                lag_days = (now - latest).days
                d["lag_days"] = lag_days
                d["is_stale"] = lag_days > (expected_lag_hrs / 24 + 1)
            except Exception:
                d["lag_days"] = None
                d["is_stale"] = False
        result.append(d)
    return result


if __name__ == "__main__":
    init_db()
    print("Database setup complete.")
