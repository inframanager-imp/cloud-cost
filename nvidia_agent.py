"""
NVIDIA (Llama 3.3 70B) tool-calling agent for the AI Assistant.

Turns a plain-English question into a safe read-only SQL query over the cost DB,
runs it, and answers from the real rows. Activated only when NVIDIA_API_KEY is set
(so production, which has no key, keeps using the existing Ollama path).
"""
import os, json, sqlite3, datetime, urllib.request
from database import DB_PATH, DB_ENGINE, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

API_KEY = os.environ.get("NVIDIA_API_KEY", "")
API_URL = os.environ.get("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
MODEL   = os.environ.get("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")

_BANNED = ("insert", "update", "delete", "drop", "alter", "create", "replace",
           "attach", "detach", "pragma", "vacuum", "reindex")

TOOLS = [{
    "type": "function",
    "function": {
        "name": "run_sql",
        "description": "Run one read-only SELECT query against the cost database and return the rows.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "A single SQLite SELECT statement."}},
            "required": ["query"],
        },
    },
}]


def _system_prompt(tenant_id):
    today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    tid = tenant_id if tenant_id is not None else 1
    engine_name = "PostgreSQL" if DB_ENGINE == "postgres" else "SQLite"
    month_filter_rule = (
        "- For a month use to_char(date::date, 'YYYY-MM')='YYYY-MM'."
        if DB_ENGINE == "postgres" else
        "- For a month use substr(date,1,7)='YYYY-MM'."
    )
    return f"""You are a FinOps analyst with read-only SQL access to a {engine_name} cost database.
Today is {today}. Answer questions by calling run_sql with a single SELECT, reading the
rows, then giving a short, direct answer with the real numbers (include the currency).
If a query returns no rows, say so plainly. NEVER invent data, names, or numbers — if the
information needed is not in the schema below, say it isn't tracked.

ALWAYS filter every query to this organization: tenant_id = {tid}.

SCHEMA ({engine_name}):
  cost_data(date 'YYYY-MM-DD', cost REAL, currency, cloud_provider, service_name,
            resource_group, resource_name, subscription_id, meter_category, tags(json), tenant_id)
      -- main cost table; SUM(cost) for totals. cloud_provider in:
      -- azure, aws, gcp, atlassian, cursor, openai
      -- subscription_id by cloud: azure=subscription, aws=account, gcp=project,
      --   atlassian=Jira org id, cursor=team name (PRISM-TEAM / GYAN-TEAM)
      -- atlassian/cursor: resource_name = user/member name
  cursor_users(tenant_id, name, email, role, spend_cents, included_cents, account)
      -- per-user Cursor; account=team; on-demand $=spend_cents/100.0; included $=included_cents/100.0
      -- some users have an empty name — use COALESCE(NULLIF(name,''), email) for display.
  cloud_providers(provider_type, name, provider_id, tenant_id)
      -- friendly account names. Join cost_data.subscription_id = cloud_providers.provider_id
      -- to filter by name (e.g. name='GYAN-JIRA', 'RCA'). Prefer returning the friendly name.

RULES:
- Only SELECT, one statement, no writes.
{month_filter_rule}
- Last login / activity dates are NOT stored — say so if asked.
"""


def _run_sql(query: str):
    q = (query or "").strip().rstrip(";").strip()
    low = q.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return {"error": "Only SELECT queries are allowed."}
    if ";" in q or any(b in low.split() for b in _BANNED):
        return {"error": "Query rejected (single read-only SELECT only)."}
    try:
        if DB_ENGINE == "postgres":
            import psycopg2
            import psycopg2.extras
            con = psycopg2.connect(
                host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD,
                cursor_factory=psycopg2.extras.RealDictCursor,
            )
            con.set_session(readonly=True)  # hard DB-level guarantee, not just the keyword filter above
            cur = con.cursor()
            cur.execute(q)
            rows = [dict(r) for r in cur.fetchmany(200)]
            con.close()
        else:
            con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            rows = [dict(r) for r in con.execute(q).fetchmany(200)]
            con.close()
        return {"row_count": len(rows), "rows": rows}
    except Exception as e:
        return {"error": str(e)}


def _post(messages):
    body = json.dumps({"model": MODEL, "messages": messages, "tools": TOOLS,
                       "tool_choice": "auto", "temperature": 0, "max_tokens": 700}).encode()
    req = urllib.request.Request(API_URL, data=body, headers={
        "Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def answer(message, tenant_id=None):
    """Return {"reply": str} — same shape the chat endpoint expects."""
    messages = [{"role": "system", "content": _system_prompt(tenant_id)},
                {"role": "user", "content": message}]
    for _ in range(6):
        data = _post(messages)
        msg = data["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not calls:
            return {"reply": (msg.get("content") or "").strip() or "I couldn't find an answer for that."}
        messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        for c in calls:
            try:
                args = json.loads(c["function"]["arguments"] or "{}")
            except Exception:
                args = {}
            result = _run_sql(args.get("query", "")) if c["function"]["name"] == "run_sql" else {"error": "unknown tool"}
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result, default=str)})
    return {"reply": "Sorry — that took too many steps. Try narrowing the question."}
