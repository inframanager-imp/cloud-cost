#!/bin/bash
echo "================================="
echo "  Azure Cost Analyzer - Startup"
echo "================================="

cd "$(dirname "$0")"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python3 is not installed."
    exit 1
fi

# Create virtual environment if not exists
if [ ! -d "venv" ]; then
    echo "[*] Creating virtual environment..."
    python3 -m venv venv
fi

# Activate
source venv/bin/activate

# Install dependencies
echo "[*] Installing dependencies..."
pip install -r requirements.txt --quiet

# Initialize database
echo "[*] Initializing database..."
python3 database.py

# Start sync runners
echo "[*] Starting config sync runner in background..."
nohup python3 config_sync_runner.py > /dev/null 2>&1 &

# Start app
echo ""
echo "================================="
echo "  Starting on http://0.0.0.0:5000"
echo "================================="
echo ""
python3 app.py
