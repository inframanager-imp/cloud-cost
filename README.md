# Cloud Cost Analyzer

Multi-cloud cost management platform supporting **Azure**, **AWS**, and **GCP** with dashboards, budget alerts, email reports, and Jira integration.

---

## Quick Start (Docker — any Ubuntu VM / EC2)

### 1. Prerequisites

```bash
# Install Docker & Docker Compose (Ubuntu 22.04 / 24.04)
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER   # log out and back in after this
```

### 2. Clone & Configure

```bash
git clone https://github.com/<your-org>/cloud-cost-analyzer.git
cd cloud-cost-analyzer

# Create your environment file from the template
cp env.example .env
nano .env          # fill in your credentials (see Configuration below)
```

### 3. Run

```bash
docker compose up -d --build
```

App is now running at **http://your-server-ip:5000**

---

## EC2 Security Group

Open the following inbound ports:

| Port | Protocol | Purpose              |
|------|----------|----------------------|
| 22   | TCP      | SSH                  |
| 5000 | TCP      | App (or use Nginx)   |
| 80   | TCP      | Nginx HTTP (optional)|
| 443  | TCP      | Nginx HTTPS (optional)|

---

## Configuration (`.env`)

Copy `env.example` to `.env` and set:

| Variable | Required | Description |
|---|---|---|
| `FLASK_SECRET_KEY` | ✅ | Random secret string for sessions |
| `ADMIN_USERNAME` | ✅ | Login username |
| `ADMIN_PASSWORD` | ✅ | Login password |
| `AZURE_TENANT_ID` | Azure only | Azure AD tenant |
| `AZURE_CLIENT_ID` | Azure only | Service principal app ID |
| `AZURE_CLIENT_SECRET` | Azure only | Service principal secret |
| `AZURE_SUBSCRIPTION_ID` | Azure only | Default subscription |
| `DB_PATH` | ✅ | `/app/data/azure_costs.db` |
| `AUTO_SYNC_ENABLED` | — | `true` to sync costs on schedule |
| `AUTO_SYNC_INTERVAL_HOURS` | — | Hours between syncs (default `6`) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` | Email | For cost report emails |
| `OLLAMA_ENABLED` | — | `true` to enable AI chatbot |

---

## Useful Commands

```bash
# View logs
docker compose logs -f

# Restart
docker compose restart

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Shell into container
docker exec -it azure-cost-analyzer bash
```

---

## Optional: Nginx Reverse Proxy (HTTPS)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# /etc/nginx/sites-available/cloud-cost-analyzer
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120;
    }
}

sudo ln -s /etc/nginx/sites-available/cloud-cost-analyzer /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Free HTTPS via Let's Encrypt
sudo certbot --nginx -d yourdomain.com
```

---

## Recommended EC2 Instance Size

| Accounts | Instance | Notes |
|---|---|---|
| 1–5 | `t3.small` (2 vCPU, 2 GB) | Set `SYNC_SEQUENTIAL=true` |
| 5–20 | `t3.medium` (2 vCPU, 4 GB) | Default settings |
| 20+ | `t3.large` (2 vCPU, 8 GB) | Enable multi-threading |

---

## Data Persistence

The SQLite database is stored in `./data/` on the host (mounted as a Docker volume). Back it up with:

```bash
cp ./data/azure_costs.db ./data/azure_costs.db.bak
```
