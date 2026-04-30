import os
import sys
import json
import time
from datetime import datetime

from dotenv import load_dotenv

load_dotenv()

from azure.identity import ClientSecretCredential, DefaultAzureCredential
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest

from database import init_db, get_subscriptions, upsert_resource_configs

TENANT_ID = os.getenv("AZURE_TENANT_ID")
CLIENT_ID = os.getenv("AZURE_CLIENT_ID")
CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET")


def _credential():
    """Use service principal from .env (same as Cost API); fallback to DefaultAzureCredential."""
    if TENANT_ID and CLIENT_ID and CLIENT_SECRET:
        return ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET)
    return DefaultAzureCredential(exclude_interactive_browser_credential=True)


def sync_configs():
    print(f"[{datetime.utcnow().isoformat()}] Starting resource configuration sync...")
    init_db()

    subs = get_subscriptions(enabled_only=True)
    if not subs:
        print("No enabled subscriptions to sync configs for.")
        return

    sub_ids = [s["subscription_id"] for s in subs]

    try:
        credential = _credential()
        rg_client = ResourceGraphClient(credential)

        query = """
        Resources
        | where type in (
            'microsoft.compute/virtualmachines',
            'microsoft.compute/disks',
            'microsoft.sql/servers/databases',
            'microsoft.dbforpostgresql/servers',
            'microsoft.dbforpostgresql/flexibleservers',
            'microsoft.dbformysql/servers',
            'microsoft.dbformysql/flexibleservers',
            'microsoft.dbformariadb/servers',
            'microsoft.web/sites',
            'microsoft.web/serverfarms',
            'microsoft.storage/storageaccounts',
            'microsoft.cache/redis',
            'microsoft.containerservice/managedclusters',
            'microsoft.network/loadbalancers',
            'microsoft.network/applicationgateways',
            'microsoft.keyvault/vaults',
            'microsoft.servicebus/namespaces',
            'microsoft.eventhub/namespaces',
            'microsoft.cognitiveservices/accounts',
            'microsoft.search/searchservices'
          )
        | extend power_state = case(
            type == 'microsoft.compute/virtualmachines',
                tostring(properties.extended.instanceView.powerState.displayStatus),
            type == 'microsoft.compute/disks',
                tostring(properties.diskState),
            type == 'microsoft.sql/servers/databases',
                tostring(properties.status),
            type in ('microsoft.dbforpostgresql/servers', 'microsoft.dbformysql/servers', 'microsoft.dbformariadb/servers'),
                tostring(properties.userVisibleState),
            type in ('microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers'),
                tostring(properties.state),
            type == 'microsoft.web/sites',
                tostring(properties.state),
            type == 'microsoft.web/serverfarms',
                tostring(properties.status),
            type == 'microsoft.cache/redis',
                tostring(properties.provisioningState),
            type == 'microsoft.containerservice/managedclusters',
                tostring(properties.powerState.code),
            tostring(properties.provisioningState)
          )
        | project subscriptionId, resourceGroup, type, name, location, sku, properties, power_state
        """

        request = QueryRequest(subscriptions=sub_ids, query=query)
        response = rg_client.resources(request)
        data = response.data

        configs = []
        for row in data:
            sku = row.get("sku")
            if isinstance(sku, dict):
                sku_name = sku.get("name")
            else:
                sku_name = row.get("sku_name")

            props = row.get("properties")
            if props is None:
                props = {}
            elif not isinstance(props, dict):
                props = {"value": props}

            configs.append(
                {
                    "subscription_id": row.get("subscriptionId"),
                    "resource_group": row.get("resourceGroup"),
                    "resource_type": row.get("type"),
                    "resource_name": row.get("name"),
                    "location": row.get("location"),
                    "sku_name": sku_name,
                    "config_json": props,
                    "power_state": row.get("power_state") or "",
                }
            )

        if configs:
            count = upsert_resource_configs(configs)
            print(f"Upserted {len(configs)} configuration row(s) ({count} DB changes).")
        else:
            print("No matching configurations found from Resource Graph.")

    except Exception as e:
        print(f"Error syncing configs: {e}")
        raise

    print(f"[{datetime.utcnow().isoformat()}] Config sync complete.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "daemon":
        interval = int(os.getenv("CONFIG_SYNC_INTERVAL_SECS", "86400"))
        while True:
            try:
                sync_configs()
            except Exception:
                pass
            time.sleep(interval)
    else:
        sync_configs()
