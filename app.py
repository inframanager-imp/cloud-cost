import os
import sys
import json
import subprocess
import tempfile
import threading
import calendar
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import wraps
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
import csv
import io

load_dotenv()

from database import (
    get_db,
    init_db, insert_cost_records, clear_cost_data, delete_cost_data_by_date,
    get_latest_cost_date, query_costs,
    get_cost_total, get_cost_totals_by_subscription, get_custom_cost,
    get_summary, get_daily_trend, get_distinct_values, get_sync_history,
    get_stats, log_sync, update_sync_log,
    get_monthly_summary, get_monthly_service_breakdown, get_monthly_rg_breakdown,
    get_monthly_subscription_breakdown,
    get_comparison_data, get_comparison_data_multi, get_comparison_drilldown, get_comparison_drilldown_multi,
    get_weekly_breakdown, get_available_periods,
    insert_activity_logs, query_activity_logs, get_activity_stats,
    get_latest_activity_timestamp, get_activity_distinct,
    save_caller_names, get_caller_names,
    upsert_subscriptions, get_subscriptions, toggle_subscription, update_subscription_sync_time,
    save_filter, get_saved_filters, update_saved_filter, delete_saved_filter,
    get_email_settings, update_email_settings, get_email_log,
    save_custom_report, get_custom_reports, get_custom_report as db_get_custom_report,
    update_custom_report, delete_custom_report,
    get_resource_config, get_all_resource_configs, get_resource_config_filter_options,
    # Phase 1 MVP additions
    get_cloud_providers, get_cloud_provider, upsert_cloud_provider,
    toggle_cloud_provider, delete_cloud_provider, update_cloud_provider_sync_time,
    get_budgets, create_budget, update_budget, delete_budget,
    get_budget_alerts, get_data_freshness,
    # SaaS multi-tenancy
    create_tenant, get_tenant, get_all_tenants, update_tenant, slugify,
    create_user, get_user_by_email, get_tenant_users,
    update_user_last_login, update_user_role, delete_user,
    create_invite, accept_invite, email_exists_in_platform,
    get_data_freshness_for_tenant,
    get_cost_by_cloud, get_distinct_cloud_providers_in_data,
    get_integration_settings, update_integration_settings,
)
from azure_fetcher import (fetch_cost_data, fetch_activity_logs, resolve_caller_names, fetch_subscriptions,
                           fetch_billing_account_costs, filter_billing_only_charges)
from email_report import send_report_email, send_test_email, _build_report_html, send_custom_report, preview_custom_report
from chatbot import process_chat_message
from resource_config_display import build_display_payload, enrich_list_row
from budget_manager import check_budgets, check_data_freshness
from slack_notifier import test_webhook as slack_test_webhook

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "default-secret-key")
app.permanent_session_lifetime = timedelta(hours=12)
# Default false: some hosts hit RuntimeError: can't start new thread when Werkzeug uses threaded=True.
FLASK_THREADED = os.getenv("FLASK_THREADED", "false").lower() in ("true", "1", "yes")

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD_HASH = generate_password_hash(os.getenv("ADMIN_PASSWORD", "admin"))

# Initialize database
init_db()

# Track sync status
sync_status = {"running": False, "message": "", "progress": 0}


def _sync_status_path():
    base = os.getenv("DB_PATH", "/app/data/azure_costs.db")
    return os.path.join(os.path.dirname(os.path.abspath(base)), ".cost_sync_status.json")


def _sync_is_busy():
    try:
        with open(_sync_status_path()) as f:
            st = json.load(f)
        if st.get("running"):
            return True
    except (OSError, json.JSONDecodeError):
        pass
    return sync_status.get("running", False)

# ─── Sync / threading (see env.example for copy-paste) ───────────────────────
# SYNC_SEQUENTIAL: fetch subs one-by-one (no ThreadPoolExecutor in runners / in-process sync).
# FORCE_SYNC_INLINE + SYNC_SUBPROCESS: VM-friendly cost sync via cost_sync_runner.py (non-blocking UI).
# FORCE_SYNC_INLINE without SYNC_SUBPROCESS: run full cost sync inside the Flask request (blocks UI).
# ACTIVITY_SYNC_SUBPROCESS: activity logs via activity_sync_runner.py (default true).
# FLASK_THREADED: Werkzeug multi-thread; default false (many containers hit "can't start new thread").
AUTO_SYNC_INTERVAL_HOURS = int(os.getenv("AUTO_SYNC_INTERVAL_HOURS", 6))
AUTO_SYNC_ENABLED = os.getenv("AUTO_SYNC_ENABLED", "true").lower() in ("true", "1", "yes")
SYNC_INLINE_MODE = os.getenv("SYNC_INLINE_MODE", "false").lower() in ("true", "1", "yes")
SYNC_SEQUENTIAL = os.getenv("SYNC_SEQUENTIAL", "false").lower() in ("true", "1", "yes")
FORCE_SYNC_INLINE = os.getenv("FORCE_SYNC_INLINE", "false").lower() in ("true", "1", "yes")
SYNC_SUBPROCESS = os.getenv("SYNC_SUBPROCESS", "true").lower() in ("true", "1", "yes")
ACTIVITY_SYNC_INLINE_MODE = os.getenv("ACTIVITY_SYNC_INLINE_MODE", "false").lower() in ("true", "1", "yes")
ACTIVITY_SYNC_SUBPROCESS = os.getenv("ACTIVITY_SYNC_SUBPROCESS", "true").lower() in ("true", "1", "yes")
EMAIL_SCHEDULER_ENABLED = os.getenv("EMAIL_SCHEDULER_ENABLED", "true").lower() in ("true", "1", "yes")

SYNC_SETTINGS_FILE = os.path.join(os.getenv("DATA_DIR", "/app/data"), "sync_settings.json")

def _load_sync_settings():
    try:
        with open(SYNC_SETTINGS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_sync_settings(data):
    try:
        os.makedirs(os.path.dirname(SYNC_SETTINGS_FILE), exist_ok=True)
        with open(SYNC_SETTINGS_FILE, "w") as f:
            json.dump(data, f)
    except Exception:
        pass

_persisted_sync = _load_sync_settings()
auto_sync_state = {
    "enabled": _persisted_sync.get("enabled", AUTO_SYNC_ENABLED),
    "interval_hours": _persisted_sync.get("interval_hours", AUTO_SYNC_INTERVAL_HOURS),
    "last_auto_sync": None,
    "next_auto_sync": None,
    "running": False,
}


def start_background_thread(target, *, name=None, daemon=True, args=(), fallback_inline=False):
    """Start a background thread safely; optional inline fallback on constrained hosts."""
    try:
        thread = threading.Thread(target=target, args=args, name=name, daemon=daemon)
        thread.start()
        return True
    except (RuntimeError, OSError) as e:
        print(f"[Threading] Could not start thread '{name or target.__name__}': {e}")
        if fallback_inline:
            print(f"[Threading] Running '{name or target.__name__}' inline instead.")
            target(*args)
            return True
        return False


# ─── Auth & Tenant Middleware ─────────────────────────────────────────────────

SUPER_ADMIN_EMAIL = os.getenv("SUPER_ADMIN_EMAIL", "superadmin@localhost")
SUPER_ADMIN_PASSWORD = os.getenv("SUPER_ADMIN_PASSWORD", os.getenv("ADMIN_PASSWORD", "admin"))

def current_tenant_id():
    """Return the active tenant_id from session (default 1 for legacy data)."""
    return session.get("tenant_id", 1)

def current_user_role():
    return session.get("role", "admin")

def is_super_admin():
    return session.get("is_super_admin", False)

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

def role_required(*roles):
    """Restrict endpoint to users with one of the given roles (or super admin)."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not session.get("logged_in"):
                return jsonify({"error": "Unauthorized"}), 401
            if is_super_admin():
                return f(*args, **kwargs)
            if current_user_role() not in roles:
                return jsonify({"error": "Forbidden – insufficient role"}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator

def super_admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in") or not is_super_admin():
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Super-admin only"}), 403
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("logged_in"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        email    = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")

        # ── Super-admin shortcut ──────────────────────────────────────────────
        if email == SUPER_ADMIN_EMAIL and check_password_hash(
                generate_password_hash(SUPER_ADMIN_PASSWORD), password) or (
                email == SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD == password):
            session.permanent = True
            session["logged_in"]     = True
            session["username"]      = "Super Admin"
            session["email"]         = email
            session["tenant_id"]     = None
            session["role"]          = "superadmin"
            session["is_super_admin"] = True
            return redirect(url_for("super_admin_dashboard"))

        # ── Regular tenant user ───────────────────────────────────────────────
        user = get_user_by_email(email)
        if user and user.get("invite_accepted") and check_password_hash(
                user["password_hash"], password):
            if user.get("tenant_status") == "suspended":
                error = "Your organisation account is suspended. Contact support."
            else:
                update_user_last_login(user["id"])
                session.permanent = True
                session["logged_in"]      = True
                session["username"]       = user.get("full_name") or email
                session["email"]          = email
                session["user_id"]        = user["id"]
                session["tenant_id"]      = user["tenant_id"]
                session["tenant_name"]    = user["tenant_name"]
                session["tenant_slug"]    = user["tenant_slug"]
                session["role"]           = user["role"]
                session["is_super_admin"] = False
                return redirect(url_for("index"))
        else:
            error = "Invalid email or password"

    return render_template("login.html", error=error)


@app.route("/signup", methods=["GET", "POST"])
def signup():
    """Self-service tenant registration."""
    if session.get("logged_in"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        org_name  = request.form.get("org_name", "").strip()
        full_name = request.form.get("full_name", "").strip()
        email     = request.form.get("email", "").strip().lower()
        password  = request.form.get("password", "")
        confirm   = request.form.get("confirm_password", "")

        if not all([org_name, full_name, email, password]):
            error = "All fields are required."
        elif password != confirm:
            error = "Passwords do not match."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        elif email_exists_in_platform(email):
            error = "An account with this email already exists."
        else:
            try:
                slug      = slugify(org_name)
                tenant_id = create_tenant(org_name, slug, email, plan="free")
                user_id   = create_user(tenant_id, email, password, full_name, role="admin")
                # Auto-login after signup
                session.permanent   = True
                session["logged_in"]      = True
                session["username"]       = full_name
                session["email"]          = email
                session["user_id"]        = user_id
                session["tenant_id"]      = tenant_id
                session["tenant_name"]    = org_name
                session["tenant_slug"]    = slug
                session["role"]           = "admin"
                session["is_super_admin"] = False
                return redirect(url_for("onboarding"))
            except Exception as e:
                error = f"Registration failed: {e}"

    return render_template("signup.html", error=error)


@app.route("/onboarding")
@login_required
def onboarding():
    """Post-signup onboarding wizard."""
    tenant = get_tenant(current_tenant_id())
    return render_template("onboarding.html",
                           username=session.get("username", ""),
                           tenant=tenant,
                           tenant_name=session.get("tenant_name", ""))


@app.route("/invite/<token>", methods=["GET", "POST"])
def accept_invite_route(token):
    """Accept a team invite."""
    error = None
    if request.method == "POST":
        password  = request.form.get("password", "")
        confirm   = request.form.get("confirm_password", "")
        full_name = request.form.get("full_name", "").strip()
        if password != confirm:
            error = "Passwords do not match."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        else:
            user = accept_invite(token, password, full_name)
            if not user:
                error = "Invalid or expired invite link."
            else:
                return redirect(url_for("login"))
    return render_template("invite.html", token=token, error=error)


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    if request.method == "POST":
        return jsonify({"redirect": "/login"})
    return redirect(url_for("login"))


# ─── Subscription Management ──────────────────────────────────────────────────

def discover_subscriptions():
    """Discover Azure subscriptions and store in DB."""
    try:
        subs = fetch_subscriptions()
        if subs:
            upsert_subscriptions(subs)
            print(f"[Subscriptions] Discovered {len(subs)} subscription(s)")
    except Exception as e:
        print(f"[Subscriptions] Discovery failed: {e}")

# Auto-discover on startup
discover_subscriptions()


@app.route("/api/subscriptions")
@login_required
def api_subscriptions():
    tid = current_tenant_id()
    # Azure subscriptions from subscriptions table
    azure_subs = get_subscriptions(tenant_id=tid)
    result = [{"subscription_id": s["subscription_id"], "name": s["name"], "enabled": s["enabled"], "cloud": "azure"} for s in azure_subs]

    # AWS/GCP accounts from cloud_providers table
    conn = get_db()
    cloud_icons = {"aws": "⚙", "gcp": "◉"}
    if tid is not None:
        cp_rows = conn.execute(
            "SELECT provider_id, name, provider_type FROM cloud_providers WHERE tenant_id=? AND provider_type IN ('aws','gcp') AND enabled=1",
            (tid,)
        ).fetchall()
    else:
        cp_rows = conn.execute(
            "SELECT provider_id, name, provider_type FROM cloud_providers WHERE provider_type IN ('aws','gcp') AND enabled=1"
        ).fetchall()
    conn.close()

    for cp in cp_rows:
        if not cp["provider_id"]:
            continue
        icon = cloud_icons.get(cp["provider_type"], "☁")
        result.append({
            "subscription_id": cp["provider_id"],
            "name": f"{icon} {cp['name'] or cp['provider_id']}",
            "enabled": True,
            "cloud": cp["provider_type"],
        })

    return jsonify(result)


@app.route("/api/subscriptions/discover", methods=["POST"])
@login_required
def api_discover_subscriptions():
    subs = fetch_subscriptions()
    if subs:
        upsert_subscriptions(subs)
    return jsonify({"message": f"Found {len(subs)} subscription(s)", "subscriptions": subs})


@app.route("/api/subscriptions/<sub_id>/toggle", methods=["POST"])
@login_required
def api_toggle_subscription(sub_id):
    body = request.get_json(silent=True) or {}
    enabled = body.get("enabled", True)
    toggle_subscription(sub_id, enabled)
    return jsonify({"message": f"Subscription {'enabled' if enabled else 'disabled'}"})


# ─── Pages ────────────────────────────────────────────────────────────────────

@app.route("/")
@login_required
def index():
    return render_template("index.html", username=session.get("username", ""))


@app.route("/drilldown")
@login_required
def drilldown_page():
    """Standalone compare drilldown (opened from Compare table row link)."""
    return render_template("drilldown.html")


# ─── API: Dashboard Stats ────────────────────────────────────────────────────

@app.route("/api/stats")
@login_required
def api_stats():
    stats = get_stats()
    return jsonify(stats)


@app.route("/api/dashboard")
@login_required
def api_dashboard():
    sub_id = request.args.get("subscription_id")
    today = datetime.utcnow()
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    first_of_month = today.replace(day=1).strftime("%Y-%m-%d")
    today_str = today.strftime("%Y-%m-%d")
    day_of_month = today.day

    tid = current_tenant_id()
    cloud_filter = request.args.get("cloud_provider") or None

    cur_trend = get_daily_trend(first_of_month, today_str, subscription_id=sub_id, tenant_id=tid, cloud_provider=cloud_filter)
    cur_total = sum(r["total_cost"] for r in cur_trend)
    days_with_data = len(cur_trend)
    avg_daily = cur_total / days_with_data if days_with_data > 0 else 0
    projected = avg_daily * days_in_month

    last_month_end = today.replace(day=1) - timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    prev_trend = get_daily_trend(last_month_start.strftime("%Y-%m-%d"), last_month_end.strftime("%Y-%m-%d"), subscription_id=sub_id, tenant_id=tid, cloud_provider=cloud_filter)
    prev_total = sum(r["total_cost"] for r in prev_trend)

    prev_same_day = min(day_of_month, last_month_end.day)
    prev_same_day_str = last_month_start.replace(day=prev_same_day).strftime("%Y-%m-%d")
    prev_partial_trend = get_daily_trend(last_month_start.strftime("%Y-%m-%d"), prev_same_day_str, subscription_id=sub_id, tenant_id=tid, cloud_provider=cloud_filter)
    prev_partial_total = sum(r["total_cost"] for r in prev_partial_trend)

    mom_change = ((cur_total - prev_partial_total) / prev_partial_total * 100) if prev_partial_total > 0 else 0

    cur_services = get_summary("service_name", first_of_month, today_str, subscription_id=sub_id, tenant_id=tid, cloud_provider=cloud_filter)[:8]
    cur_rgs = get_summary("resource_group", first_of_month, today_str, subscription_id=sub_id, tenant_id=tid, cloud_provider=cloud_filter)[:8]

    # Build account name map: Azure subscriptions + cloud_providers table (AWS accounts, GCP projects)
    subs = get_subscriptions(tenant_id=tid)
    sub_map = {s["subscription_id"]: s["name"] for s in subs}
    from database import get_db
    conn = get_db()
    # Enrich with cloud_providers table (provider_id = AWS account ID or GCP project ID)
    cp_rows = conn.execute(
        "SELECT provider_id, name, provider_type FROM cloud_providers WHERE tenant_id = ? OR tenant_id IS NULL",
        (tid,)
    ).fetchall() if tid else conn.execute(
        "SELECT provider_id, name, provider_type FROM cloud_providers"
    ).fetchall()
    for cp in cp_rows:
        if cp["provider_id"] and cp["name"]:
            sub_map[cp["provider_id"]] = cp["name"]

    # Current-month cost per account/subscription (all clouds)
    tid_filter = f"AND tenant_id = {tid}" if tid is not None else ""
    cloud_sql = f"AND cloud_provider = '{cloud_filter}'" if cloud_filter else ""
    sub_costs = conn.execute(f"""
        SELECT subscription_id, cloud_provider, SUM(cost) as total
        FROM cost_data WHERE date >= ? AND date <= ? {tid_filter} {cloud_sql}
        GROUP BY subscription_id, cloud_provider ORDER BY total DESC
    """, (first_of_month, today_str)).fetchall()

    # Last month for comparison
    last_month_end2 = today.replace(day=1) - timedelta(days=1)
    last_month_start2 = last_month_end2.replace(day=1)
    lm_str = last_month_start2.strftime("%Y-%m-%d")
    lm_end_str = last_month_end2.strftime("%Y-%m-%d")
    lm_sub_costs = conn.execute(f"""
        SELECT subscription_id, SUM(cost) as total
        FROM cost_data WHERE date >= ? AND date <= ? {tid_filter} {cloud_sql}
        GROUP BY subscription_id
    """, (lm_str, lm_end_str)).fetchall()
    lm_sub_map = {r["subscription_id"]: round(r["total"], 2) for r in lm_sub_costs}

    # Cloud breakdown for current month (for the breakdown cards)
    cloud_costs_cur = conn.execute(f"""
        SELECT cloud_provider, SUM(cost) as total
        FROM cost_data WHERE date >= ? AND date <= ? {tid_filter}
        GROUP BY cloud_provider ORDER BY total DESC
    """, (first_of_month, today_str)).fetchall()

    # Last 2 months cloud breakdown
    two_months_ago_end = last_month_start2 - timedelta(days=1)
    two_months_ago_start = two_months_ago_end.replace(day=1)
    cloud_costs_lm = conn.execute(f"""
        SELECT cloud_provider, SUM(cost) as total
        FROM cost_data WHERE date >= ? AND date <= ? {tid_filter}
        GROUP BY cloud_provider ORDER BY total DESC
    """, (lm_str, lm_end_str)).fetchall()
    cloud_costs_2m = conn.execute(f"""
        SELECT cloud_provider, SUM(cost) as total
        FROM cost_data WHERE date >= ? AND date <= ? {tid_filter}
        GROUP BY cloud_provider ORDER BY total DESC
    """, (two_months_ago_start.strftime("%Y-%m-%d"), two_months_ago_end.strftime("%Y-%m-%d"))).fetchall()
    conn.close()

    def _cloud_map(rows):
        return {r["cloud_provider"]: round(r["total"], 2) for r in rows}

    cloud_breakdown = {
        "current": _cloud_map(cloud_costs_cur),
        "last_month": _cloud_map(cloud_costs_lm),
        "two_months_ago": _cloud_map(cloud_costs_2m),
        "last_month_label": last_month_start2.strftime("%b %Y"),
        "two_months_ago_label": two_months_ago_start.strftime("%b %Y"),
    }

    cloud_icons  = {"azure": "⊞", "aws": "⚙", "gcp": "◉"}
    cloud_labels = {"azure": "Account", "aws": "Account", "gcp": "Project"}
    subscription_costs = []
    for r in sub_costs:
        if not r["total"] or r["total"] <= 0:
            continue
        raw_id = r["subscription_id"] or ""
        cloud  = r["cloud_provider"] or "azure"
        # Prefer registered name; fall back to "AWS Account ·····1234" style
        if raw_id in sub_map:
            name = sub_map[raw_id]
        elif raw_id and raw_id.isdigit() and len(raw_id) > 6:
            name = f"{cloud_labels.get(cloud,'Account')} ···{raw_id[-4:]}"
        else:
            name = raw_id[:20] or "Unknown"
        subscription_costs.append({
            "id": raw_id,
            "name": name,
            "cloud": cloud,
            "cloud_icon": cloud_icons.get(cloud, "☁"),
            "cost": round(r["total"], 2),
            "last_month_cost": lm_sub_map.get(raw_id, 0),
        })

    sync_hist = get_sync_history()
    last_sync = sync_hist[0] if sync_hist else None

    stats = get_stats(subscription_id=sub_id)

    return jsonify({
        "current_month": {
            "label": today.strftime("%B %Y"),
            "total": round(cur_total, 2),
            "avg_daily": round(avg_daily, 2),
            "projected": round(projected, 2),
            "days_elapsed": day_of_month,
            "days_remaining": days_in_month - day_of_month,
            "days_in_month": days_in_month,
            "days_with_data": days_with_data,
            "trend": [{"date": r["date"], "cost": round(r["total_cost"], 2)} for r in cur_trend],
        },
        "last_month": {
            "label": last_month_start.strftime("%B %Y"),
            "total": round(prev_total, 2),
            "partial_total": round(prev_partial_total, 2),
            "partial_days": prev_same_day,
        },
        "mom_change_pct": round(mom_change, 1),
        "top_services": [{"name": s["service_name"] or "Unknown", "cost": round(s["total_cost"], 2)} for s in cur_services],
        "top_rgs": [{"name": r["resource_group"] or "Unknown", "cost": round(r["total_cost"], 2)} for r in cur_rgs],
        "subscription_costs": subscription_costs,
        "cloud_breakdown": cloud_breakdown,
        "last_sync": {
            "time": last_sync["sync_end"] or last_sync["sync_start"],
            "status": last_sync["status"],
            "records": last_sync["records_fetched"],
        } if last_sync else None,
        "overall": stats,
    })


# ─── API: Sync Cost Data ─────────────────────────────────────────────────────

@app.route("/api/sync", methods=["POST"])
@login_required
def api_sync():
    global sync_status
    if _sync_is_busy():
        return jsonify({"error": "Sync already in progress"}), 409

    body = request.get_json(silent=True) or {}
    mode = body.get("mode", "incremental")
    target_sub = body.get("subscription_id")

    months = int(os.getenv("COST_HISTORY_MONTHS", 3))
    date_to = datetime.utcnow().strftime("%Y-%m-%d")

    # Get subscriptions to sync
    if target_sub:
        all_subs = get_subscriptions(tenant_id=current_tenant_id())
        match = [s for s in all_subs if s["subscription_id"] == target_sub]
        subs_to_sync = match if match else [{"subscription_id": target_sub, "name": target_sub[:12]}]
    else:
        subs_to_sync = get_subscriptions(enabled_only=True, tenant_id=current_tenant_id())
        if not subs_to_sync:
            subs_to_sync = [{"subscription_id": os.getenv("AZURE_SUBSCRIPTION_ID", ""), "name": "Default"}]

    # Capture tenant_id now — current_tenant_id() uses session which is unavailable in background threads
    tid = current_tenant_id()

    try:
        os.unlink(_sync_status_path())
    except OSError:
        pass

    def _fetch_one_subscription(sub, is_full, months, date_to):
        """Fetch cost data for a single subscription. Runs in a thread."""
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
                subscription_id=sub_id
            )
            all_records.extend(records)
            current_from = chunk_to + timedelta(days=1)

        count = insert_cost_records(all_records)
        update_subscription_sync_time(sub_id, "cost")
        return sub_name, count

    def _write_sync_file(running, message, progress):
        try:
            with open(_sync_status_path(), "w") as f:
                json.dump({"running": running, "message": message, "progress": progress,
                           "details": sync_status.get("details", [])}, f)
        except OSError:
            pass

    def run_sync():
        global sync_status
        is_full = mode == "full"
        mode_label = "Full sync" if is_full else "Quick sync"
        total_subs = len(subs_to_sync)
        sub_names_list = [s.get("name", s["subscription_id"][:14]) for s in subs_to_sync]
        msg_start = f"{mode_label}: Starting {total_subs} subscription(s) — {', '.join(sub_names_list[:4])}{'...' if total_subs > 4 else ''}"
        sync_status = {"running": True, "message": msg_start, "progress": 5, "details": []}
        _write_sync_file(True, msg_start, 5)
        sync_id = log_sync(datetime.utcnow().isoformat(), "", date_to)
        total_records = 0
        completed_details = []  # track per-sub results for UI

        try:
            completed = 0
            if SYNC_SEQUENTIAL:
                for sub in subs_to_sync:
                    sub_name = sub.get("name", sub["subscription_id"][:12])
                    try:
                        name, count = _fetch_one_subscription(sub, is_full, months, date_to)
                        total_records += count
                        completed += 1
                        completed_details.append({"name": name, "records": count, "ok": True})
                        sync_status["message"] = f"{mode_label}: {name} ✓ {count:,} records [{completed}/{total_subs}]"
                        sync_status["progress"] = 5 + int(90 * completed / total_subs)
                        sync_status["details"] = completed_details[:]
                    except Exception as sub_err:
                        completed += 1
                        completed_details.append({"name": sub_name, "records": 0, "ok": False, "error": str(sub_err)[:60]})
                        sync_status["message"] = f"{mode_label}: {sub_name} ✗ failed [{completed}/{total_subs}]"
                        sync_status["progress"] = 5 + int(90 * completed / total_subs)
                        sync_status["details"] = completed_details[:]
            else:
                max_workers = min(total_subs, 2)  # 2 workers avoids Azure rate limits
                SUB_TIMEOUT = 300  # 5 min max per subscription
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    futures = {
                        executor.submit(_fetch_one_subscription, sub, is_full, months, date_to): sub
                        for sub in subs_to_sync
                    }
                    for future in as_completed(futures, timeout=SUB_TIMEOUT * total_subs):
                        sub = futures[future]
                        sub_name = sub.get("name", sub["subscription_id"][:12])
                        try:
                            name, count = future.result(timeout=SUB_TIMEOUT)
                            total_records += count
                            completed += 1
                            completed_details.append({"name": name, "records": count, "ok": True})
                            sync_status["message"] = f"{mode_label}: {name} ✓ {count:,} records [{completed}/{total_subs}]"
                            sync_status["progress"] = 5 + int(90 * completed / total_subs)
                            sync_status["details"] = completed_details[:]
                        except Exception as sub_err:
                            completed += 1
                            completed_details.append({"name": sub_name, "records": 0, "ok": False, "error": str(sub_err)[:60]})
                            sync_status["message"] = f"{mode_label}: {sub_name} ✗ failed [{completed}/{total_subs}]"
                            sync_status["progress"] = 5 + int(90 * completed / total_subs)
                            sync_status["details"] = completed_details[:]

            # Attempt billing account-level supplementary fetch
            # (captures Support plans, Marketplace fees billed at account scope)
            try:
                sync_status["message"] = f"{mode_label}: Checking billing account for supplementary charges..."
                sync_status["progress"] = 95
                date_from_ba = (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")
                ba_rows, ba_ids = fetch_billing_account_costs(date_from_ba, date_to)
                if ba_rows:
                    # Build subscription-level service totals from DB to find billing-only charges
                    import sqlite3
                    db_path = os.getenv("DB_PATH", "/app/data/azure_costs.db")
                    conn = sqlite3.connect(db_path)
                    sub_svc_totals = {}
                    rows = conn.execute(
                        "SELECT LOWER(service_name), SUM(cost) FROM cost_data "
                        "WHERE cloud_provider='azure' AND date >= ? GROUP BY LOWER(service_name)",
                        (date_from_ba,)
                    ).fetchall()
                    conn.close()
                    sub_svc_totals = {r[0]: r[1] for r in rows}

                    ba_records = filter_billing_only_charges(ba_rows, sub_svc_totals)
                    if ba_records:
                        # Register billing accounts as subscriptions
                        ba_sub_entries = [{"subscription_id": ba_id, "name": f"Billing: {ba_name}", "state": "Enabled"}
                                          for ba_id, ba_name in ba_ids]
                        upsert_subscriptions(ba_sub_entries, tenant_id=tid)
                        ba_count = insert_cost_records(ba_records)
                        total_records += ba_count
                        print(f"[BillingAccount] Inserted {ba_count} billing-account-only records")
                    else:
                        print("[BillingAccount] No supplementary billing-account charges found")
            except Exception as ba_err:
                print(f"[BillingAccount] Supplementary fetch error (non-fatal): {ba_err}")

            # Sync AWS/GCP providers as part of "all" sync (when no specific Azure subscription is targeted).
            if not target_sub:
                try:
                    from aws_fetcher import fetch_aws_costs
                    from gcp_fetcher import fetch_gcp_costs
                    cp_providers = get_cloud_providers(enabled_only=True, tenant_id=tid)
                    cp_providers = [p for p in cp_providers if p.get("provider_type") in ("aws", "gcp")]

                    def _provider_date_from(provider_type, provider_id):
                        conn = get_db()
                        row = conn.execute(
                            "SELECT MAX(substr(date,1,10)) AS latest FROM cost_data WHERE cloud_provider=? AND subscription_id=?",
                            (provider_type, provider_id),
                        ).fetchone()
                        conn.close()
                        latest = row["latest"] if row and row["latest"] else None
                        if is_full:
                            return (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")
                        if latest:
                            return (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=2)).strftime("%Y-%m-%d")
                        return (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")

                    def _sync_one_provider(provider):
                        provider = get_cloud_provider(provider["id"]) or provider
                        ptype = provider.get("provider_type")
                        pid   = provider.get("provider_id")
                        pname = provider.get("name") or pid or ptype
                        p_from = _provider_date_from(ptype, pid)
                        try:
                            records = fetch_aws_costs(provider, p_from, date_to) if ptype == "aws" \
                                      else fetch_gcp_costs(provider, p_from, date_to)
                            conn = get_db()
                            if ptype == "gcp":
                                project_ids = list({r[9] for r in (records or []) if r[9]})
                                for proj_id in project_ids:
                                    conn.execute(
                                        "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider='gcp' AND subscription_id=? AND tenant_id=?",
                                        (p_from, date_to, proj_id, tid),
                                    )
                            else:
                                conn.execute(
                                    "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider=? AND subscription_id=? AND tenant_id=?",
                                    (p_from, date_to, ptype, pid, tid),
                                )
                            if records:
                                conn.executemany(
                                    "INSERT INTO cost_data (date,resource_group,service_name,resource_type,"
                                    "resource_name,meter_category,meter_subcategory,cost,currency,"
                                    "subscription_id,tags,cloud_provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                    records,
                                )
                            conn.commit()
                            conn.close()
                            update_cloud_provider_sync_time(provider["id"], error=None)
                            print(f"[Sync] {ptype.upper()} '{pname}': {len(records or [])} records")
                            return len(records or [])
                        except Exception as cp_err:
                            update_cloud_provider_sync_time(provider["id"], error=str(cp_err))
                            print(f"[Sync] {ptype.upper()} '{pname}' failed: {cp_err}")
                            return 0

                    sync_status["message"] = f"{mode_label}: syncing {len(cp_providers)} cloud provider(s) in parallel…"
                    sync_status["progress"] = 95
                    with ThreadPoolExecutor(max_workers=min(len(cp_providers), 4)) as cp_ex:
                        cp_futures = {cp_ex.submit(_sync_one_provider, p): p for p in cp_providers}
                        for f in as_completed(cp_futures):
                            total_records += f.result() or 0
                except Exception as cp_outer_err:
                    print(f"[Sync] Cloud providers sync error (non-fatal): {cp_outer_err}")

            sync_status["message"] = f"{mode_label} complete! {total_records} records across {total_subs} subscription(s)."
            sync_status["progress"] = 100
            update_sync_log(sync_id, "success", total_records)
            # Run budget threshold checks after a successful sync
            try:
                check_budgets(provider_filter="azure")
            except Exception as be:
                print(f"[Budget] Post-sync budget check error: {be}")

        except Exception as e:
            sync_status["message"] = f"{mode_label} failed: {str(e)}"
            sync_status["progress"] = 0
            update_sync_log(sync_id, "failed", total_records, str(e))
        finally:
            sync_status["running"] = False
            _write_sync_file(False, sync_status.get("message", ""), sync_status.get("progress", 0))

    if FORCE_SYNC_INLINE and SYNC_SUBPROCESS:
        data_dir = os.path.dirname(os.path.abspath(os.getenv("DB_PATH", "/app/data/azure_costs.db")))
        os.makedirs(data_dir, exist_ok=True)
        payload = {"mode": mode, "subscription_id": target_sub, "date_to": date_to}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", dir=data_dir, delete=False, encoding="utf-8"
        ) as tf:
            json.dump(payload, tf)
            payload_path = tf.name
        runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cost_sync_runner.py")
        sync_status.update(
            {"running": True, "message": "Cost sync started in subprocess…", "progress": 0}
        )
        subprocess.Popen(
            [sys.executable, runner, payload_path],
            cwd=os.path.dirname(runner),
            stdin=subprocess.DEVNULL,
            close_fds=True,
        )
        print("[Sync] FORCE_SYNC_INLINE + SYNC_SUBPROCESS: spawned cost_sync_runner.py")
        sub_names = [s.get("name", s["subscription_id"][:12]) for s in subs_to_sync]
        return jsonify(
            {
                "message": f"Sync started (subprocess) for {len(subs_to_sync)} subscription(s)",
                "subscriptions": sub_names,
                "subprocess": True,
            }
        )

    if FORCE_SYNC_INLINE:
        print("[Sync] FORCE_SYNC_INLINE: running cost sync in request handler (no background thread).")
        run_sync()
        sub_names = [s.get("name", s["subscription_id"][:12]) for s in subs_to_sync]
        return jsonify(
            {
                "message": f"Sync finished inline for {len(subs_to_sync)} subscription(s)",
                "subscriptions": sub_names,
                "inline": True,
            }
        )

    started = start_background_thread(
        run_sync,
        name="cost-sync",
        fallback_inline=SYNC_INLINE_MODE,
    )
    if not started:
        return jsonify({"error": "Unable to start sync thread on this host. Enable SYNC_INLINE_MODE=true or FORCE_SYNC_INLINE=true."}), 503
    sub_names = [s.get("name", s["subscription_id"][:12]) for s in subs_to_sync]
    return jsonify({"message": f"Sync started for {len(subs_to_sync)} subscription(s)", "subscriptions": sub_names})


@app.route("/api/sync/status")
@login_required
def api_sync_status():
    global sync_status
    try:
        with open(_sync_status_path()) as f:
            st = json.load(f)
        sync_status.update(
            {
                "running": st.get("running", False),
                "message": st.get("message", ""),
                "progress": st.get("progress", 0),
            }
        )
        return jsonify(st)
    except (OSError, json.JSONDecodeError):
        pass
    return jsonify(sync_status)


# ─── API: Query / Search Costs ───────────────────────────────────────────────

@app.route("/api/costs")
@login_required
def api_costs():
    def _csv_list(name):
        raw = (request.args.get(name) or "").strip()
        return [v.strip() for v in raw.split(",") if v.strip()] if raw else []
    filters = {
        "subscription_id": request.args.get("subscription_id"),
        "subscription_ids": _csv_list("subscription_ids"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "granularity": request.args.get("granularity", "daily"),
        "resource_group": request.args.get("resource_group"),
        "resource_groups": _csv_list("resource_groups"),
        "service_name": request.args.get("service_name"),
        "service_names": _csv_list("service_names"),
        "include_blank_subscription": (request.args.get("include_blank_subscription") or "").lower() in ("1", "true", "yes"),
        "include_blank_resource_group": (request.args.get("include_blank_resource_group") or "").lower() in ("1", "true", "yes"),
        "include_blank_service": (request.args.get("include_blank_service") or "").lower() in ("1", "true", "yes"),
        "resource_type": request.args.get("resource_type"),
        "meter_category": request.args.get("meter_category"),
        "search": request.args.get("search"),
        "cloud_provider": request.args.get("cloud_provider") or None,
        "limit": request.args.get("limit", 100, type=int),
        "offset": request.args.get("offset", 0, type=int),
    }
    # Remove None values
    filters = {k: v for k, v in filters.items() if v is not None}
    data = query_costs(filters, tenant_id=current_tenant_id())

    # Replace raw EC2 instance IDs with resolved Name tags where available
    try:
        from database import get_aws_resource_names
        ec2_names = get_aws_resource_names()
        if ec2_names:
            for row in data:
                raw = row.get("resource_name") or ""
                if raw.startswith("i-") and raw in ec2_names:
                    row["resource_name"] = ec2_names[raw]
                    row["resource_id"] = raw  # keep original ID accessible
    except Exception:
        pass

    count_filters = dict(filters)
    count_filters.pop("limit", None)
    count_filters.pop("offset", None)
    total_meta = get_cost_total(count_filters, tenant_id=current_tenant_id(), cloud_provider=filters.get("cloud_provider"))
    return jsonify({
        "rows": data,
        "total": int(total_meta.get("total_records") or 0),
        "offset": int(filters.get("offset") or 0),
        "limit": int(filters.get("limit") or 100),
    })


@app.route("/api/costs/total")
@login_required
def api_costs_total():
    def _csv_list(name):
        raw = (request.args.get(name) or "").strip()
        return [v.strip() for v in raw.split(",") if v.strip()] if raw else []
    filters = {
        "subscription_id": request.args.get("subscription_id"),
        "subscription_ids": _csv_list("subscription_ids"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "resource_group": request.args.get("resource_group"),
        "resource_groups": _csv_list("resource_groups"),
        "service_name": request.args.get("service_name"),
        "service_names": _csv_list("service_names"),
        "include_blank_subscription": (request.args.get("include_blank_subscription") or "").lower() in ("1", "true", "yes"),
        "include_blank_resource_group": (request.args.get("include_blank_resource_group") or "").lower() in ("1", "true", "yes"),
        "include_blank_service": (request.args.get("include_blank_service") or "").lower() in ("1", "true", "yes"),
        "resource_type": request.args.get("resource_type"),
        "meter_category": request.args.get("meter_category"),
        "search": request.args.get("search"),
    }
    filters = {k: v for k, v in filters.items() if v is not None and v != ""}
    cloud_provider = request.args.get("cloud_provider") or None
    return jsonify(get_cost_total(filters, tenant_id=current_tenant_id(), cloud_provider=cloud_provider))


@app.route("/api/costs/total-by-subscription")
@login_required
def api_costs_total_by_subscription():
    def _csv_list(name):
        raw = (request.args.get(name) or "").strip()
        return [v.strip() for v in raw.split(",") if v.strip()] if raw else []
    filters = {
        "subscription_ids": _csv_list("subscription_ids"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "resource_group": request.args.get("resource_group"),
        "resource_groups": _csv_list("resource_groups"),
        "service_name": request.args.get("service_name"),
        "service_names": _csv_list("service_names"),
        "include_blank_subscription": (request.args.get("include_blank_subscription") or "").lower() in ("1", "true", "yes"),
        "include_blank_resource_group": (request.args.get("include_blank_resource_group") or "").lower() in ("1", "true", "yes"),
        "include_blank_service": (request.args.get("include_blank_service") or "").lower() in ("1", "true", "yes"),
        "resource_type": request.args.get("resource_type"),
        "meter_category": request.args.get("meter_category"),
        "search": request.args.get("search"),
        # subscription_id intentionally ignored; this endpoint returns totals for all subs
    }
    filters = {k: v for k, v in filters.items() if v is not None and v != ""}
    cloud_provider = request.args.get("cloud_provider") or None
    return jsonify(get_cost_totals_by_subscription(filters, tenant_id=current_tenant_id(), cloud_provider=cloud_provider))


@app.route("/api/resource_config")
@login_required
def api_resource_config():
    sub_id = request.args.get("subscription_id")
    rg = request.args.get("resource_group")
    name = request.args.get("resource_name")
    
    if not sub_id or not rg or not name:
        return jsonify({"error": "subscription_id, resource_group, and resource_name are required"}), 400

    cfg = get_resource_config(sub_id, rg, name)
    if cfg:
        cfg["display"] = build_display_payload(
            cfg.get("config_json"),
            cfg.get("resource_type"),
            cfg.get("sku_name"),
        )
        return jsonify(cfg)
    return jsonify({}), 404

@app.route("/api/resource_configs_list")
@login_required
def api_resource_configs_list():
    rtype = request.args.get("resource_type") or None
    try:
        lim = int(request.args.get("limit", 2000))
    except ValueError:
        lim = 2000
    configs = get_all_resource_configs(
        resource_type=rtype,
        limit=lim,
    )
    for row in configs:
        enrich_list_row(row)
    return jsonify(configs)


@app.route("/api/resource_configs/filters")
@login_required
def api_resource_configs_filters():
    return jsonify(get_resource_config_filter_options())


@app.route("/api/resource_configs/sync", methods=["POST"])
@login_required
def api_resource_configs_sync():
    """Run Resource Graph sync once (same credentials as cost sync)."""
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config_sync_runner.py")
    try:
        subprocess.Popen(
            [sys.executable, runner],
            cwd=os.path.dirname(runner),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"message": "Resource configuration sync started. Refresh the list in a few moments."})


# ─── API: Summary (grouped) ──────────────────────────────────────────────────

@app.route("/api/summary")
@login_required
def api_summary():
    group_by = request.args.get("group_by", "service_name")
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    sub_id = request.args.get("subscription_id")
    data = get_summary(group_by, date_from, date_to, subscription_id=sub_id)
    return jsonify(data)


# ─── API: Daily Trend ────────────────────────────────────────────────────────

@app.route("/api/trend")
@login_required
def api_trend():
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    resource_group = request.args.get("resource_group")
    service_name = request.args.get("service_name")
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider") or None
    data = get_daily_trend(date_from, date_to, resource_group, service_name, subscription_id=sub_id, tenant_id=current_tenant_id(), cloud_provider=cloud_provider)
    return jsonify(data)


# ─── API: Monthly Cost Breakdown ──────────────────────────────────────────────

@app.route("/api/monthly")
@login_required
def api_monthly():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider") or None
    summary = get_monthly_summary(subscription_id=sub_id, tenant_id=current_tenant_id(), cloud_provider=cloud_provider)
    service_breakdown = get_monthly_service_breakdown(subscription_id=sub_id, tenant_id=current_tenant_id(), cloud_provider=cloud_provider)
    rg_breakdown = get_monthly_rg_breakdown(subscription_id=sub_id, tenant_id=current_tenant_id(), cloud_provider=cloud_provider)
    sub_breakdown = get_monthly_subscription_breakdown(subscription_id=sub_id, tenant_id=current_tenant_id(), cloud_provider=cloud_provider)

    # Group service/rg/subscription data by month
    svc_by_month = {}
    for r in service_breakdown:
        m = r["month"]
        if m not in svc_by_month:
            svc_by_month[m] = []
        svc_by_month[m].append({"service": r["service_name"], "cost": round(r["total_cost"], 2)})

    rg_by_month = {}
    for r in rg_breakdown:
        m = r["month"]
        if m not in rg_by_month:
            rg_by_month[m] = []
        rg_by_month[m].append({"resource_group": r["resource_group"] or "Unknown", "cost": round(r["total_cost"], 2)})

    sub_by_month = {}
    for r in sub_breakdown:
        m = r["month"]
        if m not in sub_by_month:
            sub_by_month[m] = []
        sub_by_month[m].append({
            "subscription_id": r["subscription_id"],
            "name": r["subscription_name"] or r["subscription_id"] or "",
            "cost": round(r["total_cost"], 2),
            "cloud": r.get("cloud_provider", "azure"),
        })

    # Cloud breakdown per month (aws / azure / gcp totals)
    tid = current_tenant_id()
    conn = get_db()
    cloud_rows = conn.execute("""
        SELECT strftime('%Y-%m', date) as month, cloud_provider, SUM(cost) as total
        FROM cost_data
        WHERE tenant_id = ?
        GROUP BY month, cloud_provider
    """, (tid,)).fetchall()
    conn.close()
    cloud_by_month = {}
    for r in cloud_rows:
        m = r["month"]
        if m not in cloud_by_month:
            cloud_by_month[m] = {}
        cloud_by_month[m][r["cloud_provider"]] = round(r["total"], 2)

    result = []
    for s in summary:
        result.append({
            "month": s["month"],
            "total_cost": round(s["total_cost"], 2),
            "record_count": s["record_count"],
            "rg_count": s["rg_count"],
            "service_count": s["service_count"],
            "top_services": svc_by_month.get(s["month"], [])[:10],
            "top_rgs": rg_by_month.get(s["month"], [])[:10],
            "by_subscription": sub_by_month.get(s["month"], [])[:8],
            "by_cloud": cloud_by_month.get(s["month"], {}),
        })
    return jsonify(result)


# ─── API: Comparison ──────────────────────────────────────────────────────────

def _parse_compare_periods_arg(raw):
    """Parse JSON periods from query: list of {from,to,label?} or [from,to]. Returns (list[(from,to)], list[label])."""
    try:
        spec = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None, None
    if not isinstance(spec, list) or len(spec) < 2 or len(spec) > 6:
        return None, None
    periods = []
    labels = []
    for item in spec:
        if isinstance(item, dict):
            df = item.get("from")
            dt = item.get("to")
            if not df or not dt:
                return None, None
            periods.append((df, dt))
            labels.append((item.get("label") or "").strip() or f"{df} – {dt}")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            periods.append((item[0], item[1]))
            labels.append(f"{item[0]} – {item[1]}")
        else:
            return None, None
    return periods, labels


def _friendly_compare_name(name, group_by):
    """Normalize display names for compare grids, especially AWS resource identifiers."""
    value = (name or "").strip()
    if not value:
        return "Unknown"
    if group_by != "resource_name":
        return value

    # Resolve EC2 instance IDs via cached Name tags.
    if value.startswith("i-"):
        try:
            from database import get_aws_resource_names
            return get_aws_resource_names().get(value, value)
        except Exception:
            return value

    # Convert common AWS ARNs into friendly resource names.
    if value.startswith("arn:aws:"):
        parts = value.split(":")
        arn_resource = parts[5] if len(parts) > 5 else ""
        if arn_resource.startswith("db:"):
            return arn_resource.split(":", 1)[1] or value
        if arn_resource.startswith("loadbalancer/"):
            lb_parts = arn_resource.split("/")
            return lb_parts[2] if len(lb_parts) >= 3 else (lb_parts[-1] or value)
        tail_parts = arn_resource.split("/")
        return tail_parts[-1] or value

    return value


def _compare_rows_from_costs(rows_data, group_by):
    """rows_data: iterable of {name, costs: list} — add difference (last−first) and change_pct vs first."""
    out = []
    for row in rows_data:
        costs = [round(float(c or 0), 2) for c in row["costs"]]
        first = costs[0]
        last = costs[-1]
        diff = round(last - first, 2)
        pct = round((diff / first * 100), 1) if first > 0 else (100.0 if last > 0 else 0.0)
        out.append({
            "name": _friendly_compare_name(row.get("name"), group_by),
            "costs": costs,
            "difference": diff,
            "change_pct": pct,
        })
    return out


def _resource_groups_from_body_or_query(body=None):
    if body and isinstance(body.get("resource_groups"), list):
        return [x for x in body["resource_groups"] if x]
    if body and isinstance(body.get("resource_groups"), str) and body["resource_groups"].strip():
        return [x.strip() for x in body["resource_groups"].split(",") if x.strip()]
    resource_groups_str = request.args.get("resource_groups")
    return resource_groups_str.split(",") if resource_groups_str else None


def _periods_labels_from_spec_list(spec):
    """spec: list of {from, to, label?} dicts. Returns (periods, labels) or (None, None)."""
    if not isinstance(spec, list) or len(spec) < 2 or len(spec) > 6:
        return None, None
    periods = []
    labels = []
    for item in spec:
        if not isinstance(item, dict):
            return None, None
        df = item.get("from")
        dt = item.get("to")
        if not df or not dt:
            return None, None
        periods.append((df, dt))
        labels.append((item.get("label") or "").strip() or f"{df} – {dt}")
    return periods, labels


def _compare_multi_response(group_by, periods, labels, sub_id, resource_groups, cloud_provider=None, subscription_ids=None):
    data = get_comparison_data_multi(group_by, periods, subscription_id=sub_id, resource_groups=resource_groups, tenant_id=current_tenant_id(), cloud_provider=cloud_provider, subscription_ids=subscription_ids)
    rows = _compare_rows_from_costs(data, group_by)
    return jsonify({"labels": labels, "rows": rows})


@app.route("/api/compare", methods=["GET", "POST"])
@login_required
def api_compare():
    # ── POST: primary path (JSON body; force=True in case Content-Type is stripped) ──
    if request.method == "POST":
        body = request.get_json(silent=True, force=True)
        if not isinstance(body, dict):
            try:
                body = json.loads(request.get_data(as_text=True) or "{}")
            except (json.JSONDecodeError, TypeError):
                body = {}
        group_by = body.get("group_by", "service_name")
        sub_id = body.get("subscription_id")
        cloud_provider = body.get("cloud_provider") or None
        resource_groups = _resource_groups_from_body_or_query(body)
        # subscription_ids: for AWS/GCP account filtering
        sub_ids_raw = body.get("subscription_ids")
        subscription_ids = sub_ids_raw if isinstance(sub_ids_raw, list) and sub_ids_raw else None
        spec_list = body.get("periods")
        if not isinstance(spec_list, list):
            return jsonify({"error": 'POST body must include a JSON "periods" array (2–6 items with from, to, optional label).'}), 400
        periods, labels = _periods_labels_from_spec_list(spec_list)
        if not periods:
            return jsonify({"error": "Invalid periods: each entry needs from and to dates; use 2–6 periods."}), 400
        return _compare_multi_response(group_by, periods, labels, sub_id, resource_groups, cloud_provider=cloud_provider, subscription_ids=subscription_ids)

    # ── GET: ?periods=… JSON or legacy p1_from / p2_to ──
    group_by = request.args.get("group_by", "service_name")
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider") or None
    resource_groups_str = request.args.get("resource_groups")
    resource_groups = resource_groups_str.split(",") if resource_groups_str else None
    sub_ids_str = request.args.get("subscription_ids")
    subscription_ids = sub_ids_str.split(",") if sub_ids_str else None

    periods_raw = request.args.get("periods")
    if periods_raw:
        periods, labels = _parse_compare_periods_arg(periods_raw)
        if not periods:
            return jsonify({"error": "Invalid periods query parameter (expect JSON array)."}), 400
        return _compare_multi_response(group_by, periods, labels, sub_id, resource_groups, cloud_provider=cloud_provider, subscription_ids=subscription_ids)

    p1_from = request.args.get("p1_from")
    p1_to = request.args.get("p1_to")
    p2_from = request.args.get("p2_from")
    p2_to = request.args.get("p2_to")
    if all([p1_from, p1_to, p2_from, p2_to]):
        data = get_comparison_data(group_by, p1_from, p1_to, p2_from, p2_to, subscription_id=sub_id, resource_groups=resource_groups, tenant_id=current_tenant_id(), cloud_provider=cloud_provider, subscription_ids=subscription_ids)
        rows = []
        for row in data:
            p1 = round(row["period1_cost"], 2)
            p2 = round(row["period2_cost"], 2)
            diff = round(p2 - p1, 2)
            pct = round((diff / p1 * 100), 1) if p1 > 0 else (100.0 if p2 > 0 else 0)
            rows.append({
                "name": _friendly_compare_name(row.get("name"), group_by),
                "costs": [p1, p2],
                "difference": diff,
                "change_pct": pct,
            })
        return jsonify({"labels": ["Period 1", "Period 2"], "rows": rows})

    return jsonify({
        "error": "No periods supplied. The Compare button should POST JSON; hard-refresh the page (Ctrl+Shift+R) or restart the Flask app if this continues.",
    }), 400


@app.route("/api/compare/periods")
@login_required
def api_compare_periods():
    sub_id = request.args.get("subscription_id")
    return jsonify(get_available_periods(subscription_id=sub_id))


@app.route("/api/compare/drilldown")
@login_required
def api_compare_drilldown():
    group_by = request.args.get("group_by", "service_name")
    group_value = request.args.get("name", "")
    sub_id = request.args.get("subscription_id")
    resource_groups_str = request.args.get("resource_groups")
    resource_groups = resource_groups_str.split(',') if resource_groups_str else None

    periods_raw = request.args.get("periods")
    if periods_raw:
        periods, _labels = _parse_compare_periods_arg(periods_raw)
        if not group_value or not periods:
            return jsonify({"error": "name and valid periods (2–6) required"}), 400
        data = get_comparison_drilldown_multi(group_by, group_value, periods, subscription_id=sub_id, resource_groups=resource_groups, tenant_id=current_tenant_id())
        for key in data:
            if key == "daily_trend":
                continue
            for row in data[key]:
                row["name"] = row["name"] or "Unknown"
                costs = [round(float(c or 0), 2) for c in row["costs"]]
                first, last = costs[0], costs[-1]
                diff = round(last - first, 2)
                pct = round((diff / first * 100), 1) if first > 0 else (100.0 if last > 0 else 0)
                row["costs"] = costs
                row["difference"] = diff
                row["change_pct"] = pct
        return jsonify(data)

    p1_from = request.args.get("p1_from")
    p1_to = request.args.get("p1_to")
    p2_from = request.args.get("p2_from")
    p2_to = request.args.get("p2_to")
    if not all([group_value, p1_from, p1_to, p2_from, p2_to]):
        return jsonify({"error": "All parameters required"}), 400

    data = get_comparison_drilldown(group_by, group_value, p1_from, p1_to, p2_from, p2_to, subscription_id=sub_id, resource_groups=resource_groups, tenant_id=current_tenant_id())

    for key in data:
        if key == "daily_trend":
            continue
        for row in data[key]:
            p1 = round(row["period1_cost"], 2)
            p2 = round(row["period2_cost"], 2)
            diff = round(p2 - p1, 2)
            pct = round((diff / p1 * 100), 1) if p1 > 0 else (100.0 if p2 > 0 else 0)
            row["period1_cost"] = p1
            row["period2_cost"] = p2
            row["costs"] = [p1, p2]
            row["difference"] = diff
            row["change_pct"] = pct
            row["name"] = row["name"] or "Unknown"

    return jsonify(data)


@app.route("/api/compare/weekly")
@login_required
def api_compare_weekly():
    group_by = request.args.get("group_by", "service_name")
    date_from = request.args.get("date_from")
    date_to = request.args.get("date_to")
    sub_id = request.args.get("subscription_id")
    resource_groups_str = request.args.get("resource_groups")
    resource_groups = resource_groups_str.split(',') if resource_groups_str else None
    data = get_weekly_breakdown(group_by, date_from, date_to, subscription_id=sub_id, resource_groups=resource_groups)

    # Restructure: {week -> {name: cost}}
    weeks = {}
    for r in data:
        w = r["week"]
        if w not in weeks:
            weeks[w] = {"week": w, "week_start": r["week_start"], "week_end": r["week_end"], "items": []}
        weeks[w]["items"].append({"name": r["name"] or "Unknown", "cost": round(r["total_cost"], 2)})

    return jsonify(list(weeks.values()))


# ─── API: Filter Options ─────────────────────────────────────────────────────

@app.route("/api/filters")
@login_required
def api_filters():
    sub_id = request.args.get("subscription_id")
    sub_ids_raw = (request.args.get("subscription_ids") or "").strip()
    sub_ids = [v.strip() for v in sub_ids_raw.split(",") if v.strip()] if sub_ids_raw else None
    cloud = request.args.get("cloud_provider")
    return jsonify({
        "resource_groups": get_distinct_values("resource_group", subscription_id=sub_id, subscription_ids=sub_ids, cloud_provider=cloud),
        "services": get_distinct_values("service_name", subscription_id=sub_id, subscription_ids=sub_ids, cloud_provider=cloud),
        "resource_types": get_distinct_values("resource_type", subscription_id=sub_id, subscription_ids=sub_ids, cloud_provider=cloud),
        "meter_categories": get_distinct_values("meter_category", subscription_id=sub_id, subscription_ids=sub_ids, cloud_provider=cloud),
    })


# ─── API: Sync History ───────────────────────────────────────────────────────

@app.route("/api/sync/history")
@login_required
def api_sync_history():
    return jsonify(get_sync_history())


# ─── API: Export CSV ──────────────────────────────────────────────────────────

@app.route("/api/export")
@login_required
def api_export():
    def _csv_list(name):
        raw = (request.args.get(name) or "").strip()
        return [v.strip() for v in raw.split(",") if v.strip()] if raw else []
    filters = {
        "subscription_id": request.args.get("subscription_id"),
        "subscription_ids": _csv_list("subscription_ids"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "granularity": request.args.get("granularity", "daily"),
        "resource_group": request.args.get("resource_group"),
        "resource_groups": _csv_list("resource_groups"),
        "service_name": request.args.get("service_name"),
        "service_names": _csv_list("service_names"),
        "include_blank_subscription": (request.args.get("include_blank_subscription") or "").lower() in ("1", "true", "yes"),
        "include_blank_resource_group": (request.args.get("include_blank_resource_group") or "").lower() in ("1", "true", "yes"),
        "include_blank_service": (request.args.get("include_blank_service") or "").lower() in ("1", "true", "yes"),
        "resource_type": request.args.get("resource_type"),
        "cloud_provider": request.args.get("cloud_provider"),
        "search": request.args.get("search"),
    }
    filters = {k: v for k, v in filters.items() if v is not None}
    data = query_costs(filters)

    output = io.StringIO()
    writer = csv.writer(output)
    if data:
        writer.writerow(data[0].keys())
        for row in data:
            writer.writerow(row.values())

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment;filename=azure_costs.csv"}
    )


# ─── API: Chatbot ────────────────────────────────────────────────────────────

@app.route("/api/chat", methods=["POST"])
@login_required
def api_chat():
    message = request.json.get("message", "")
    if not message.strip():
        return jsonify({"reply": "Please type a question about your Azure costs."})

    reply = process_chat_message(message)
    return jsonify(reply)


# ─── API: Activity Logs ──────────────────────────────────────────────────────

activity_sync_status = {"running": False, "message": "", "progress": 0}
ACTIVITY_AUTO_SYNC_INTERVAL_MINUTES = int(os.getenv("ACTIVITY_AUTO_SYNC_INTERVAL_MINUTES", 60))
ACTIVITY_AUTO_SYNC_ENABLED = os.getenv("ACTIVITY_AUTO_SYNC_ENABLED", "false").lower() in ("true", "1", "yes")
ACTIVITY_AUTO_SYNC_DAYS = int(os.getenv("ACTIVITY_AUTO_SYNC_DAYS", 7))
_persisted_activity_sync = _load_sync_settings()
activity_auto_sync_state = {
    "enabled": _persisted_activity_sync.get("activity_enabled", ACTIVITY_AUTO_SYNC_ENABLED),
    "interval_minutes": _persisted_activity_sync.get("activity_interval_minutes", ACTIVITY_AUTO_SYNC_INTERVAL_MINUTES),
    "days": _persisted_activity_sync.get("activity_days", ACTIVITY_AUTO_SYNC_DAYS),
    "last_auto_sync": None,
    "next_auto_sync": None,
    "running": False,
}
_activity_auto_sync_timer = None


def _activity_sync_status_path():
    base = os.getenv("DB_PATH", "/app/data/azure_costs.db")
    return os.path.join(os.path.dirname(os.path.abspath(base)), ".activity_sync_status.json")


def _activity_sync_is_busy():
    try:
        with open(_activity_sync_status_path()) as f:
            st = json.load(f)
        if st.get("running"):
            return True
    except (OSError, json.JSONDecodeError):
        pass
    return activity_sync_status.get("running", False)


def _sync_or_activity_busy():
    """True if cost or activity sync is in progress (file-backed for subprocess workers)."""
    return _sync_is_busy() or _activity_sync_is_busy()


def _spawn_activity_sync_subprocess(days, target_sub, cloud_provider=None):
    """Start activity_sync_runner.py; same pattern as cost subprocess sync."""
    try:
        os.unlink(_activity_sync_status_path())
    except OSError:
        pass
    data_dir = os.path.dirname(os.path.abspath(os.getenv("DB_PATH", "/app/data/azure_costs.db")))
    os.makedirs(data_dir, exist_ok=True)
    payload = {"days": int(days), "subscription_id": target_sub, "cloud_provider": cloud_provider}
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", dir=data_dir, delete=False, encoding="utf-8"
    ) as tf:
        json.dump(payload, tf)
        payload_path = tf.name
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "activity_sync_runner.py")
    activity_sync_status.update(
        {"running": True, "message": "Activity sync started (subprocess)…", "progress": 0}
    )
    subprocess.Popen(
        [sys.executable, runner, payload_path],
        cwd=os.path.dirname(runner),
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )
    print("[Activity-sync] spawned activity_sync_runner.py")


def _execute_activity_sync(days=7, target_sub=None, cloud_provider=None):
    """Run activity sync job. Updates global activity_sync_status.
    cloud_provider: None=all, 'azure'=only Azure, 'aws'=only AWS, 'gcp'=only GCP
    """
    global activity_sync_status

    date_to = datetime.utcnow().strftime("%Y-%m-%d")
    skip_azure = cloud_provider in ("aws", "gcp")
    skip_cloud_providers = cloud_provider == "azure"

    if target_sub:
        subs_to_sync = [{"subscription_id": target_sub}]
    elif skip_azure:
        subs_to_sync = []
    else:
        subs_to_sync = get_subscriptions(enabled_only=True)
        if not subs_to_sync:
            subs_to_sync = [{"subscription_id": os.getenv("AZURE_SUBSCRIPTION_ID", "")}]

    def _fetch_one_activity(sub, days_local, date_to_local):
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

    total_subs = len(subs_to_sync)
    mode_lbl = "sequentially" if SYNC_SEQUENTIAL else "in parallel"
    provider_lbl = cloud_provider.upper() if cloud_provider else "All clouds"
    start_msg = (
        f"Starting {provider_lbl} ({total_subs} subscription(s)) {mode_lbl}..."
        if total_subs else
        f"Starting {provider_lbl} cloud provider activity sync..."
    )
    activity_sync_status = {"running": True, "message": start_msg, "progress": 5}
    total_count = 0
    all_caller_ids = set()

    try:
        completed = 0

        def _run_activity_parallel():
            nonlocal completed, total_count
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
                        activity_sync_status["message"] = f"{name} done ({count} events) [{completed}/{total_subs}]"
                        activity_sync_status["progress"] = 5 + int(75 * completed / total_subs)
                    except Exception as sub_err:
                        completed += 1
                        activity_sync_status["message"] = f"{sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]"
                        activity_sync_status["progress"] = 5 + int(75 * completed / total_subs)

        def _run_activity_sequential():
            nonlocal completed, total_count
            for sub in subs_to_sync:
                sub_name = sub.get("name", sub["subscription_id"][:12])
                try:
                    name, count, caller_ids = _fetch_one_activity(sub, days, date_to)
                    total_count += count
                    all_caller_ids.update(caller_ids)
                    completed += 1
                    activity_sync_status["message"] = f"{name} done ({count} events) [{completed}/{total_subs}]"
                    activity_sync_status["progress"] = 5 + int(75 * completed / total_subs)
                except Exception as sub_err:
                    completed += 1
                    activity_sync_status["message"] = f"{sub_name} failed: {str(sub_err)[:80]} [{completed}/{total_subs}]"
                    activity_sync_status["progress"] = 5 + int(75 * completed / total_subs)

        if total_subs > 0:
            if SYNC_SEQUENTIAL:
                _run_activity_sequential()
            else:
                try:
                    _run_activity_parallel()
                except RuntimeError as re:
                    if "thread" in str(re).lower():
                        print(f"[Activity-sync] Parallel run failed ({re}), retrying sequential.")
                        completed = 0
                        total_count = 0
                        all_caller_ids = set()
                        _run_activity_sequential()
                    else:
                        raise

        activity_sync_status["message"] = "Resolving user names..."
        activity_sync_status["progress"] = 85
        guid_ids = [c for c in all_caller_ids if "@" not in c and len(c) > 8]

        from azure_fetcher import _caller_name_cache
        claims_names = {k: v for k, v in _caller_name_cache.items() if k in guid_ids and len(v) > 15}
        if claims_names:
            save_caller_names(claims_names)

        still_unknown = [c for c in guid_ids if c not in claims_names]
        if still_unknown:
            name_map = resolve_caller_names(still_unknown)
            save_caller_names(name_map)

        # Sync AWS CloudTrail and GCP Audit Logs from cloud_providers table
        if not target_sub and not skip_cloud_providers:
            try:
                from aws_fetcher import fetch_aws_activity
                from gcp_fetcher import fetch_gcp_activity
                cp_providers = get_cloud_providers(enabled_only=True)
                allowed_types = {cloud_provider} if cloud_provider in ("aws", "gcp") else {"aws", "gcp"}
                aws_gcp = [p for p in cp_providers if p.get("provider_type") in allowed_types]
                for cp in aws_gcp:
                    cp = get_cloud_provider(cp["id"]) or cp  # re-fetch with credentials_json
                    cp_type = cp.get("provider_type", "")
                    cp_name = cp.get("name", cp.get("provider_id", ""))
                    activity_sync_status["message"] = f"Syncing {cp_name} ({cp_type.upper()}) activity..."
                    activity_sync_status["progress"] = 90
                    try:
                        if cp_type == "aws":
                            recs = fetch_aws_activity(cp, days)
                        else:
                            recs = fetch_gcp_activity(cp, days)
                        count = insert_activity_logs(recs, subscription_id=cp.get("provider_id"), cloud_provider=cp_type)
                        total_count += count
                        print(f"[Activity-sync] {cp_name} ({cp_type}): {count} events inserted")
                    except Exception as cp_err:
                        print(f"[Activity-sync] {cp_name} ({cp_type}) failed: {cp_err}")
            except Exception as outer_err:
                print(f"[Activity-sync] Cloud provider sync error: {outer_err}")

        activity_sync_status = {"running": False, "message": f"Done! {total_count} events synced.", "progress": 100}
        return True
    except Exception as e:
        activity_sync_status = {"running": False, "message": f"Failed: {str(e)}", "progress": 0}
        return False

@app.route("/api/activity/sync", methods=["POST"])
@login_required
def api_activity_sync():
    if _activity_sync_is_busy():
        return jsonify({"error": "Activity sync already in progress"}), 409

    body = request.get_json(silent=True) or {}
    days = int(body.get("days", 7))
    target_sub = body.get("subscription_id")
    cloud_provider = (body.get("cloud_provider") or "").strip().lower() or None

    if ACTIVITY_SYNC_SUBPROCESS:
        _spawn_activity_sync_subprocess(days, target_sub, cloud_provider)
        return jsonify({"message": "Activity sync started", "subprocess": True})

    started = start_background_thread(
        _execute_activity_sync,
        name="activity-sync",
        args=(days, target_sub, cloud_provider),
        fallback_inline=ACTIVITY_SYNC_INLINE_MODE,
    )
    if not started:
        return jsonify({"error": "Unable to start activity sync thread on this host. Enable ACTIVITY_SYNC_SUBPROCESS=true or ACTIVITY_SYNC_INLINE_MODE=true."}), 503
    return jsonify({"message": "Activity sync started"})


@app.route("/api/activity/sync/status")
@login_required
def api_activity_sync_status():
    global activity_sync_status
    try:
        with open(_activity_sync_status_path()) as f:
            st = json.load(f)
        activity_sync_status.update(
            {
                "running": st.get("running", False),
                "message": st.get("message", ""),
                "progress": st.get("progress", 0),
            }
        )
        return jsonify(st)
    except (OSError, json.JSONDecodeError):
        pass
    return jsonify(activity_sync_status)


def _run_activity_auto_sync():
    """Run scheduled activity-only auto-sync and schedule the next run."""
    global activity_auto_sync_state
    if _activity_sync_is_busy():
        _schedule_next_activity_auto_sync()
        return
    activity_auto_sync_state["running"] = True
    activity_auto_sync_state["last_auto_sync"] = datetime.utcnow().isoformat()
    try:
        if ACTIVITY_SYNC_SUBPROCESS:
            _spawn_activity_sync_subprocess(activity_auto_sync_state["days"], None)
        else:
            _execute_activity_sync(days=activity_auto_sync_state["days"])
    finally:
        activity_auto_sync_state["running"] = False
        _schedule_next_activity_auto_sync()


def _schedule_next_activity_auto_sync():
    global _activity_auto_sync_timer
    if _activity_auto_sync_timer:
        _activity_auto_sync_timer.cancel()
    if not activity_auto_sync_state["enabled"]:
        activity_auto_sync_state["next_auto_sync"] = None
        return
    interval_secs = max(60, int(activity_auto_sync_state["interval_minutes"]) * 60)
    next_time = datetime.utcnow() + timedelta(seconds=interval_secs)
    activity_auto_sync_state["next_auto_sync"] = next_time.isoformat()
    try:
        _activity_auto_sync_timer = threading.Timer(interval_secs, _run_activity_auto_sync)
        _activity_auto_sync_timer.daemon = True
        _activity_auto_sync_timer.start()
    except RuntimeError as e:
        activity_auto_sync_state["enabled"] = False
        activity_auto_sync_state["next_auto_sync"] = None
        print(f"[Activity Auto-Sync] Disabled (could not start timer thread): {e}")


@app.route("/api/activity-auto-sync", methods=["GET"])
@login_required
def api_get_activity_auto_sync():
    return jsonify(activity_auto_sync_state)


@app.route("/api/activity-auto-sync", methods=["POST"])
@login_required
def api_set_activity_auto_sync():
    body = request.get_json(silent=True) or {}
    if "enabled" in body:
        activity_auto_sync_state["enabled"] = bool(body["enabled"])
    if "interval_minutes" in body:
        mins = int(body["interval_minutes"])
        allowed = {5, 30, 60, 720, 1440}
        if mins not in allowed:
            return jsonify({"error": "interval_minutes must be one of 5,30,60,720,1440"}), 400
        activity_auto_sync_state["interval_minutes"] = mins
    if "days" in body:
        activity_auto_sync_state["days"] = max(1, min(30, int(body["days"])))

    if activity_auto_sync_state["enabled"]:
        _schedule_next_activity_auto_sync()
    else:
        global _activity_auto_sync_timer
        if _activity_auto_sync_timer:
            _activity_auto_sync_timer.cancel()
        activity_auto_sync_state["next_auto_sync"] = None

    _save_sync_settings({
        **_load_sync_settings(),
        "activity_enabled": activity_auto_sync_state["enabled"],
        "activity_interval_minutes": activity_auto_sync_state["interval_minutes"],
        "activity_days": activity_auto_sync_state["days"],
    })
    return jsonify({"message": f"Activity auto-sync {'enabled' if activity_auto_sync_state['enabled'] else 'disabled'}", **activity_auto_sync_state})


@app.route("/api/activity-auto-sync/run-now", methods=["POST"])
@login_required
def api_activity_auto_sync_run_now():
    if _activity_sync_is_busy():
        return jsonify({"error": "Activity sync already in progress"}), 409
    if ACTIVITY_SYNC_SUBPROCESS:
        _spawn_activity_sync_subprocess(activity_auto_sync_state["days"], None)
        return jsonify({"message": "Activity auto-sync triggered (subprocess)", "subprocess": True})
    started = start_background_thread(
        _execute_activity_sync,
        name="activity-auto-sync-run-now",
        args=(activity_auto_sync_state["days"], None),
        fallback_inline=ACTIVITY_SYNC_INLINE_MODE,
    )
    if not started:
        return jsonify({"error": "Unable to start activity sync. Set ACTIVITY_SYNC_SUBPROCESS=true."}), 503
    return jsonify({"message": "Activity auto-sync triggered manually"})


@app.route("/api/activity")
@login_required
def api_activity():
    filters = {
        "subscription_id": request.args.get("subscription_id"),
        "cloud_provider": request.args.get("cloud_provider"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "caller": request.args.get("caller"),
        "resource_group": request.args.get("resource_group"),
        "status": request.args.get("status"),
        "level": request.args.get("level"),
        "search": request.args.get("search"),
        "limit": request.args.get("limit", 200, type=int),
    }
    filters = {k: v for k, v in filters.items() if v is not None}
    data = query_activity_logs(filters)
    names = get_caller_names()
    for row in data:
        row["caller_display"] = names.get(row.get("caller", ""), row.get("caller", ""))
        rid = row.get("resource_id", "")
        if rid:
            parts = rid.strip("/").split("/")
            res_type = ""
            for i, p in enumerate(parts):
                if p.lower() == "providers" and i + 2 < len(parts):
                    res_type = parts[i + 2]
                    break
            row["resource_type_short"] = res_type
    return jsonify(data)


@app.route("/api/activity/export")
@login_required
def api_activity_export():
    filters = {
        "subscription_id": request.args.get("subscription_id"),
        "cloud_provider": request.args.get("cloud_provider"),
        "date_from": request.args.get("date_from"),
        "date_to": request.args.get("date_to"),
        "caller": request.args.get("caller"),
        "resource_group": request.args.get("resource_group"),
        "status": request.args.get("status"),
        "level": request.args.get("level"),
        "search": request.args.get("search"),
        "limit": 10000,
    }
    filters = {k: v for k, v in filters.items() if v is not None}
    data = query_activity_logs(filters)
    names = get_caller_names()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Timestamp", "User", "Operation", "Resource", "Subscription", "Resource Group", "Status", "Level", "Description"])
    for r in data:
        writer.writerow([
            r.get("timestamp", ""),
            names.get(r.get("caller", ""), r.get("caller", "")),
            r.get("operation_name", ""),
            r.get("resource_name", ""),
            r.get("subscription_name", "") or r.get("subscription_id", ""),
            r.get("resource_group", ""),
            r.get("status", ""),
            r.get("level", ""),
            r.get("description", ""),
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment;filename=activity_logs_{datetime.utcnow().strftime('%Y%m%d')}.csv"}
    )


@app.route("/api/activity/overview")
@login_required
def api_activity_overview():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider")
    conn = get_db()
    params = []
    where = " WHERE 1=1"
    if sub_id:
        where += " AND subscription_id = ?"
        params.append(sub_id)
    if cloud_provider:
        where += " AND cloud_provider = ?"
        params.append(cloud_provider)

    row = conn.execute(f"SELECT COUNT(*) as total_events, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM activity_logs{where}", params).fetchone()
    by_status = conn.execute(f"SELECT status, COUNT(*) as cnt FROM activity_logs{where} GROUP BY status ORDER BY cnt DESC", params).fetchall()
    by_level = conn.execute(f"SELECT level, COUNT(*) as cnt FROM activity_logs{where} GROUP BY level ORDER BY cnt DESC", params).fetchall()
    by_op_type = conn.execute(f"""
        SELECT
            CASE
                WHEN operation_name LIKE 'Create%' OR operation_name LIKE 'Update%' THEN 'Create/Update'
                WHEN operation_name LIKE 'Delete%' THEN 'Delete'
                WHEN operation_name LIKE 'Get%' OR operation_name LIKE 'List%' THEN 'Read'
                WHEN operation_name LIKE 'Start%' OR operation_name LIKE 'Stop%' OR operation_name LIKE 'Deallocate%' OR operation_name LIKE 'Backup%' THEN 'Action'
                WHEN operation_name LIKE 'Health%' OR operation_name LIKE '%recommendation%' THEN 'Health/Advisory'
                ELSE 'Other'
            END as op_type, COUNT(*) as cnt
        FROM activity_logs{where}
        GROUP BY op_type ORDER BY cnt DESC
    """, params).fetchall()
    daily = conn.execute(f"""
        SELECT DATE(timestamp) as day, COUNT(*) as cnt,
               SUM(CASE WHEN status='Failed' THEN 1 ELSE 0 END) as failed_cnt
        FROM activity_logs{where}
        GROUP BY day ORDER BY day DESC LIMIT 30
    """, params).fetchall()
    heatmap = conn.execute(f"""
        SELECT CAST(strftime('%w', timestamp) AS INTEGER) as dow,
               CAST(strftime('%H', timestamp) AS INTEGER) as hour,
               COUNT(*) as cnt
        FROM activity_logs{where}
        GROUP BY dow, hour
    """, params).fetchall()
    top_resources = conn.execute(f"""
        SELECT resource_name, resource_type, resource_group, COUNT(*) as cnt
        FROM activity_logs{where} AND resource_name IS NOT NULL AND resource_name != ''
        GROUP BY resource_name ORDER BY cnt DESC LIMIT 10
    """, params).fetchall()
    unique_callers = conn.execute(f"SELECT COUNT(DISTINCT caller) as cnt FROM activity_logs{where} AND caller IS NOT NULL AND caller != ''", params).fetchone()
    unique_rgs = conn.execute(f"SELECT COUNT(DISTINCT resource_group) as cnt FROM activity_logs{where} AND resource_group IS NOT NULL AND resource_group != ''", params).fetchone()
    conn.close()

    return jsonify({
        "total_events": row["total_events"] or 0,
        "earliest": row["earliest"],
        "latest": row["latest"],
        "by_status": {r["status"]: r["cnt"] for r in by_status},
        "by_level": {r["level"]: r["cnt"] for r in by_level},
        "by_operation_type": {r["op_type"]: r["cnt"] for r in by_op_type},
        "daily_trend": [dict(r) for r in reversed(daily)],
        "hourly_heatmap": [dict(r) for r in heatmap],
        "top_resources": [dict(r) for r in top_resources],
        "unique_callers": unique_callers["cnt"] if unique_callers else 0,
        "unique_rgs": unique_rgs["cnt"] if unique_rgs else 0,
    })


@app.route("/api/activity/users")
@login_required
def api_activity_users():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider")
    conn = get_db()
    params = []
    where = " WHERE caller IS NOT NULL AND caller != ''"
    if sub_id:
        where += " AND subscription_id = ?"
        params.append(sub_id)
    if cloud_provider:
        where += " AND cloud_provider = ?"
        params.append(cloud_provider)
    rows = conn.execute(f"""
        SELECT caller,
               COUNT(*) as total_ops,
               SUM(CASE WHEN status='Succeeded' THEN 1 ELSE 0 END) as succeeded,
               SUM(CASE WHEN status='Failed' THEN 1 ELSE 0 END) as failed,
               SUM(CASE WHEN operation_name LIKE 'Create%' OR operation_name LIKE 'Update%' THEN 1 ELSE 0 END) as creates,
               SUM(CASE WHEN operation_name LIKE 'Delete%' THEN 1 ELSE 0 END) as deletes,
               COUNT(DISTINCT resource_name) as resource_count,
               MAX(timestamp) as last_seen
        FROM activity_logs
        {where}
        GROUP BY caller
        ORDER BY total_ops DESC
        LIMIT 100
    """, params).fetchall()
    conn.close()
    names = get_caller_names()
    users = []
    for r in rows:
        d = dict(r)
        d["caller_display"] = names.get(d.get("caller", ""), d.get("caller", ""))
        users.append(d)
    return jsonify({"users": users})


@app.route("/api/activity/resource-timeline")
@login_required
def api_activity_resource_timeline():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider")
    resource_name = request.args.get("resource_name")
    resource_group = request.args.get("resource_group")
    conn = get_db()
    params = []
    where = " WHERE 1=1"
    if sub_id:
        where += " AND subscription_id = ?"
        params.append(sub_id)
    if cloud_provider:
        where += " AND cloud_provider = ?"
        params.append(cloud_provider)
    if resource_group:
        where += " AND resource_group = ?"
        params.append(resource_group)

    if resource_name:
        rows = conn.execute(f"""
            SELECT timestamp, caller, operation_name, status, level, resource_type, resource_name, resource_group
            FROM activity_logs
            {where} AND resource_name = ?
            ORDER BY timestamp ASC
            LIMIT 1000
        """, params + [resource_name]).fetchall()
        conn.close()
        names = get_caller_names()
        events = []
        for r in rows:
            d = dict(r)
            d["caller_display"] = names.get(d.get("caller", ""), d.get("caller", ""))
            events.append(d)
        return jsonify({"events": events})

    rows = conn.execute(f"""
        SELECT resource_name, resource_type, resource_group,
               COUNT(*) as event_count,
               MIN(timestamp) as first_event,
               MAX(timestamp) as last_event,
               SUM(CASE WHEN status='Failed' THEN 1 ELSE 0 END) as failures,
               GROUP_CONCAT(DISTINCT
                   CASE
                       WHEN operation_name LIKE 'Create%' OR operation_name LIKE 'Update%' THEN 'Create'
                       WHEN operation_name LIKE 'Delete%' THEN 'Delete'
                       WHEN operation_name LIKE 'Start%' OR operation_name LIKE 'Stop%' OR operation_name LIKE 'Deallocate%' THEN 'Action'
                       ELSE 'Other'
                   END
               ) as op_types
        FROM activity_logs
        {where} AND resource_name IS NOT NULL AND resource_name != ''
        GROUP BY resource_name
        ORDER BY last_event DESC
        LIMIT 500
    """, params).fetchall()
    conn.close()
    return jsonify({"resources": [dict(r) for r in rows]})


@app.route("/api/activity/failed")
@login_required
def api_activity_failed():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider")
    conn = get_db()
    params = []
    where = " WHERE status = 'Failed'"
    if sub_id:
        where += " AND subscription_id = ?"
        params.append(sub_id)
    if cloud_provider:
        where += " AND cloud_provider = ?"
        params.append(cloud_provider)
    total = conn.execute(f"SELECT COUNT(*) as cnt FROM activity_logs{where}", params).fetchone()
    by_op = conn.execute(f"""
        SELECT operation_name, COUNT(*) as cnt
        FROM activity_logs {where}
        GROUP BY operation_name
        ORDER BY cnt DESC
        LIMIT 20
    """, params).fetchall()
    by_res = conn.execute(f"""
        SELECT resource_name, resource_group, COUNT(*) as cnt, MAX(timestamp) as last_occurred,
               GROUP_CONCAT(DISTINCT operation_name) as operations
        FROM activity_logs {where} AND resource_name IS NOT NULL AND resource_name != ''
        GROUP BY resource_name
        ORDER BY cnt DESC
        LIMIT 20
    """, params).fetchall()
    by_caller = conn.execute(f"""
        SELECT caller, COUNT(*) as cnt
        FROM activity_logs {where} AND caller IS NOT NULL AND caller != ''
        GROUP BY caller
        ORDER BY cnt DESC
        LIMIT 20
    """, params).fetchall()
    recent = conn.execute(f"""
        SELECT timestamp, caller, operation_name, resource_name, resource_group, level
        FROM activity_logs {where}
        ORDER BY timestamp DESC
        LIMIT 100
    """, params).fetchall()
    daily = conn.execute(f"""
        SELECT DATE(timestamp) as day, COUNT(*) as cnt
        FROM activity_logs {where}
        GROUP BY day
        ORDER BY day DESC
        LIMIT 30
    """, params).fetchall()
    conn.close()
    names = get_caller_names()
    recent_out = []
    for r in recent:
        d = dict(r)
        d["caller_display"] = names.get(d.get("caller", ""), d.get("caller", ""))
        recent_out.append(d)
    return jsonify({
        "total_failed": total["cnt"] if total else 0,
        "by_operation": [dict(r) for r in by_op],
        "by_resource": [dict(r) for r in by_res],
        "by_caller": [dict(r) for r in by_caller],
        "recent": recent_out,
        "daily_trend": [dict(r) for r in reversed(daily)],
    })


@app.route("/api/activity/security")
@login_required
def api_activity_security():
    sub_id = request.args.get("subscription_id")
    cloud_provider = request.args.get("cloud_provider")
    conn = get_db()
    params = []
    where = " WHERE 1=1"
    if sub_id:
        where += " AND subscription_id = ?"
        params.append(sub_id)
    if cloud_provider:
        where += " AND cloud_provider = ?"
        params.append(cloud_provider)
    events = conn.execute(f"""
        SELECT timestamp, caller, operation_name, operation, resource_name, resource_group, status, level
        FROM activity_logs
        {where} AND (
            operation LIKE 'Microsoft.Authorization/%'
            OR operation LIKE 'Microsoft.Network/networkSecurityGroups/%'
            OR operation LIKE '%diagnosticSettings%'
            OR operation_name LIKE '%role assignment%'
            OR operation_name LIKE '%Policy action%'
            OR operation_name LIKE '%Network Security Group%'
            OR operation_name LIKE '%lock%'
            OR operation_name LIKE '%Firewall Rule%'
        )
        ORDER BY timestamp DESC
        LIMIT 500
    """, params).fetchall()
    conn.close()
    names = get_caller_names()
    by_type = {}
    top_caller = {}
    out = []
    for r in events:
        d = dict(r)
        d["caller_display"] = names.get(d.get("caller", ""), d.get("caller", ""))
        s = (d.get("operation", "") + " " + d.get("operation_name", "")).lower()
        if "roleassignment" in s or "role assignment" in s:
            t = "Role Assignments"
        elif "policy" in s:
            t = "Policy Changes"
        elif "networksecuritygroup" in s or "network security group" in s or "firewall" in s:
            t = "Network Security"
        elif "keyvault" in s or "key vault" in s:
            t = "Key Vault"
        elif "diagnostic" in s:
            t = "Diagnostic Settings"
        elif "lock" in s:
            t = "Resource Locks"
        else:
            t = "Other Security"
        by_type[t] = by_type.get(t, 0) + 1
        c = d.get("caller_display", "")
        if c:
            top_caller[c] = top_caller.get(c, 0) + 1
        out.append(d)
    top_callers = sorted(top_caller.items(), key=lambda x: -x[1])[:10]
    return jsonify({"total": len(out), "by_type": by_type, "top_callers": top_callers, "events": out})


@app.route("/api/activity/stats")
@login_required
def api_activity_stats():
    stats = get_activity_stats()
    names = get_caller_names()
    stats["callers_display"] = {c: names.get(c, c) for c in stats.get("callers", [])}
    for r in stats.get("recent", []):
        r["caller_display"] = names.get(r.get("caller", ""), r.get("caller", ""))
    return jsonify(stats)


@app.route("/api/activity/filters")
@login_required
def api_activity_filters():
    callers = get_activity_distinct("caller")
    names = get_caller_names()
    caller_options = [{"id": c, "name": names.get(c, c)} for c in callers]
    return jsonify({
        "callers": caller_options,
        "resource_groups": get_activity_distinct("resource_group"),
        "statuses": get_activity_distinct("status"),
        "levels": get_activity_distinct("level"),
    })


@app.route("/api/caller-names", methods=["GET"])
@login_required
def api_get_caller_names():
    return jsonify(get_caller_names())


@app.route("/api/caller-names", methods=["POST"])
@login_required
def api_set_caller_names():
    body = request.get_json(silent=True) or {}
    if not body:
        return jsonify({"error": "No data"}), 400
    save_caller_names(body)
    return jsonify({"message": f"Updated {len(body)} caller name(s)"})


@app.route("/api/custom-cost", methods=["POST"])
@login_required
def api_custom_cost():
    body = request.get_json(silent=True) or {}
    sub_ids = body.get("subscription_ids") or []
    sub_id = body.get("subscription_id")
    rgs = body.get("resource_groups") or []
    services = body.get("services") or []
    date_from = body.get("date_from")
    date_to = body.get("date_to")
    cloud_provider = body.get("cloud_provider") or None
    result = get_custom_cost(
        subscription_id=sub_id or None,
        subscription_ids=sub_ids if sub_ids else None,
        resource_groups=rgs if rgs else None,
        services=services if services else None,
        date_from=date_from or None,
        date_to=date_to or None,
        tenant_id=current_tenant_id(),
        cloud_provider=cloud_provider,
    )
    return jsonify(result)


@app.route("/api/costs/by-cloud")
@login_required
def api_costs_by_cloud():
    date_from = request.args.get("date_from")
    date_to   = request.args.get("date_to")
    data = get_cost_by_cloud(
        tenant_id=current_tenant_id(),
        date_from=date_from,
        date_to=date_to
    )
    return jsonify(data)


@app.route("/api/costs/cloud-providers-in-data")
@login_required
def api_cloud_providers_in_data():
    providers = get_distinct_cloud_providers_in_data(tenant_id=current_tenant_id())
    return jsonify(providers)


@app.route("/api/saved-filters", methods=["GET"])
@login_required
def api_get_saved_filters():
    return jsonify(get_saved_filters())


@app.route("/api/saved-filters", methods=["POST"])
@login_required
def api_save_filter():
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    filters = body.get("filters")
    if not name or not filters:
        return jsonify({"error": "Name and filters are required"}), 400
    fid = save_filter(name, filters)
    return jsonify({"id": fid, "message": f"Filter '{name}' saved"})


@app.route("/api/saved-filters/<int:fid>", methods=["PUT"])
@login_required
def api_update_saved_filter(fid):
    body = request.get_json(silent=True) or {}
    update_saved_filter(fid, name=body.get("name"), filters=body.get("filters"))
    return jsonify({"message": "Filter updated"})


@app.route("/api/saved-filters/<int:fid>", methods=["DELETE"])
@login_required
def api_delete_saved_filter(fid):
    delete_saved_filter(fid)
    return jsonify({"message": "Filter deleted"})


# ─── Email Reports ────────────────────────────────────────────────────────────

@app.route("/api/email/settings", methods=["GET"])
@login_required
def api_get_email_settings():
    settings = get_email_settings()
    safe = dict(settings)
    if safe.get("smtp_password"):
        safe["smtp_password"] = "••••••••"
    return jsonify(safe)


@app.route("/api/email/settings", methods=["POST"])
@login_required
def api_update_email_settings():
    body = request.get_json(silent=True) or {}
    if body.get("smtp_password") == "••••••••":
        body.pop("smtp_password", None)
    update_email_settings(body)
    return jsonify({"message": "Email settings updated"})


@app.route("/api/email/test", methods=["POST"])
@login_required
def api_test_email():
    body = request.get_json(silent=True) or {}
    recipient = body.get("recipient", "").strip()
    if not recipient:
        return jsonify({"error": "Recipient email is required"}), 400
    try:
        send_test_email(recipient)
        return jsonify({"message": f"Test email sent to {recipient}"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/send-report", methods=["POST"])
@login_required
def api_send_report_now():
    try:
        send_report_email(report_type="manual")
        return jsonify({"message": "Report sent successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/email/preview", methods=["GET"])
@login_required
def api_preview_report():
    settings = get_email_settings()
    sections_param = request.args.get("sections")
    if sections_param:
        sections = [s.strip() for s in sections_param.split(",") if s.strip()]
    else:
        sections = settings.get("report_sections", ["summary", "subscriptions", "top_services", "top_rgs", "trend"])
    cloud_provider = request.args.get("cloud_provider", "").strip() or None
    # Allow URL params to override saved date settings for live preview
    date_range = request.args.get("date_range", "").strip()
    if date_range:
        settings["report_date_range"] = date_range
    date_from = request.args.get("date_from", "").strip()
    if date_from:
        settings["report_date_from"] = date_from
    date_to = request.args.get("date_to", "").strip()
    if date_to:
        settings["report_date_to"] = date_to
    html = _build_report_html(sections, settings=settings, cloud_provider=cloud_provider)
    return Response(html, mimetype="text/html")


@app.route("/api/email/log", methods=["GET"])
@login_required
def api_email_log():
    return jsonify(get_email_log(30))


# ─── Custom Reports ──────────────────────────────────────────────────────────

@app.route("/api/custom-reports", methods=["GET"])
@login_required
def api_get_custom_reports():
    return jsonify(get_custom_reports())


@app.route("/api/custom-reports", methods=["POST"])
@login_required
def api_create_custom_report():
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Report name is required"}), 400
    rid = save_custom_report(body)
    return jsonify({"id": rid, "message": f"Report '{name}' created"})


@app.route("/api/custom-reports/<int:rid>", methods=["PUT"])
@login_required
def api_update_custom_report(rid):
    body = request.get_json(silent=True) or {}
    update_custom_report(rid, body)
    return jsonify({"message": "Report updated"})


@app.route("/api/custom-reports/<int:rid>", methods=["DELETE"])
@login_required
def api_delete_custom_report(rid):
    delete_custom_report(rid)
    return jsonify({"message": "Report deleted"})


@app.route("/api/custom-reports/<int:rid>/send", methods=["POST"])
@login_required
def api_send_custom_report(rid):
    try:
        send_custom_report(rid, report_type="manual")
        return jsonify({"message": "Custom report sent successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/custom-reports/<int:rid>/preview", methods=["GET"])
@login_required
def api_preview_custom_report(rid):
    try:
        html = preview_custom_report(rid)
        return Response(html, mimetype="text/html")
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Auto-Sync Scheduler ──────────────────────────────────────────────────────

_auto_sync_timer = None

def _run_auto_sync():
    """Execute an incremental cost sync + activity sync silently in the background."""
    global sync_status, activity_sync_status, auto_sync_state

    if _sync_or_activity_busy():
        print("[Auto-Sync] Skipped — a sync is already running.")
        _schedule_next_auto_sync()
        return

    auto_sync_state["running"] = True
    auto_sync_state["last_auto_sync"] = datetime.utcnow().isoformat()
    print(f"[Auto-Sync] Starting at {auto_sync_state['last_auto_sync']}")

    subs_to_sync = get_subscriptions(enabled_only=True)
    if not subs_to_sync:
        subs_to_sync = [{"subscription_id": os.getenv("AZURE_SUBSCRIPTION_ID", ""), "name": "Default"}]

    months = int(os.getenv("COST_HISTORY_MONTHS", 3))
    date_to = datetime.utcnow().strftime("%Y-%m-%d")
    total_subs = len(subs_to_sync)
    sync_id = log_sync(datetime.utcnow().isoformat(), "", date_to)
    total_records = 0

    try:
        # --- Parallel cost sync ---
        sync_status = {"running": True, "message": f"Auto-sync: costs ({total_subs} subs)...", "progress": 5}

        def _auto_fetch_cost(sub):
            sub_id = sub["subscription_id"]
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
                    subscription_id=sub_id
                )
                all_records.extend(records)
                current_from = chunk_to + timedelta(days=1)

            count = insert_cost_records(all_records)
            update_subscription_sync_time(sub_id, "cost")
            return count

        max_w = min(total_subs, 5)
        done = 0

        def _run_cost_parallel():
            nonlocal total_records, done
            with ThreadPoolExecutor(max_workers=max_w) as executor:
                cost_futures = {executor.submit(_auto_fetch_cost, sub): sub for sub in subs_to_sync}
                for future in as_completed(cost_futures):
                    try:
                        total_records += future.result()
                    except Exception as e:
                        print(f"[Auto-Sync] Cost sub error: {e}")
                    done += 1
                    sync_status["progress"] = 5 + int(45 * done / total_subs)
                    sync_status["message"] = f"Auto-sync: costs [{done}/{total_subs}] done"

        def _run_cost_sequential():
            nonlocal total_records, done
            for sub in subs_to_sync:
                try:
                    total_records += _auto_fetch_cost(sub)
                except Exception as e:
                    print(f"[Auto-Sync] Cost sub error: {e}")
                done += 1
                sync_status["progress"] = 5 + int(45 * done / total_subs)
                sync_status["message"] = f"Auto-sync: costs [{done}/{total_subs}] done"

        if SYNC_SEQUENTIAL:
            _run_cost_sequential()
        else:
            try:
                _run_cost_parallel()
            except RuntimeError as re:
                if "thread" in str(re).lower():
                    print(f"[Auto-Sync] Cost parallel failed ({re}), retrying sequential.")
                    total_records = 0
                    done = 0
                    _run_cost_sequential()
                else:
                    raise

        # --- AWS / GCP provider sync (parallel) ---
        try:
            from aws_fetcher import fetch_aws_costs
            from gcp_fetcher import fetch_gcp_costs
            from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _ac
            cp_providers = get_cloud_providers(enabled_only=True)
            cp_providers = [p for p in cp_providers if p.get("provider_type") in ("aws", "gcp")]
            months = int(os.getenv("COST_HISTORY_MONTHS", 3))

            def _auto_sync_provider(p):
                p = get_cloud_provider(p["id"]) or p
                ptype = p.get("provider_type")
                pid   = p.get("provider_id")
                pname = p.get("name") or pid or ptype
                try:
                    conn2 = get_db()
                    row = conn2.execute(
                        "SELECT MAX(substr(date,1,10)) FROM cost_data WHERE cloud_provider=? AND subscription_id=?",
                        (ptype, pid),
                    ).fetchone()
                    conn2.close()
                    latest = row[0] if row and row[0] else None
                    p_from = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=2)).strftime("%Y-%m-%d") if latest \
                             else (datetime.utcnow() - timedelta(days=months * 30)).strftime("%Y-%m-%d")
                    records = fetch_aws_costs(p, p_from, date_to) if ptype == "aws" \
                              else fetch_gcp_costs(p, p_from, date_to)
                    conn2 = get_db()
                    if ptype == "gcp":
                        project_ids = list({r[9] for r in (records or []) if r[9]})
                        for proj_id in project_ids:
                            conn2.execute(
                                "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider='gcp' AND subscription_id=?",
                                (p_from, date_to, proj_id),
                            )
                    else:
                        conn2.execute(
                            "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider=? AND subscription_id=?",
                            (p_from, date_to, ptype, pid),
                        )
                    if records:
                        conn2.executemany(
                            "INSERT INTO cost_data (date,resource_group,service_name,resource_type,resource_name,"
                            "meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            records,
                        )
                    conn2.commit()
                    conn2.close()
                    update_cloud_provider_sync_time(p["id"], error=None)
                    print(f"[Auto-Sync] {ptype.upper()} '{pname}': {len(records or [])} records")
                    return len(records or [])
                except Exception as cp_err:
                    update_cloud_provider_sync_time(p["id"], error=str(cp_err))
                    print(f"[Auto-Sync] {ptype.upper()} '{pname}' failed: {cp_err}")
                    return 0

            with _TPE(max_workers=min(len(cp_providers), 4)) as ex:
                for count in _ac({ex.submit(_auto_sync_provider, p): p for p in cp_providers}):
                    total_records += count.result() or 0
        except Exception as cp_outer:
            print(f"[Auto-Sync] AWS/GCP sync error (non-fatal): {cp_outer}")

        update_sync_log(sync_id, "success", total_records)
        sync_status = {"running": False, "message": f"Auto-sync costs done: {total_records} records", "progress": 100}

        # --- Parallel activity sync ---
        activity_sync_status = {"running": True, "message": f"Auto-sync: activity ({total_subs} subs)...", "progress": 5}
        total_events = 0
        all_caller_ids = set()

        def _auto_fetch_activity(sub):
            sub_id = sub["subscription_id"]
            latest = get_latest_activity_timestamp(subscription_id=sub_id)
            if latest:
                date_from = latest[:10]
            else:
                date_from = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%d")

            records = fetch_activity_logs(date_from, date_to, subscription_id=sub_id)
            count = insert_activity_logs(records, subscription_id=sub_id)
            update_subscription_sync_time(sub_id, "activity")
            cids = {r[2] for r in records if r[2]}
            return count, cids

        done = 0

        def _run_act_parallel():
            nonlocal total_events, done
            with ThreadPoolExecutor(max_workers=max_w) as executor:
                act_futures = {executor.submit(_auto_fetch_activity, sub): sub for sub in subs_to_sync}
                for future in as_completed(act_futures):
                    try:
                        count, cids = future.result()
                        total_events += count
                        all_caller_ids.update(cids)
                    except Exception as e:
                        print(f"[Auto-Sync] Activity sub error: {e}")
                    done += 1
                    activity_sync_status["progress"] = 5 + int(75 * done / total_subs)
                    activity_sync_status["message"] = f"Auto-sync: activity [{done}/{total_subs}] done"

        def _run_act_sequential():
            nonlocal total_events, done
            for sub in subs_to_sync:
                try:
                    count, cids = _auto_fetch_activity(sub)
                    total_events += count
                    all_caller_ids.update(cids)
                except Exception as e:
                    print(f"[Auto-Sync] Activity sub error: {e}")
                done += 1
                activity_sync_status["progress"] = 5 + int(75 * done / total_subs)
                activity_sync_status["message"] = f"Auto-sync: activity [{done}/{total_subs}] done"

        if SYNC_SEQUENTIAL:
            _run_act_sequential()
        else:
            try:
                _run_act_parallel()
            except RuntimeError as re:
                if "thread" in str(re).lower():
                    print(f"[Auto-Sync] Activity parallel failed ({re}), retrying sequential.")
                    total_events = 0
                    all_caller_ids.clear()
                    done = 0
                    _run_act_sequential()
                else:
                    raise

        # Resolve caller names
        guid_ids = [c for c in all_caller_ids if "@" not in c and len(c) > 8]
        from azure_fetcher import _caller_name_cache
        claims_names = {k: v for k, v in _caller_name_cache.items() if k in guid_ids and len(v) > 15}
        if claims_names:
            save_caller_names(claims_names)
        still_unknown = [c for c in guid_ids if c not in claims_names]
        if still_unknown:
            name_map = resolve_caller_names(still_unknown)
            save_caller_names(name_map)

        activity_sync_status = {"running": False, "message": f"Auto-sync done: {total_events} events", "progress": 100}

        print(f"[Auto-Sync] Complete — {total_records} cost records, {total_events} activity events")

    except Exception as e:
        print(f"[Auto-Sync] Error: {e}")
        sync_status = {"running": False, "message": f"Auto-sync failed: {str(e)}", "progress": 0}
        activity_sync_status = {"running": False, "message": "", "progress": 0}
    finally:
        auto_sync_state["running"] = False
        _schedule_next_auto_sync()


def _schedule_next_auto_sync():
    """Schedule the next auto-sync timer."""
    global _auto_sync_timer
    if _auto_sync_timer:
        _auto_sync_timer.cancel()

    if not auto_sync_state["enabled"]:
        auto_sync_state["next_auto_sync"] = None
        return

    interval_secs = auto_sync_state["interval_hours"] * 3600
    next_time = datetime.utcnow() + timedelta(seconds=interval_secs)
    auto_sync_state["next_auto_sync"] = next_time.isoformat()

    try:
        _auto_sync_timer = threading.Timer(interval_secs, _run_auto_sync)
        _auto_sync_timer.daemon = True
        _auto_sync_timer.start()
        print(f"[Auto-Sync] Next sync scheduled at {auto_sync_state['next_auto_sync']} ({auto_sync_state['interval_hours']}h)")
    except RuntimeError as e:
        auto_sync_state["enabled"] = False
        auto_sync_state["next_auto_sync"] = None
        print(f"[Auto-Sync] Disabled (could not start timer thread): {e}")


@app.route("/api/auto-sync", methods=["GET"])
@login_required
def api_get_auto_sync():
    return jsonify(auto_sync_state)


@app.route("/api/auto-sync", methods=["POST"])
@login_required
def api_set_auto_sync():
    body = request.get_json(silent=True) or {}
    if "enabled" in body:
        auto_sync_state["enabled"] = bool(body["enabled"])
    if "interval_hours" in body:
        hrs = max(1, min(24, int(body["interval_hours"])))
        auto_sync_state["interval_hours"] = hrs

    if auto_sync_state["enabled"]:
        _schedule_next_auto_sync()
    else:
        global _auto_sync_timer
        if _auto_sync_timer:
            _auto_sync_timer.cancel()
        auto_sync_state["next_auto_sync"] = None

    _save_sync_settings({
        **_load_sync_settings(),
        "enabled": auto_sync_state["enabled"],
        "interval_hours": auto_sync_state["interval_hours"],
    })
    return jsonify({"message": f"Auto-sync {'enabled' if auto_sync_state['enabled'] else 'disabled'}", **auto_sync_state})


@app.route("/api/auto-sync/run-now", methods=["POST"])
@login_required
def api_auto_sync_run_now():
    if _sync_or_activity_busy():
        return jsonify({"error": "A sync is already running"}), 409
    started = start_background_thread(
        _run_auto_sync,
        name="auto-sync-run-now",
        daemon=True,
    )
    if not started:
        return jsonify({"error": "Unable to start auto-sync thread on this host."}), 503
    return jsonify({"message": "Auto-sync triggered manually"})


# ─── Scheduled Email Reports ──────────────────────────────────────────────────

_email_timer = None

def _check_email_schedule():
    """Check if it's time to send a scheduled report, then reschedule."""
    global _email_timer
    try:
        settings = get_email_settings()
        if not settings.get("enabled"):
            _schedule_email_check()
            return

        now = datetime.utcnow()
        schedule = settings.get("schedule", "weekly")
        target_hour = settings.get("schedule_hour", 8)
        target_day = settings.get("schedule_day", 1)

        should_send = False
        if now.hour == target_hour:
            if schedule == "daily":
                should_send = True
            elif schedule == "weekly" and now.weekday() == target_day:
                should_send = True
            elif schedule == "monthly" and now.day == 1:
                should_send = True

        if should_send:
            print(f"[Email Report] Sending scheduled {schedule} report...")
            try:
                send_report_email(report_type="scheduled")
                print("[Email Report] Sent successfully.")
            except Exception as e:
                print(f"[Email Report] Failed: {e}")

        # Check custom reports
        custom_reports = get_custom_reports()
        for cr in custom_reports:
            if not cr.get("enabled") or cr.get("schedule", "none") == "none":
                continue
            cr_schedule = cr["schedule"]
            cr_hour = cr.get("schedule_hour", 8)
            cr_day = cr.get("schedule_day", 1)
            cr_should_send = False
            if now.hour == cr_hour:
                if cr_schedule == "daily":
                    cr_should_send = True
                elif cr_schedule == "weekly" and now.weekday() == cr_day:
                    cr_should_send = True
                elif cr_schedule == "monthly" and now.day == 1:
                    cr_should_send = True
            if cr_should_send:
                try:
                    print(f"[Email Report] Sending custom report '{cr['name']}'...")
                    send_custom_report(cr["id"], report_type="scheduled")
                    print(f"[Email Report] Custom report '{cr['name']}' sent.")
                except Exception as e:
                    print(f"[Email Report] Custom report '{cr['name']}' failed: {e}")

    except Exception as e:
        print(f"[Email Report] Scheduler error: {e}")
    finally:
        _schedule_email_check()


def _schedule_email_check():
    """Check every hour if a report needs to be sent."""
    global _email_timer
    if _email_timer:
        _email_timer.cancel()
    try:
        _email_timer = threading.Timer(3600, _check_email_schedule)
        _email_timer.daemon = True
        _email_timer.start()
    except RuntimeError as e:
        print(f"[Email Report] Scheduler disabled (could not start timer thread): {e}")


# ─── SaaS: Super-Admin Portal ────────────────────────────────────────────────

@app.route("/superadmin")
@super_admin_required
def super_admin_dashboard():
    tenants = get_all_tenants()
    return render_template("superadmin.html",
                           tenants=tenants,
                           username="Super Admin")

@app.route("/api/superadmin/tenants/<int:tid>", methods=["PUT"])
@super_admin_required
def api_sa_tenant_update(tid):
    body = request.get_json(silent=True) or {}
    update_tenant(tid, **{k: body[k] for k in ("plan","status","max_users","max_cloud_providers") if k in body})
    return jsonify({"message": "Updated"})

@app.route("/api/superadmin/impersonate/<int:tid>", methods=["POST"])
@super_admin_required
def api_sa_impersonate(tid):
    """Let super-admin view the app as a specific tenant."""
    tenant = get_tenant(tid)
    if not tenant:
        return jsonify({"error": "Tenant not found"}), 404
    users = get_tenant_users(tid)
    if not users:
        return jsonify({"error": "No users in tenant"}), 400
    u = users[0]
    session["tenant_id"]   = tid
    session["tenant_name"] = tenant["name"]
    session["tenant_slug"] = tenant["slug"]
    session["username"]    = f"[Impersonating] {tenant['name']}"
    session["role"]        = "admin"
    # keep is_super_admin=True so we can exit
    return jsonify({"message": f"Now impersonating {tenant['name']}", "redirect": "/"})

@app.route("/api/superadmin/stop-impersonate", methods=["POST"])
@super_admin_required
def api_sa_stop_impersonate():
    session["tenant_id"]   = None
    session["tenant_name"] = "Super Admin"
    session["username"]    = "Super Admin"
    return jsonify({"redirect": "/superadmin"})


# ─── SaaS: Tenant Settings & Team Management ─────────────────────────────────

@app.route("/api/tenant")
@login_required
def api_tenant_info():
    tid = current_tenant_id()
    tenant = get_tenant(tid) if tid else {"name": "Super Admin", "plan": "enterprise"}
    users  = get_tenant_users(tid) if tid else []
    providers = get_cloud_providers(tenant_id=current_tenant_id())
    return jsonify({
        "tenant": tenant,
        "users":  users,
        "provider_count": len(providers),
    })

@app.route("/api/tenant/users", methods=["GET"])
@login_required
def api_tenant_users():
    return jsonify(get_tenant_users(current_tenant_id()))

@app.route("/api/tenant/users/<int:uid>/role", methods=["PUT"])
@login_required
@role_required("admin")
def api_tenant_user_role(uid):
    body = request.get_json(silent=True) or {}
    role = body.get("role", "viewer")
    if role not in ("admin", "editor", "viewer"):
        return jsonify({"error": "Invalid role"}), 400
    update_user_role(uid, current_tenant_id(), role)
    return jsonify({"message": "Role updated"})

@app.route("/api/tenant/users/<int:uid>", methods=["DELETE"])
@login_required
@role_required("admin")
def api_tenant_user_delete(uid):
    if uid == session.get("user_id"):
        return jsonify({"error": "Cannot delete yourself"}), 400
    delete_user(uid, current_tenant_id())
    return jsonify({"message": "User removed"})

@app.route("/api/tenant/invite", methods=["POST"])
@login_required
@role_required("admin")
def api_tenant_invite():
    body  = request.get_json(silent=True) or {}
    email = body.get("email", "").strip().lower()
    role  = body.get("role", "viewer")
    if not email:
        return jsonify({"error": "Email required"}), 400
    token = create_invite(current_tenant_id(), email, role)
    invite_url = f"{request.host_url}invite/{token}"
    # Optionally send email here; for now return the link
    return jsonify({"message": f"Invite created for {email}", "invite_url": invite_url, "token": token})


# ─── Phase 1 MVP: Cloud Providers ────────────────────────────────────────────

@app.route("/api/cloud-providers", methods=["GET"])
@login_required
def api_cloud_providers_list():
    return jsonify(get_cloud_providers(tenant_id=current_tenant_id()))


@app.route("/api/cloud-providers", methods=["POST"])
@login_required
def api_cloud_providers_create():
    body = request.get_json(silent=True) or {}
    provider_type = body.get("provider_type", "").lower()
    name = body.get("name", "").strip()
    provider_id = body.get("provider_id", "").strip()
    credentials = body.get("credentials", {})
    enabled = bool(body.get("enabled", True))

    if provider_type not in ("aws", "gcp", "azure"):
        return jsonify({"error": "provider_type must be aws, gcp, or azure"}), 400
    if not name or not provider_id:
        return jsonify({"error": "name and provider_id are required"}), 400

    row_id = upsert_cloud_provider(provider_type, name, provider_id, credentials, enabled, tenant_id=current_tenant_id())
    return jsonify({"id": row_id, "message": "Cloud provider saved"})


@app.route("/api/cloud-providers/<int:pk>", methods=["GET"])
@login_required
def api_cloud_provider_get(pk):
    p = get_cloud_provider(pk)
    if not p:
        return jsonify({"error": "Not found"}), 404
    # Never expose raw credentials in API response
    p.pop("credentials_json", None)
    return jsonify(p)


@app.route("/api/cloud-providers/<int:pk>", methods=["PUT"])
@login_required
def api_cloud_provider_update(pk):
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    credentials = body.get("credentials")
    enabled = body.get("enabled")

    existing = get_cloud_provider(pk)
    if not existing:
        return jsonify({"error": "Not found"}), 404

    import json as _json
    creds_to_save = credentials if credentials is not None else existing.get("credentials_json", {})
    enabled_val = bool(enabled) if enabled is not None else bool(existing.get("enabled", True))
    name_val = name or existing.get("name", "")

    upsert_cloud_provider(
        existing["provider_type"], name_val,
        existing["provider_id"], creds_to_save, enabled_val,
        tenant_id=current_tenant_id()
    )
    return jsonify({"message": "Updated"})


@app.route("/api/cloud-providers/<int:pk>/toggle", methods=["POST"])
@login_required
def api_cloud_provider_toggle(pk):
    body = request.get_json(silent=True) or {}
    enabled = bool(body.get("enabled", True))
    toggle_cloud_provider(pk, enabled)
    return jsonify({"message": f"Provider {'enabled' if enabled else 'disabled'}"})


@app.route("/api/cloud-providers/<int:pk>/rename", methods=["POST"])
@login_required
def api_cloud_provider_rename(pk):
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    conn = get_db()
    conn.execute("UPDATE cloud_providers SET name = ? WHERE id = ?", (name, pk))
    conn.commit()
    conn.close()
    return jsonify({"message": "Renamed"})


@app.route("/api/cloud-providers/<int:pk>", methods=["DELETE"])
@login_required
def api_cloud_provider_delete(pk):
    delete_cloud_provider(pk)
    return jsonify({"message": "Deleted"})


@app.route("/api/cloud-providers/<int:pk>/sync", methods=["POST"])
@login_required
def api_cloud_provider_sync(pk):
    """Trigger a cost sync for a specific cloud provider (AWS or GCP)."""
    provider = get_cloud_provider(pk)
    if not provider:
        return jsonify({"error": "Not found"}), 404

    body = request.get_json(silent=True) or {}
    months = int(body.get("months", int(os.getenv("COST_HISTORY_MONTHS", 3))))
    date_to = datetime.utcnow().strftime("%Y-%m-%d")
    date_from = (datetime.utcnow() - timedelta(days=30 * months)).strftime("%Y-%m-%d")

    def _do_sync():
        try:
            credentials = provider.get("credentials_json", {})
            if isinstance(credentials, str):
                import json as _json
                try:
                    credentials = _json.loads(credentials)
                except Exception:
                    credentials = {}

            if provider["provider_type"] == "aws":
                from aws_fetcher import fetch_aws_costs, fetch_aws_accounts
                records = fetch_aws_costs(provider, date_from, date_to)

                # ── Auto-save AWS account names ────────────────────────────
                try:
                    accounts = fetch_aws_accounts(credentials)
                    tid = provider.get("tenant_id")
                    conn = get_db()
                    for acct in accounts:
                        acct_id = acct.get("account_id", "")
                        acct_name = acct.get("name", acct_id)
                        if not acct_id or acct_name == acct_id:
                            continue  # skip if no real name
                        existing = conn.execute(
                            "SELECT id, name FROM cloud_providers WHERE provider_id=? AND provider_type='aws'",
                            (acct_id,)
                        ).fetchone()
                        if existing:
                            current_name = existing["name"] or ""
                            # Only overwrite if the name looks like a default (account ID or "Account <id>")
                            is_default_name = (current_name == acct_id or
                                               current_name == f"Account {acct_id}" or
                                               not current_name)
                            if is_default_name:
                                conn.execute(
                                    "UPDATE cloud_providers SET name=? WHERE provider_id=? AND provider_type='aws'",
                                    (acct_name, acct_id)
                                )
                                print(f"[AWS] Auto-updated default name: {acct_id} → {acct_name}")
                            else:
                                print(f"[AWS] Keeping custom name '{current_name}' for account {acct_id}")
                        else:
                            conn.execute(
                                "INSERT INTO cloud_providers(name,provider_type,provider_id,tenant_id,enabled) VALUES(?,?,?,?,1)",
                                (acct_name, "aws", acct_id, tid)
                            )
                        print(f"[AWS] Saved account name: {acct_id} → {acct_name}")
                    conn.commit()
                    conn.close()
                except Exception as ae:
                    print(f"[AWS] Could not auto-fetch account names: {ae}")

                # ── Resolve EC2 instance Name tags ─────────────────────────
                try:
                    from aws_fetcher import resolve_all_ec2_names
                    from database import save_aws_resource_names
                    ec2_names = resolve_all_ec2_names(provider)
                    if ec2_names:
                        save_aws_resource_names(ec2_names, provider_id=provider.get("provider_id"))
                        print(f"[AWS] Cached {len(ec2_names)} EC2 instance names")
                except Exception as ne:
                    print(f"[AWS] EC2 name resolution failed: {ne}")

            elif provider["provider_type"] == "gcp":
                from gcp_fetcher import fetch_gcp_costs
                records = fetch_gcp_costs(provider, date_from, date_to)
            else:
                print(f"[Sync] Azure providers use /api/sync endpoint")
                return

            if records:
                conn = get_db()
                cloud = provider["provider_type"]
                if cloud == "gcp":
                    # Delete only the project IDs present in this fetch — avoid wiping other GCP projects
                    project_ids = list({r[9] for r in records if r[9]})
                    for proj_id in project_ids:
                        conn.execute(
                            "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider='gcp' AND subscription_id=?",
                            (date_from, date_to, proj_id)
                        )
                else:
                    conn.execute(
                        "DELETE FROM cost_data WHERE date>=? AND date<=? AND cloud_provider=? AND subscription_id=?",
                        (date_from, date_to, cloud, provider["provider_id"])
                    )
                conn.commit()
                conn.close()

                # Insert with 12-column tuples (includes cloud_provider)
                conn = get_db()
                conn.executemany("""
                    INSERT INTO cost_data
                      (date,resource_group,service_name,resource_type,resource_name,
                       meter_category,meter_subcategory,cost,currency,subscription_id,tags,cloud_provider)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """, records)
                conn.commit()
                conn.close()

            update_cloud_provider_sync_time(pk, error=None)
            # Run budget checks after sync
            check_budgets(provider_filter=provider["provider_type"])
            print(f"[Sync] {provider['provider_type'].upper()} sync complete: {len(records)} records")
        except Exception as e:
            err_msg = str(e)
            print(f"[Sync] {provider['provider_type'].upper()} sync error: {err_msg}")
            # Always stamp last_sync so UI polling resolves (not stuck timing out)
            update_cloud_provider_sync_time(pk, error=err_msg)

    start_background_thread(_do_sync, name=f"sync-{provider['provider_type']}-{pk}")
    return jsonify({"message": f"Sync started for {provider['name']}", "provider": provider["provider_type"]})


@app.route("/api/cloud-providers/discover", methods=["POST"])
@login_required
def api_cloud_providers_discover():
    """List accounts/projects for a given provider type + credentials."""
    body = request.get_json(silent=True) or {}
    provider_type = body.get("provider_type", "").lower()
    credentials = body.get("credentials", {})

    try:
        if provider_type == "aws":
            from aws_fetcher import fetch_aws_accounts
            accounts = fetch_aws_accounts(credentials)
            return jsonify({"accounts": accounts})
        elif provider_type == "gcp":
            from gcp_fetcher import fetch_gcp_projects
            projects = fetch_gcp_projects(credentials)
            return jsonify({"projects": projects})
        elif provider_type == "azure":
            subs = fetch_subscriptions()
            return jsonify({"subscriptions": subs})
        else:
            return jsonify({"error": "Unknown provider_type"}), 400
    except ImportError as e:
        return jsonify({"error": str(e)}), 501
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── CUR (Cost & Usage Report) S3 Import ─────────────────────────────────────

@app.route("/api/cur/manifests", methods=["POST"])
@login_required
def api_cur_manifests():
    """List available CUR billing periods from an S3 bucket."""
    body = request.get_json(silent=True) or {}
    bucket = (body.get("bucket") or "").strip()
    prefix = (body.get("prefix") or "").strip()
    provider_id = body.get("provider_id")

    if not bucket:
        return jsonify({"error": "bucket is required"}), 400

    # Resolve credentials from provider_id if given
    credentials = body.get("credentials") or {}
    if provider_id:
        conn = get_db()
        row = conn.execute("SELECT credentials_json FROM cloud_providers WHERE id=?", (provider_id,)).fetchone()
        conn.close()
        if row and row["credentials_json"]:
            try:
                credentials = json.loads(row["credentials_json"]) if isinstance(row["credentials_json"], str) else row["credentials_json"]
            except Exception:
                pass

    try:
        from cur_importer import get_available_manifests
        manifests = get_available_manifests(credentials, bucket, prefix)
        return jsonify({"manifests": manifests})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/cur/import-local", methods=["POST"])
@login_required
def api_cur_import_local():
    """Import CUR files already present on the server filesystem."""
    body = request.get_json(silent=True) or {}
    file_paths = body.get("file_paths", [])
    account_id = body.get("account_id") or None
    date_from  = body.get("date_from") or None
    date_to    = body.get("date_to") or None
    replace    = bool(body.get("replace", True))

    if not file_paths:
        return jsonify({"error": "file_paths is required"}), 400

    # Validate all paths exist
    missing = [p for p in file_paths if not os.path.exists(p)]
    if missing:
        return jsonify({"error": f"Files not found: {missing}"}), 400

    def _do_import():
        try:
            from cur_importer import parse_local_cur_files
            from database import insert_cost_records, delete_cost_data_by_date

            records, skipped = parse_local_cur_files(
                file_paths=file_paths,
                account_id=account_id,
                date_from=date_from,
                date_to=date_to,
            )

            if replace and date_from and date_to and account_id:
                delete_cost_data_by_date(date_from, date_to, subscription_id=account_id)
            elif replace and account_id:
                # Replace all data for this account
                from database import clear_cost_data
                conn = get_db()
                conn.execute("DELETE FROM cost_data WHERE subscription_id=? AND cloud_provider='aws'", (account_id,))
                conn.commit()
                conn.close()

            inserted = insert_cost_records(records)
            print(f"[CUR] Local import complete: {inserted} inserted, {skipped} skipped")
        except Exception as e:
            import traceback
            print(f"[CUR] Local import error: {e}\n{traceback.format_exc()}")

    import threading
    t = threading.Thread(target=_do_import, daemon=True)
    t.start()

    return jsonify({"message": f"CUR import started for {len(file_paths)} file(s)", "files": file_paths})


@app.route("/api/cur/import", methods=["POST"])
@login_required
def api_cur_import():
    """Import a CUR CSV period from S3 into cost_data."""
    body = request.get_json(silent=True) or {}
    bucket       = (body.get("bucket") or "").strip()
    prefix       = (body.get("prefix") or "").strip()
    manifest_key = body.get("manifest_key") or None
    date_from    = body.get("date_from") or None
    date_to      = body.get("date_to") or None
    provider_id  = body.get("provider_id")
    account_id   = body.get("account_id") or None
    replace      = bool(body.get("replace", True))

    if not bucket:
        return jsonify({"error": "bucket is required"}), 400

    credentials = body.get("credentials") or {}
    if provider_id:
        conn = get_db()
        row = conn.execute("SELECT credentials_json, provider_id FROM cloud_providers WHERE id=?", (provider_id,)).fetchone()
        conn.close()
        if row:
            if not account_id:
                account_id = row["provider_id"]
            if row["credentials_json"]:
                try:
                    credentials = json.loads(row["credentials_json"]) if isinstance(row["credentials_json"], str) else row["credentials_json"]
                except Exception:
                    pass

    def _do_import():
        try:
            from cur_importer import fetch_cur_records, list_cur_manifests, _s3_client
            from database import insert_cost_records, delete_cost_data_by_date

            # If a specific manifest was given, import just that one
            if manifest_key:
                manifests_to_import = [manifest_key]
            else:
                # Auto-discover all manifests and filter to those overlapping the date range
                s3 = _s3_client(credentials)
                all_manifests = list_cur_manifests(s3, bucket, prefix.rstrip("/") + "/")
                if not all_manifests:
                    print("[CUR] No manifests found in bucket")
                    return

                manifests_to_import = []
                for m in all_manifests:
                    # Period folder name like 20260101-20260201
                    period = m["period"]
                    parts = period.replace("/", "").split("-")
                    if len(parts) >= 2:
                        p_start = parts[0][:8]  # YYYYMMDD
                        p_end   = parts[1][:8]
                        p_start_iso = f"{p_start[:4]}-{p_start[4:6]}-{p_start[6:8]}"
                        p_end_iso   = f"{p_end[:4]}-{p_end[4:6]}-{p_end[6:8]}"
                        # Include if period overlaps with requested date range
                        if date_from and date_to:
                            if p_end_iso <= date_from or p_start_iso >= date_to:
                                continue  # no overlap
                        manifests_to_import.append(m["key"])

                if not manifests_to_import:
                    # Fall back to latest
                    manifests_to_import = [all_manifests[0]["key"]]

                print(f"[CUR] Auto-selected {len(manifests_to_import)} billing period(s) for date range {date_from} → {date_to}")

            # Clear existing data for the date range before importing
            if replace and date_from and date_to:
                delete_cost_data_by_date(date_from, date_to, subscription_id=account_id)

            total_inserted = 0
            total_skipped = 0
            for mk in manifests_to_import:
                print(f"[CUR] Importing manifest: {mk}")
                records, skipped = fetch_cur_records(
                    credentials=credentials,
                    bucket=bucket,
                    prefix=prefix,
                    date_from=date_from,
                    date_to=date_to,
                    manifest_key=mk,
                    account_id=account_id,
                )
                inserted = insert_cost_records(records)
                total_inserted += inserted
                total_skipped += skipped
                print(f"[CUR] {mk}: {inserted} inserted")

            print(f"[CUR] All done: {total_inserted} total inserted, {total_skipped} skipped")
        except Exception as e:
            import traceback
            print(f"[CUR] Import error: {e}\n{traceback.format_exc()}")

    import threading
    t = threading.Thread(target=_do_import, daemon=True)
    t.start()

    return jsonify({"message": "CUR import started", "bucket": bucket, "prefix": prefix})


# ─── Jinja template filters ───────────────────────────────────────────────────

@app.template_filter('relative_time')
def relative_time_filter(dt):
    from datetime import timezone
    try:
        if isinstance(dt, str):
            dt = datetime.fromisoformat(dt.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        s = int(delta.total_seconds())
        if s < 60: return 'just now'
        if s < 3600: return f"{s//60}m ago"
        if s < 86400: return f"{s//3600}h ago"
        if s < 172800: return 'yesterday'
        return f"{s//86400}d ago"
    except Exception:
        return str(dt)[:16] if dt else '—'

@app.template_filter('format_money')
def format_money_filter(v):
    try:
        v = float(v)
        if v >= 1000:
            return f"{v:,.0f}"
        return f"{v:,.2f}"
    except Exception:
        return str(v)

# ─── Phase 1 MVP: Budgets ─────────────────────────────────────────────────────

@app.route("/api/budgets", methods=["GET"])
@login_required
def api_budgets_list():
    import calendar as _cal
    from budget_manager import get_current_spend
    budgets = get_budgets(tenant_id=current_tenant_id())
    today = datetime.utcnow()
    day_n = today.day
    days_in_month = _cal.monthrange(today.year, today.month)[1]
    for b in budgets:
        spent = get_current_spend(b)
        amount = float(b.get("amount") or 0)
        pct = round(spent / amount * 100, 1) if amount else 0
        if pct >= 100:
            status = "exceeded"
        elif pct >= 70:
            status = "at_risk"
        else:
            status = "on_track"
        projected = round(spent / day_n * days_in_month, 2) if day_n else 0
        b["spent"] = round(spent, 2)
        b["pct"] = pct
        b["status"] = status
        b["projected"] = projected
        b["day_n"] = day_n
        b["days_in_month"] = days_in_month
        b["over"] = round(max(0, spent - amount), 2)
    return jsonify(budgets)


@app.route("/api/budgets", methods=["POST"])
@login_required
def api_budgets_create():
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    amount = body.get("amount")
    if not name or amount is None:
        return jsonify({"error": "name and amount are required"}), 400
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400

    budget_id = create_budget(
        name=name,
        amount=amount,
        provider_type=body.get("provider_type", "all"),
        provider_id=body.get("provider_id", ""),
        period=body.get("period", "monthly"),
        alert_thresholds=body.get("alert_thresholds", [80, 100]),
        alert_channels=body.get("alert_channels", ["email"]),
        tenant_id=current_tenant_id(),
        resource_group=body.get("resource_group", ""),
        service_name=body.get("service_name", ""),
        scope_label=body.get("scope_label", ""),
        alert_emails=body.get("alert_emails", ""),
    )
    return jsonify({"id": budget_id, "message": "Budget created"})


@app.route("/api/budgets/<int:budget_id>", methods=["GET"])
@login_required
def api_budget_get(budget_id):
    budgets = get_budgets(tenant_id=current_tenant_id())
    b = next((x for x in budgets if x["id"] == budget_id), None)
    if not b:
        return jsonify({"error": "Not found"}), 404
    return jsonify(b)


@app.route("/api/budgets/<int:budget_id>", methods=["PUT"])
@login_required
def api_budgets_update(budget_id):
    body = request.get_json(silent=True) or {}
    kwargs = {}
    for field in ("name", "amount", "provider_type", "provider_id", "period",
                  "alert_thresholds", "alert_channels", "enabled",
                  "resource_group", "service_name", "scope_label", "alert_emails"):
        if field in body:
            kwargs[field] = body[field]
    update_budget(budget_id, **kwargs)
    return jsonify({"message": "Updated"})


@app.route("/api/budgets/<int:budget_id>", methods=["DELETE"])
@login_required
def api_budgets_delete(budget_id):
    delete_budget(budget_id)
    return jsonify({"message": "Deleted"})


@app.route("/api/budgets/<int:budget_id>/test-email", methods=["POST"])
@login_required
def api_budget_test_email(budget_id):
    """Send a test alert email for a specific budget."""
    budgets = get_budgets(tenant_id=current_tenant_id())
    budget = next((b for b in budgets if b["id"] == budget_id), None)
    if not budget:
        return jsonify({"error": "Budget not found"}), 404
    try:
        from budget_manager import _send_email_alert
        ok = _send_email_alert(budget, threshold_pct=budget.get("alert_thresholds", [80])[0],
                               current_spend=budget.get("spent", 0))
        if ok:
            return jsonify({"message": "Test email sent successfully"})
        return jsonify({"error": "Email not configured or failed to send. Check SMTP settings in Email Reports."}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/budgets/check", methods=["POST"])
@login_required
def api_budgets_check():
    """Manually trigger budget threshold evaluation."""
    fired = check_budgets()
    return jsonify({"alerts_fired": len(fired), "details": fired})


@app.route("/api/budget-alerts", methods=["GET"])
@login_required
def api_budget_alerts():
    budget_id = request.args.get("budget_id", type=int)
    limit = request.args.get("limit", 50, type=int)
    return jsonify(get_budget_alerts(budget_id=budget_id, limit=limit, tenant_id=current_tenant_id()))


# ─── Phase 1 MVP: Data Freshness ──────────────────────────────────────────────

@app.route("/api/data-freshness", methods=["GET"])
@login_required
def api_data_freshness():
    """
    Returns per-cloud-provider data freshness info:
      - latest date in cost_data
      - lag_days since that date
      - expected billing lag (provider-dependent)
      - is_stale flag
    Also includes a global last-sync from sync_log.
    """
    freshness = get_data_freshness(tenant_id=current_tenant_id())
    sync_hist = get_sync_history()
    last_sync = sync_hist[0] if sync_hist else None

    # Billing lag notes per provider
    lag_notes = {
        "azure": "Azure billing data typically lags 24 hours.",
        "aws": "AWS Cost Explorer data typically lags 24-48 hours.",
        "gcp": "GCP billing data typically lags 24-72 hours.",
    }

    for item in freshness:
        item["lag_note"] = lag_notes.get(item["cloud_provider"], "")

    return jsonify({
        "providers": freshness,
        "last_azure_sync": {
            "time": last_sync["sync_end"] or last_sync["sync_start"],
            "status": last_sync["status"],
            "records": last_sync["records_fetched"],
        } if last_sync else None,
        "checked_at": datetime.utcnow().isoformat(),
    })


# ─── Phase 1 MVP: Slack test ──────────────────────────────────────────────────

@app.route("/api/notifications/slack/test", methods=["POST"])
@login_required
def api_slack_test():
    body = request.get_json(silent=True) or {}
    webhook_url = body.get("webhook_url", os.getenv("SLACK_WEBHOOK_URL", ""))
    if not webhook_url:
        return jsonify({"error": "No SLACK_WEBHOOK_URL configured"}), 400
    ok = slack_test_webhook(webhook_url)
    if ok:
        return jsonify({"message": "Test message sent successfully"})
    return jsonify({"error": "Failed to send test message — check webhook URL"}), 502


@app.route("/api/notifications/settings", methods=["GET"])
@login_required
def api_notification_settings():
    return jsonify({
        "slack_webhook_configured": bool(os.getenv("SLACK_WEBHOOK_URL", "")),
        "email_configured": bool(os.getenv("SMTP_HOST", "")),
    })


# ─── Integrations API ────────────────────────────────────────────────────────

@app.route("/api/integrations/settings", methods=["GET"])
@login_required
def api_get_integrations():
    s = get_integration_settings()
    # Mask secrets in response
    def mask(v):
        if not v:
            return ""
        return v[:4] + "••••••••" + v[-2:] if len(v) > 6 else "••••••••"
    return jsonify({
        "jira":      {"url": s.get("jira_url",""), "email": s.get("jira_email",""), "token": mask(s.get("jira_token","")), "project": s.get("jira_project",""), "issue_type": s.get("jira_issue_type","Task"), "enabled": s.get("jira_enabled", False), "admin_token": mask(s.get("jira_admin_token","")), "admin_org_id": s.get("jira_admin_org_id",""), "mode": s.get("jira_mode","cloud"), "server_user": s.get("jira_server_user",""), "server_password": mask(s.get("jira_server_password",""))},
        "bitbucket": {"workspace": s.get("bitbucket_workspace",""), "repo": s.get("bitbucket_repo",""), "token": mask(s.get("bitbucket_token","")), "enabled": s.get("bitbucket_enabled", False)},
        "cursor":    {"api_key": mask(s.get("cursor_api_key","")), "enabled": s.get("cursor_enabled", False)},
        "openai":    {"api_key": mask(s.get("openai_api_key","")), "org_id": s.get("openai_org_id",""), "enabled": s.get("openai_enabled", False)},
    })


@app.route("/api/integrations/settings", methods=["POST"])
@login_required
def api_update_integrations():
    body = request.get_json(silent=True) or {}
    flat = {}
    for tool, fields in body.items():
        if not isinstance(fields, dict):
            continue
        for k, v in fields.items():
            col = f"{tool}_{k}"
            # Don't overwrite masked values
            if isinstance(v, str) and "••••" in v:
                continue
            flat[col] = v
    update_integration_settings(flat)
    return jsonify({"message": "Integration settings saved"})


@app.route("/api/integrations/test/<tool>", methods=["POST"])
@login_required
def api_test_integration(tool):
    # Prefer values from the request body (form fields not yet saved),
    # fall back to saved DB settings for any missing field.
    s    = get_integration_settings()
    body = request.get_json(silent=True) or {}

    def _pick(body_key, db_key, body_section=None):
        """Return form value if provided and not masked, else DB value."""
        section = body.get(body_section or tool, {}) if body_section is not False else body
        v = section.get(body_key, "") if isinstance(section, dict) else ""
        if v and "••••" not in str(v):
            return str(v).strip()
        return (s.get(db_key) or "").strip()

    if tool == "jira":
        import requests as _req
        url  = _pick("url",  "jira_url").rstrip("/")
        mode = _pick("mode", "jira_mode") or "cloud"
        if mode == "server":
            u = _pick("server_user",     "jira_server_user")
            p = _pick("server_password", "jira_server_password")
            if not (url and u and p):
                return jsonify({"error": "Missing Jira Server URL, username or password"}), 400
            creds = (u, p)
        else:
            email = _pick("email", "jira_email")
            token = _pick("token", "jira_token")
            if not url:
                return jsonify({"error": "Missing Jira URL"}), 400
            if not email:
                return jsonify({"error": "Missing Email (username)"}), 400
            if not token:
                return jsonify({"error": "Missing API Token"}), 400
            creds = (email, token)
        try:
            r = _req.get(f"{url}/rest/api/3/myself", auth=creds, timeout=10)
            if r.status_code == 200:
                data = r.json()
                return jsonify({"ok": True, "message": f"Connected as {data.get('displayName', creds[0])}"})
            if r.status_code == 401:
                return jsonify({"error": "Authentication failed — check email and API token"}), 502
            return jsonify({"error": f"Jira returned HTTP {r.status_code}"}), 502
        except Exception as e:
            return jsonify({"error": f"Connection failed: {str(e)}"}), 502

    elif tool == "bitbucket":
        import requests as _req
        token     = _pick("token",     "bitbucket_token")
        workspace = _pick("workspace", "bitbucket_workspace")
        if not (token and workspace):
            return jsonify({"error": "Missing Bitbucket workspace or token"}), 400
        try:
            r = _req.get(f"https://api.bitbucket.org/2.0/workspaces/{workspace}",
                         headers={"Authorization": f"Bearer {token}"}, timeout=8)
            if r.status_code == 200:
                return jsonify({"ok": True, "message": f"Connected to workspace '{workspace}'"})
            return jsonify({"error": f"Bitbucket returned HTTP {r.status_code}"}), 502
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    elif tool == "openai":
        import requests as _req
        key = _pick("api_key", "openai_api_key")
        if not key:
            return jsonify({"error": "Missing OpenAI API key"}), 400
        try:
            r = _req.get("https://api.openai.com/v1/models",
                         headers={"Authorization": f"Bearer {key}"}, timeout=8)
            if r.status_code == 200:
                return jsonify({"ok": True, "message": "OpenAI API key is valid"})
            return jsonify({"error": f"OpenAI returned HTTP {r.status_code}"}), 502
        except Exception as e:
            return jsonify({"error": str(e)}), 502

    elif tool == "cursor":
        key = _pick("api_key", "cursor_api_key")
        if not key:
            return jsonify({"error": "Missing Cursor API key"}), 400
        return jsonify({"ok": True, "message": "Cursor API key saved (usage sync coming soon)"})

    return jsonify({"error": "Unknown integration"}), 404


@app.route("/api/integrations/jira/users", methods=["GET"])
@login_required
def api_jira_users():
    """Fetch Jira user list + license summary. Uses standard API + optional Atlassian Admin API for last_active."""
    import requests as _req, base64

    s = get_integration_settings()
    url         = (s.get("jira_url") or "").rstrip("/")
    mode        = s.get("jira_mode") or "cloud"
    admin_token = s.get("jira_admin_token") or ""

    if mode == "server":
        username = s.get("jira_server_user") or ""
        password = s.get("jira_server_password") or ""
        if not (url and username and password):
            return jsonify({"error": "Jira Server not configured. Please add URL, username and password in Integrations settings."}), 400
        auth_str = f"{username}:{password}"
    else:
        email = s.get("jira_email") or ""
        token = s.get("jira_token") or ""
        if not (url and email and token):
            return jsonify({"error": "Jira Cloud not configured. Please add URL, email and API token in Integrations settings."}), 400
        auth_str = f"{email}:{token}"

    auth = base64.b64encode(auth_str.encode()).decode()
    headers = {"Authorization": f"Basic {auth}", "Accept": "application/json"}

    # Fetch all users (paginated, up to 2000)
    users = []
    start = 0
    while True:
        try:
            r = _req.get(f"{url}/rest/api/3/users/search", headers=headers,
                         params={"startAt": start, "maxResults": 200, "query": ""}, timeout=12)
            if r.status_code != 200:
                return jsonify({"error": f"Jira API error {r.status_code}: {r.text[:300]}"}), 502
            batch = r.json()
            if not batch:
                break
            users.extend(batch)
            if len(batch) < 200:
                break
            start += 200
        except Exception as e:
            return jsonify({"error": f"Request failed: {str(e)}"}), 502

    # Filter to real accounts (exclude system/app accounts)
    human_users = [u for u in users if u.get("accountType") == "atlassian"]
    active   = [u for u in human_users if u.get("active")]
    inactive = [u for u in human_users if not u.get("active")]

    # Attempt to get last_active via Atlassian Admin API if admin token provided
    last_active_map = {}
    admin_error = None
    admin_org_id = s.get("jira_admin_org_id","").strip()
    if admin_token:
        try:
            admin_hdrs = {"Authorization": f"Bearer {admin_token}", "Accept": "application/json"}
            # Use saved org_id directly if provided, skip /orgs lookup
            if admin_org_id:
                org_id = admin_org_id
            else:
                org_r = _req.get("https://api.atlassian.com/admin/v1/orgs", headers=admin_hdrs, timeout=10)
                if org_r.status_code != 200:
                    admin_error = f"Admin API /orgs returned HTTP {org_r.status_code}: {org_r.text[:200]}"
                else:
                    orgs = org_r.json().get("data", [])
                    if not orgs:
                        admin_error = "No organisations found. Paste your Organization ID from admin.atlassian.com into the Configure form."
                    else:
                        org_id = orgs[0]["id"]
            if org_id:
                cursor_val = None
                total_fetched = 0
                for _ in range(20):
                    # Atlassian Admin API /users only accepts 'cursor' — no 'limit' param
                    params = {}
                    if cursor_val:
                        params["cursor"] = cursor_val
                    ur = _req.get(f"https://api.atlassian.com/admin/v1/orgs/{org_id}/users",
                                  headers=admin_hdrs, params=params, timeout=12)
                    if ur.status_code != 200:
                        admin_error = f"Admin API /users returned HTTP {ur.status_code}: {ur.text[:300]}"
                        break
                    udata = ur.json()
                    page_users = udata.get("data", [])
                    total_fetched += len(page_users)
                    for u in page_users:
                        aid = u.get("account_id") or u.get("accountId")
                        la = (u.get("last_active") or u.get("lastActive")
                              or u.get("last_active_date") or u.get("lastActiveDate"))
                        if aid:
                            if la:
                                last_active_map[aid] = la
                    links = udata.get("links") or {}
                    next_link = links.get("next") or ""
                    if "cursor=" in str(next_link):
                        cursor_val = str(next_link).split("cursor=")[-1].split("&")[0]
                    else:
                        cursor_val = None
                    if not cursor_val:
                        break
                # If API succeeded but returned 0 managed users, explain why
                if not admin_error and total_fetched == 0:
                    admin_error = (
                        "domain_not_claimed: The Atlassian Admin API returned 0 managed accounts. "
                        "Last Active dates are only available for users on a verified/claimed email domain. "
                        "To enable this, go to admin.atlassian.com → Security → Verify domain, "
                        "then claim your organisation's email domain (e.g. prismxai.com)."
                    )
        except Exception as e:
            admin_error = f"Admin API exception: {str(e)}"

    # Build response user list
    def _fmt_user(u):
        aid = u.get("accountId", "")
        la  = last_active_map.get(aid)
        return {
            "accountId":   aid,
            "displayName": u.get("displayName", ""),
            "email":       u.get("emailAddress", ""),
            "active":      u.get("active", False),
            "accountType": u.get("accountType", ""),
            "avatar":      (u.get("avatarUrls") or {}).get("24x24", ""),
            "last_active": la or "",
        }

    return jsonify({
        "summary": {
            "total":    len(human_users),
            "active":   len(active),
            "inactive": len(inactive),
            "has_last_active": bool(last_active_map),
            "admin_error": admin_error,
        },
        "users": [_fmt_user(u) for u in sorted(human_users, key=lambda x: (not x.get("active"), (x.get("displayName") or "").lower()))],
    })


@app.route("/api/integrations/jira/test-admin", methods=["POST"])
@login_required
def api_jira_test_admin():
    """Test Atlassian Admin API token independently."""
    import requests as _req
    body        = request.get_json(silent=True) or {}
    s           = get_integration_settings()
    admin_token = body.get("admin_token","").strip()
    org_id_in   = body.get("org_id","").strip()
    if not admin_token or "••••" in admin_token:
        admin_token = s.get("jira_admin_token","").strip()
    if not org_id_in or "••••" in org_id_in:
        org_id_in = s.get("jira_admin_org_id","").strip()
    if not admin_token:
        return jsonify({"error": "No Admin API token provided"}), 400

    hdrs = {"Authorization": f"Bearer {admin_token}", "Accept": "application/json"}
    try:
        org_id = org_id_in
        org_name = org_id_in or "unknown"

        if not org_id:
            # Try auto-discovering org id
            r = _req.get("https://api.atlassian.com/admin/v1/orgs", headers=hdrs, timeout=10)
            if r.status_code == 401:
                return jsonify({"error": "Token rejected (401) — make sure this is an Atlassian Admin API key, not a regular Jira API token"}), 400
            if r.status_code == 403:
                return jsonify({"error": "Permission denied (403) — token needs read:orgs:admin scope"}), 400
            if r.status_code == 200:
                orgs = r.json().get("data", [])
                if orgs:
                    org_id   = orgs[0]["id"]
                    org_name = orgs[0].get("name", org_id)
            if not org_id:
                return jsonify({"error": "Could not find Organisation automatically. Copy the Organization ID shown by Atlassian when you created the key and paste it into the Organization ID field."}), 400

        # Test users endpoint with the org_id — no extra params, /users only accepts cursor
        ur = _req.get(f"https://api.atlassian.com/admin/v1/orgs/{org_id}/users",
                      headers=hdrs, timeout=10)
        if ur.status_code == 401:
            return jsonify({"error": "Token rejected on /users — invalid token"}), 400
        if ur.status_code == 403:
            return jsonify({"error": f"Org ID accepted but users access denied — add read:accounts:admin scope to the token"}), 400
        if ur.status_code == 404:
            return jsonify({"error": f"Organisation ID not found — double-check the ID from admin.atlassian.com"}), 400
        if ur.status_code != 200:
            return jsonify({"error": f"/users returned HTTP {ur.status_code}: {ur.text[:200]}"}), 502

        raw    = ur.json()
        udata  = raw.get("data", [])
        sample = udata[0] if udata else {}
        sample_keys = list(sample.keys()) if sample else []
        has_la = bool(sample.get("last_active") or sample.get("lastActive")
                      or sample.get("last_active_date") or sample.get("lastActiveDate")
                      or sample.get("product_access"))
        return jsonify({
            "ok": True,
            "org_id": org_id,
            "user_count": len(udata),
            "sample_keys": sample_keys,
            "sample_user": sample,
            "message": f"✓ Connected to org '{org_name}' — {len(udata)} users returned. Last Active data {'available' if has_la else 'not in response (check sample_keys)'}",
            "has_last_active": has_la,
        })
    except Exception as e:
        return jsonify({"error": f"Request failed: {str(e)}"}), 502


# ─── SaaS: JSON Signup API ───────────────────────────────────────────────────

@app.route("/api/signup", methods=["POST"])
def api_signup():
    """JSON signup used by signup.html SPA form."""
    body       = request.get_json(silent=True) or {}
    org_name   = (body.get("org_name") or "").strip()
    first_name = (body.get("first_name") or "").strip()
    last_name  = (body.get("last_name") or "").strip()
    email      = (body.get("email") or "").strip().lower()
    password   = body.get("password") or ""
    full_name  = f"{first_name} {last_name}".strip()

    if not all([org_name, email, password, first_name]):
        return jsonify({"error": "All fields are required."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if email_exists_in_platform(email):
        return jsonify({"error": "An account with this email already exists."}), 409

    try:
        slug      = slugify(org_name)
        tenant_id = create_tenant(org_name, slug, email, plan="free")
        user_id   = create_user(tenant_id, email, password, full_name, role="admin")
        session.permanent        = True
        session["logged_in"]     = True
        session["username"]      = full_name
        session["email"]         = email
        session["user_id"]       = user_id
        session["tenant_id"]     = tenant_id
        session["tenant_name"]   = org_name
        session["tenant_slug"]   = slug
        session["role"]          = "admin"
        session["is_super_admin"] = False
        return jsonify({"success": True, "redirect": "/onboarding"})
    except Exception as e:
        return jsonify({"error": f"Registration failed: {e}"}), 500


# ─── SaaS: Invite JSON APIs ──────────────────────────────────────────────────

@app.route("/api/invite/<token>")
def api_invite_info(token):
    """Return invite metadata so invite.html can render the org name + email."""
    from database import get_db
    conn = get_db()
    row  = conn.execute(
        "SELECT u.email, u.role, t.name AS org_name "
        "FROM users u JOIN tenants t ON t.id = u.tenant_id "
        "WHERE u.invite_token = ? AND u.invite_accepted = 0",
        (token,)
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Invalid or expired invite"}), 404
    return jsonify({"email": row["email"], "role": row["role"], "org_name": row["org_name"]})


@app.route("/api/invite/<token>/accept", methods=["POST"])
def api_invite_accept(token):
    """Accept a team invite via JSON (used by invite.html SPA)."""
    body       = request.get_json(silent=True) or {}
    password   = body.get("password") or ""
    first_name = (body.get("first_name") or "").strip()
    last_name  = (body.get("last_name") or "").strip()
    full_name  = f"{first_name} {last_name}".strip()

    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400

    user = accept_invite(token, password, full_name or "User")
    if not user:
        return jsonify({"error": "Invalid or expired invite link."}), 400

    # Auto-login after accepting invite
    tenant = get_tenant(user["tenant_id"])
    session.permanent        = True
    session["logged_in"]     = True
    session["username"]      = full_name or user.get("email", "")
    session["email"]         = user["email"]
    session["user_id"]       = user["id"]
    session["tenant_id"]     = user["tenant_id"]
    session["tenant_name"]   = tenant["name"] if tenant else ""
    session["tenant_slug"]   = tenant["slug"] if tenant else ""
    session["role"]          = user["role"]
    session["is_super_admin"] = False
    return jsonify({"success": True})


# ─── SaaS: Current User Info ─────────────────────────────────────────────────

@app.route("/api/me")
@login_required
def api_me():
    return jsonify({
        "email":          session.get("email"),
        "username":       session.get("username"),
        "role":           session.get("role"),
        "tenant_id":      session.get("tenant_id"),
        "tenant_name":    session.get("tenant_name"),
        "is_super_admin": session.get("is_super_admin", False),
    })


# ─── SaaS: Super-Admin Extra Routes ──────────────────────────────────────────

@app.route("/api/superadmin/tenants/<int:tid>/suspend", methods=["POST"])
@super_admin_required
def api_sa_suspend_tenant(tid):
    update_tenant(tid, status="suspended")
    return jsonify({"message": "Tenant suspended"})


@app.route("/api/superadmin/tenants/<int:tid>/activate", methods=["POST"])
@super_admin_required
def api_sa_activate_tenant(tid):
    update_tenant(tid, status="active")
    return jsonify({"message": "Tenant activated"})


@app.route("/api/superadmin/users")
@super_admin_required
def api_sa_all_users():
    """All users across all tenants for the super-admin portal."""
    from database import get_db
    conn = get_db()
    rows = conn.execute(
        "SELECT u.id, u.email, u.full_name, u.role, u.last_login, "
        "t.name AS org_name, t.id AS tenant_id "
        "FROM users u JOIN tenants t ON t.id = u.tenant_id "
        "ORDER BY u.created_at DESC LIMIT 500"
    ).fetchall()
    conn.close()
    return jsonify({"users": [dict(r) for r in rows]})


@app.route("/api/superadmin/users/<int:uid>", methods=["DELETE"])
@super_admin_required
def api_sa_delete_user(uid):
    from database import get_db
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (uid,))
    conn.commit()
    conn.close()
    return jsonify({"message": "User deleted"})


@app.route("/api/superadmin/stats")
@super_admin_required
def api_sa_stats():
    from database import get_db
    conn = get_db()
    stats = {}
    stats["tenants"]    = conn.execute("SELECT COUNT(*) FROM tenants").fetchone()[0]
    stats["users"]      = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    stats["providers"]  = conn.execute("SELECT COUNT(*) FROM cloud_providers").fetchone()[0]
    stats["records"]    = conn.execute("SELECT COUNT(*) FROM cost_data").fetchone()[0]
    stats["budgets"]    = conn.execute("SELECT COUNT(*) FROM budgets WHERE enabled=1").fetchone()[0]
    stats["alerts_30d"] = conn.execute(
        "SELECT COUNT(*) FROM budget_alerts WHERE triggered_at >= datetime('now','-30 days')"
    ).fetchone()[0]
    conn.close()
    return jsonify(stats)


# ─── SaaS: Bulk Invite (Onboarding) ──────────────────────────────────────────

@app.route("/api/tenant/invite-bulk", methods=["POST"])
@login_required
@role_required("admin")
def api_tenant_invite_bulk():
    body    = request.get_json(silent=True) or {}
    invites = body.get("invites", [])
    if not invites:
        return jsonify({"error": "No invites provided"}), 400
    results = []
    for inv in invites:
        email = (inv.get("email") or "").strip().lower()
        role  = inv.get("role", "viewer")
        if not email:
            continue
        try:
            token = create_invite(current_tenant_id(), email, role)
            invite_url = f"{request.host_url}invite/{token}"
            results.append({"email": email, "invite_url": invite_url})
        except Exception as e:
            results.append({"email": email, "error": str(e)})
    return jsonify({"results": results, "sent": len(results)})


# ─── SaaS: Tenant Settings API ─────────────────────────────────────────────

@app.route("/api/superadmin/tenants")
@super_admin_required
def api_sa_tenants_list():
    """Returns tenant list with user_count for superadmin portal."""
    from database import get_db
    conn = get_db()
    rows = conn.execute(
        "SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count "
        "FROM tenants t ORDER BY t.created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify({"tenants": [dict(r) for r in rows]})


# ─── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if auto_sync_state["enabled"]:
        _schedule_next_auto_sync()
    if activity_auto_sync_state["enabled"]:
        _schedule_next_activity_auto_sync()
    if EMAIL_SCHEDULER_ENABLED:
        _schedule_email_check()
    else:
        print("[Email Report] Scheduler disabled by EMAIL_SCHEDULER_ENABLED=false")
    
    # One-shot Resource Graph sync at startup (uses AZURE_* client credentials)
    _cfg_runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config_sync_runner.py")
    try:
        subprocess.Popen(
            [sys.executable, _cfg_runner],
            cwd=os.path.dirname(_cfg_runner),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        print("Started config_sync_runner.py (one-shot)")
    except Exception as e:
        print(f"Could not start config_sync_runner.py: {e}")

    app.run(host="0.0.0.0", port=5000, debug=False, threaded=FLASK_THREADED)
