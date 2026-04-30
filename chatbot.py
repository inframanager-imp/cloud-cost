import re
import os
import json
import calendar
import requests
from datetime import datetime, timedelta
from database import get_summary, get_daily_trend, query_costs, get_stats, get_distinct_values

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:1.5b")
OLLAMA_URL   = os.getenv("OLLAMA_URL", "http://localhost:11434")


def process_chat_message(message, tenant_id=None):
    msg = message.lower().strip()
    result = rule_based_response(msg, tenant_id=tenant_id)
    if result:
        return result
    return ollama_response(message, tenant_id=tenant_id)


# ═══════════════════════════════════════════════════════════════════════════════
# CLOUD DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

def detect_cloud(msg):
    """Return 'azure', 'aws', 'gcp', or None."""
    if re.search(r'\b(aws|amazon|ec2|s3|rds|lambda|cloudwatch|dynamo)\b', msg):
        return 'aws'
    if re.search(r'\b(gcp|google\s*cloud|gcloud|bigquery|cloud\s*run|translate|text.?to.?speech|tts|gemini)\b', msg):
        return 'gcp'
    if re.search(r'\b(azure|microsoft\s*cloud|arm)\b', msg):
        return 'azure'
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# SERVICE DETECTION (multi-cloud)
# ═══════════════════════════════════════════════════════════════════════════════

AZURE_SERVICE_MAP = {
    r'\b(vm|virtual\s*machine)\b':              "Virtual Machines",
    r'\b(storage|blob)\b':                       "Storage",
    r'\b(mysql)\b':                              "Azure Database for MySQL",
    r'\b(postgres|postgresql)\b':               "Azure Database for PostgreSQL",
    r'\b(sql\s*database|sql\s*server|mssql)\b': "SQL Database",
    r'\b(netapp)\b':                             "Azure NetApp Files",
    r'\b(log\s*analytics)\b':                   "Log Analytics",
    r'\b(kubernetes|aks)\b':                    "Azure Kubernetes Service",
    r'\b(app\s*service|web\s*app)\b':           "Azure App Service",
    r'\b(function|serverless)\b':               "Functions",
    r'\b(redis|cache)\b':                        "Azure Cache for Redis",
    r'\b(key\s*vault)\b':                        "Key Vault",
    r'\b(cosmos|cosmosdb)\b':                   "Azure Cosmos DB",
    r'\b(service\s*bus)\b':                      "Service Bus",
    r'\b(container\s*registry|acr)\b':          "Container Registry",
    r'\b(bandwidth|vnet|load\s*balancer)\b':    "Virtual Network",
    r'\b(backup)\b':                             "Backup",
    r'\b(foundry)\b':                            "Foundry Tools",
}

AWS_SERVICE_MAP = {
    r'\b(ec2|elastic\s*compute|instance)\b':             "Amazon EC2",
    r'\b(s3|simple\s*storage)\b':                         "Amazon S3",
    r'\b(rds|relational\s*database)\b':                   "Amazon RDS",
    r'\b(lambda)\b':                                      "AWS Lambda",
    r'\b(cloudwatch|cloud\s*watch)\b':                    "AmazonCloudWatch",
    r'\b(dynamodb|dynamo)\b':                             "Amazon DynamoDB",
    r'\b(cloudfront|cdn)\b':                              "Amazon CloudFront",
    r'\b(elb|elastic\s*load\s*balanc)\b':                "Elastic Load Balancing",
    r'\b(ecs|elastic\s*container)\b':                     "Amazon ECS",
    r'\b(eks)\b':                                         "Amazon EKS",
    r'\b(vpc|nat\s*gateway)\b':                           "Amazon VPC",
    r'\b(route\s*53|dns)\b':                              "Amazon Route 53",
    r'\b(ses|simple\s*email)\b':                          "Amazon SES",
    r'\b(sns|simple\s*notification)\b':                   "Amazon SNS",
    r'\b(sqs|simple\s*queue)\b':                          "Amazon SQS",
    r'\b(ebs|elastic\s*block)\b':                         "Amazon EBS",
    r'\b(glue)\b':                                        "AWS Glue",
    r'\b(athena)\b':                                      "Amazon Athena",
    r'\b(redshift)\b':                                    "Amazon Redshift",
    r'\b(elastic\s*cache|elasticache)\b':                 "Amazon ElastiCache",
    r'\b(api\s*gateway)\b':                               "Amazon API Gateway",
    r'\b(cost\s*explorer)\b':                             "AWS Cost Explorer",
}

GCP_SERVICE_MAP = {
    r'\b(text.?to.?speech|tts|speech\s*synthesis)\b':    "Cloud Text-to-Speech",
    r'\b(translate|translation)\b':                       "Cloud Translation API",
    r'\b(gemini|vertex\s*ai|ai\s*platform)\b':           "Gemini API",
    r'\b(bigquery|big\s*query)\b':                        "BigQuery",
    r'\b(cloud\s*run)\b':                                 "Cloud Run",
    r'\b(cloud\s*function)\b':                            "Cloud Functions",
    r'\b(gce|compute\s*engine)\b':                        "Compute Engine",
    r'\b(gcs|cloud\s*storage)\b':                         "Cloud Storage",
    r'\b(gke|kubernetes\s*engine)\b':                     "Kubernetes Engine",
    r'\b(cloud\s*sql)\b':                                 "Cloud SQL",
    r'\b(custom\s*search)\b':                             "Custom Search",
    r'\b(support)\b':                                     "Support",
}


def detect_service(msg, cloud=None):
    """Detect service from message, optionally filtered by cloud."""
    maps = []
    if cloud == 'aws':
        maps = [AWS_SERVICE_MAP]
    elif cloud == 'gcp':
        maps = [GCP_SERVICE_MAP]
    elif cloud == 'azure':
        maps = [AZURE_SERVICE_MAP]
    else:
        maps = [AZURE_SERVICE_MAP, AWS_SERVICE_MAP, GCP_SERVICE_MAP]

    for smap in maps:
        for pattern, service_name in smap.items():
            if re.search(pattern, msg):
                return service_name

    # Fallback: match against actual DB values
    available = get_distinct_values("service_name")
    for svc in available:
        if svc and len(svc) > 3 and svc.lower() in msg:
            return svc
    return None


def detect_resource_group(msg):
    available = get_distinct_values("resource_group")
    for rg in available:
        if rg and len(rg) > 2 and rg.lower() in msg:
            return rg
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# RULE-BASED ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def rule_based_response(msg, tenant_id=None):

    # ── Greetings ──
    if re.match(r'^(hi|hello|hey|good\s*(morning|afternoon|evening)|greetings|howdy|sup)\b', msg):
        stats = get_stats()
        return {
            "reply": (
                f"**Hello! I'm your Multi-Cloud Cost Assistant.**\n\n"
                f"**Overview:**\n"
                f"  - Total Cost: **${stats['total_cost']:,.2f}**\n"
                f"  - Records: **{stats['total_records']:,}**\n"
                f"  - Data Range: {stats['date_range_from']} to {stats['date_range_to']}\n\n"
                f"**Try asking:**\n"
                f"  - \"How much did AWS cost in March?\"\n"
                f"  - \"GCP spend this month\"\n"
                f"  - \"Top 5 Azure services last month\"\n"
                f"  - \"Compare AWS vs Azure costs\"\n"
                f"  - \"EC2 cost last 30 days\"\n"
                f"  - Type **help** for all options."
            )
        }

    # ── Help ──
    if re.search(r'\b(help|what can you|how to use|commands|options|guide)\b', msg):
        return {
            "reply": (
                "**Multi-Cloud Cost Assistant — What I can do:**\n\n"
                "**Cost Queries:**\n"
                "  - \"Total AWS cost in January\"\n"
                "  - \"How much did EC2 cost last month?\"\n"
                "  - \"GCP translate cost this week\"\n"
                "  - \"Azure VM spend last 30 days\"\n\n"
                "**Cloud Comparisons:**\n"
                "  - \"Compare AWS vs Azure costs\"\n"
                "  - \"Compare Jan and Feb AWS costs\"\n"
                "  - \"Last week vs this week\"\n\n"
                "**Top Services / Accounts:**\n"
                "  - \"Top 5 expensive AWS services\"\n"
                "  - \"Most expensive GCP services\"\n"
                "  - \"Which resource group costs most?\"\n\n"
                "**Trends:**\n"
                "  - \"Daily cost trend last 30 days\"\n"
                "  - \"AWS cost trend this month\"\n\n"
                "**Supported clouds:** Azure · AWS · GCP"
            )
        }

    # ── Stats / Summary ──
    if re.search(r'\b(stats|summary|overview|status|info|total\s*spend|all\s*cloud)\b', msg) and \
       not re.search(r'\b(cost|spend|expense|vm|storage|ec2|gcp|aws|azure)\b', msg):
        stats = get_stats()
        azure = sum(r["total_cost"] for r in get_summary("service_name", None, None, cloud_provider="azure")[:1]) if True else 0
        try:
            from database import get_db
            conn = get_db()
            cloud_rows = conn.execute(
                "SELECT cloud_provider, SUM(cost) as total FROM cost_data GROUP BY cloud_provider"
            ).fetchall()
            conn.close()
            breakdown = "\n".join([f"  - **{r['cloud_provider'].upper()}**: ${r['total']:,.2f}" for r in cloud_rows])
        except Exception:
            breakdown = ""
        return {
            "reply": (
                f"**Multi-Cloud Cost Summary:**\n"
                f"  - Total Cost: **${stats['total_cost']:,.2f}**\n"
                f"  - Total Records: **{stats['total_records']:,}**\n"
                f"  - Date Range: {stats['date_range_from']} to {stats['date_range_to']}\n\n"
                f"**By Cloud:**\n{breakdown}"
            )
        }

    # ── Cloud vs Cloud comparison ──
    if re.search(r'\b(compare|versus|vs\.?)\b', msg) and \
       re.search(r'\b(aws|azure|gcp|google|amazon|microsoft)\b', msg) and \
       len(re.findall(r'\b(aws|azure|gcp)\b', msg)) >= 2:
        return handle_cloud_vs_cloud(msg)

    # ── Period comparison ──
    if re.search(r'\b(compare|comparison|versus|vs\.?|differ|between)\b', msg):
        return handle_comparison(msg)

    # ── Extract filters ──
    date_from, date_to = extract_date_range(msg)
    cloud  = detect_cloud(msg)
    service = detect_service(msg, cloud)
    rg     = detect_resource_group(msg)

    # ── Cloud total cost ──
    if cloud and not service and not rg and \
       re.search(r'\b(cost|spend|spent|total|much|bill|expense|how much)\b', msg):
        data = get_summary("service_name", date_from, date_to, cloud_provider=cloud)
        total = sum(r["total_cost"] for r in data)
        top5  = data[:5]
        period = f"({date_from} to {date_to})" if date_from else "(all time)"
        breakdown = "\n".join([f"  {i+1}. **{s['service_name']}**: ${s['total_cost']:,.2f}" for i, s in enumerate(top5)])
        return {
            "reply": f"**{cloud.upper()} total cost {period}: ${total:,.2f}**\n\nTop services:\n{breakdown}",
            "chart_data": {
                "type": "pie",
                "labels": [s["service_name"] for s in top5],
                "values": [round(s["total_cost"], 2) for s in top5],
                "title": f"{cloud.upper()} Cost Breakdown {period}"
            }
        }

    # ── Top services ──
    if re.search(r'\b(top|most expensive|highest|biggest|rank|which.*most|which.*expensive)\b', msg):
        if re.search(r'\b(rg|resource.?group|account|subscription|project)\b', msg):
            return make_top_rgs_response(date_from, date_to, _extract_limit(msg), cloud)
        return make_top_services_response(date_from, date_to, _extract_limit(msg), cloud)

    # ── Resource group queries ──
    if rg and not service:
        data  = get_daily_trend(date_from, date_to, resource_group=rg, cloud_provider=cloud)
        total = sum(r["total_cost"] for r in data)
        period = f"({date_from} to {date_to})" if date_from else "(all time)"
        return {
            "reply": f"**'{rg}' cost {period}: ${total:,.2f}**\n  - Days with data: {len(data)}",
            "chart_data": {
                "type": "line",
                "labels": [r["date"] for r in data],
                "values": [round(r["total_cost"], 2) for r in data],
                "title": f"{rg} - Daily Cost"
            }
        }

    if re.search(r'\b(resource.?group|rg|account|subscription|project)\b', msg):
        return make_top_rgs_response(date_from, date_to, _extract_limit(msg), cloud)

    # ── Service cost ──
    if service:
        filters = {"search": service, "date_from": date_from, "date_to": date_to, "limit": 5000}
        if rg:
            filters["resource_group"] = rg
        if cloud:
            filters["cloud_provider"] = cloud
        data  = query_costs(filters)
        total = sum(r["cost"] for r in data)
        daily = {}
        for r in data:
            daily[r["date"]] = daily.get(r["date"], 0) + r["cost"]
        sorted_daily = sorted(daily.items())
        period = f"({date_from} to {date_to})" if date_from else "(all time)"
        cloud_label = f" [{cloud.upper()}]" if cloud else ""
        return {
            "reply": f"**{service}{cloud_label} cost {period}: ${total:,.2f}**\n  - Records: {len(data)}, Days: {len(sorted_daily)}",
            "chart_data": {
                "type": "line",
                "labels": [d[0] for d in sorted_daily],
                "values": [round(d[1], 2) for d in sorted_daily],
                "title": f"{service} Cost Trend"
            }
        }

    # ── Trend ──
    if re.search(r'\b(trend|daily|chart|graph|over time|day by day)\b', msg):
        data  = get_daily_trend(date_from, date_to, cloud_provider=cloud)
        if not data:
            return {"reply": "No data found for the specified period."}
        total = sum(r["total_cost"] for r in data)
        avg   = total / len(data)
        period = f"({date_from} to {date_to})" if date_from else ""
        cloud_label = f" [{cloud.upper()}]" if cloud else ""
        return {
            "reply": f"**Daily Cost Trend{cloud_label} {period}:**\n  - Total: **${total:,.2f}**\n  - Avg/day: **${avg:,.2f}**\n  - Days: {len(data)}",
            "chart_data": {
                "type": "line",
                "labels": [r["date"] for r in data],
                "values": [round(r["total_cost"], 2) for r in data],
                "title": f"Daily Cost Trend{cloud_label}"
            }
        }

    # ── Generic cost/spend question ──
    if re.search(r'\b(cost|spend|spent|expense|bill|paid|charge|much|total|how much)\b', msg) or _detect_month_name(msg):
        data  = get_summary("service_name", date_from, date_to, cloud_provider=cloud)
        total = sum(r["total_cost"] for r in data)
        top5  = data[:5]
        period = f"({date_from} to {date_to})" if date_from else "(all time)"
        cloud_label = f" [{cloud.upper()}]" if cloud else ""
        breakdown = "\n".join([f"  - **{s['service_name']}**: ${s['total_cost']:,.2f}" for s in top5])
        return {
            "reply": f"**Total cost{cloud_label} {period}: ${total:,.2f}**\n\nTop services:\n{breakdown}",
            "chart_data": {
                "type": "pie",
                "labels": [s["service_name"] for s in top5],
                "values": [round(s["total_cost"], 2) for s in top5],
                "title": f"Cost Breakdown{cloud_label} {period}"
            }
        }

    return None


# ═══════════════════════════════════════════════════════════════════════════════
# CLOUD vs CLOUD COMPARISON
# ═══════════════════════════════════════════════════════════════════════════════

def handle_cloud_vs_cloud(msg):
    date_from, date_to = extract_date_range(msg)
    period = f"({date_from} to {date_to})" if date_from else "(all time)"

    clouds = []
    for c in ['aws', 'azure', 'gcp']:
        if c in msg or (c == 'gcp' and 'google' in msg):
            clouds.append(c)

    if len(clouds) < 2:
        clouds = ['azure', 'aws', 'gcp']

    results = []
    for c in clouds:
        data  = get_summary("service_name", date_from, date_to, cloud_provider=c)
        total = sum(r["total_cost"] for r in data)
        results.append((c.upper(), total))

    results.sort(key=lambda x: -x[1])
    lines = "\n".join([f"  {i+1}. **{r[0]}**: ${r[1]:,.2f}" for i, r in enumerate(results)])
    winner = results[0][0]

    return {
        "reply": f"**Cloud Cost Comparison {period}:**\n\n{lines}\n\n**{winner}** has the highest spend.",
        "chart_data": {
            "type": "bar",
            "labels": [r[0] for r in results],
            "values": [round(r[1], 2) for r in results],
            "title": f"Cloud Cost Comparison {period}"
        }
    }


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def make_top_services_response(date_from, date_to, limit, cloud=None):
    data   = get_summary("service_name", date_from, date_to, cloud_provider=cloud)
    top    = data[:limit]
    period = f"({date_from} to {date_to})" if date_from else ""
    label  = "All" if limit >= 50 else f"Top {len(top)}"
    cloud_label = f" [{cloud.upper()}]" if cloud else ""
    breakdown = "\n".join([f"  {i+1}. **{s['service_name']}**: ${s['total_cost']:,.2f}" for i, s in enumerate(top)])
    total = sum(s["total_cost"] for s in top)
    breakdown += f"\n\n  **Grand Total: ${total:,.2f}**"
    return {
        "reply": f"**{label} Services{cloud_label} {period}:**\n{breakdown}",
        "chart_data": {
            "type": "bar",
            "labels": [s["service_name"] for s in top[:15]],
            "values": [round(s["total_cost"], 2) for s in top[:15]],
            "title": f"{label} Services by Cost{cloud_label}"
        }
    }


def make_top_rgs_response(date_from, date_to, limit, cloud=None):
    data   = get_summary("resource_group", date_from, date_to, cloud_provider=cloud)
    top    = data[:limit]
    period = f"({date_from} to {date_to})" if date_from else ""
    label  = "All" if limit >= 50 else f"Top {len(top)}"
    cloud_label = f" [{cloud.upper()}]" if cloud else ""
    breakdown = "\n".join([f"  {i+1}. **{r['resource_group'] or 'Unknown'}**: ${r['total_cost']:,.2f}" for i, r in enumerate(top)])
    total = sum(r["total_cost"] for r in top)
    breakdown += f"\n\n  **Grand Total: ${total:,.2f}**"
    return {
        "reply": f"**{label} Accounts/Groups{cloud_label} {period}:**\n{breakdown}",
        "chart_data": {
            "type": "bar",
            "labels": [r["resource_group"] or "Unknown" for r in top[:15]],
            "values": [round(r["total_cost"], 2) for r in top[:15]],
            "title": f"{label} Accounts/Groups by Cost{cloud_label}"
        }
    }


def _extract_limit(msg):
    if re.search(r'\b(all|every|complete|full|entire|each)\b', msg):
        return 100
    m = re.search(r'\b(\d+)\b', msg)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 100:
            return n
    return 5


def handle_comparison(msg):
    today   = datetime.utcnow()
    cloud   = detect_cloud(msg)
    service = detect_service(msg, cloud)
    rg      = detect_resource_group(msg)

    months_found = _find_two_months(msg)
    if months_found:
        p1_from, p1_to, p2_from, p2_to = months_found
    elif re.search(r'last\s*week.*this\s*week|this\s*week.*last\s*week', msg):
        p2_from = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
        p2_to   = today.strftime("%Y-%m-%d")
        p1_from = (today - timedelta(days=today.weekday() + 7)).strftime("%Y-%m-%d")
        p1_to   = (today - timedelta(days=today.weekday() + 1)).strftime("%Y-%m-%d")
    elif re.search(r'last\s*month.*this\s*month|this\s*month.*last\s*month', msg):
        p2_from = today.replace(day=1).strftime("%Y-%m-%d")
        p2_to   = today.strftime("%Y-%m-%d")
        prev    = today.replace(day=1) - timedelta(days=1)
        p1_from = prev.replace(day=1).strftime("%Y-%m-%d")
        p1_to   = prev.strftime("%Y-%m-%d")
    else:
        p2_from = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
        p2_to   = today.strftime("%Y-%m-%d")
        p1_from = (today - timedelta(days=today.weekday() + 7)).strftime("%Y-%m-%d")
        p1_to   = (today - timedelta(days=today.weekday() + 1)).strftime("%Y-%m-%d")

    extra = {}
    if cloud:
        extra["cloud_provider"] = cloud

    if service:
        p1_data  = query_costs({"search": service, "date_from": p1_from, "date_to": p1_to, "limit": 5000, **extra})
        p2_data  = query_costs({"search": service, "date_from": p2_from, "date_to": p2_to, "limit": 5000, **extra})
        p1_total = sum(r["cost"] for r in p1_data)
        p2_total = sum(r["cost"] for r in p2_data)
    else:
        p1_trend = get_daily_trend(p1_from, p1_to, rg, cloud_provider=cloud)
        p2_trend = get_daily_trend(p2_from, p2_to, rg, cloud_provider=cloud)
        p1_total = sum(r["total_cost"] for r in p1_trend)
        p2_total = sum(r["total_cost"] for r in p2_trend)

    diff      = p2_total - p1_total
    pct       = (diff / p1_total * 100) if p1_total > 0 else 0
    direction = "increased" if diff > 0 else "decreased"
    filter_label = f" - {service}" if service else (f" - {rg}" if rg else "")
    cloud_label  = f" [{cloud.upper()}]" if cloud else ""

    p1_chart = get_daily_trend(p1_from, p1_to, rg, cloud_provider=cloud)
    p2_chart = get_daily_trend(p2_from, p2_to, rg, cloud_provider=cloud)

    return {
        "reply": (
            f"**Cost Comparison{cloud_label}{filter_label}:**\n\n"
            f"  - **Period 1** ({p1_from} → {p1_to}): **${p1_total:,.2f}**\n"
            f"  - **Period 2** ({p2_from} → {p2_to}): **${p2_total:,.2f}**\n\n"
            f"  Cost {direction} by **${abs(diff):,.2f}** ({abs(pct):.1f}%)"
        ),
        "chart_data": {
            "type": "comparison",
            "labels": [f"Day {i+1}" for i in range(max(len(p1_chart), len(p2_chart), 1))],
            "datasets": [
                {"label": f"Period 1 ({p1_from} → {p1_to})", "values": [round(r["total_cost"], 2) for r in p1_chart]},
                {"label": f"Period 2 ({p2_from} → {p2_to})", "values": [round(r["total_cost"], 2) for r in p2_chart]}
            ],
            "title": f"Cost Comparison{cloud_label}{filter_label}"
        }
    }


def _find_two_months(msg):
    month_names = {
        "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
        "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
        "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
        "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
    }
    today = datetime.utcnow()
    found = []
    for name, num in sorted(month_names.items(), key=lambda x: -len(x[0])):
        if re.search(r'\b' + name + r'\b', msg):
            if num not in [f[0] for f in found]:
                year     = today.year if num <= today.month else today.year - 1
                last_day = calendar.monthrange(year, num)[1]
                end      = today.strftime("%Y-%m-%d") if (year == today.year and num == today.month) else f"{year}-{num:02d}-{last_day:02d}"
                found.append((num, f"{year}-{num:02d}-01", end))
            if len(found) == 2:
                break
    if len(found) == 2:
        found.sort(key=lambda x: x[0])
        return found[0][1], found[0][2], found[1][1], found[1][2]
    return None


def _detect_month_name(msg):
    months = ["jan","january","feb","february","mar","march","apr","april","may",
              "jun","june","jul","july","aug","august","sep","sept","september",
              "oct","october","nov","november","dec","december"]
    for m in months:
        if re.search(r'\b' + m + r'\b', msg):
            return True
    return False


def extract_date_range(msg):
    today = datetime.utcnow()
    month_names = {
        "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
        "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
        "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
        "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
    }

    detected_month = None
    for name, num in sorted(month_names.items(), key=lambda x: -len(x[0])):
        if re.search(r'\b' + name + r'\b', msg):
            detected_month = num
            break

    if detected_month:
        year_match = re.search(r'\b(20\d{2})\b', msg)
        year     = int(year_match.group(1)) if year_match else (today.year if detected_month <= today.month else today.year - 1)
        last_day = calendar.monthrange(year, detected_month)[1]
        if year == today.year and detected_month == today.month:
            return f"{year}-{detected_month:02d}-01", today.strftime("%Y-%m-%d")
        return f"{year}-{detected_month:02d}-01", f"{year}-{detected_month:02d}-{last_day:02d}"

    if "today" in msg:
        d = today.strftime("%Y-%m-%d"); return d, d
    if "yesterday" in msg:
        d = (today - timedelta(days=1)).strftime("%Y-%m-%d"); return d, d
    if "this week" in msg:
        return (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if "last week" in msg:
        return (today - timedelta(days=today.weekday()+7)).strftime("%Y-%m-%d"), (today - timedelta(days=today.weekday()+1)).strftime("%Y-%m-%d")
    if "this month" in msg:
        return today.replace(day=1).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if "last month" in msg:
        prev = today.replace(day=1) - timedelta(days=1)
        return prev.replace(day=1).strftime("%Y-%m-%d"), prev.strftime("%Y-%m-%d")
    if re.search(r'last\s*7\s*days|past\s*week', msg):
        return (today - timedelta(days=7)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if re.search(r'last\s*14\s*days|past\s*2\s*weeks|2\s*weeks', msg):
        return (today - timedelta(days=14)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if re.search(r'last\s*30\s*days|past\s*month', msg):
        return (today - timedelta(days=30)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if re.search(r'last\s*60\s*days|2\s*months', msg):
        return (today - timedelta(days=60)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if re.search(r'last\s*90\s*days|3\s*months|quarter', msg):
        return (today - timedelta(days=90)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")

    dates = re.findall(r'\d{4}-\d{2}-\d{2}', msg)
    if len(dates) >= 2: return dates[0], dates[1]
    if len(dates) == 1: return dates[0], today.strftime("%Y-%m-%d")

    return None, None


# ═══════════════════════════════════════════════════════════════════════════════
# OLLAMA FALLBACK — now queries real data before calling LLM
# ═══════════════════════════════════════════════════════════════════════════════

def ollama_response(message, tenant_id=None):
    try:
        stats    = get_stats()
        today    = datetime.utcnow()
        date_from, date_to = extract_date_range(message.lower())
        cloud    = detect_cloud(message.lower())

        # Pull real data to give Ollama actual numbers
        summary  = get_summary("service_name", date_from, date_to, cloud_provider=cloud)
        total    = sum(r["total_cost"] for r in summary)
        top5     = summary[:5]
        top5_text = "\n".join([f"  - {s['service_name']}: ${s['total_cost']:,.2f}" for s in top5])

        try:
            from database import get_db
            conn = get_db()
            cloud_rows = conn.execute(
                "SELECT cloud_provider, SUM(cost) as total FROM cost_data GROUP BY cloud_provider"
            ).fetchall()
            conn.close()
            cloud_text = ", ".join([f"{r['cloud_provider'].upper()}: ${r['total']:,.2f}" for r in cloud_rows])
        except Exception:
            cloud_text = f"Total: ${stats.get('total_cost', 0):,.2f}"

        period_text = f"{date_from} to {date_to}" if date_from else f"{stats.get('date_range_from')} to {stats.get('date_range_to')}"
        cloud_text2 = f" for {cloud.upper()}" if cloud else ""

        prompt = f"""You are a helpful multi-cloud cost assistant (Azure, AWS, GCP). Today: {today.strftime('%Y-%m-%d')}.

REAL DATA{cloud_text2} for {period_text}:
- Total cost: ${total:,.2f}
- By cloud: {cloud_text}
- Top services:
{top5_text}

Overall data range: {stats.get('date_range_from')} to {stats.get('date_range_to')}

User asks: "{message}"

Answer using the real data above. Be concise (under 150 words). Use **bold** for numbers and key terms.
If the question cannot be answered from this data, say so clearly and suggest a better question."""

        resp = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
                "options": {"temperature": 0.2, "num_predict": 250}
            },
            timeout=30
        )
        resp.raise_for_status()
        reply = resp.json()["message"]["content"].strip()
        return {"reply": reply}

    except Exception:
        # Last resort: answer from data without LLM
        try:
            date_from, date_to = extract_date_range(message.lower())
            cloud = detect_cloud(message.lower())
            data  = get_summary("service_name", date_from, date_to, cloud_provider=cloud)
            total = sum(r["total_cost"] for r in data)
            top5  = data[:5]
            period = f"({date_from} to {date_to})" if date_from else "(all time)"
            cloud_label = f" [{cloud.upper()}]" if cloud else ""
            breakdown = "\n".join([f"  - **{s['service_name']}**: ${s['total_cost']:,.2f}" for s in top5])
            return {
                "reply": f"**Total cost{cloud_label} {period}: ${total:,.2f}**\n\nTop services:\n{breakdown}\n\n_Tip: Try asking more specifically, e.g. \"AWS EC2 cost in March\"_"
            }
        except Exception:
            return {
                "reply": (
                    "I couldn't process that query. Try:\n"
                    "  - \"AWS cost in March\"\n"
                    "  - \"GCP translate spend last month\"\n"
                    "  - \"Compare Azure vs AWS costs\"\n"
                    "  - \"Top 5 services last 30 days\"\n"
                    "  - Type **help** for all options."
                )
            }
