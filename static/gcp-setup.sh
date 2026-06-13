#!/bin/bash
# Cloud Cost Analyzer — GCP One-Click Setup
# Usage: curl -sLk https://finops.prismxai.com/static/gcp-setup.sh | bash -s -- --token TOKEN --tool-url URL

set -e

# ── Parse arguments ───────────────────────────────────────────────────────────
SETUP_TOKEN=""
TOOL_URL=""
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --token)     SETUP_TOKEN="$2"; shift ;;
        --tool-url)  TOOL_URL="$2";    shift ;;
    esac
    shift
done

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "${BOLD}   Cloud Cost Analyzer — GCP Setup Script${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""

# ── Check gcloud CLI ──────────────────────────────────────────────────────────
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}ERROR: gcloud CLI not found.${NC}"
    echo "Install: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" == "(unset)" ]; then
    echo -e "${RED}ERROR: No active gcloud project. Run 'gcloud config set project PROJECT_ID' first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ GCP project: $PROJECT_ID${NC}"
[ -n "$SETUP_TOKEN" ] && echo -e "${GREEN}✓ Setup token: ${SETUP_TOKEN:0:8}...${NC}"
echo ""

# ── Config ────────────────────────────────────────────────────────────────────
SA_NAME="finops-cost-reader"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE=$(mktemp /tmp/finops-sa-key-XXXXXX.json)

# ── Step 1: Enable required APIs ─────────────────────────────────────────────
echo -e "[1/4] Enabling required APIs (BigQuery, Cloud Billing)"
gcloud services enable bigquery.googleapis.com cloudbilling.googleapis.com logging.googleapis.com --project "$PROJECT_ID" > /dev/null 2>&1 \
    && echo -e "      ${GREEN}✓ APIs enabled${NC}" \
    || echo -e "      ${YELLOW}→ Could not enable APIs (may already be enabled)${NC}"

# ── Step 2: Service Account ──────────────────────────────────────────────────
echo -e "[2/4] Creating service account: ${BOLD}$SA_EMAIL${NC}"
if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" &>/dev/null; then
    echo -e "      ${YELLOW}→ Already exists${NC}"
else
    gcloud iam service-accounts create "$SA_NAME" \
        --display-name="FinOps Cost Reader" \
        --project "$PROJECT_ID" > /dev/null
    echo -e "      ${GREEN}✓ Created${NC}"
fi

# ── Step 3: Role bindings ────────────────────────────────────────────────────
echo -e "[3/4] Granting BigQuery roles on project"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/bigquery.dataViewer" > /dev/null 2>&1 \
    && echo -e "      ${GREEN}✓ BigQuery Data Viewer assigned${NC}" \
    || echo -e "      ${YELLOW}→ BigQuery Data Viewer may already be assigned${NC}"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/bigquery.jobUser" > /dev/null 2>&1 \
    && echo -e "      ${GREEN}✓ BigQuery Job User assigned${NC}" \
    || echo -e "      ${YELLOW}→ BigQuery Job User may already be assigned${NC}"

# Logs Viewer — needed to read Admin Activity audit logs (Cloud Logging API)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/logging.viewer" > /dev/null 2>&1 \
    && echo -e "      ${GREEN}✓ Logs Viewer assigned${NC}" \
    || echo -e "      ${YELLOW}→ Logs Viewer may already be assigned${NC}"

# Try to grant Billing Account Viewer (best-effort — requires billing IAM admin permission)
BILLING_ACCOUNT=$(gcloud beta billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null | sed 's#billingAccounts/##')
if [ -n "$BILLING_ACCOUNT" ]; then
    gcloud beta billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
        --member="serviceAccount:${SA_EMAIL}" \
        --role="roles/billing.viewer" > /dev/null 2>&1 \
        && echo -e "      ${GREEN}✓ Billing Account Viewer assigned${NC}" \
        || echo -e "      ${YELLOW}→ Could not assign Billing Account Viewer (may need billing admin)${NC}"
fi

# ── Step 4: Service account key ──────────────────────────────────────────────
echo -e "[4/4] Generating service account key"

KEY_POLICY_CONSTRAINT="constraints/iam.disableServiceAccountKeyCreation"

_create_key() {
    gcloud iam service-accounts keys create "$KEY_FILE" \
        --iam-account="$SA_EMAIL" --project "$PROJECT_ID" 2>/tmp/finops_keyerr
}

if ! _create_key; then
    if grep -qi "disableServiceAccountKeyCreation\|Key creation is not allowed" /tmp/finops_keyerr; then
        echo -e "      ${YELLOW}→ Key creation blocked by org policy — overriding it for this project...${NC}"
        if gcloud resource-manager org-policies disable-enforce \
                "$KEY_POLICY_CONSTRAINT" --project "$PROJECT_ID" > /dev/null 2>&1; then
            echo -e "      ${GREEN}✓ Org policy override applied — retrying (policy can take ~1 min to propagate)${NC}"
            KEY_OK=""
            for attempt in 1 2 3 4 5 6; do
                sleep 15
                if _create_key; then KEY_OK="yes"; break; fi
                echo -e "      ${YELLOW}→ Not propagated yet (attempt ${attempt}/6)...${NC}"
            done
            if [ -z "$KEY_OK" ]; then
                echo -e "      ${RED}✗ Still blocked after override — the policy change may need a few more minutes.${NC}"
                echo -e "${YELLOW}Re-run this exact command shortly; the override and service account persist.${NC}"
                rm -f /tmp/finops_keyerr; exit 1
            fi
        else
            echo -e "      ${RED}✗ Could not override the org policy (needs the Organization Policy Administrator role).${NC}"
            echo ""
            echo -e "${BOLD}-------------------------------------------------------${NC}"
            echo -e "${YELLOW}Ask an org/project admin to run this once, then re-run this command:${NC}"
            echo -e "  ${BOLD}gcloud resource-manager org-policies disable-enforce \\\\${NC}"
            echo -e "  ${BOLD}    ${KEY_POLICY_CONSTRAINT} --project=${PROJECT_ID}${NC}"
            echo -e "${BOLD}-------------------------------------------------------${NC}"
            rm -f /tmp/finops_keyerr; exit 1
        fi
    else
        echo -e "      ${RED}✗ Key creation failed:${NC}"
        cat /tmp/finops_keyerr
        rm -f /tmp/finops_keyerr; exit 1
    fi
fi
rm -f /tmp/finops_keyerr
echo -e "      ${GREEN}✓ Key generated${NC}"

# ── Billing export dataset ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}-------------------------------------------------------${NC}"
echo -e "${YELLOW}IMPORTANT: BigQuery Billing Export${NC}"
echo -e "${BOLD}-------------------------------------------------------${NC}"
echo "For cost data to appear, Billing Export to BigQuery must be enabled"
echo "(one-time, manual step in the GCP Console):"
echo ""
echo "  Billing -> Billing export -> BigQuery export -> Edit settings"
echo "  -> select a dataset and enable 'Standard usage cost' export."
echo ""
echo "If you've already done this, enter the dataset and table name below"
echo "(table name usually looks like gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX)."
echo "Leave blank to skip for now — you can add this later in the tool."
echo ""
# Read from the terminal, not stdin. This script is itself piped into bash via
# 'curl | bash', so stdin carries the script — a bare `read` would consume the
# next script line instead of the user's input. /dev/tty targets the terminal.
BQ_DATASET=""
BQ_TABLE=""
if [ -r /dev/tty ]; then
    read -r -p "BigQuery dataset name [skip]: " BQ_DATASET < /dev/tty || BQ_DATASET=""
    read -r -p "BigQuery table name [skip]: "   BQ_TABLE   < /dev/tty || BQ_TABLE=""
else
    echo "(no terminal detected — skipping; add the dataset/table in the tool later)"
fi

# ── Callback to tool (auto-save) ─────────────────────────────────────────────
SA_JSON=$(cat "$KEY_FILE")
if [ -n "$SETUP_TOKEN" ] && [ -n "$TOOL_URL" ]; then
    echo ""
    echo -e "Connecting to your tool..."
    CALLBACK_RESP=$(curl -sk -X POST "${TOOL_URL}/api/gcp/auto-connect" \
        -H "Content-Type: application/json" \
        -d "$(python3 - "$SETUP_TOKEN" "$PROJECT_ID" "$BQ_DATASET" "$BQ_TABLE" "$KEY_FILE" <<'PYEOF'
import sys, json
token, project_id, dataset, table, key_file = sys.argv[1:6]
with open(key_file) as f:
    sa_json = json.load(f)
print(json.dumps({
    "token": token,
    "project_id": project_id,
    "dataset": dataset,
    "table": table,
    "service_account_json": sa_json,
    "name": project_id,
}))
PYEOF
)" 2>/dev/null)

    if echo "$CALLBACK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
        echo -e "${GREEN}${BOLD}✅ Auto-connected to your tool!${NC}"
        echo -e "   Go back to your browser — the account is now active."
    else
        echo -e "${YELLOW}⚠ Could not auto-connect. Use the credentials below to connect manually.${NC}"
    fi
fi

# ── Always print credentials ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "${GREEN}${BOLD}   Setup Complete!${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""
echo -e "  ${BOLD}Project ID         :${NC} $PROJECT_ID"
echo -e "  ${BOLD}Service Account    :${NC} $SA_EMAIL"
echo -e "  ${BOLD}BigQuery Dataset   :${NC} ${BQ_DATASET:-<not set>}"
echo -e "  ${BOLD}BigQuery Table     :${NC} ${BQ_TABLE:-<not set>}"
echo -e "  ${BOLD}Key file (local)   :${NC} $KEY_FILE"
echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "  ${GREEN}Cost data will be available once Billing Export${NC}"
echo -e "  ${GREEN}to BigQuery is enabled and data has populated.${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""

# Clean up local key file (already sent to tool)
rm -f "$KEY_FILE"
