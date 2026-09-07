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
import json
import os
import re
import sys

from urllib.parse import parse_qs

import requests
from dotenv import load_dotenv
from flask import Flask, Response, g, redirect, render_template, request

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
