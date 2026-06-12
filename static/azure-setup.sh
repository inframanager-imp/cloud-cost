#!/bin/bash
# Cloud Cost Analyzer — Azure One-Click Setup
# Usage: curl -sLk https://finops.prismxai.com/static/azure-setup.sh | bash -s -- --token TOKEN --tool-url URL

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
echo -e "${BOLD}   Cloud Cost Analyzer — Azure Setup Script${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""

# ── Check Azure CLI ───────────────────────────────────────────────────────────
if ! command -v az &> /dev/null; then
    echo -e "${RED}ERROR: Azure CLI not found.${NC}"
    echo "Install: https://learn.microsoft.com/cli/azure/install-azure-cli"
    exit 1
fi

ACCOUNT_JSON=$(az account show 2>/dev/null) || {
    echo -e "${RED}ERROR: Azure CLI not logged in. Run 'az login' first.${NC}"
    exit 1
}
SUBSCRIPTION_ID=$(echo "$ACCOUNT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
SUBSCRIPTION_NAME=$(echo "$ACCOUNT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
AZURE_TENANT_ID=$(echo "$ACCOUNT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['tenantId'])")

echo -e "${GREEN}✓ Azure subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)${NC}"
[ -n "$SETUP_TOKEN" ] && echo -e "${GREEN}✓ Setup token: ${SETUP_TOKEN:0:8}...${NC}"
echo ""

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="finops-cost-reader-${SUBSCRIPTION_ID:0:8}"

# ── Step 1: App Registration ─────────────────────────────────────────────────
echo -e "[1/3] Creating app registration: ${BOLD}$APP_NAME${NC}"
EXISTING_APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv 2>/dev/null)
if [ -n "$EXISTING_APP_ID" ]; then
    CLIENT_ID="$EXISTING_APP_ID"
    echo -e "      ${YELLOW}→ Already exists${NC}"
else
    CLIENT_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
    echo -e "      ${GREEN}✓ Created${NC}"
fi

# Ensure a service principal exists for the app
az ad sp create --id "$CLIENT_ID" > /dev/null 2>&1 || true

# ── Step 2: Client Secret ────────────────────────────────────────────────────
echo -e "[2/3] Generating client secret"
CLIENT_SECRET=$(az ad app credential reset --id "$CLIENT_ID" --append --years 2 --query password -o tsv)
echo -e "      ${GREEN}✓ Secret generated${NC}"

# ── Step 3: Role Assignment ──────────────────────────────────────────────────
echo -e "[3/3] Assigning 'Cost Management Reader' + 'Reader' roles on subscription"
az role assignment create --assignee "$CLIENT_ID" --role "Cost Management Reader" \
    --scope "/subscriptions/${SUBSCRIPTION_ID}" > /dev/null 2>&1 && \
    echo -e "      ${GREEN}✓ Cost Management Reader assigned${NC}" || \
    echo -e "      ${YELLOW}→ Cost Management Reader may already be assigned${NC}"

az role assignment create --assignee "$CLIENT_ID" --role "Reader" \
    --scope "/subscriptions/${SUBSCRIPTION_ID}" > /dev/null 2>&1 && \
    echo -e "      ${GREEN}✓ Reader assigned${NC}" || \
    echo -e "      ${YELLOW}→ Reader may already be assigned${NC}"

# ── Callback to tool (auto-save) ─────────────────────────────────────────────
if [ -n "$SETUP_TOKEN" ] && [ -n "$TOOL_URL" ]; then
    echo ""
    echo -e "Connecting to your tool..."
    CALLBACK_RESP=$(curl -sk -X POST "${TOOL_URL}/api/azure/auto-connect" \
        -H "Content-Type: application/json" \
        -d "{
            \"token\":           \"${SETUP_TOKEN}\",
            \"azure_tenant_id\": \"${AZURE_TENANT_ID}\",
            \"client_id\":       \"${CLIENT_ID}\",
            \"client_secret\":   \"${CLIENT_SECRET}\",
            \"subscription_id\": \"${SUBSCRIPTION_ID}\",
            \"name\":            \"${SUBSCRIPTION_NAME}\"
        }" 2>/dev/null)

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
echo -e "  ${BOLD}Subscription ID :${NC} $SUBSCRIPTION_ID"
echo -e "  ${BOLD}Azure Tenant ID :${NC} $AZURE_TENANT_ID"
echo -e "  ${BOLD}Client (App) ID :${NC} $CLIENT_ID"
echo -e "  ${BOLD}Client Secret   :${NC} $CLIENT_SECRET"
echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "  ${GREEN}Cost Management data is usually available within minutes.${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""
