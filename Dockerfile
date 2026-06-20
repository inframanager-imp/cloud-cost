FROM python:3.10-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_PROGRESS_BAR=off

COPY requirements.txt .
RUN pip install --no-cache-dir --progress-bar off -r requirements.txt

# .env is NOT baked into the image — supply it via docker-compose env_file or EC2 env vars
COPY app.py cost_sync_runner.py activity_sync_runner.py config_sync_runner.py resource_config_display.py \
     database.py azure_fetcher.py aws_fetcher.py gcp_fetcher.py atlassian_fetcher.py cur_importer.py chatbot.py email_report.py \
     slack_notifier.py budget_manager.py tenant_isolation_audit.py currency.py gunicorn_conf.py ./
COPY templates/ templates/
COPY static/ static/

RUN mkdir -p /app/data

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/login', timeout=4)" || exit 1

CMD ["gunicorn", "-c", "/app/gunicorn_conf.py", "app:app"]
