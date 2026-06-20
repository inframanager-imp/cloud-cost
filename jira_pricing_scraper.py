"""
Atlassian Jira Pricing Scraper
-------------------------------
Scrapes the Jira pricing page dynamically — enters a user count,
reads the per-plan computed prices.

Requirements:
    pip install playwright
    playwright install chromium

Usage:
    python jira_pricing_scraper.py --users 300
    python jira_pricing_scraper.py --users 300 --billing annual
    python jira_pricing_scraper.py --users 500 --headless false
    python jira_pricing_scraper.py --users 300 --output result.json

    # If prices show $0.00 or wrong plans, run this to inspect real DOM:
    python jira_pricing_scraper.py --diagnose
"""

import argparse
import json
import re
import time

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

JIRA_PRICING_URL = "https://www.atlassian.com/software/jira/pricing"

LOAD_WAIT_SEC   = 4
ACTION_WAIT_SEC = 2

# Exact Jira plan names — used to filter out noise like "Everything from Free, plus:"
KNOWN_PLANS = ["Free", "Standard", "Premium", "Enterprise"]


# ─────────────────────────────────────────────────────────────────────────────
#  PUBLIC ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def get_jira_pricing(users: int, billing: str = "monthly", headless: bool = True) -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        _load_page(page)
        _dismiss_cookie_banner(page)
        _set_billing_cycle(page, billing)
        _set_user_count(page, users)

        results = _extract_pricing(page, users, billing)

        if not headless:
            input("\n[browser] Press Enter to close...")
        browser.close()

    return results


# ─────────────────────────────────────────────────────────────────────────────
#  DIAGNOSTIC MODE
# ─────────────────────────────────────────────────────────────────────────────

def run_diagnostics():
    """Open pricing page and dump real DOM structure so you can fix selectors."""
    print(f"[diagnose] Opening {JIRA_PRICING_URL} ...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(JIRA_PRICING_URL, wait_until="networkidle", timeout=30_000)
        time.sleep(LOAD_WAIT_SEC)

        # All inputs
        inputs = page.evaluate("""() =>
            Array.from(document.querySelectorAll('input')).map(e => ({
                type: e.type, name: e.name, id: e.id,
                placeholder: e.placeholder, value: e.value,
                cls: e.className.slice(0, 100),
                ariaLabel: e.getAttribute('aria-label'),
                dataTestId: e.getAttribute('data-testid'),
            }))
        """)
        print("\n=== INPUT ELEMENTS ===")
        print(json.dumps(inputs, indent=2))

        # All leaf nodes with $ — these are price candidates
        prices = page.evaluate("""() =>
            Array.from(document.querySelectorAll('*'))
                .filter(e => {
                    if (e.children.length !== 0) return false;
                    const t = (e.innerText || '').trim();
                    return /^\\$[\\d.,]+$/.test(t);
                })
                .map(e => ({
                    text:       e.innerText.trim(),
                    tag:        e.tagName,
                    cls:        e.className.slice(0, 120),
                    id:         e.id,
                    dataTestId: e.getAttribute('data-testid'),
                    parentTag:  e.parentElement ? e.parentElement.tagName : '',
                    parentCls:  e.parentElement ? e.parentElement.className.slice(0, 120) : '',
                    grandParentCls: (e.parentElement && e.parentElement.parentElement)
                                    ? e.parentElement.parentElement.className.slice(0, 120) : '',
                }))
        """)
        print("\n=== PRICE ELEMENTS (leaf nodes with $X.XX) ===")
        print(json.dumps(prices, indent=2))

        # All h2/h3/h4 text — to see what headings are present
        headings = page.evaluate("""() =>
            Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(e => ({
                tag:        e.tagName,
                text:       e.innerText.trim(),
                cls:        e.className.slice(0, 100),
                dataTestId: e.getAttribute('data-testid'),
            }))
        """)
        print("\n=== HEADINGS ===")
        print(json.dumps(headings, indent=2))

        input("\n[diagnose] Inspect browser then press Enter to close...")
        browser.close()

    print("\n[diagnose] Done. Paste the output above to get updated selectors.")


# ─────────────────────────────────────────────────────────────────────────────
#  PAGE INTERACTION HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_page(page):
    print(f"[*] Loading {JIRA_PRICING_URL} ...")
    try:
        page.goto(JIRA_PRICING_URL, wait_until="networkidle", timeout=30_000)
    except PWTimeout:
        page.goto(JIRA_PRICING_URL, wait_until="domcontentloaded", timeout=30_000)
    time.sleep(LOAD_WAIT_SEC)


def _dismiss_cookie_banner(page):
    for sel in [
        "button:has-text('Accept all')",
        "button:has-text('Accept cookies')",
        "button:has-text('Accept')",
        "#onetrust-accept-btn-handler",
    ]:
        try:
            page.click(sel, timeout=2000)
            print("[*] Dismissed cookie banner")
            time.sleep(1)
            return
        except Exception:
            continue


def _set_billing_cycle(page, billing: str):
    target_text = "Annual" if billing == "annual" else "Monthly"
    for sel in [
        f"[data-testid*='{billing}']",
        f"label:has-text('{target_text}')",
        f"button:has-text('{target_text}')",
        f"[role='radio']:has-text('{target_text}')",
        f"[role='tab']:has-text('{target_text}')",
    ]:
        try:
            page.click(sel, timeout=3000)
            print(f"[*] Set billing to: {billing}  (selector: {sel})")
            time.sleep(ACTION_WAIT_SEC)
            return
        except Exception:
            continue
    print(f"[!] Could not set billing toggle — defaulting to page default")


def _set_user_count(page, users: int):
    for sel in [
        "[data-testid='user-count-input']",
        "[data-testid*='user']",
        "input[aria-label*='user' i]",
        "input[aria-label*='team' i]",
        "input[name*='user' i]",
        "input[id*='user' i]",
        "input[placeholder*='user' i]",
        "input[type='number']",
        "main input[type='text']",
        "section input",
    ]:
        try:
            el = page.wait_for_selector(sel, timeout=3000, state="visible")
            if el:
                el.click()
                el.press("Control+a")
                el.press("Meta+a")
                el.type(str(users), delay=50)
                el.press("Tab")
                print(f"[*] Entered {users} users  (selector: {sel})")
                time.sleep(ACTION_WAIT_SEC)
                return
        except Exception:
            continue
    print("[!] Could not find user-count input")


# ─────────────────────────────────────────────────────────────────────────────
#  PRICE EXTRACTION  — 3 strategies, most-specific first
# ─────────────────────────────────────────────────────────────────────────────

def _extract_pricing(page, users: int, billing: str) -> dict:
    # Strategy 1: find price leaf nodes, anchor each to nearest plan heading
    result = _strategy_anchor_prices(page, users, billing)
    if result:
        print(f"[*] Extraction strategy: anchor_prices ({len(result)} plans found)")
        return result

    # Strategy 2: card containers
    result = _strategy_cards(page, users, billing)
    if result:
        print(f"[*] Extraction strategy: cards ({len(result)} plans found)")
        return result

    # Strategy 3: page text regex
    print("[!] Falling back to page-text parse")
    return _strategy_page_text(page, users, billing)


def _strategy_anchor_prices(page, users: int, billing: str) -> dict:
    """
    Find every leaf node whose text is exactly "$X.XX" (a price),
    then walk UP the DOM to find the nearest ancestor that also contains
    a known plan name heading. This is robust to any card layout.
    """
    raw = page.evaluate("""(knownPlans) => {
        const results = [];

        // All leaf nodes that look like a price: $7.91  $14.54  $0
        const priceEls = Array.from(document.querySelectorAll('*')).filter(e => {
            if (e.children.length !== 0) return false;
            const t = (e.innerText || '').trim();
            return /^\\$[\\d,]+(\\.\\d+)?$/.test(t);
        });

        priceEls.forEach(priceEl => {
            const priceText = priceEl.innerText.trim();

            // Walk UP to find a containing section that has a plan name heading
            let el = priceEl;
            for (let depth = 0; depth < 10; depth++) {
                el = el.parentElement;
                if (!el) break;

                // Look for a heading inside this ancestor
                const headings = el.querySelectorAll('h1,h2,h3,h4,h5');
                for (const h of headings) {
                    const hText = (h.innerText || '').trim();
                    // Must be an EXACT plan name match (not "Everything from X, plus:")
                    const matchedPlan = knownPlans.find(p =>
                        hText.toLowerCase() === p.toLowerCase()
                    );
                    if (matchedPlan) {
                        results.push({ plan: matchedPlan, price: priceText });
                        return; // stop walking for this priceEl
                    }
                }
            }
        });

        return results;
    }""", KNOWN_PLANS)

    return _build_result(raw, users, billing)


def _strategy_cards(page, users: int, billing: str) -> dict:
    """Look for explicit card/tier containers and extract name + price."""
    raw = page.evaluate("""(knownPlans) => {
        const results = [];
        const cardSelectors = [
            '[data-testid*="plan"]', '[data-testid*="tier"]',
            '[class*="PricingCard"]', '[class*="pricing-card"]',
            '[class*="PricingTier"]', '[class*="plan-card"]',
        ];

        for (const sel of cardSelectors) {
            const cards = document.querySelectorAll(sel);
            if (!cards.length) continue;

            cards.forEach(card => {
                const nameEl = card.querySelector('h2,h3,h4');
                const nameText = nameEl ? (nameEl.innerText || '').trim() : '';
                const matchedPlan = knownPlans.find(p =>
                    nameText.toLowerCase() === p.toLowerCase()
                );
                if (!matchedPlan) return;

                // Find price leaf
                const leaves = Array.from(card.querySelectorAll('*'))
                    .filter(e => e.children.length === 0);
                const priceLeaf = leaves.find(e => {
                    const t = (e.innerText || '').trim();
                    return /^\\$[\\d,]+(\\.\\d+)?$/.test(t);
                });

                results.push({
                    plan:  matchedPlan,
                    price: priceLeaf ? priceLeaf.innerText.trim() : null,
                });
            });

            if (results.length) return results;
        }
        return results;
    }""", KNOWN_PLANS)

    return _build_result(raw, users, billing)


def _strategy_page_text(page, users: int, billing: str) -> dict:
    full_text = page.evaluate("() => document.body.innerText")
    raw = []
    for plan in KNOWN_PLANS:
        pattern = rf"(?<!\w){re.escape(plan)}(?!\w).*?\$([\d.]+)"
        match = re.search(pattern, full_text, re.DOTALL | re.IGNORECASE)
        if match:
            raw.append({"plan": plan, "price": f"${match.group(1)}"})
    return _build_result(raw, users, billing)


def _build_result(raw: list, users: int, billing: str) -> dict:
    """Convert raw [{plan, price}] list into the final result dict."""
    result = {}
    for item in raw:
        plan  = item.get("plan", "").strip()
        price_text = (item.get("price") or "").strip()

        if not plan or plan in result:
            continue

        m = re.search(r"\$([\d,]+\.?\d*)", price_text)
        ppu = float(m.group(1).replace(",", "")) if m else None

        is_free = plan.lower() == "free"
        result[plan] = {
            "plan":                 plan,
            "price_per_user_month": 0.0 if is_free else ppu,
            "total_monthly":        0.0 if is_free else (round(ppu * users, 2) if ppu else None),
            "total_annual":         0.0 if is_free else (round(ppu * users * 12, 2) if ppu else None),
            "billing":              billing,
            "users":                users,
        }
    return result


# ─────────────────────────────────────────────────────────────────────────────
#  OUTPUT
# ─────────────────────────────────────────────────────────────────────────────

def print_results(data: dict, users: int, billing: str):
    print("\n" + "=" * 60)
    print(f"  Jira Pricing  |  {users} users  |  Billed: {billing.upper()}")
    print("=" * 60)

    if not data:
        print("\n  [!] No pricing data could be extracted.")
        print("  Run:  python jira_pricing_scraper.py --diagnose")
        print("  Paste the output and the selectors will be updated.\n")
        return

    for plan_name, info in data.items():
        ppu    = info.get("price_per_user_month")
        total  = info.get("total_monthly")
        annual = info.get("total_annual")
        print(f"\n  Plan        : {plan_name}")
        if plan_name.lower() == "free":
            print("  Price       : $0  (up to 10 users)")
        elif plan_name.lower() == "enterprise":
            print("  Price       : Contact Atlassian")
            print("                Switch to Annual billing on the page to see Enterprise pricing")
        elif ppu is not None:
            print(f"  Per user    : ${ppu:.2f} / user / month")
            print(f"  Total/month : ${total:>12,.2f}")
            print(f"  Total/year  : ${annual:>12,.2f}")
        else:
            print("  Price       : Not available (check --diagnose)")

    print("\n" + "=" * 60)


# ─────────────────────────────────────────────────────────────────────────────
#  MULTI-PRODUCT ENTRY POINT  (used by Flask app)
# ─────────────────────────────────────────────────────────────────────────────

PRODUCT_PRICING_URLS = {
    "jira-software":           "https://www.atlassian.com/software/jira/pricing",
    "confluence":              "https://www.atlassian.com/software/confluence/pricing",
    "jira-service-management": "https://www.atlassian.com/software/jira/service-management/pricing",
    "bitbucket":               "https://bitbucket.org/product/pricing",
    "jira-product-discovery":  "https://www.atlassian.com/software/jira/product-discovery/pricing",
}


def get_product_pricing(product_key: str, users: int, billing: str = "monthly",
                        headless: bool = True) -> dict:
    """
    Scrapes live pricing for any Atlassian product from its public pricing page.
    Returns { plan_name: { price_per_user_month, total_monthly, total_annual, billing, users } }
    Returns {} if the product URL is not known or scraping yields no data.
    """
    url = PRODUCT_PRICING_URLS.get(product_key)
    if not url:
        print(f"[!] No pricing URL configured for product: {product_key}")
        return {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        # Reuse same page helpers with the product-specific URL
        global JIRA_PRICING_URL
        _orig_url        = JIRA_PRICING_URL
        JIRA_PRICING_URL = url

        _load_page(page)
        _dismiss_cookie_banner(page)
        _set_billing_cycle(page, billing)
        _set_user_count(page, users)
        results = _extract_pricing(page, users, billing)

        JIRA_PRICING_URL = _orig_url
        browser.close()

    if not results:
        print(f"[!] No pricing data scraped for {product_key} — run --diagnose to inspect the page")

    return results


# ─────────────────────────────────────────────────────────────────────────────
#  CLI
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape Jira pricing for a given user count")
    parser.add_argument("--users",    type=int,  default=300,       help="Number of users (default: 300)")
    parser.add_argument("--billing",  type=str,  default="monthly", choices=["monthly", "annual"],
                        help="Billing cycle: monthly or annual (default: monthly)")
    parser.add_argument("--headless", type=str,  default="true",    help="Run headless: true/false")
    parser.add_argument("--output",   type=str,  default=None,      help="Save JSON output to this file")
    parser.add_argument("--diagnose", action="store_true",          help="Dump real DOM selectors for debugging")
    args = parser.parse_args()

    if args.diagnose:
        run_diagnostics()
        return

    headless = args.headless.lower() != "false"
    print(f"\n[*] Fetching Jira pricing — {args.users} users | {args.billing} billing ...")

    data = get_jira_pricing(users=args.users, billing=args.billing, headless=headless)
    print_results(data, args.users, args.billing)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(data, f, indent=2)
        print(f"[*] Saved to: {args.output}\n")


if __name__ == "__main__":
    main()