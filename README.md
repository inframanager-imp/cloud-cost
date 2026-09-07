# Cloud Cost Analyzer — Frontend

The UI, runnable on its own against any deployment of the backend.

This folder owns every template, stylesheet, script and image the product
serves. Nothing in here imports the backend; it talks to it over HTTP.

```
frontend/
├── server.py          standalone server + backend proxy
├── templates/         Jinja pages (index, login, superadmin, …)
├── static/            css/, js/, img/, vendor/
├── certs/             CA bundle, only needed for an https backend
├── requirements.txt   flask, requests, python-dotenv
└── .env.example
```

## Run it

```bash
cd frontend
python -m venv venv
venv/Scripts/python.exe -m pip install -r requirements.txt   # Linux/mac: venv/bin/python
cp .env.example .env      # set LIVE_API_URL
venv/Scripts/python.exe server.py
```

Calling the venv's interpreter directly avoids two papercuts: PowerShell's
execution policy blocking `Activate.ps1`, and `pip` being missing from
`Scripts/` when `ensurepip` half-fails (it does that on long paths and profile
names with spaces — `python -m pip` still works because the module is there).

Open <http://127.0.0.1:3000> and sign in with your backend credentials. Edits
to templates, CSS and JS are picked up on reload.

| Variable | Meaning |
|---|---|
| `LIVE_API_URL` | Backend base URL, no trailing slash. **Required.** |
| `FRONTEND_PORT` | Listen port (default `3000`). |
| `LIVE_CA_BUNDLE` | CA bundle for an https backend with an incomplete chain. |
| `LIVE_VERIFY_TLS` | `false` disables cert verification. Last resort. |

Changing `.env` needs a **restart** — the auto-reloader re-executes the module,
but `load_dotenv()` will not override a variable already in the environment.

## How it works

Everything is served from one origin (this server), so the browser never makes
a cross-origin request. That matters: the backend sends **no CORS headers**, so
a UI hosted on a different origin would have all ~145 of its `fetch('/api/…')`
calls blocked and its session cookie withheld. Opening these HTML files
directly will not work either.

| Request | Handled by |
|---|---|
| `/`, `/drilldown`, `/service-detail`, `/onboarding`, `/superadmin` | rendered here, session from the backend's `/api/me` |
| `/login`, `/signup`, `/invite/<token>` | rendered here; the form POST is proxied |
| `/api/*`, `/logout`, auth POSTs | proxied to `LIVE_API_URL` |
| `/static/*` | served from `static/` |

Pages are rendered from **these** templates rather than passed through from the
backend, on purpose: a deployed backend's HTML can lag behind this checkout,
and pairing its stale markup with current CSS is what breaks the layout. When a
login fails, the error is lifted out of the backend's response and shown on the
local template so stale markup never reaches the browser.

Cookies from the backend are rewritten (`Domain` and `Secure` dropped) so an
https session works over `http://localhost`, and redirects are rewritten to
relative paths so the browser stays here.

## Deploying behind an https reverse proxy

This works — the browser only ever talks to the proxy, so everything stays
same-origin and CORS never enters the picture. Three things must change from
the dev defaults.

**1. Do not serve it with `python server.py`.** Flask's built-in server is not
for production, and `FRONTEND_DEBUG=true` exposes Werkzeug's debugger, which
executes arbitrary code from the browser on any traceback. Use waitress
(or gunicorn on Linux) against the same `app` object:

```bash
waitress-serve --listen=127.0.0.1:3000 server:app
# gunicorn -w 4 -b 127.0.0.1:3000 server:app
```

**2. Set the deployment flags in `.env`:**

```ini
LIVE_API_URL=https://your-backend
FRONTEND_HOST=127.0.0.1          # proxy is on the same host
FRONTEND_DEBUG=false             # required
FRONTEND_COOKIE_SECURE=true      # browsers reach us over https
FRONTEND_BEHIND_PROXY=true       # trust X-Forwarded-Proto/-For
```

`FRONTEND_COOKIE_SECURE` matters: this server rewrites the backend's session
cookie for its own origin. Left `false` under https the cookie ships without
`Secure`, so any stray http request would leak the session. Set `true` under
https, and leave `false` for local http — a `Secure` cookie over http is
dropped by the browser and login silently never sticks.

**3. Terminate TLS in nginx and forward:**

```nginx
server {
    listen 443 ssl;
    server_name ui.example.com;

    ssl_certificate     /etc/letsencrypt/live/ui.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ui.example.com/privkey.pem;

    # Served straight from disk; never reaches Python.
    location /static/ {
        alias /srv/frontend/static/;
        expires 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # required by BEHIND_PROXY
        proxy_read_timeout 120s;                      # syncs can be slow
    }
}

server {                      # redirect plain http
    listen 80;
    server_name ui.example.com;
    return 301 https://$host$request_uri;
}
```

`fullchain.pem`, not the bare cert — a chain missing its intermediate still
loads in browsers (they fetch it via AIA) while failing every Python, Go and
Java client.

**The backend link is a separate hop.** Https between browser and this server
says nothing about this server to `LIVE_API_URL`. If that is `http://`,
credentials and session cookies cross it in clear no matter how good the
frontend's certificate is — so point it at an https backend too.

## Note for backend work

`app.py` also serves this UI in production — it points Flask at
`frontend/templates` and `frontend/static`, and the `/static/…` URLs are
unchanged. So `static/` still holds a few files the **backend** owns and hands
out in onboarding commands: `aws-setup.sh`, `azure-setup.sh`, `gcp-setup.sh`
and `aws-integration-template.json`. They live here to keep their public URLs
stable — don't move them without updating `app.py`.
