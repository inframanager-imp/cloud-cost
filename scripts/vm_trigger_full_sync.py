#!/usr/bin/env python3
"""Run on the EC2 host (not inside container). Uses /data/azure-cost/.env for admin login."""
import json
import time
import urllib.parse
import urllib.request
import http.cookiejar
from pathlib import Path


def load_env(path):
    env = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        env[k] = v
    return env


def main():
    env = load_env("/data/azure-cost/.env")
    base = "http://127.0.0.1:5000"
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    data = urllib.parse.urlencode(
        {"username": env["ADMIN_USERNAME"], "password": env["ADMIN_PASSWORD"]}
    ).encode()
    op.open(urllib.request.Request(f"{base}/login", data=data, method="POST"))
    print("[ok] login")

    op.open(urllib.request.Request(f"{base}/api/subscriptions/discover", method="POST"))
    print("[ok] discover subscriptions")

    body = json.dumps({"mode": "full"}).encode()
    req = urllib.request.Request(
        f"{base}/api/sync",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        # Inline sync can take many minutes (full + sequential subs)
        resp = op.open(req, timeout=7200).read().decode()
        print("[ok] sync response:", resp[:800])
        data = json.loads(resp)
        if data.get("inline"):
            print("[ok] completed inline; skipping status poll.")
            # jump to db print
            import sqlite3

            c = sqlite3.connect("/data/azure-cost/data/azure_costs.db")
            r = c.execute(
                "select max(date), count(distinct subscription_id), count(*) from cost_data"
            ).fetchone()
            print("[db]", "max_date", r[0], "subs", r[1], "rows", r[2])
            c.close()
            return
    except Exception as ex:
        print("[warn] sync POST:", ex)

    for i in range(400):
        time.sleep(5)
        st = json.loads(
            op.open(urllib.request.Request(f"{base}/api/sync/status")).read().decode()
        )
        msg = (st.get("message") or "")[:120]
        prog = st.get("progress")
        run = st.get("running")
        print(f"[{i * 5}s] running={run} progress={prog} {msg}")
        if not run:
            break

    # Final DB hint
    import sqlite3

    c = sqlite3.connect("/data/azure-cost/data/azure_costs.db")
    r = c.execute(
        "select max(date), count(distinct subscription_id), count(*) from cost_data"
    ).fetchone()
    print("[db]", "max_date", r[0], "subs", r[1], "rows", r[2])
    c.close()


if __name__ == "__main__":
    main()
