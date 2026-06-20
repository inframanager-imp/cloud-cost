"""
Atlassian pricing cache refresher (standalone — runs OUT of the web container).

The web app reads per-user prices from the `atlassian_pricing` table; it never
scrapes on the request path. This script scrapes live Atlassian pricing with
Playwright and upserts the cache. Run it on a host that has Playwright/Chromium
installed (e.g. a daily cron on the VM), NOT inside the slim app container:

    pip install playwright && playwright install chromium
    DB_PATH=/path/to/azure_costs.db python3 atlassian_pricing_sync.py

It refreshes every (product, plan) the cache already knows about, plus the core
products, scraping at a representative user count.
"""
import sys
from datetime import datetime

from database import get_db

# Scrape at a representative org size; Atlassian per-user price is tier-based so
# this is "price for a mid-size org". Override with: python atlassian_pricing_sync.py 120
DEFAULT_USERS = 50

PRODUCTS = ["jira-software", "confluence", "jira-service-management"]
PLANS    = ["standard", "premium", "enterprise"]


def _upsert(conn, product, plan, price, currency, users_basis):
    conn.execute("DELETE FROM atlassian_pricing WHERE product_name=? AND plan=?", (product, plan))
    conn.execute(
        "INSERT INTO atlassian_pricing(product_name,plan,price_per_user,currency,users_basis,source,scraped_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (product, plan, price, currency, users_basis, "scrape", datetime.utcnow().isoformat()),
    )


def refresh(users: int = DEFAULT_USERS):
    try:
        from jira_pricing_scraper import get_product_pricing
    except Exception as e:
        print(f"[pricing] Playwright/scraper not available: {e}")
        print("[pricing] Install with: pip install playwright && playwright install chromium")
        return 1

    conn = get_db()
    updated = 0
    for product in PRODUCTS:
        try:
            data = get_product_pricing(product, users, "monthly")  # {Plan: {price_per_user_month,...}}
        except Exception as e:
            print(f"[pricing] {product}: scrape failed — {e}")
            continue
        if not data:
            print(f"[pricing] {product}: no data returned")
            continue
        for plan in PLANS:
            match = next((v for k, v in data.items() if k.lower() == plan), None)
            if not match:
                continue
            price = match.get("price_per_user_month")
            if price is None:
                continue
            _upsert(conn, product, plan, round(float(price), 2), "USD", users)
            updated += 1
            print(f"[pricing] {product}/{plan} = ${price:.2f} (basis {users} users)")
    conn.commit()
    conn.close()
    print(f"[pricing] done — {updated} prices refreshed")
    return 0


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_USERS
    sys.exit(refresh(n))
