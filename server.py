#!/usr/bin/env python3
"""
Standalone frontend server for Cloud Cost Analyzer.

Owns templates/ and static/ and renders the whole UI itself, proxying every
API call and form submission to a backend named by LIVE_API_URL. The browser
only ever talks to this server, so requests stay same-origin — the backend
sends no CORS headers, and the session cookie keeps working.

    cd frontend
    pip install -r requirements.txt
    cp .env.example .env      # set LIVE_API_URL
    python server.py          # http://127.0.0.1:3000

This folder is self-contained: nothing here imports the backend, and it runs
against any deployment of it. Pages are rendered from these templates on
purpose — a deployed backend's HTML can lag behind this checkout, and pairing
stale markup with new CSS is what breaks the layout. Only things that need real
server state are proxied: auth POSTs, /logout, and the API.
"""
import calendar
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from urllib.parse import parse_qs

import requests
from dotenv import load_dotenv
from flask import Flask, Response, g, jsonify, redirect, render_template, request

HERE = os.path.dirname(os.path.abspath(__file__))

# Load the .env sitting next to this file, not whatever the working directory
# happens to be, so `python frontend/server.py` behaves like `cd frontend`.
load_dotenv(os.path.join(HERE, ".env"))

def _flag(name, default):
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes")


LIVE = os.getenv("LIVE_API_URL", "").rstrip("/")
PORT = int(os.getenv("FRONTEND_PORT", "3000"))
HOST = os.getenv("FRONTEND_HOST", "127.0.0.1")
VERIFY_TLS = _flag("LIVE_VERIFY_TLS", "true")

# Off in any real deployment: Werkzeug's debugger executes arbitrary code from
# the browser on a traceback, and its reloader forks processes a supervisor
# should own.
DEBUG = _flag("FRONTEND_DEBUG", "true")

# True when browsers reach *this* server over https, so the session cookie we
# relay should carry Secure. Independent of the backend's own scheme.
COOKIE_SECURE = _flag("FRONTEND_COOKIE_SECURE", "false")

# Trust X-Forwarded-* from a reverse proxy in front of us.
BEHIND_PROXY = _flag("FRONTEND_BEHIND_PROXY", "false")

# Some hosts serve only the leaf cert and omit the intermediate. Browsers and
# curl paper over that by fetching the issuer via AIA; OpenSSL will not, so
# requests fails with "unable to get local issuer certificate". Point at a
# bundle containing the missing intermediate rather than skipping verification.
_DEFAULT_CA_BUNDLE = os.path.join(HERE, "certs", "live-ca-bundle.pem")
CA_BUNDLE = os.getenv("LIVE_CA_BUNDLE") or (
    _DEFAULT_CA_BUNDLE if os.path.exists(_DEFAULT_CA_BUNDLE) else None
)
VERIFY = (CA_BUNDLE or True) if VERIFY_TLS else False

# Authenticated pages whose only server input is the session user.
LOCAL_PAGES = {
    "/":               "index.html",
    "/drilldown":      "drilldown.html",
    "/service-detail": "service_detail.html",
    "/onboarding":     "onboarding.html",
}

# Headers describing one specific hop; never relay them to the next.
HOP_BY_HOP = {
    "content-encoding", "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "upgrade", "host",
    # This dev server generates its own; relaying the live ones duplicates them.
    "server", "date",
    # Cookies are passed explicitly via cookies=; forwarding the raw header too
    # makes requests send both, and the header would win.
    "cookie",
}

if not LIVE:
    sys.exit(
        "LIVE_API_URL is not set.\n"
        "  LIVE_API_URL=http://your-backend:5000 python server.py\n"
        f"or set it in {os.path.join(HERE, '.env')} (see .env.example)"
    )

app = Flask(__name__,
            template_folder=os.path.join(HERE, "templates"),
            static_folder=os.path.join(HERE, "static"))

if BEHIND_PROXY:
    # Honour X-Forwarded-Proto/-For from the reverse proxy. Only with a proxy
    # actually in front — otherwise a client could forge these headers.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# ── upstream plumbing ────────────────────────────────────────────────────────

def _live(path):
    return f"{LIVE}/{path.lstrip('/')}"


def _localise_cookie(value):
    """Re-scope a backend Set-Cookie to this server.

    Domain and Secure describe the backend's origin, not ours, so drop both and
    let FRONTEND_COOKIE_SECURE decide — it tracks how browsers reach *us*. Over
    plain http (local dev) an inherited Secure flag would make the browser
    discard the cookie outright and login would silently never stick.
    """
    keep = []
    for part in value.split(";"):
        name = part.strip().lower().split("=")[0]
        if name in ("domain", "secure"):
            continue
        # SameSite=None is only honoured alongside Secure.
        if part.strip().lower() == "samesite=none" and not COOKIE_SECURE:
            continue
        keep.append(part)
    cookie = ";".join(keep)
    if COOKIE_SECURE:
        cookie += "; Secure"
    return cookie


def _localise_location(value):
    """Rewrite an absolute redirect back onto this dev server."""
    return re.sub(r"^https?://[^/]+", "", value) or "/"


def _raw_body():
    """The request body, read once and kept.

    Never reach for request.form here: touching it makes Werkzeug parse and
    consume the stream, so a later get_data() hands back b"" and the upstream
    POST arrives with no fields at all.
    """
    if not hasattr(g, "_raw_body"):
        g._raw_body = request.get_data()
    return g._raw_body


def _body_field(name, default=""):
    """Read one urlencoded field out of the raw body we are forwarding."""
    values = parse_qs(_raw_body().decode("utf-8", "replace")).get(name)
    return values[0] if values else default


def _upstream(path, **overrides):
    """Call the live backend with this request's method, body and cookies."""
    headers = {k: v for k, v in request.headers if k.lower() not in HOP_BY_HOP}
    kwargs = dict(
        method=request.method,
        url=_live(path),
        headers=headers,
        params=request.args,
        data=_raw_body(),
        cookies=request.cookies,
        allow_redirects=False,
        verify=VERIFY,
        timeout=120,
    )
    kwargs.update(overrides)
    return requests.request(**kwargs)


def _relay(upstream):
    """Turn an upstream response into one this dev server can return."""
    resp = Response(upstream.content, status=upstream.status_code)
    for key, value in upstream.raw.headers.items():
        low = key.lower()
        if low in HOP_BY_HOP or low == "set-cookie":
            continue
        resp.headers[key] = _localise_location(value) if low == "location" else value
    for cookie in upstream.raw.headers.getlist("Set-Cookie"):
        resp.headers.add("Set-Cookie", _localise_cookie(cookie))
    return resp


def _proxy(path):
    try:
        return _relay(_upstream(path))
    except requests.RequestException as exc:
        return Response(f"Upstream {LIVE} failed:\n\n{exc}", status=502,
                        mimetype="text/plain")


def _me():
    """Ask the live backend who this browser's session belongs to.

    Returns (payload, error); payload is None when the session is not valid.
    """
    try:
        r = requests.get(_live("/api/me"), cookies=request.cookies,
                         allow_redirects=False, verify=VERIFY, timeout=30)
    except requests.RequestException as exc:
        return None, f"Could not reach {LIVE}\n\n{exc}"
    if r.status_code != 200:
        return None, None
    try:
        return r.json(), None
    except ValueError:
        return None, None


def _page(template, **context):
    resp = app.make_response(render_template(template, **context))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


# The live HTML may be an older build, so pull the message out generically
# instead of relying on this checkout's markup.
_ERROR_PATTERNS = (
    r'class="[^"]*(?:alert|error|flash)[^"]*"[^>]*>\s*([^<>]{3,200}?)\s*<',
    r'<p[^>]*id="[^"]*error[^"]*"[^>]*>\s*([^<>]{3,200}?)\s*<',
)


def _extract_error(html, fallback):
    for pattern in _ERROR_PATTERNS:
        m = re.search(pattern, html, re.I | re.S)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return fallback


def _auth_post(path, template, fallback_error, **context):
    """Proxy a login/signup/invite POST.

    A redirect means it worked — relay it verbatim so the session cookie is
    set. Anything else means the backend re-rendered the form with an error, so
    show that error on *our* template rather than its possibly stale HTML.
    """
    try:
        upstream = _upstream(path)
    except requests.RequestException as exc:
        return Response(f"Upstream {LIVE} failed:\n\n{exc}", status=502,
                        mimetype="text/plain")
    if upstream.status_code in (301, 302, 303, 307, 308):
        return _relay(upstream)
    error = _extract_error(upstream.text or "", fallback_error)
    return _page(template, error=error, **context), upstream.status_code


# ── public pages ─────────────────────────────────────────────────────────────

@app.route("/login", endpoint="login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        return _auth_post(
            "/login", "login.html", "Invalid email or password",
            notice=None, email=_body_field("username"),
        )
    return _page("login.html", error=None,
                 notice=request.args.get("notice"), email="")


@app.route("/signup", endpoint="signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        return _auth_post("/signup", "signup.html",
                          "Could not create the organisation.")
    return _page("signup.html", error=None)


@app.route("/invite/<token>", methods=["GET", "POST"])
def invite(token):
    if request.method == "POST":
        return _auth_post(f"/invite/{token}", "invite.html",
                          "Invalid or expired invite link.", token=token)
    return _page("invite.html", token=token, error=None)


# Stubs on the backend that only ever redirect; let it own that behaviour.
@app.route("/forgot-password", endpoint="forgot_password")
def forgot_password():
    return _proxy("/forgot-password")


@app.route("/auth/sso/<provider>", endpoint="sso_login")
def sso_login(provider):
    return _proxy(f"/auth/sso/{provider}")


# ── authenticated pages ──────────────────────────────────────────────────────

@app.route("/superadmin")
def superadmin():
    me, error = _me()
    if error:
        return Response(error, status=502, mimetype="text/plain")
    if me is None:
        return redirect("/login")
    if not me.get("is_super_admin"):
        return redirect("/")

    # app.py seeds this server-side; fetch the same rows from the API instead.
    try:
        r = requests.get(_live("/api/superadmin/tenants"), cookies=request.cookies,
                         allow_redirects=False, verify=VERIFY, timeout=60)
        tenants = r.json() if r.status_code == 200 else []
    except (requests.RequestException, ValueError):
        tenants = []
    if isinstance(tenants, dict):
        tenants = tenants.get("tenants", [])

    return _page(
        "superadmin.html",
        tenants=tenants,
        tenants_json=json.dumps(tenants, default=str).replace("</", "<\\/"),
        username="Super Admin",
    )


# ── synthesized & fallback API routes ────────────────────────────────────────

_CACHE = {}

def _cached_meta(endpoint, max_age_seconds=120):
    now_ts = time.time()
    cache_entry = _CACHE.get(endpoint)
    if cache_entry and (now_ts - cache_entry["time"] < max_age_seconds):
        return cache_entry["data"]
    try:
        r = _upstream(endpoint, params={}, timeout=5)
        if r.status_code == 200:
            data = r.json()
            _CACHE[endpoint] = {"time": now_ts, "data": data}
            return data
    except Exception:
        pass
    return _CACHE.get(endpoint, {}).get("data") or []


def _synthesize_home_overview(preset="this_month"):
    """Synthesize Public Cloud Home overview from live executive summary, subscriptions & clients."""
    now = datetime.utcnow()
    preset = (preset or "this_month").strip().lower()

    if preset == "last_month":
        first_this_month = now.replace(day=1)
        end_dt = first_this_month - timedelta(days=1)
        start_dt = end_dt.replace(day=1)
        days_in_period = end_dt.day
        days_elapsed = end_dt.day
        exec_params = {
            "year": start_dt.year,
            "month": start_dt.month,
            "preset": "last_month",
            "date_from": start_dt.strftime("%Y-%m-%d"),
            "date_to": end_dt.strftime("%Y-%m-%d"),
        }
    elif preset == "7d":
        end_dt = now
        start_dt = now - timedelta(days=6)
        days_in_period = 7
        days_elapsed = 7
        exec_params = {"preset": "7d", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    elif preset == "15d":
        end_dt = now
        start_dt = now - timedelta(days=14)
        days_in_period = 15
        days_elapsed = 15
        exec_params = {"preset": "15d", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    elif preset == "30d":
        end_dt = now
        start_dt = now - timedelta(days=29)
        days_in_period = 30
        days_elapsed = 30
        exec_params = {"preset": "30d", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    elif preset == "60d":
        end_dt = now
        start_dt = now - timedelta(days=59)
        days_in_period = 60
        days_elapsed = 60
        exec_params = {"preset": "60d", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    elif preset == "90d":
        end_dt = now
        start_dt = now - timedelta(days=89)
        days_in_period = 90
        days_elapsed = 90
        exec_params = {"preset": "90d", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    elif preset == "6m":
        end_dt = now
        start_dt = now - timedelta(days=179)
        days_in_period = 180
        days_elapsed = 180
        exec_params = {"preset": "6m", "date_from": start_dt.strftime("%Y-%m-%d"), "date_to": end_dt.strftime("%Y-%m-%d")}
    else:  # this_month
        start_dt = now.replace(day=1)
        end_dt = now
        days_elapsed = now.day
        days_in_period = calendar.monthrange(now.year, now.month)[1]
        exec_params = {
            "year": now.year,
            "month": now.month,
            "preset": "this_month",
            "date_from": start_dt.strftime("%Y-%m-%d"),
            "date_to": end_dt.strftime("%Y-%m-%d"),
        }

    try:
        r_exec = _upstream("/api/executive-summary", params=exec_params, timeout=15)
        exec_data = r_exec.json() if r_exec.status_code == 200 else {}
    except Exception:
        exec_data = {}

    subs_data = _cached_meta("/api/subscriptions")
    clients_data = _cached_meta("/api/clients")
    provs_data = _cached_meta("/api/cloud-providers")

    kpi = exec_data.get("kpis") or {}
    sym = exec_data.get("currency_symbol") or "$"
    cur = exec_data.get("currency") or "USD"

    cur_total = float(kpi.get("total") or 0.0)
    cur_days_elapsed = int(kpi.get("days_elapsed") or now.day or 1)
    daily_rate = cur_total / max(cur_days_elapsed, 1)

    trend = exec_data.get("monthly_trend") or []
    recent = list(reversed(trend))

    if preset == "this_month":
        total_spend = cur_total
        scale_factor = 1.0
        avg_daily = total_spend / max(days_elapsed, 1)
        forecasted = avg_daily * days_in_period
    elif preset == "last_month":
        total_spend = float(kpi.get("total") or kpi.get("total_lm") or 0.0)
        scale_factor = 1.0
        avg_daily = total_spend / max(days_in_period, 1)
        forecasted = total_spend
    else:
        cur_m = recent[0].get("total", cur_total) if len(recent) > 0 else cur_total
        lm = recent[1].get("total", float(kpi.get("total_lm") or 0.0)) if len(recent) > 1 else float(kpi.get("total_lm") or 0.0)
        lm_daily = (lm / 31.0) if lm > 0 else daily_rate

        if preset == "7d":
            total_spend = daily_rate * 7
        elif preset == "15d":
            rem = max(0, 15 - cur_days_elapsed)
            total_spend = (cur_m + (lm_daily * rem)) if rem > 0 else (daily_rate * 15)
        elif preset == "30d":
            rem = max(0, 30 - cur_days_elapsed)
            total_spend = (cur_m + (lm_daily * rem)) if rem > 0 else (daily_rate * 30)
        elif preset == "60d":
            rem = max(0, 60 - cur_days_elapsed - 31)
            m2 = recent[2].get("total", 0.0) if len(recent) > 2 else 0.0
            m2_daily = (m2 / 31.0) if m2 > 0 else daily_rate
            total_spend = cur_m + lm + (m2_daily * rem)
        elif preset == "90d":
            rem = max(0, 90 - cur_days_elapsed - 62)
            m2 = recent[2].get("total", 0.0) if len(recent) > 2 else 0.0
            m3 = recent[3].get("total", 0.0) if len(recent) > 3 else 0.0
            m3_daily = (m3 / 30.0) if m3 > 0 else daily_rate
            total_spend = cur_m + lm + m2 + (m3_daily * rem)
        elif preset == "6m":
            total_spend = sum(float(m.get("total") or 0.0) for m in recent[:6]) or (daily_rate * 180)
        else:
            total_spend = cur_total

        scale_factor = total_spend / max(cur_total, 1.0) if cur_total > 0 else 1.0
        avg_daily = total_spend / max(days_in_period, 1)
        forecasted = avg_daily * 30

    subs_list = subs_data if isinstance(subs_data, list) else (subs_data.get("subscriptions") or [])
    total_subs = len(subs_list)

    prov_list = provs_data if isinstance(provs_data, list) else (provs_data.get("providers") or provs_data.get("cloud_providers") or [])

    prov_meta = {
        "azure": {"name": "Microsoft Azure", "color": "#008AD7", "sub_colors": ["#0078D4", "#2563EB", "#38BDF8", "#60A5FA"]},
        "aws": {"name": "Amazon Web Services", "color": "#FF9900", "sub_colors": ["#F59E0B", "#D97706", "#B45309", "#FBBF24"]},
        "gcp": {"name": "Google Cloud Platform", "color": "#4285F4", "sub_colors": ["#34A853", "#4285F4", "#EA4335", "#FBBC05"]},
    }

    connected_clouds = set()
    for p in prov_list:
        p_name = (p.get("provider") or p.get("cloud") or "").lower().strip()
        if p_name:
            connected_clouds.add(p_name)

    for cp in ("azure", "aws", "gcp"):
        if float(kpi.get(cp) or 0.0) > 0:
            connected_clouds.add(cp)

    if not connected_clouds:
        connected_clouds = {"azure"}

    cards = []
    total_resources = int((exec_data.get("governance") or {}).get("total_resources") or 0)
    top_accounts = exec_data.get("top_accounts") or []
    top_services = exec_data.get("top_services") or []

    for cp in sorted(connected_clouds):
        base_cost = float(kpi.get(cp) or 0.0)
        cost = base_cost * scale_factor
        prev_cost = float(kpi.get(f"{cp}_lm") or kpi.get(f"{cp}_prev") or 0.0)
        if prev_cost == 0 and cost > 0:
            mom = kpi.get(f"{cp}_mom_pct")
            if mom is not None:
                try:
                    prev_cost = cost / (1.0 + (mom / 100.0)) if mom != -100 else 0.0
                except Exception:
                    prev_cost = cost

        cp_daily = cost / max(days_in_period, 1)

        cp_subs = [s for s in subs_list if (s.get("cloud_provider") or s.get("cloud") or "azure").lower().strip() == cp]
        cp_subs_count = len(cp_subs) if cp_subs else (1 if cost > 0 else 0)

        breakdown = []
        palette = prov_meta.get(cp, {}).get("sub_colors", ["#2563EB", "#38BDF8", "#818CF8", "#C084FC"])

        matched_accs = [a for a in top_accounts if (a.get("cloud_provider") or a.get("cloud") or "").lower().strip() == cp]
        if not matched_accs and cp_subs:
            matched_accs = cp_subs

        if matched_accs:
            sub_total = sum(float(a.get("cost") or 0.0) for a in matched_accs) or base_cost or 1.0
            for idx, a in enumerate(matched_accs[:5]):
                c_val = float(a.get("cost") or 0.0) * scale_factor
                pct = round((c_val / cost) * 100) if cost > 0 else 0
                name = a.get("account_name") or a.get("subscription_name") or a.get("name") or f"Sub {idx+1}"
                breakdown.append({
                    "name": name,
                    "cost": c_val,
                    "pct": pct,
                    "color": palette[idx % len(palette)]
                })
        elif cost > 0:
            breakdown.append({
                "name": f"{prov_meta.get(cp, {}).get('name', cp.title())} Account",
                "cost": cost,
                "pct": 100,
                "color": palette[0]
            })

        srv_count = len([s for s in top_services if (s.get("cloud_provider") or cp).lower().strip() == cp]) or (len(top_services) if cp == "azure" else 4)
        res_count = max(srv_count * 3, cp_subs_count * 5)
        if total_resources == 0:
            total_resources += res_count

        cards.append({
            "provider": cp,
            "provider_name": prov_meta.get(cp, {}).get("name", cp.upper()),
            "cost": cost,
            "last_month_cost": prev_cost,
            "avg_daily_cost": cp_daily,
            "subs_count": cp_subs_count,
            "services_count": max(srv_count, 1) if cost > 0 else 0,
            "resources_count": res_count if cost > 0 else 0,
            "subscription_breakdown": breakdown,
        })

    total_running = max(1, int((total_resources or 100) * 0.7))

    client_list = clients_data if isinstance(clients_data, list) else (clients_data.get("clients") or [])
    active_cls = [c for c in client_list if c.get("active", True)]

    # Capture cookies & headers in the main request thread before handing off to workers
    req_cookies = dict(request.cookies)
    req_headers = {k: v for k, v in request.headers if k.lower() not in HOP_BY_HOP}
    c_date_from = start_dt.strftime("%Y-%m-%d")
    c_date_to = end_dt.strftime("%Y-%m-%d")

    # Fetch real cost data for each client from /api/clients/<id>/costs
    def _fetch_client_cost(cl):
        cid = cl.get("id")
        cache_k = f"cl_cost_{cid}_{c_date_from}_{c_date_to}"
        cached = _CACHE.get(cache_k)
        if cached and (time.time() - cached["time"] < 120):
            return cid, cached["data"]
        try:
            r = requests.get(
                _live(f"/api/clients/{cid}/costs"),
                params={"date_from": c_date_from, "date_to": c_date_to},
                headers=req_headers,
                cookies=req_cookies,
                verify=VERIFY,
                timeout=8,
            )
            if r.status_code == 200:
                data = r.json()
                _CACHE[cache_k] = {"time": time.time(), "data": data}
                return cid, data
        except Exception as exc:
            print(f"[ClientCost] Error fetching client {cid}: {exc}", file=sys.stderr)
        return cid, {}

    client_cost_map = {}
    if client_list:
        with ThreadPoolExecutor(max_workers=min(len(client_list), 8)) as executor:
            for cid, c_data in executor.map(_fetch_client_cost, client_list):
                client_cost_map[cid] = c_data

    client_cards = []
    tot_client_cost = 0.0
    for cl in client_list:
        cid = cl.get("id")
        c_cost_data = client_cost_map.get(cid) or {}
        cl_cost = float(c_cost_data.get("total") or 0.0)
        tot_client_cost += cl_cost

        # Determine clouds from client mappings
        cl_mappings = cl.get("mappings") or []
        cl_clouds = sorted(list(set((m.get("cloud") or "azure").lower().strip() for m in cl_mappings if m.get("cloud"))))
        if not cl_clouds:
            cl_clouds = list(connected_clouds)

        # Determine top service from by_service
        by_svc = c_cost_data.get("by_service") or []
        top_svc = "Cloud Resources"
        if by_svc and isinstance(by_svc, list) and len(by_svc) > 0:
            top_svc = by_svc[0].get("service_name") or by_svc[0].get("name") or "Cloud Resources"

        pct = round((cl_cost / total_spend) * 100) if total_spend > 0 else 0
        client_cards.append({
            "id": cid,
            "name": cl.get("name") or f"Client {cid}",
            "clouds": cl_clouds,
            "cost": cl_cost,
            "pct": pct,
            "top_service": top_svc
        })

    client_cards.sort(key=lambda x: x["cost"], reverse=True)

    alloc_pct = round((tot_client_cost / total_spend) * 100) if total_spend > 0 else 0
    unalloc = max(0.0, total_spend - tot_client_cost)

    client_overview = {
        "total_client_cost": tot_client_cost,
        "allocated_pct": alloc_pct,
        "active_clients_count": len(active_cls),
        "total_clients_count": len(client_list),
        "unallocated_cost": unalloc,
        "clients": client_cards
    }

    return {
        "total_spend": total_spend,
        "days_elapsed": days_elapsed,
        "days_in_period": days_in_period,
        "avg_daily_cost": avg_daily,
        "forecasted_eom": forecasted,
        "total_subs": total_subs or len(cards),
        "total_running": total_running,
        "total_resources": total_resources or 100,
        "date_from": start_dt.strftime("%Y-%m-%d"),
        "date_to": end_dt.strftime("%Y-%m-%d"),
        "currency": cur,
        "currency_symbol": sym,
        "cards": cards,
        "client_overview": client_overview
    }


@app.route("/api/analytics/home-overview", methods=["GET"])
def api_home_overview():
    try:
        up = _upstream("/api/analytics/home-overview")
        if up.status_code == 200:
            return _relay(up)
        if up.status_code == 401:
            return _relay(up)
    except Exception:
        pass
    me, _ = _me()
    if not me:
        return jsonify({"error": "Unauthorized"}), 401
    preset = request.args.get("preset", "this_month").strip().lower()
    return jsonify(_synthesize_home_overview(preset))



@app.route("/api/top-idle-resources", methods=["GET"])
def api_top_idle_resources():
    try:
        up = _upstream("/api/top-idle-resources")
        if up.status_code in (200, 401):
            return _relay(up)
    except Exception:
        pass
    me, _ = _me()
    if not me:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"idle_resources": [], "idle_count": 0})


@app.route("/api/top-resources-by-group", methods=["GET"])
def api_top_resources_by_group():
    try:
        up = _upstream("/api/top-resources-by-group")
        if up.status_code in (200, 401):
            return _relay(up)
    except Exception:
        pass
    me, _ = _me()
    if not me:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"resources": []})


@app.route("/api/budgets/alerts", methods=["GET"])
def api_budgets_alerts():
    return _proxy("/api/budget-alerts")


@app.route("/api/team/members", methods=["GET"])
def api_team_members():
    return _proxy("/api/tenant/users")


@app.route("/api/resource-inventory", methods=["GET"])
def api_resource_inventory():
    try:
        up = _upstream("/api/resource-inventory")
        if up.status_code in (200, 401):
            return _relay(up)
    except Exception:
        pass
    me, _ = _me()
    if not me:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"resources": [], "total": 0})


@app.route("/api/resource-inventory/filters", methods=["GET"])
def api_resource_inventory_filters():
    try:
        up = _upstream("/api/resource-inventory/filters")
        if up.status_code in (200, 401):
            return _relay(up)
    except Exception:
        pass
    me, _ = _me()
    if not me:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"clouds": [], "subscriptions": [], "resource_groups": [], "types": [], "locations": []})


@app.route("/", defaults={"path": ""},
           methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
@app.route("/<path:path>",
           methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
def dispatch(path):
    route = "/" + path
    template = LOCAL_PAGES.get(route)

    if not (request.method == "GET" and template):
        return _proxy(route)

    me, error = _me()
    if error:
        return Response(error, status=502, mimetype="text/plain")
    if me is None:
        return redirect("/login")

    # Mirror the routing app.py:529 does for a super-admin with no tenant picked.
    if route == "/" and me.get("is_super_admin") and me.get("tenant_id") is None:
        return redirect("/superadmin")

    username = me.get("username") or ""
    is_impersonating = bool(me.get("is_super_admin")) and me.get("tenant_id") is not None
    impersonated_tenant = None
    if is_impersonating and username.startswith("[Impersonating] "):
        impersonated_tenant = username[len("[Impersonating] "):]
        username = "Super Admin"

    return _page(template, username=username, is_impersonating=is_impersonating,
                 impersonated_tenant=impersonated_tenant)


if __name__ == "__main__":
    print("=" * 62)
    print("  Frontend-only dev server")
    print("=" * 62)
    print(f"  Local UI   : http://127.0.0.1:{PORT}")
    print(f"  Live API   : {LIVE}")
    print("  Pages      : rendered from local templates/")
    print("  Static     : local static/")
    print("  Proxied    : /api/*, auth POSTs, /logout")
    if not VERIFY_TLS:
        print("  TLS verify : DISABLED (insecure)")
    elif CA_BUNDLE:
        print(f"  TLS verify : on, via {os.path.relpath(CA_BUNDLE)}")
    else:
        print("  TLS verify : on (system/certifi bundle)")
    # Plain ASCII here: the Windows console default codepage mangles em dashes.
    if LIVE.startswith("http://"):
        print("  ! backend link is plain http - credentials cross it in clear")
    if DEBUG:
        print("  ! debug on - dev only, never expose this to a network")
    print("=" * 62)
    app.run(host=HOST, port=PORT, debug=DEBUG)
