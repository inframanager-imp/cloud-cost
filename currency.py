"""
Multi-currency support: FX rates, symbols, conversion, and per-tenant reporting
currency. Cloud bills arrive in the account's native currency (e.g. AWS in USD,
an Indian Azure subscription in INR). We pick one reporting currency per tenant
(their dominant currency) and convert everything to it for consistent totals.

Rates are USD-based and refreshed daily from a free no-key API, with a hardcoded
fallback so the tool never depends on the network being up.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime

# USD-based fallback rates (1 USD = X currency). Refreshed at runtime when possible.
DEFAULT_RATES = {
    "USD": 1.0,
    "INR": 86.0,
    "EUR": 0.92,
    "GBP": 0.79,
    "AUD": 1.52,
    "CAD": 1.36,
    "SGD": 1.35,
    "AED": 3.67,
    "JPY": 157.0,
}

SYMBOLS = {
    "USD": "$", "INR": "₹", "EUR": "€", "GBP": "£", "AUD": "A$",
    "CAD": "C$", "SGD": "S$", "AED": "AED ", "JPY": "¥",
}

_CACHE_TTL = 24 * 3600  # refresh once a day


def _cache_path() -> str:
    base = os.getenv("DB_PATH", "/app/data/azure_costs.db")
    return os.path.join(os.path.dirname(os.path.abspath(base)), ".fx_rates.json")


def get_rates() -> dict:
    """Return USD-based rates, refreshing from a free API at most once a day.
    Falls back to the cached file, then to DEFAULT_RATES."""
    path = _cache_path()
    # Use cached file if fresh
    try:
        if os.path.exists(path) and (time.time() - os.path.getmtime(path)) < _CACHE_TTL:
            with open(path) as f:
                data = json.load(f)
            if data.get("rates"):
                return {**DEFAULT_RATES, **data["rates"]}
    except Exception:
        pass

    # Try to refresh from a free, no-key endpoint
    try:
        import urllib.request
        with urllib.request.urlopen("https://open.er-api.com/v6/latest/USD", timeout=6) as r:
            payload = json.load(r)
        rates = payload.get("rates") or {}
        if rates.get("INR"):
            merged = {**DEFAULT_RATES, **{k: float(v) for k, v in rates.items()}}
            try:
                with open(path, "w") as f:
                    json.dump({"fetched_at": datetime.utcnow().isoformat(), "rates": merged}, f)
            except Exception:
                pass
            return merged
    except Exception:
        pass

    # Last resort: stale cache or defaults
    try:
        with open(path) as f:
            data = json.load(f)
        if data.get("rates"):
            return {**DEFAULT_RATES, **data["rates"]}
    except Exception:
        pass
    return dict(DEFAULT_RATES)


def convert(amount: float, frm: str, to: str, rates: dict = None) -> float:
    """Convert amount from one currency to another using USD-based rates."""
    if amount is None:
        return 0.0
    frm = (frm or "USD").upper()
    to = (to or "USD").upper()
    if frm == to:
        return float(amount)
    rates = rates or get_rates()
    r_from = rates.get(frm)
    r_to = rates.get(to)
    if not r_from or not r_to:
        return float(amount)  # unknown currency — leave as-is rather than distort
    # amount(frm) -> USD -> to
    return float(amount) / r_from * r_to


def symbol(code: str) -> str:
    return SYMBOLS.get((code or "USD").upper(), (code or "").upper() + " ")


def tenant_reporting_currency(tenant_id, get_db) -> str:
    """Pick the tenant's reporting currency: the currency with the most spend
    (compared in a common base). Defaults to USD when there's no data."""
    try:
        conn = get_db()
        if tenant_id is not None:
            rows = conn.execute(
                "SELECT currency, SUM(cost) AS c FROM cost_data "
                "WHERE tenant_id=? AND currency IS NOT NULL AND currency!='' GROUP BY currency",
                (tenant_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT currency, SUM(cost) AS c FROM cost_data "
                "WHERE currency IS NOT NULL AND currency!='' GROUP BY currency"
            ).fetchall()
        conn.close()
    except Exception:
        return "USD"
    if not rows:
        return "USD"
    rates = get_rates()
    best, best_usd = "USD", -1.0
    for r in rows:
        cur = (r["currency"] or "USD").upper()
        usd_val = convert(float(r["c"] or 0), cur, "USD", rates)
        if usd_val > best_usd:
            best_usd, best = usd_val, cur
    return best
