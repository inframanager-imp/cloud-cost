"""
Human-readable VM / disk specs from ARM properties (Resource Graph / resource_configs.config_json).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# Common Azure VM sizes: (vCPUs, RAM GiB). Extend as needed.
VM_SIZE_SPECS: Dict[str, Tuple[int, float]] = {
    # Burstable B
    "Standard_B1ls": (1, 0.5),
    "Standard_B1ms": (1, 2.0),
    "Standard_B1s": (1, 1.0),
    "Standard_B2ms": (2, 8.0),
    "Standard_B2s": (2, 4.0),
    "Standard_B4ms": (4, 16.0),
    "Standard_B8ms": (8, 32.0),
    "Standard_B12ms": (12, 48.0),
    "Standard_B16ms": (16, 64.0),
    "Standard_B20ms": (20, 80.0),
    # General purpose Dsv3–v5 (2–64 vCPU, 4 GiB per vCPU typical)
    "Standard_D2s_v3": (2, 8.0),
    "Standard_D4s_v3": (4, 16.0),
    "Standard_D8s_v3": (8, 32.0),
    "Standard_D16s_v3": (16, 64.0),
    "Standard_D32s_v3": (32, 128.0),
    "Standard_D48s_v3": (48, 192.0),
    "Standard_D64s_v3": (64, 256.0),
    "Standard_D2s_v4": (2, 8.0),
    "Standard_D4s_v4": (4, 16.0),
    "Standard_D8s_v4": (8, 32.0),
    "Standard_D16s_v4": (16, 64.0),
    "Standard_D32s_v4": (32, 128.0),
    "Standard_D48s_v4": (48, 192.0),
    "Standard_D64s_v4": (64, 256.0),
    "Standard_D2s_v5": (2, 8.0),
    "Standard_D4s_v5": (4, 16.0),
    "Standard_D8s_v5": (8, 32.0),
    "Standard_D16s_v5": (16, 64.0),
    "Standard_D32s_v5": (32, 128.0),
    "Standard_D48s_v5": (48, 192.0),
    "Standard_D64s_v5": (64, 256.0),
    "Standard_D96s_v5": (96, 384.0),
    # D with local temp (ds)
    "Standard_D2ds_v4": (2, 8.0),
    "Standard_D4ds_v4": (4, 16.0),
    "Standard_D8ds_v4": (8, 32.0),
    "Standard_D16ds_v4": (16, 64.0),
    "Standard_D32ds_v4": (32, 128.0),
    "Standard_D48ds_v4": (48, 192.0),
    "Standard_D64ds_v4": (64, 256.0),
    "Standard_D2ds_v5": (2, 8.0),
    "Standard_D4ds_v5": (4, 16.0),
    "Standard_D8ds_v5": (8, 32.0),
    "Standard_D16ds_v5": (16, 64.0),
    "Standard_D32ds_v5": (32, 128.0),
    "Standard_D48ds_v5": (48, 192.0),
    "Standard_D64ds_v5": (64, 256.0),
    # Memory-optimized Esv3 / Esv4 / Esv5
    "Standard_E2s_v3": (2, 16.0),
    "Standard_E4s_v3": (4, 32.0),
    "Standard_E8s_v3": (8, 64.0),
    "Standard_E16s_v3": (16, 128.0),
    "Standard_E20s_v3": (20, 160.0),
    "Standard_E32s_v3": (32, 256.0),
    "Standard_E48s_v3": (48, 384.0),
    "Standard_E64s_v3": (64, 432.0),
    "Standard_E2s_v4": (2, 16.0),
    "Standard_E4s_v4": (4, 32.0),
    "Standard_E8s_v4": (8, 64.0),
    "Standard_E16s_v4": (16, 128.0),
    "Standard_E20s_v4": (20, 160.0),
    "Standard_E32s_v4": (32, 256.0),
    "Standard_E48s_v4": (48, 384.0),
    "Standard_E64s_v4": (64, 504.0),
    "Standard_E2s_v5": (2, 16.0),
    "Standard_E4s_v5": (4, 32.0),
    "Standard_E8s_v5": (8, 64.0),
    "Standard_E16s_v5": (16, 128.0),
    "Standard_E20s_v5": (20, 160.0),
    "Standard_E32s_v5": (32, 256.0),
    "Standard_E48s_v5": (48, 384.0),
    "Standard_E64s_v5": (64, 512.0),
    # Compute optimized Fsv2
    "Standard_F2s_v2": (2, 4.0),
    "Standard_F4s_v2": (4, 8.0),
    "Standard_F8s_v2": (8, 16.0),
    "Standard_F16s_v2": (16, 32.0),
    "Standard_F32s_v2": (32, 64.0),
    "Standard_F48s_v2": (48, 96.0),
    "Standard_F64s_v2": (64, 128.0),
    "Standard_F72s_v2": (72, 144.0),
}

DISK_SKU_LABELS = {
    "Premium_LRS": "Premium SSD",
    "Premium_ZRS": "Premium SSD (zone)",
    "StandardSSD_LRS": "Standard SSD",
    "StandardSSD_ZRS": "Standard SSD (zone)",
    "Standard_LRS": "Standard HDD",
    "UltraSSD_LRS": "Ultra Disk",
}


def _friendly_disk_sku(sku: Optional[str]) -> str:
    if not sku:
        return "—"
    return DISK_SKU_LABELS.get(sku, sku.replace("_", " "))


def _lookup_vm_size(vm_size: Optional[str]) -> Tuple[Optional[int], Optional[float]]:
    if not vm_size:
        return None, None
    if vm_size in VM_SIZE_SPECS:
        v, m = VM_SIZE_SPECS[vm_size]
        return v, m
    # Dsv3–v5 style: Standard_D{2,4,8,...}s_v3|v4|v5 → ~4 GiB / vCPU
    m = re.match(r"^Standard_D(\d+)s_v[345]$", vm_size)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 96:
            return n, float(n * 4)
    # Esv3–v5: ~8 GiB / vCPU (common through 32 vCPU)
    m = re.match(r"^Standard_E(\d+)s_v[35]$", vm_size)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 32:
            return n, float(n * 8)
    # Broad D* without version match
    m = re.match(r"^Standard_D(\d+)(?:ds|ads)?_v[345]$", vm_size, re.I)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 96:
            return n, float(n * 4)
    return None, None


def _os_disk_line(os_disk: Dict[str, Any]) -> Tuple[str, str]:
    """Returns (short label, detail string)."""
    if not os_disk:
        return "OS disk", "—"
    size = os_disk.get("diskSizeGB")
    md = os_disk.get("managedDisk") or {}
    st = md.get("storageAccountType") or os_disk.get("storageAccountType")
    kind = _friendly_disk_sku(st)
    parts = [kind]
    if size is not None:
        parts.append(f"{size} GiB")
    caching = os_disk.get("caching")
    if caching:
        parts.append(f"caching: {caching}")
    return "OS disk", " · ".join(parts)


def _data_disks_summary(data_disks: Any) -> str:
    if not data_disks or not isinstance(data_disks, list):
        return "None attached"
    lines: List[str] = []
    for i, d in enumerate(data_disks):
        if not isinstance(d, dict):
            continue
        lun = d.get("lun", i)
        size = d.get("diskSizeGB")
        md = d.get("managedDisk") or {}
        st = md.get("storageAccountType")
        kind = _friendly_disk_sku(st)
        sz = f"{size} GiB" if size is not None else "size n/a"
        lines.append(f"LUN {lun}: {kind}, {sz}")
    return "; ".join(lines) if lines else "None attached"


def build_vm_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    hw = props.get("hardwareProfile") or {}
    vm_size = hw.get("vmSize") or sku_fallback
    vcpu, ram_gib = _lookup_vm_size(vm_size)

    sp = props.get("storageProfile") or {}
    os_disk = sp.get("osDisk") or {}
    _, os_detail = _os_disk_line(os_disk)
    data_summary = _data_disks_summary(sp.get("dataDisks"))

    img = sp.get("imageReference") or {}
    os_line = "—"
    if img:
        offer = img.get("offer") or ""
        sku_img = img.get("sku") or ""
        ver = img.get("exactVersion") or img.get("version") or ""
        os_line = " ".join(x for x in (offer, sku_img, ver) if x).strip() or "—"

    rows: List[Dict[str, str]] = [
        {"label": "VM size (Azure SKU)", "value": vm_size or "—"},
    ]
    if vcpu is not None:
        rows.append({"label": "vCPUs", "value": str(vcpu)})
    if ram_gib is not None:
        ram_txt = str(int(ram_gib)) if ram_gib == int(ram_gib) else f"{ram_gib:.1f}"
        rows.append({"label": "Memory", "value": f"{ram_txt} GiB RAM"})
    elif vm_size:
        rows.append(
            {
                "label": "Memory",
                "value": "Not in local lookup — see JSON or Azure VM sizes",
            }
        )

    rows.extend(
        [
            {"label": "OS image", "value": os_line},
            {"label": "OS disk", "value": os_detail},
            {"label": "Data disks", "value": data_summary},
        ]
    )

    one_parts = []
    if vcpu is not None and ram_gib is not None:
        ram_txt = str(int(ram_gib)) if ram_gib == int(ram_gib) else f"{ram_gib:.1f}"
        one_parts.append(f"{vcpu} vCPU · {ram_txt} GiB RAM")
    elif vm_size:
        one_parts.append(vm_size)
    one_parts.append(os_detail.split(" · ")[0] if os_detail != "—" else "")
    one_liner = " · ".join(p for p in one_parts if p)

    return {
        "resource_kind": "virtual_machine",
        "title": "Virtual machine",
        "rows": rows,
        "one_liner": one_liner or (vm_size or "VM"),
    }


def build_disk_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    size = props.get("diskSizeGB")
    tier = props.get("tier")
    sku = props.get("sku")
    if isinstance(sku, dict):
        sku_name = sku.get("name")
    else:
        sku_name = sku_fallback or (sku if isinstance(sku, str) else None)

    kind = _friendly_disk_sku(sku_name)
    state = props.get("diskState") or props.get("provisioningState") or "—"

    rows: List[Dict[str, str]] = [
        {"label": "Disk kind", "value": kind},
        {"label": "Size", "value": f"{size} GiB" if size is not None else "—"},
        {"label": "Tier", "value": str(tier) if tier else "—"},
        {"label": "State", "value": str(state)},
    ]
    sz = f"{size} GiB" if size is not None else ""
    one_liner = " · ".join(x for x in (kind, sz) if x)

    return {
        "resource_kind": "managed_disk",
        "title": "Managed disk",
        "rows": rows,
        "one_liner": one_liner or kind,
    }


def build_sql_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    sku = props.get("sku") or {}
    tier = sku.get("tier") or props.get("currentServiceObjectiveName") or sku_fallback or "—"
    capacity = sku.get("capacity")
    max_size = props.get("maxSizeBytes")
    max_size_str = f"{round(max_size / (1024**3), 1)} GiB" if max_size else "—"
    rows: List[Dict[str, str]] = [
        {"label": "Tier", "value": str(tier)},
        {"label": "DTUs / vCores", "value": str(capacity) if capacity else "—"},
        {"label": "Max size", "value": max_size_str},
    ]
    one_liner = tier if tier != "—" else "SQL DB"
    return {"resource_kind": "sql_database", "title": "SQL Database", "rows": rows, "one_liner": one_liner}


def build_postgres_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    sku = props.get("sku") or {}
    tier = sku.get("tier") or sku_fallback or "—"
    vcores = sku.get("capacity") or props.get("vcores")
    storage = (props.get("storageProfile") or {}).get("storageMB") or props.get("storage", {}).get("storageSizeGB")
    storage_str = f"{round(storage / 1024, 0):.0f} GiB" if storage and storage > 1000 else (f"{storage} GiB" if storage else "—")
    rows: List[Dict[str, str]] = [
        {"label": "Tier / SKU", "value": str(tier)},
        {"label": "vCores", "value": str(vcores) if vcores else "—"},
        {"label": "Storage", "value": storage_str},
    ]
    return {"resource_kind": "postgresql", "title": "PostgreSQL", "rows": rows, "one_liner": f"{tier}" if tier != "—" else "PostgreSQL"}


def build_mysql_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    sku = props.get("sku") or {}
    tier = sku.get("tier") or sku_fallback or "—"
    vcores = sku.get("capacity") or props.get("vcores")
    storage = (props.get("storageProfile") or {}).get("storageMB") or props.get("storage", {}).get("storageSizeGB")
    storage_str = f"{round(storage / 1024, 0):.0f} GiB" if storage and storage > 1000 else (f"{storage} GiB" if storage else "—")
    rows: List[Dict[str, str]] = [
        {"label": "Tier / SKU", "value": str(tier)},
        {"label": "vCores", "value": str(vcores) if vcores else "—"},
        {"label": "Storage", "value": storage_str},
    ]
    return {"resource_kind": "mysql", "title": "MySQL", "rows": rows, "one_liner": f"{tier}" if tier != "—" else "MySQL"}


def build_webapp_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    kind = props.get("kind") or "Web App"
    sku = props.get("sku") or {}
    tier = sku.get("tier") or sku_fallback or "—"
    workers = sku.get("capacity")
    rows: List[Dict[str, str]] = [
        {"label": "Kind", "value": str(kind)},
        {"label": "Plan tier", "value": str(tier)},
        {"label": "Workers", "value": str(workers) if workers else "—"},
    ]
    return {"resource_kind": "webapp", "title": "App Service", "rows": rows, "one_liner": f"{kind} · {tier}" if tier != "—" else str(kind)}


def build_storage_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    kind = props.get("kind") or "Storage"
    access_tier = props.get("accessTier") or "—"
    replication = sku_fallback or "—"
    rows: List[Dict[str, str]] = [
        {"label": "Kind", "value": str(kind)},
        {"label": "Access tier", "value": str(access_tier)},
        {"label": "Replication", "value": str(replication)},
    ]
    return {"resource_kind": "storage", "title": "Storage Account", "rows": rows, "one_liner": f"{kind} · {access_tier}"}


def build_redis_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    sku = props.get("sku") or {}
    tier = sku.get("name") or sku_fallback or "—"
    capacity = sku.get("capacity")
    rows: List[Dict[str, str]] = [
        {"label": "Tier", "value": str(tier)},
        {"label": "Capacity", "value": str(capacity) if capacity is not None else "—"},
    ]
    return {"resource_kind": "redis", "title": "Redis Cache", "rows": rows, "one_liner": f"{tier} C{capacity}" if capacity is not None else str(tier)}


def build_aks_display(props: Dict[str, Any], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    k8s_version = props.get("kubernetesVersion") or "—"
    node_pools = props.get("agentPoolProfiles") or []
    total_nodes = sum(p.get("count", 0) for p in node_pools if isinstance(p, dict))
    rows: List[Dict[str, str]] = [
        {"label": "Kubernetes version", "value": str(k8s_version)},
        {"label": "Node pools", "value": str(len(node_pools))},
        {"label": "Total nodes", "value": str(total_nodes) if total_nodes else "—"},
    ]
    return {"resource_kind": "aks", "title": "AKS Cluster", "rows": rows, "one_liner": f"k8s {k8s_version} · {total_nodes} nodes"}


def build_generic_display(props: Dict[str, Any], resource_type: Optional[str], sku_fallback: Optional[str] = None) -> Dict[str, Any]:
    tier = sku_fallback or (props.get("sku") or {}).get("name") if isinstance(props.get("sku"), dict) else sku_fallback
    provisioning = props.get("provisioningState") or "—"
    rows: List[Dict[str, str]] = [
        {"label": "Type", "value": _short_type(resource_type)},
    ]
    if tier:
        rows.append({"label": "SKU / Tier", "value": str(tier)})
    rows.append({"label": "Provisioning", "value": str(provisioning)})
    return {"resource_kind": "other", "title": _short_type(resource_type) or "Resource", "rows": rows, "one_liner": tier or _short_type(resource_type) or "—"}


def build_display_payload(
    config_json: Any,
    resource_type: Optional[str],
    sku_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Structured summary for API + UI."""
    props: Dict[str, Any] = config_json if isinstance(config_json, dict) else {}
    rtype = (resource_type or "").lower()

    if "virtualmachines" in rtype:
        block = build_vm_display(props, sku_fallback=sku_name)
    elif "disks" in rtype:
        block = build_disk_display(props, sku_fallback=sku_name)
    elif "sql/servers/databases" in rtype:
        block = build_sql_display(props, sku_fallback=sku_name)
    elif "dbforpostgresql" in rtype:
        block = build_postgres_display(props, sku_fallback=sku_name)
    elif "dbformysql" in rtype or "dbformariadb" in rtype:
        block = build_mysql_display(props, sku_fallback=sku_name)
    elif "web/sites" in rtype or "web/serverfarms" in rtype:
        block = build_webapp_display(props, sku_fallback=sku_name)
    elif "storageaccounts" in rtype:
        block = build_storage_display(props, sku_fallback=sku_name)
    elif "redis" in rtype:
        block = build_redis_display(props, sku_fallback=sku_name)
    elif "managedclusters" in rtype:
        block = build_aks_display(props, sku_fallback=sku_name)
    else:
        block = build_generic_display(props, resource_type, sku_fallback=sku_name)

    return {"summary": block}


def _short_type(resource_type: Optional[str]) -> str:
    if not resource_type:
        return "—"
    return resource_type.split("/")[-1].replace(".", "/")


def spec_one_liner(
    config_json: Any,
    resource_type: Optional[str],
    sku_name: Optional[str] = None,
) -> str:
    """Single line for table column."""
    payload = build_display_payload(config_json, resource_type, sku_name)
    return payload["summary"].get("one_liner") or "—"


def enrich_list_row(row: Dict[str, Any]) -> None:
    """Mutates row: adds spec_summary, removes bulky config_json for list API."""
    summ = spec_one_liner(row.get("config_json"), row.get("resource_type"), row.get("sku_name"))
    row["spec_summary"] = summ
    row.pop("config_json", None)
