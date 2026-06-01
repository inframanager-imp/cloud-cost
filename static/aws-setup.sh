#!/bin/bash
# Cloud Cost Analyzer — AWS One-Click Setup
# Run: curl -sLk https://finops.prismxai.com/static/aws-setup.sh | bash

set -e

# Colors
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "${BOLD}   Cloud Cost Analyzer — AWS Setup Script${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}ERROR: AWS CLI not found. Install it from https://aws.amazon.com/cli/${NC}"
    exit 1
fi

# Check AWS credentials
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
if [ -z "$ACCOUNT_ID" ]; then
    echo -e "${RED}ERROR: AWS CLI not configured. Run 'aws configure' first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ AWS account detected: $ACCOUNT_ID${NC}"
echo ""

# Config
USER_NAME="finops-cost-api"
BUCKET_NAME="finops-cur-${ACCOUNT_ID}"
REPORT_NAME="finops-daily"
PREFIX="cur"
REGION="us-east-1"

# ── Step 1: IAM User ──────────────────────────────────────────────────────────
echo -e "[1/5] Creating IAM user: ${BOLD}$USER_NAME${NC}"
aws iam create-user --user-name "$USER_NAME" > /dev/null 2>&1 && \
    echo -e "      ${GREEN}✓ Created${NC}" || \
    echo -e "      ${YELLOW}→ Already exists, continuing${NC}"

# ── Step 2: IAM Policy ───────────────────────────────────────────────────────
echo -e "[2/5] Attaching read-only cost policy"
POLICY_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CostBillingAccess",
      "Effect": "Allow",
      "Action": ["ce:*", "cur:DescribeReportDefinitions", "budgets:ViewBudget"],
      "Resource": "*"
    },
    {
      "Sid": "S3CURAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": "*"
    },
    {
      "Sid": "ResourceDiscovery",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*", "rds:Describe*",
        "elasticloadbalancing:Describe*",
        "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
        "organizations:Describe*", "organizations:List*",
        "savingsplans:Describe*"
      ],
      "Resource": "*"
    }
  ]
}'
aws iam put-user-policy \
    --user-name "$USER_NAME" \
    --policy-name "FinOpsCostAnalyzerPolicy" \
    --policy-document "$POLICY_DOC" > /dev/null 2>&1
echo -e "      ${GREEN}✓ Policy attached${NC}"

# ── Step 3: Access Keys ──────────────────────────────────────────────────────
echo -e "[3/5] Generating access keys"

# Remove old keys if limit reached (max 2 per user)
KEY_COUNT=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text 2>/dev/null || echo "0")
if [ "$KEY_COUNT" -ge 2 ]; then
    OLD_KEY=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[0].AccessKeyId' --output text)
    aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$OLD_KEY" > /dev/null 2>&1
    echo -e "      ${YELLOW}→ Removed old key to make room${NC}"
fi

KEYS_JSON=$(aws iam create-access-key --user-name "$USER_NAME")
ACCESS_KEY=$(echo "$KEYS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
SECRET_KEY=$(echo "$KEYS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")
echo -e "      ${GREEN}✓ Keys generated${NC}"

# ── Step 4: S3 Bucket ────────────────────────────────────────────────────────
echo -e "[4/5] Creating S3 bucket: ${BOLD}$BUCKET_NAME${NC}"
if aws s3api head-bucket --bucket "$BUCKET_NAME" > /dev/null 2>&1; then
    echo -e "      ${YELLOW}→ Bucket already exists, skipping${NC}"
else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" > /dev/null 2>&1
    echo -e "      ${GREEN}✓ Bucket created${NC}"
fi

# Block public access
aws s3api put-public-access-block \
    --bucket "$BUCKET_NAME" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
    > /dev/null 2>&1

# Bucket policy — allow CUR service to write
BUCKET_POLICY="{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {
      \"Sid\": \"AllowCURGetBucketACL\",
      \"Effect\": \"Allow\",
      \"Principal\": {\"Service\": \"billingreports.amazonaws.com\"},
      \"Action\": [\"s3:GetBucketAcl\", \"s3:GetBucketPolicy\"],
      \"Resource\": \"arn:aws:s3:::${BUCKET_NAME}\"
    },
    {
      \"Sid\": \"AllowCURPutObject\",
      \"Effect\": \"Allow\",
      \"Principal\": {\"Service\": \"billingreports.amazonaws.com\"},
      \"Action\": \"s3:PutObject\",
      \"Resource\": \"arn:aws:s3:::${BUCKET_NAME}/*\"
    }
  ]
}"
aws s3api put-bucket-policy --bucket "$BUCKET_NAME" --policy "$BUCKET_POLICY" > /dev/null 2>&1
echo -e "      ${GREEN}✓ Bucket policy set${NC}"

# ── Step 5: CUR Report ───────────────────────────────────────────────────────
echo -e "[5/5] Creating CUR report: ${BOLD}$REPORT_NAME${NC}"
REPORT_DEF="{
  \"ReportName\": \"${REPORT_NAME}\",
  \"TimeUnit\": \"DAILY\",
  \"Format\": \"textORcsv\",
  \"Compression\": \"GZIP\",
  \"AdditionalSchemaElements\": [\"RESOURCES\"],
  \"S3Bucket\": \"${BUCKET_NAME}\",
  \"S3Prefix\": \"${PREFIX}\",
  \"S3Region\": \"${REGION}\",
  \"RefreshClosedReports\": true,
  \"ReportVersioning\": \"OVERWRITE_REPORT\"
}"
aws cur put-report-definition \
    --report-definition "$REPORT_DEF" \
    --region us-east-1 > /dev/null 2>&1 && \
    echo -e "      ${GREEN}✓ CUR report created${NC}" || \
    echo -e "      ${YELLOW}→ CUR report may already exist${NC}"

# ── Output ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "${GREEN}${BOLD}   ✅ Setup Complete! Paste these into your tool:${NC}"
echo -e "${BOLD}=======================================================${NC}"
echo ""
echo -e "  ${BOLD}AWS Account ID :${NC} $ACCOUNT_ID"
echo -e "  ${BOLD}Access Key ID  :${NC} $ACCESS_KEY"
echo -e "  ${BOLD}Secret Key     :${NC} $SECRET_KEY"
echo -e "  ${BOLD}Region         :${NC} $REGION"
echo ""
echo -e "  ${BOLD}── For CUR Setup (Step 3) ──────────────────${NC}"
echo -e "  ${BOLD}S3 Bucket      :${NC} $BUCKET_NAME"
echo -e "  ${BOLD}S3 Prefix      :${NC} $PREFIX"
echo -e "  ${BOLD}Report Name    :${NC} $REPORT_NAME"
echo ""
echo -e "${BOLD}=======================================================${NC}"
echo -e "  Go to: Cloud Providers → Add AWS → paste values above"
echo -e "  CUR data appears after ${YELLOW}24-48 hours${NC} (first delivery)"
echo -e "${BOLD}=======================================================${NC}"
echo ""
