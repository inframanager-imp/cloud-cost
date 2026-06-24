// ─── State ────────────────────────────────────────────────────────────────
let currentPage = 'executive';
let chartInstances = {};

// ─── Currency (per-tenant reporting currency) ───────────────────────────────
window.TENANT_CUR = window.TENANT_CUR || { code: 'USD', symbol: '$' };
function curSym() { return (window.TENANT_CUR && window.TENANT_CUR.symbol) || '$'; }
function money(v, dec = 2) {
    return curSym() + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
async function loadTenantCurrency() {
    try {
        const c = await fetch('/api/tenant/currency').then(r => r.json());
        if (c && c.symbol) window.TENANT_CUR = { code: c.code || 'USD', symbol: c.symbol };
    } catch (e) { /* keep default $ */ }
}

// ─── Schedule time helpers (HH:MM <-> hour/minute) ──────────────────────────
function _hmToTime(hour, minute) {
    const h = String(Math.max(0, Math.min(23, parseInt(hour ?? 8)))).padStart(2, '0');
    const m = String(Math.max(0, Math.min(59, parseInt(minute ?? 0)))).padStart(2, '0');
    return `${h}:${m}`;
}
function _timeToHM(val) {
    const [h, m] = String(val || '08:00').split(':');
    return { hour: parseInt(h) || 0, minute: parseInt(m) || 0 };
}
function setScheduleTime(id, hour, minute) {
    const el = document.getElementById(id);
    if (el) el.value = _hmToTime(hour, minute);
}
let syncInterval = null;
let selectedSubscription = '';
let selectedCloud = '';          // '' | 'azure' | 'aws' | 'gcp'
let selectedClient = '';         // '' | client id string
let selectedActCloud = '';       // '' | 'azure' | 'aws' | 'gcp' — Activity Log cloud filter
let costSortBy = 'date';
let costSortDir = 'desc';
let actSortBy = 'timestamp';
let actSortDir = 'desc';
let configSortBy = 'resource_name';
let configSortDir = 'asc';
let _configsData = [];
let _cfgSelectedSubs = new Set();
let _cfgSelectedRGs  = new Set();

// ─── Cloud Provider Filter ────────────────────────────────────────────────
const CLOUD_LOGOS = {
    aws:    '<img src="/static/img/aws-logo.svg"   alt="AWS"   style="height:22px;vertical-align:middle">',
    azure:  '<img src="/static/img/azure-logo.svg" alt="Azure" style="height:22px;vertical-align:middle">',
    gcp:    '<img src="/static/img/gcp-logo.svg"   alt="GCP"   style="height:22px;vertical-align:middle">',
    openai: '<svg width="20" height="20" viewBox="0 0 24 24" fill="#10a37f" style="vertical-align:middle"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073z"/></svg>',
    atlassian: '<svg width="20" height="20" viewBox="0 0 32 32" style="vertical-align:middle"><defs><linearGradient id="atlg" x1="50%" y1="40%" x2="0%" y2="100%"><stop offset="0" stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient></defs><path fill="url(#atlg)" d="M9.5 15.1a.83.83 0 0 0-1.42.18L1.06 29.4a.86.86 0 0 0 .77 1.24h9.8a.83.83 0 0 0 .77-.47c2.1-4.36.83-10.98-2.9-15.07z"/><path fill="#2684FF" d="M15.3 1.43a18.9 18.9 0 0 0-1.1 18.66l4.72 9.45a.86.86 0 0 0 .77.47h9.8a.86.86 0 0 0 .77-1.24S17.5 2.06 17.2 1.43a.8.8 0 0 0-1.9 0z"/></svg>',
};
const CLOUD_META = {
    azure:     { icon: '⊞', logo: CLOUD_LOGOS.azure,     label: 'Azure',     color: '#0078d4', groupLabel: { sub: 'Subscription', rg: 'Resource Group', service: 'Service', resource: 'Resource' } },
    aws:       { icon: '⚙', logo: CLOUD_LOGOS.aws,       label: 'AWS',       color: '#ff9900', groupLabel: { sub: 'Account',      rg: 'Region',         service: 'Service', resource: 'Resource' } },
    gcp:       { icon: '◉', logo: CLOUD_LOGOS.gcp,       label: 'GCP',       color: '#4285f4', groupLabel: { sub: 'Project',      rg: 'Project',        service: 'Service', resource: 'Resource' } },
    openai:    { icon: '◈', logo: CLOUD_LOGOS.openai,    label: 'OpenAI',    color: '#10a37f', groupLabel: { sub: 'API Key / Org', rg: 'Model',  service: 'Service', resource: 'Model / Token' } },
    atlassian: { icon: '◧', logo: CLOUD_LOGOS.atlassian, label: 'Atlassian', color: '#0052cc', groupLabel: { sub: 'Organization',  rg: 'Plan',   service: 'Product', resource: 'Seat' } },
    cursor:    { icon: '◧', logo: '<img src="/static/img/cursor-logo.svg" alt="Cursor" style="height:18px;vertical-align:middle">', label: 'Cursor', color: '#111111', groupLabel: { sub: 'Team / Account', rg: 'Role', service: 'Service', resource: 'User' } },
    twilio:    { icon: '☎', logo: '☎',                   label: 'Twilio',    color: '#f22f46', groupLabel: { sub: 'Account',      rg: 'Plan',           service: 'Service'  } },
    sendgrid:  { icon: '✉', logo: '✉',                   label: 'SendGrid',  color: '#1a82e2', groupLabel: { sub: 'Account',      rg: 'Plan',           service: 'Service'  } },
};
// Canonical provider order — every feature draws its cloud list from this so a
// new provider only has to be added here + to CLOUD_META to appear everywhere.
const CLOUD_ORDER = ['azure', 'aws', 'gcp', 'openai', 'atlassian', 'cursor', 'twilio', 'sendgrid'];
// Clouds this tenant actually has (per /api/connected-clouds), in canonical order.
// Falls back to the 3 core clouds before connected-clouds has loaded.
function activeClouds() {
    const list = CLOUD_ORDER.filter(c => CLOUD_META[c] && (!connectedClouds || connectedClouds.has(c)));
    return list.length ? list : ['azure', 'aws', 'gcp'];
}
// The cloud to land on by default (biggest-spend, per /api/clouds/default). Cached.
let _defaultCloud = null;
async function defaultCloud() {
    if (_defaultCloud) return _defaultCloud;
    try {
        const d = await fetch('/api/clouds/default').then(r => r.json());
        _defaultCloud = (d && d.cloud) || activeClouds()[0] || 'azure';
    } catch (e) { _defaultCloud = activeClouds()[0] || 'azure'; }
    return _defaultCloud;
}

// Populate a <select> with the tenant's clouds (optionally an "All" entry first).
function fillCloudSelect(selectId, { includeAll = false, allLabel = 'All Clouds', allValue = '' } = {}) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const cur = el.value;
    const opts = (includeAll ? [`<option value="${allValue}">${allLabel}</option>`] : [])
        .concat(activeClouds().map(c => `<option value="${c}">${CLOUD_META[c].label}</option>`));
    el.innerHTML = opts.join('');
    if (cur) el.value = cur;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const CHART_COLORS = () => [
    cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'),
    cssVar('--chart-4'), cssVar('--chart-5'), cssVar('--chart-other'),
];
const CHART_TEXT = () => cssVar('--text-secondary');
const CHART_GRID = () => cssVar('--border-subtle');

// Helper: get cloud-aware label for resource_group column
function rgLabel(cloud) { return CLOUD_META[cloud]?.groupLabel?.rg || 'Resource Group / Region / Project'; }
// Helper: get cloud-aware label for subscription column
function subLabel(cloud) { return CLOUD_META[cloud]?.groupLabel?.sub || 'Account / Subscription / Project'; }

function setCloudFilter(cloud) {
    selectedCloud = cloud;
    // Update pill active state
    document.querySelectorAll('[data-cloud]').forEach(p => {
        p.classList.toggle('active', p.dataset.cloud === cloud);
    });
    // Update adaptive labels
    _updateCloudLabels(cloud);
    // Reload current page data
    navigateTo(currentPage);
}

function _updateCloudLabels(cloud) {
    const meta = CLOUD_META[cloud] || null;
    const subTitle = document.getElementById('dashSubTitle');
    const svcTitle = document.getElementById('dashServiceTitle');
    const rgTitle  = document.getElementById('dashRGTitle');
    const filterLabel = document.getElementById('cloudFilterLabel');

    if (meta) {
        if (subTitle) subTitle.textContent = `Cost by ${meta.groupLabel.sub.toLowerCase()}`;
        if (svcTitle) svcTitle.textContent = `Top ${meta.label.toLowerCase()} services`;
        if (rgTitle)  rgTitle.textContent  = `Top ${meta.groupLabel.rg.toLowerCase()}s`;
        if (filterLabel) filterLabel.textContent = `Showing ${meta.label} costs only`;
        // Update segmented control active state
        document.querySelectorAll('.db-seg-btn[data-cloud]').forEach(b => b.classList.toggle('active', b.dataset.cloud === (selectedCloud||'')));
    } else {
        if (subTitle) subTitle.textContent = `Cost by account / subscription / project`;
        if (svcTitle) svcTitle.textContent = `Top services`;
        if (rgTitle)  rgTitle.textContent  = `Top resource groups / regions / projects`;
        if (filterLabel) filterLabel.textContent = '';
        document.querySelectorAll('.db-seg-btn[data-cloud]').forEach(b => b.classList.toggle('active', b.dataset.cloud === ''));
    }
}

function cloudParam(prefix = '?') {
    return selectedCloud ? `${prefix}cloud_provider=${selectedCloud}` : '';
}

function addCloudParam(params) {
    // URLSearchParams helper
    if (selectedCloud) params.set('cloud_provider', selectedCloud);
}

// Initialise cloud filter pills based on which clouds have data
// Clouds this tenant should see (enabled providers + historical cost data).
// null = unknown (fail open: show everything).
let connectedClouds = null;

function cloudVisible(cloud) {
    return !connectedClouds || connectedClouds.has(cloud);
}

async function initCloudFilter() {
    try {
        const clouds = await fetch('/api/connected-clouds').then(r => r.json());
        connectedClouds = new Set(clouds);
    } catch(e) { connectedClouds = null; /* fail open */ }
    applyCloudVisibility();
}

function applyCloudVisibility() {
    // Static elements tagged with data-cloud-vis (KPI cards, header chips)
    document.querySelectorAll('[data-cloud-vis]').forEach(el => {
        el.style.display = cloudVisible(el.dataset.cloudVis) ? '' : 'none';
    });

    // Cloud filter chips across pages (keep "All" / empty value)
    const chipSelectors = [
        ['#cloudFilterPills .cloud-pill[data-cloud]', 'cloud'],
        ['#ccCloudsFilter [data-cloud]',              'cloud'],
        ['[data-costs-cloud]',                        'costsCloud'],
        ['[data-cmp-cloud]',                          'cmpCloud'],
        ['[data-act-cloud]',                          'actCloud'],
        ['#rgCloudSeg [data-rg-cloud]',               'rgCloud'],
    ];
    chipSelectors.forEach(([sel, key]) => {
        document.querySelectorAll(sel).forEach(b => {
            const cloud = b.dataset[key];
            if (!cloud || cloud === 'all') return; // keep "All"
            b.style.display = cloudVisible(cloud) ? '' : 'none';
        });
    });

    // Recompute KPI grid columns so hidden cards don't leave gaps
    const row = document.getElementById('exKpiRow');
    if (row) {
        const visible = Array.from(row.children).filter(c => c.style.display !== 'none').length;
        row.style.gridTemplateColumns = `repeat(${visible || 1},minmax(0,1fr))`;
    }
}

// ─── Navigation ──────────────────────────────────────────────────────────
function navigateTo(page) {
    currentPage = page;
    // Persist active page in URL hash so browser refresh restores position
    history.replaceState(null, '', '#' + page);
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    if (page === 'executive') loadExecutiveSummary();
    if (page === 'cloud-overview') loadCloudOverview();
    if (page === 'costs') {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const firstDay = `${y}-${m}-01`;
        const today    = `${y}-${m}-${d}`;
        const fromEl = document.getElementById('costDateFrom');
        const toEl   = document.getElementById('costDateTo');
        if (fromEl) fromEl.value = firstDay;
        if (toEl)   toEl.value   = today;
        _initCostDateRangePicker(firstDay, today);
        // Pre-select the cloud if arriving from a cloud card (setCloudFilter sets selectedCloud)
        if (selectedCloud) {
            costsSelectedCloud = selectedCloud;
            document.querySelectorAll('[data-costs-cloud]').forEach(b =>
                b.classList.toggle('active', b.dataset.costsCloud === selectedCloud));
            _updateCostsCloudFilters(selectedCloud);
            loadCostsTable();
        } else {
            // Auto-select the first cloud this tenant actually has data for
            // (e.g. an AWS-only tenant defaults to AWS, not an empty Azure view).
            _pickDefaultCostsCloud().then(cloud => {
                costsSelectedCloud = cloud;
                document.querySelectorAll('[data-costs-cloud]').forEach(b =>
                    b.classList.toggle('active', b.dataset.costsCloud === cloud));
                _updateCostsCloudFilters(cloud);
                loadCostsTable();
            });
        }
    }
    if (page === 'monthly') loadMonthly();
    if (page === 'configs') loadConfigsPage();
    if (page === 'compare') {
        onCompareModeChange();
        loadCompare();
    }
    if (page === 'analytics') loadAnalytics();
    if (page === 'custom-cost') loadCustomCostPage();
    if (page === 'reports') loadReportsPage();
    if (page === 'activity') loadActivityPage();
    if (page === 'subscriptions') loadSubscriptionsPage();
    if (page === 'budgets') loadBudgetsPage();
    if (page === 'cloud-providers') loadCloudProvidersPage();
    if (page === 'team') loadTeamPage();
    if (page === 'clients') loadClientsPage();
    if (page === 'othercosts') loadOtherCostsPage();
}

function subParam(prefix = '?') {
    const parts = [];
    if (selectedSubscription) parts.push(`subscription_id=${selectedSubscription}`);
    if (selectedCloud) parts.push(`cloud_provider=${selectedCloud}`);
    if (selectedClient) parts.push(`client_id=${selectedClient}`);
    return parts.length ? prefix + parts.join('&') : '';
}

function setClientFilter(clientId) {
    selectedClient = clientId || '';
    // Sync both dropdowns
    const dash = document.getElementById('dashClientFilter');
    const costs = document.getElementById('costsClientFilter');
    if (dash && dash.value !== selectedClient) dash.value = selectedClient;
    if (costs && costs.value !== selectedClient) costs.value = selectedClient;
    navigateTo(currentPage);
}

async function populateClientDropdowns() {
    try {
        const clients = await fetch('/api/clients').then(r => r.json());
        ['dashClientFilter', 'costsClientFilter'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const cur = el.value;
            el.innerHTML = '<option value="">All Clients</option>';
            clients.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name;
                el.appendChild(opt);
            });
            el.value = cur;
        });
    } catch(e) { /* non-fatal */ }
}

async function loadBudgetsPage() {
    const grid = document.getElementById('budgetCardsGrid');
    const alertBody = document.getElementById('alertHistoryBody');
    try {
        const budgets = await fetch('/api/budgets').then(r => r.json()).catch(() => []);
        if (grid) {
            if (!budgets || budgets.length === 0) {
                grid.innerHTML = _emptyState('success',
                    '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
                    'No budgets yet',
                    'Set monthly spend limits and get notified before you blow past them.',
                    [{label:'+ New budget', primary:true, onclick:'showBudgetModal()'}]
                );
            }
        }
        const alerts = await fetch('/api/budgets/alerts').then(r => r.json()).catch(() => []);
        if (alertBody) {
            if (!alerts || alerts.length === 0) {
                alertBody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none">` +
                    _emptyState('success',
                        '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
                        'All caught up',
                        'No alerts triggered yet. Your budgets are healthy.'
                    ) + `</td></tr>`;
            }
        }
    } catch (err) {
        console.error('Budgets page error:', err);
    }
}

async function loadCloudProvidersPage() {
    const tbody = document.getElementById('providersTableBody');
    if (!tbody) return;
    try {
        const providers = await fetch('/api/cloud-providers').then(r => r.json()).catch(() => []);
        if (!providers || providers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none">` +
                _emptyState('info',
                    '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
                    'Connect your first cloud',
                    'Link AWS, Azure, or GCP to start tracking costs. Takes about 2 minutes.',
                    [{label:'+ Add provider', primary:true, onclick:'showProviderModal()'}]
                ) + `</td></tr>`;
        }
    } catch (err) {
        console.error('Cloud providers page error:', err);
    }
}

async function loadTeamPage() {
    const tbody = document.getElementById('team-members-tbody');
    if (!tbody) return;
    try {
        const data = await fetch('/api/team/members').then(r => r.json()).catch(() => null);
        const members = data?.members || data || [];
        if (!members || members.length <= 1) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none">` +
                _emptyState('info',
                    '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
                    'Invite your teammates',
                    'Bring in finance, engineering, or leadership to collaborate on cost.',
                    [{label:'+ Invite member', primary:true, onclick:"document.getElementById('invite-modal-backdrop') && (document.getElementById('invite-modal-backdrop').style.display='flex')"}]
                ) + `</td></tr>`;
        }
    } catch (err) {
        console.error('Team page error:', err);
    }
}

// ─── Cloud Overview ──────────────────────────────────────────────────────────

const PROVIDER_META = {
    azure: { label: 'Azure',  logo: '⊞', color: '#0078d4', bg: 'rgba(0,120,212,0.10)' },
    aws:   { label: 'AWS',    logo: '⚙', color: '#ff9900', bg: 'rgba(255,153,0,0.10)'  },
    gcp:   { label: 'GCP',    logo: '◉', color: '#4285f4', bg: 'rgba(66,133,244,0.10)' },
};

function _coFmtShort(v) {
    const s = curSym();
    if (v >= 1e6) return s + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return s + (v / 1e3).toFixed(1) + 'K';
    return s + Math.round(v).toLocaleString();
}

function _emptyState(tone, svgPath, headline, sub, actions) {
  const actionsHtml = (actions || []).map(a =>
    a.primary
      ? `<button class="cp-btn-primary" style="font-size:13px" onclick="${a.onclick || ''}">${a.label}</button>`
      : `<button class="cp-btn-secondary" style="font-size:13px" onclick="${a.onclick || ''}">${a.label}</button>`
  ).join('');
  return `<div class="empty-state">
    <div class="empty-state__icon empty-state__icon--${tone}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${svgPath}</svg>
    </div>
    <div class="empty-state__headline">${headline}</div>
    <div class="empty-state__sub">${sub}</div>
    ${actionsHtml ? `<div class="empty-state__actions">${actionsHtml}</div>` : ''}
  </div>`;
}

function _computeSparkPoints(trend, width, height) {
    if (!trend || trend.length < 2) return null;
    const costs = trend.map(d => d.cost || 0);
    const maxC = Math.max(...costs);
    if (maxC === 0) return null;
    const minC = Math.min(...costs);
    const range = maxC - minC || 1;
    const step = width / (trend.length - 1);
    return trend.map((d, i) => {
        const x = Math.round(i * step * 10) / 10;
        const y = Math.round((height - 2 - ((d.cost - minC) / range) * (height - 6)) * 10) / 10;
        return `${x},${y}`;
    }).join(' ');
}

// ── Executive Summary ────────────────────────────────────────────────────────
let _exTrendChart = null;
let _exDonutChart = null;
let _exYear  = null;
let _exMonth = null;

function exNavMonth(delta) {
    if (_exYear === null) { loadExecutiveSummary(); return; }
    const d = new Date(_exYear, _exMonth - 1 + delta, 1);
    const now = new Date();
    if (d.getFullYear() > now.getFullYear() ||
        (d.getFullYear() === now.getFullYear() && d.getMonth() > now.getMonth())) return;
    _exYear  = d.getFullYear();
    _exMonth = d.getMonth() + 1;
    loadExecutiveSummary();
}

async function loadExecutiveSummary() {
    if (_exYear === null) {
        const now = new Date();
        _exYear  = now.getFullYear();
        _exMonth = now.getMonth() + 1;
    }
    const now = new Date();
    const nextBtn = document.getElementById('exNextBtn');
    if (nextBtn) {
        const atCurrent = _exYear === now.getFullYear() && _exMonth === now.getMonth() + 1;
        nextBtn.style.opacity = atCurrent ? '0.3' : '1';
        nextBtn.style.cursor  = atCurrent ? 'default' : 'pointer';
    }
    try {
        const resp = await fetch(`/api/executive-summary?year=${_exYear}&month=${_exMonth}`);
        if (!resp.ok) { console.error('Executive summary API error:', resp.status, await resp.text()); return; }
        const d = await resp.json();
        const _sym = d.currency_symbol || '$';
        if (typeof window !== 'undefined') window.TENANT_CUR = { code: d.currency || 'USD', symbol: _sym };
        const $fmt  = v => _sym + (v||0).toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0});
        const $fmt2 = v => _sym + (v||0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
        const kpi = d.kpis || {};
        const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark';

        // Period labels
        const el = id => document.getElementById(id);
        const periodStr = d.period || '';
        if (el('exPeriodLabel'))   el('exPeriodLabel').textContent   = periodStr;
        if (el('exComparePeriod')) el('exComparePeriod').textContent = d.compare_period || '';
        ['exDonutPeriod','exDriversPeriod','exAccountsPeriod'].forEach(id => {
            if (el(id)) el(id).textContent = periodStr;
        });

        // MoM badge helper
        const momBadge = pct => {
            if (pct == null) return '';
            const up = pct >= 0;
            return `<span style="font-size:10px;font-weight:600;color:${up?'#ef4444':'#10b981'}">${up?'▲':'▼'} ${Math.abs(pct)}% vs last month</span>`;
        };

        // Sparkline helper: convert array of values to SVG polyline points (80x20 viewBox)
        const toSparkPoints = vals => {
            if (!vals || vals.length < 2) return '0,16 80,16';
            const mn = Math.min(...vals), mx = Math.max(...vals);
            const range = mx - mn || 1;
            return vals.map((v, i) => {
                const x = Math.round(i / (vals.length - 1) * 80);
                const y = Math.round(16 - ((v - mn) / range) * 12);
                return `${x},${y}`;
            }).join(' ');
        };

        const trend = d.monthly_trend || [];
        const sparkPoints = {
            total: toSparkPoints(trend.map(t => t.total)),
            azure: toSparkPoints(trend.map(t => t.azure)),
            aws:   toSparkPoints(trend.map(t => t.aws)),
            gcp:   toSparkPoints(trend.map(t => t.gcp)),
            avg:   toSparkPoints(trend.map(t => t.total / 30)),
        };

        // KPI values
        if (el('exTotalSpend')) el('exTotalSpend').textContent = $fmt(kpi.total);
        if (el('exTotalMom'))   el('exTotalMom').innerHTML = momBadge(kpi.total_mom_pct);
        if (el('exTotalSub'))   el('exTotalSub').textContent = `vs last month ${$fmt2(kpi.total_lm)}`;
        if (el('exSparkTotal')) el('exSparkTotal').setAttribute('points', sparkPoints.total);

        if (el('exAzureSpend')) el('exAzureSpend').textContent = $fmt(kpi.azure);
        if (el('exAzureMom'))   el('exAzureMom').innerHTML = momBadge(kpi.azure_mom_pct);
        if (el('exAzureSub'))   el('exAzureSub').textContent = kpi.azure > 0 ? `${Math.round(kpi.azure/(kpi.total||1)*100)}% of total` : '';
        if (el('exSparkAzure')) el('exSparkAzure').setAttribute('points', sparkPoints.azure);

        if (el('exAwsSpend'))   el('exAwsSpend').textContent = $fmt(kpi.aws);
        if (el('exAwsMom'))     el('exAwsMom').innerHTML = momBadge(kpi.aws_mom_pct);
        if (el('exAwsSub'))     el('exAwsSub').textContent = kpi.aws > 0 ? `${Math.round(kpi.aws/(kpi.total||1)*100)}% of total` : '';
        if (el('exSparkAws'))   el('exSparkAws').setAttribute('points', sparkPoints.aws);

        if (el('exGcpSpend'))   el('exGcpSpend').textContent = $fmt(kpi.gcp);
        if (el('exGcpMom'))     el('exGcpMom').innerHTML = momBadge(kpi.gcp_mom_pct);
        if (el('exGcpSub'))     el('exGcpSub').textContent = kpi.gcp > 0 ? `${Math.round(kpi.gcp/(kpi.total||1)*100)}% of total` : '';
        if (el('exSparkGcp'))   el('exSparkGcp').setAttribute('points', sparkPoints.gcp);

        if (el('exAvgDay'))  el('exAvgDay').textContent = $fmt2(kpi.avg_daily);
        if (el('exAvgMom'))  el('exAvgMom').innerHTML  = momBadge(kpi.total_mom_pct);
        if (el('exAvgSub'))  el('exAvgSub').textContent = `${kpi.days_elapsed} of ${kpi.days_in_month} days`;
        if (el('exSparkAvg')) el('exSparkAvg').setAttribute('points', sparkPoints.avg);

        // Projected EOM + month progress
        if (el('exProjected'))         el('exProjected').textContent = $fmt2(kpi.projected);
        if (el('exMonthProgressLabel')) el('exMonthProgressLabel').textContent = `Day ${kpi.days_elapsed} of ${kpi.days_in_month} — ${Math.round(kpi.days_elapsed/kpi.days_in_month*100)}% through month`;
        if (el('exMonthProgress')) {
            const pct = Math.round(kpi.days_elapsed / kpi.days_in_month * 100);
            el('exMonthProgress').style.width = pct + '%';
        }

        // Budget vs Actual
        const budget = d.budget || {};
        if (el('exBudgetActual')) el('exBudgetActual').textContent = $fmt2(budget.utilized || kpi.total);
        if (budget.pct != null) {
            if (el('exBudgetOf'))      el('exBudgetOf').textContent = `of ${$fmt2(budget.total)} budget`;
            if (el('exBudgetPct'))     el('exBudgetPct').textContent = budget.pct.toFixed(1) + '%';
            if (el('exBudgetRemain'))  el('exBudgetRemain').textContent = `Remaining ${$fmt2(budget.remaining)}`;
            if (el('exBudgetBar')) {
                const p = Math.min(budget.pct, 100);
                el('exBudgetBar').style.width = p + '%';
                el('exBudgetBar').style.background = p > 90 ? '#ef4444' : p > 75 ? '#f59e0b' : '#10b981';
            }
        } else {
            if (el('exBudgetOf'))  el('exBudgetOf').textContent = 'No budget configured';
            if (el('exBudgetPct')) el('exBudgetPct').textContent = '—';
        }

        // Monthly Trend Chart
        const trendLabels = trend.map(t => t.label);
        const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
        const txtColor  = isDark ? '#9ca3af' : '#6b7280';
        if (_exTrendChart) { _exTrendChart.destroy(); _exTrendChart = null; }
        const trendCtx = el('exTrendChart');
        if (trendCtx) {
            _exTrendChart = new Chart(trendCtx, {
                type: 'line',
                data: {
                    labels: trendLabels,
                    datasets: [
                        { label: 'Total',  data: trend.map(t => t.total), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.08)', tension: 0.4, fill: true,  borderWidth: 2,   pointRadius: 3 },
                        ...(cloudVisible('azure') ? [{ label: 'Azure',  data: trend.map(t => t.azure), borderColor: '#0089D6', backgroundColor: 'transparent', tension: 0.4, fill: false, borderWidth: 1.5, pointRadius: 2, borderDash: [5,3] }] : []),
                        ...(cloudVisible('aws')   ? [{ label: 'AWS',    data: trend.map(t => t.aws),   borderColor: '#FF9900', backgroundColor: 'transparent', tension: 0.4, fill: false, borderWidth: 1.5, pointRadius: 2, borderDash: [5,3] }] : []),
                        ...(cloudVisible('gcp')   ? [{ label: 'GCP',    data: trend.map(t => t.gcp),   borderColor: '#34A853', backgroundColor: 'transparent', tension: 0.4, fill: false, borderWidth: 1,   pointRadius: 2, borderDash: [3,3] }] : []),
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'top', labels: { color: txtColor, font: { size: 11 }, boxWidth: 16, padding: 12 } } },
                    scales: {
                        x: { grid: { color: gridColor }, ticks: { color: txtColor, font: { size: 11 } } },
                        y: { grid: { color: gridColor }, ticks: { color: txtColor, font: { size: 11 }, callback: v => curSym() + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v) } }
                    }
                }
            });
        }

        // Top Cost Drivers
        const drivers = d.top_services || [];
        const maxCost = drivers[0]?.cost || 1;
        const dColors = ['#6366f1','#0089D6','#FF9900','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#84cc16','#f97316'];
        if (el('exTopDriversList')) {
            el('exTopDriversList').innerHTML = drivers.map((s, i) => {
                const pct = Math.round(s.cost / maxCost * 100);
                return `<div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:10px;color:var(--text-secondary);width:12px;text-align:right;flex-shrink:0">${i+1}</span>
                    <div style="flex:1;min-width:0">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                            <span style="font-size:11px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px" title="${s.name}">${s.name}</span>
                            <span style="font-size:11px;font-weight:700;color:var(--text-primary);flex-shrink:0;margin-left:6px">${$fmt2(s.cost)}</span>
                        </div>
                        <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
                            <div style="height:100%;width:${pct}%;background:${dColors[i%dColors.length]};border-radius:2px"></div>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        // Cloud Donut — all providers with spend (from kpi.by_cloud), not just 3
        const _byCloud = kpi.by_cloud || { azure: kpi.azure||0, aws: kpi.aws||0, gcp: kpi.gcp||0 };
        const _donutClouds = activeClouds().filter(c => (_byCloud[c] || 0) > 0);
        const cVals   = _donutClouds.map(c => _byCloud[c] || 0);
        const cLabels = _donutClouds.map(c => CLOUD_META[c]?.label || c);
        const cColors = _donutClouds.map(c => CLOUD_META[c]?.color || '#888');
        const active  = cVals.map((v,i) => v > 0 ? i : -1).filter(i => i >= 0);
        if (_exDonutChart) { _exDonutChart.destroy(); _exDonutChart = null; }
        const donutCtx = el('exCloudDonut');
        if (donutCtx && active.length) {
            _exDonutChart = new Chart(donutCtx, {
                type: 'doughnut',
                data: { labels: active.map(i => cLabels[i]), datasets: [{ data: active.map(i => cVals[i]), backgroundColor: active.map(i => cColors[i]), borderWidth: 2, borderColor: isDark ? '#1f2937' : '#fff', hoverOffset: 4 }] },
                options: { responsive: true, maintainAspectRatio: true, cutout: '72%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${$fmt2(ctx.parsed)}` } } } }
            });
        }
        if (el('exDonutTotal')) el('exDonutTotal').textContent = $fmt(kpi.total);
        if (el('exCloudLegend')) {
            el('exCloudLegend').innerHTML = active.map(i => `
                <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;padding:2px 0">
                    <div style="display:flex;align-items:center;gap:5px">
                        <div style="width:8px;height:8px;border-radius:50%;background:${cColors[i]};flex-shrink:0"></div>
                        <span style="color:var(--text-secondary)">${cLabels[i]}</span>
                        <span style="color:var(--text-secondary);font-size:10px">${Math.round(cVals[i]/(kpi.total||1)*100)}%</span>
                    </div>
                    <span style="font-weight:600;color:var(--text-primary)">${$fmt2(cVals[i])}</span>
                </div>`).join('');
        }

        // Top Accounts
        const accounts = d.top_accounts || [];
        const maxAcc = accounts[0]?.cost || 1;
        const cloudColMap = { azure: '#0089D6', aws: '#FF9900', gcp: '#34A853' };
        if (el('exAccountsList')) {
            el('exAccountsList').innerHTML = accounts.map(a => {
                const pct = Math.round(a.cost / maxAcc * 100);
                const badge = `<span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:8px;background:${cloudColMap[a.cloud]||'#6366f1'}22;color:${cloudColMap[a.cloud]||'#6366f1'};text-transform:uppercase">${a.cloud}</span>`;
                return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                        <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1">
                            ${badge}
                            <span style="font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</span>
                        </div>
                        <span style="font-size:12px;font-weight:700;color:var(--text-primary);flex-shrink:0;margin-left:10px">${$fmt2(a.cost)}</span>
                    </div>
                    <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:${cloudColMap[a.cloud]||'#6366f1'};border-radius:2px;opacity:0.6"></div>
                    </div>
                </div>`;
            }).join('');
        }

        // Savings Opportunities
        const savings = d.savings_opportunities || [];
        const totalSavings = savings.reduce((s, r) => s + r.amount, 0);
        if (el('exSavingsTotal')) el('exSavingsTotal').textContent = $fmt(totalSavings);
        if (el('exSavingsList')) {
            const sIcons = { resize: '⤡', savings: '💰', idle: '⏸', storage: '🗄' };
            const sColors = ['#10b981','#6366f1','#f59e0b','#06b6d4'];
            el('exSavingsList').innerHTML = savings.map((s, i) => `
                <div style="display:flex;align-items:center;justify-content:space-between">
                    <div style="display:flex;align-items:center;gap:6px;min-width:0">
                        <div style="width:6px;height:6px;border-radius:50%;background:${sColors[i%sColors.length]};flex-shrink:0"></div>
                        <span style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.label}</span>
                    </div>
                    <span style="font-size:12px;font-weight:700;color:#10b981;flex-shrink:0;margin-left:8px">${$fmt(s.amount)}</span>
                </div>`).join('');
        }

        // Governance
        const gov = d.governance || {};
        if (el('exUntagged')) el('exUntagged').textContent = (gov.untagged_resources||0).toLocaleString();
        if (el('exTotalRes')) el('exTotalRes').textContent = (gov.total_resources||0).toLocaleString();
        if (el('exTagPct'))   el('exTagPct').textContent = (gov.tag_compliance_pct||0).toFixed(1) + '%';
        if (el('exTagBar')) {
            const p = gov.tag_compliance_pct || 0;
            el('exTagBar').style.width = p + '%';
            el('exTagBar').style.background = p > 80 ? '#10b981' : p > 50 ? '#f59e0b' : '#ef4444';
        }

        // Service Categories
        const cats = d.service_categories || [];
        const maxCat = cats[0]?.cost || 1;
        const catColors = ['#6366f1','#0089D6','#10b981','#f59e0b','#ef4444','#8b5cf6'];
        if (el('exCatList')) {
            el('exCatList').innerHTML = cats.slice(0,5).map((c, i) => {
                const pct = Math.round(c.cost / maxCat * 100);
                return `<div style="display:flex;align-items:center;gap:6px">
                    <span style="font-size:11px;color:var(--text-secondary);min-width:70px">${c.name}</span>
                    <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:${catColors[i%catColors.length]};border-radius:2px"></div>
                    </div>
                    <span style="font-size:10px;font-weight:600;color:var(--text-primary);min-width:50px;text-align:right">${$fmt2(c.cost)}</span>
                </div>`;
            }).join('');
        }

    } catch(e) {
        console.error('Executive summary error:', e);
    }
}

async function loadCloudOverview() {
    const grid    = document.getElementById('coProviderGrid');
    const summBar = document.getElementById('coSummaryBar');
    const period  = document.getElementById('cloudOverviewPeriod');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);grid-column:1/-1">Loading…</div>';

    // 1. Which clouds have actual data?
    let cloudsInData = [];
    try {
        cloudsInData = await fetch('/api/costs/cloud-providers-in-data').then(r => r.json());
    } catch(e) { cloudsInData = ['azure']; }
    if (!cloudsInData.length) cloudsInData = ['azure'];

    // 2. Load per-provider dashboard data in parallel (all the tenant's clouds)
    const results = await Promise.all(
        activeClouds().map(async (cloud) => {
            try {
                const d = await fetch(`/api/dashboard?cloud_provider=${cloud}`).then(r => r.json());
                return { cloud, data: d, hasData: cloudsInData.includes(cloud) };
            } catch(e) {
                return { cloud, data: null, hasData: false };
            }
        })
    );

    // 3. Summary totals
    const totalAll      = results.reduce((s, r) => s + (r.data?.current_month?.total || 0), 0);
    const lastAll       = results.reduce((s, r) => s + (r.data?.last_month?.total  || 0), 0);
    const activeProvs   = results.filter(r => r.hasData && (r.data?.current_month?.total || 0) > 0).length;
    const totalAccounts = results.reduce((s, r) => s + ((r.data?.subscription_costs || []).filter(x => x.cost > 0).length), 0);
    const momAll        = lastAll > 0 ? ((totalAll - lastAll) / lastAll * 100) : 0;
    const avgPerDay     = results.reduce((s, r) => s + (r.data?.current_month?.avg_daily || 0), 0);
    const daysTracked   = results.reduce((m, r) => Math.max(m, r.data?.current_month?.days_elapsed || 0), 0);
    const lastMonthLabel = results[0]?.data?.last_month?.label || 'Last month';

    if (period) period.textContent = results[0]?.data?.current_month?.label || '';

    // 4. KPI strip
    if (summBar) {
        const momDir = momAll < 0 ? 'down' : 'up';
        const momArrow = momAll < 0 ? '▼' : '▲';
        summBar.innerHTML = `
            <div class="co-kpi">
                <div class="co-kpi__label">Total this month</div>
                <div class="co-kpi__value-row">
                    <span class="co-kpi__value">${_coFmtShort(totalAll)}</span>
                    <span class="co-kpi__delta delta-${momDir}">${momArrow} ${Math.abs(momAll).toFixed(1)}%</span>
                </div>
                <div class="co-kpi__sub">across all clouds</div>
            </div>
            <div class="co-kpi">
                <div class="co-kpi__label">Last month</div>
                <div class="co-kpi__value-row">
                    <span class="co-kpi__value">${_coFmtShort(lastAll)}</span>
                </div>
                <div class="co-kpi__sub">${lastMonthLabel} total</div>
            </div>
            <div class="co-kpi">
                <div class="co-kpi__label">Avg / day</div>
                <div class="co-kpi__value-row">
                    <span class="co-kpi__value">${curSym()}${Math.round(avgPerDay).toLocaleString()}</span>
                </div>
                <div class="co-kpi__sub">${daysTracked}-day average</div>
            </div>
            <div class="co-kpi">
                <div class="co-kpi__label">Active providers</div>
                <div class="co-kpi__value-row">
                    <span class="co-kpi__value">${activeProvs}</span>
                    <span class="co-kpi__sub-inline">of 3</span>
                </div>
                <div class="co-kpi__sub">${totalAccounts} accounts connected</div>
            </div>`;
    }

    // 5. Compute share_pct for each provider
    const provTotals = { azure: 0, aws: 0, gcp: 0 };
    results.forEach(r => { provTotals[r.cloud] = r.data?.current_month?.total || 0; });
    const maxProvTotal = Math.max(...Object.values(provTotals));

    // Brand palette
    const cloudColor   = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4', openai: '#10a37f', atlassian: '#0052cc', cursor: '#111111' };
    const sparkStroke  = { azure: 'var(--chart-1,#185FA5)', aws: 'var(--chart-3,#BA7517)', gcp: 'var(--chart-2,#1D9E75)', openai: '#10a37f', atlassian: '#0052cc', cursor: '#555555' };
    const cloudFull    = { azure: 'Microsoft Azure', aws: 'Amazon Web Services', gcp: 'Google Cloud', openai: 'OpenAI', atlassian: 'Atlassian', cursor: 'Cursor' };
    const logoH        = { azure: '16', aws: '13', gcp: '16', openai: '18', atlassian: '18', cursor: '16' };

    // 6. Render provider cards
    grid.innerHTML = '';

    if (activeProvs === 0) {
      grid.innerHTML = _emptyState('info',
        '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
        'No cloud providers connected',
        'Link AWS, Azure, or GCP to start tracking costs. Takes about 2 minutes.',
        [{label:'+ Add provider', primary:true, onclick:"navigateTo('cloud-providers')"}]
      );
    }

    activeClouds().forEach(cloud => {
        const r    = results.find(x => x.cloud === cloud);
        const card = document.createElement('div');

        if (!r || !r.hasData || !(r.data?.current_month?.total)) {
            card.className = 'co-empty-lg';
            card.innerHTML = `
                <img src="/static/img/${cloud}-logo.svg" alt="${cloud}" style="height:28px;opacity:0.45">
                <div style="font-size:13px;font-weight:500;color:var(--text-primary)">${cloudFull[cloud]}</div>
                <div style="font-size:12px;color:var(--text-secondary)">No cost data for this provider.</div>
                <button class="cp-btn-secondary" style="font-size:12px;margin-top:4px" onclick="navigateTo('cloud-providers')">
                    Connect ${cloudFull[cloud].split(' ')[0]}
                </button>`;
            grid.appendChild(card);
            return;
        }

        const cm      = r.data.current_month;
        const lm      = r.data.last_month;
        const mom     = lm.total > 0 ? ((cm.total - lm.total) / lm.total * 100) : 0;
        const subs    = (r.data.subscription_costs || []).filter(s => s.cost > 0);
        const topSubs = subs.slice(0, 8);
        const maxSub  = topSubs[0]?.cost || 1;
        const sharePct  = totalAll > 0 ? Math.round(cm.total / totalAll * 100) : 0;
        const isLargest = cm.total === maxProvTotal && maxProvTotal > 0;
        const momDir2   = mom < 0 ? 'down' : 'up';
        const momArrow2 = mom < 0 ? '▼' : '▲';

        // Sparkline — last 13 days of daily trend
        const trend13   = (cm.trend || []).slice(-13);
        const sparkPts  = _computeSparkPoints(trend13, 240, 32);
        const fillPts   = sparkPts && trend13.length > 1 ? `${sparkPts} 240,32 0,32` : null;
        const clr       = cloudColor[cloud];
        const strokeClr = sparkStroke[cloud];

        card.className = 'co-card-lg' + (isLargest ? ' co-card-lg--featured' : '');
        card.innerHTML = `
            <div class="co-card-lg__head">
                <div class="co-card-lg__brand">
                    <div class="co-card-lg__icon" style="background:${clr}">
                        <img src="/static/img/${cloud}-logo.svg" alt="${cloud}" style="height:${logoH[cloud]}px;filter:brightness(0) invert(1)">
                    </div>
                    <div>
                        <div class="co-card-lg__name">${cloudFull[cloud]}</div>
                        <div class="co-card-lg__sub">${subs.length} account${subs.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>
                <span class="co-card-lg__share" style="background:${clr}1a;color:${clr}">${sharePct}%</span>
            </div>

            <div class="co-card-lg__amount">
                <span class="metric-number">${curSym()}${cm.total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                <span class="co-card-lg__delta delta-${momDir2}">${momArrow2} ${Math.abs(mom).toFixed(1)}%</span>
            </div>

            <svg class="co-card-lg__spark" viewBox="0 0 240 32" preserveAspectRatio="none">
                ${fillPts ? `<polyline points="${fillPts}" fill="${clr}" fill-opacity="0.08" stroke="none"/>` : ''}
                ${sparkPts ? `<polyline points="${sparkPts}" fill="none" stroke="${strokeClr}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
            </svg>

            <div class="co-card-lg__stats">
                <div>
                    <div class="co-stat-cell__label">Last month</div>
                    <div class="co-stat-cell__value">${curSym()}${Math.round(lm.total).toLocaleString()}</div>
                </div>
                <div>
                    <div class="co-stat-cell__label">Avg / day</div>
                    <div class="co-stat-cell__value">${curSym()}${Math.round(cm.avg_daily).toLocaleString()}</div>
                </div>
                <div>
                    <div class="co-stat-cell__label">Projected</div>
                    <div class="co-stat-cell__value">${curSym()}${Math.round(cm.projected).toLocaleString()}</div>
                </div>
            </div>

            ${topSubs.length ? `
            <div>
                <div class="co-card-lg__section-head">
                    <span class="co-micro-label">Top accounts</span>
                    <span class="co-micro-label" style="font-weight:400">${subs.length} total</span>
                </div>
                <div class="co-rank-list">
                    ${topSubs.map((s, i) => `
                    <div class="co-rank-item">
                        <div class="co-rank-row">
                            <span class="co-rank-name" title="${_esc(s.name)}">${_esc(s.name)}</span>
                            <span class="co-rank-amt">${curSym()}${Math.round(s.cost).toLocaleString()}</span>
                        </div>
                        <div class="co-rank-bar"><div class="co-rank-bar__fill" style="width:${Math.round(s.cost/maxSub*100)}%;background:${clr};opacity:${Math.max(0.35, 1-i*0.09)}"></div></div>
                    </div>`).join('')}
                </div>
            </div>` : ''}

            <div class="co-card-lg__actions">
                <button class="cp-btn-secondary" style="flex:1;justify-content:center" onclick="setCloudFilter('${cloud}');navigateTo('executive')">View dashboard</button>
                <button class="co-btn-link" onclick="setCloudFilter('${cloud}');navigateTo('costs')">Cost data →</button>
            </div>`;

        grid.appendChild(card);
    });
}

async function _renderCoTrendChart(results) {
    // Build last-6-month labels
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ label: d.toLocaleString('default',{month:'short',year:'2-digit'}), year: d.getFullYear(), month: d.getMonth()+1 });
    }

    // Fetch monthly data per provider (all the tenant's clouds)
    const colors6 = cloudColor;
    const datasets = [];

    await Promise.all(activeClouds().map(async (cloud) => {
        const r = results.find(x => x.cloud === cloud);
        if (!r?.hasData) return;
        try {
            const monthly = await fetch(`/api/monthly?cloud_provider=${cloud}`).then(r => r.json());
            const vals = months.map(m => {
                const key = `${m.year}-${String(m.month).padStart(2,'0')}`;
                const row = monthly.find(x => (x.month || '').startsWith(key));
                return row ? (row.total_cost || 0) : 0;
            });
            if (vals.some(v => v > 0)) {
                datasets.push({ label: cloudFull[cloud], data: vals, borderColor: colors6[cloud], backgroundColor: colors6[cloud]+'33', fill: true, tension: 0.3, pointRadius: 4 });
            }
        } catch(e) { /* skip */ }
    }));

    if (!datasets.length) return;
    renderChart('coTrendChart', 'line', {
        labels: months.map(m => m.label),
        datasets
    }, 'Monthly Spend', { scales: { y: { ticks: { callback: v => curSym()+v.toLocaleString() } } } });
}

// ─── Costs Table ─────────────────────────────────────────────────────────
let costsSelectedCloud = 'azure';
let costPageOffset = 0;
let costPageLimit = 100;
let costPageTotal = 0;

// Sub-table sort state
let _subTableData        = [];
let _subTableIsService   = false;
let _subTableSortBy      = 'cost';
let _subTableSortDir     = 'desc';
let _drillBaseParams     = new URLSearchParams();

function sortSubTable(col) {
    if (_subTableSortBy === col) {
        _subTableSortDir = _subTableSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        _subTableSortBy = col;
        _subTableSortDir = col === 'cost' ? 'desc' : 'asc';
    }
    _renderSubTable();
}

function _renderSubTable() {
    const sorted = [..._subTableData].sort((a, b) => {
        let av, bv;
        if (_subTableSortBy === 'cost') { av = a.total_cost || 0; bv = b.total_cost || 0; }
        else if (_subTableSortBy === 'name') { av = (a.subscription_name || a.service_name || '').toLowerCase(); bv = (b.subscription_name || b.service_name || '').toLowerCase(); }
        else if (_subTableSortBy === 'account') { av = (a.account || '').toLowerCase(); bv = (b.account || '').toLowerCase(); }
        else { av = ''; bv = ''; }
        if (av < bv) return _subTableSortDir === 'asc' ? -1 : 1;
        if (av > bv) return _subTableSortDir === 'asc' ? 1 : -1;
        return 0;
    });

    // Update sort indicators
    ['cloud','account','name','cost'].forEach(col => {
        const el = document.getElementById(`sub-sort-${col}`);
        if (!el) return;
        if (col === _subTableSortBy) el.textContent = _subTableSortDir === 'asc' ? '↑' : '↓';
        else el.textContent = '↕';
    });

    const bySubBody = document.getElementById('costBySubscriptionBody');
    if (!bySubBody) return;
    const awsLogo = `<img src="/static/img/aws-logo.svg" alt="AWS" style="height:10px;vertical-align:middle;margin-right:4px">`;

    if (!sorted.length) {
        bySubBody.innerHTML = `<tr><td colspan="${_subTableIsService ? 4 : 2}" style="text-align:center;padding:20px;color:var(--text-secondary)">No data found for current filters.</td></tr>`;
        return;
    }
    if (_subTableIsService) {
        bySubBody.innerHTML = sorted.map(s => {
            const svcAttr = (s.service_name || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
            return `<tr style="cursor:pointer" title="Click to see individual resources"
                data-service="${svcAttr}" onclick="openServiceDrill(this.dataset.service)">
                <td>${awsLogo}AWS</td>
                <td style="color:var(--text-secondary)">${s.account || ''}</td>
                <td style="color:var(--accent)">${s.service_name || '-'} <span style="font-size:10px;opacity:0.7">&#8599;</span></td>
                <td style="text-align:right;font-weight:500;color:var(--text-primary)">${curSym()}${(s.total_cost || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
            </tr>`;
        }).join('');
    } else {
        bySubBody.innerHTML = sorted.map(s => `
            <tr>
                <td>${s.subscription_name || s.subscription_id || '-'}</td>
                <td style="text-align:right;font-weight:500;color:var(--text-primary)">${curSym()}${(s.total_cost || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
            </tr>`).join('');
    }
}

async function refreshCostsTable(btn) {
    if (btn) { btn.disabled = true; const icon = document.getElementById('costsRefreshIcon'); if (icon) icon.style.animation = 'spin 0.8s linear infinite'; }
    await loadCostsTable();
    if (btn) { btn.disabled = false; const icon = document.getElementById('costsRefreshIcon'); if (icon) icon.style.animation = ''; }
}

function openServiceDrill(serviceName) {
    const p = new URLSearchParams();
    p.set('service', serviceName);
    const cp = _drillBaseParams.get('cloud_provider') || '';
    if (cp) p.set('cloud', cp);
    const subs = _drillBaseParams.get('subscription_ids') || '';
    if (subs) p.set('account', subs);
    const df = _drillBaseParams.get('date_from') || '';
    const dt = _drillBaseParams.get('date_to') || '';
    if (df) p.set('date_from', df);
    if (dt) p.set('date_to', dt);
    window.open('/service-detail?' + p.toString(), '_blank');
}

// Cost Data multiselect state
let cdRgOptions  = [];   // string[]
let cdSvcOptions = [];   // string[]
let cdResOptions = [];   // string[]
let cdAccOptions = [];   // {id, label}[]
let cdRgSelected  = new Set();
let cdSvcSelected = new Set();
let cdResSelected = new Set();
let cdAccSelected = new Set(); // stores provider_ids

const CD_MS = {
    rg:  { panel: 'cdRgPanel',  list: 'cdRgList',  search: 'cdRgSearch',  trigger: 'cdRgTriggerText'  },
    svc: { panel: 'cdSvcPanel', list: 'cdSvcList', search: 'cdSvcSearch', trigger: 'cdSvcTriggerText' },
    res: { panel: 'cdResPanel', list: 'cdResList', search: 'cdResSearch', trigger: 'cdResTriggerText' },
    acc: { panel: 'cdAccPanel', list: 'cdAccList', search: 'cdAccSearch', trigger: 'cdAccTriggerText' },
};

function cdOpts(key) { return key === 'rg' ? cdRgOptions : key === 'svc' ? cdSvcOptions : key === 'res' ? cdResOptions : cdAccOptions; }
function cdSel(key)  { return key === 'rg' ? cdRgSelected : key === 'svc' ? cdSvcSelected : key === 'res' ? cdResSelected : cdAccSelected; }

function cdTogglePanel(key) {
    const cfg = CD_MS[key];
    const panel = document.getElementById(cfg.panel);
    if (!panel) return;
    const wasHidden = panel.hasAttribute('hidden');
    Object.values(CD_MS).forEach(c => {
        const p = document.getElementById(c.panel);
        if (p) { p.setAttribute('hidden', ''); p.style.left = ''; p.style.right = ''; }
    });
    if (wasHidden) {
        panel.removeAttribute('hidden');
        // Keep the panel within the viewport horizontally
        const rect = panel.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            panel.style.left = 'auto';
            panel.style.right = '0';
        }
        document.getElementById(cfg.search)?.focus();
    }
}

function cdRenderList(key) {
    const cfg = CD_MS[key];
    const query = (document.getElementById(cfg.search)?.value || '').toLowerCase();
    const list = document.getElementById(cfg.list);
    if (!list) return;
    const sel = cdSel(key);
    const opts = cdOpts(key);
    const items = key === 'acc' ? opts : opts.map(o => ({ id: o, label: o === '__BLANK__' ? '(Blank)' : o === '__RESERVATIONS__' ? 'Reservations' : key === 'res' ? _friendlyAwsResource(o) : o }));
    const filtered = items.filter(o => o.label.toLowerCase().includes(query));
    list.innerHTML = filtered.map(o => {
        const checked = sel.has(o.id) ? 'checked' : '';
        const safeId = o.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<label class="multiselect__option"><input type="checkbox" ${checked} onchange="cdToggleOpt('${key}','${safeId}',this.checked)"> ${o.label}</label>`;
    }).join('');
}

function cdToggleOpt(key, id, checked) {
    const sel = cdSel(key);
    if (checked) sel.add(id); else sel.delete(id);
    cdUpdateTrigger(key);
    costPageOffset = 0;
    loadCostsTable();
}

function cdSelectAll(key) {
    const sel = cdSel(key);
    cdOpts(key).forEach(o => sel.add(typeof o === 'object' ? o.id : o));
    cdRenderList(key);
    cdUpdateTrigger(key);
    costPageOffset = 0;
    loadCostsTable();
}

function cdDeselectAll(key) {
    cdSel(key).clear();
    cdRenderList(key);
    cdUpdateTrigger(key);
    costPageOffset = 0;
    loadCostsTable();
}

function cdFilterList(key) { cdRenderList(key); }

function cdUpdateTrigger(key) {
    const sel = cdSel(key);
    const el = document.getElementById(CD_MS[key].trigger);
    if (!el) return;
    if (sel.size === 0) {
        el.textContent = 'All'; el.className = 'multiselect__placeholder';
    } else if (sel.size === 1) {
        const v = [...sel][0];
        const opt = key === 'acc' ? cdAccOptions.find(o => o.id === v) : null;
        el.textContent = opt ? opt.label : (v === '__BLANK__' ? '(Blank)' : v === '__RESERVATIONS__' ? 'Reservations' : v);
        el.className = 'multiselect__summary';
    } else {
        el.textContent = `${sel.size} selected`; el.className = 'multiselect__summary';
    }
}

function populateCdMultiselect(key, options) {
    // Resource list also gets a single "Reservations" entry (selects all reservation
    // orders) since the individual reservation GUIDs are excluded from the list.
    const newOpts = key === 'res' ? ['__BLANK__', '__RESERVATIONS__', ...options] : ['__BLANK__', ...options];
    if (key === 'rg') cdRgOptions = newOpts;
    else if (key === 'res') cdResOptions = newOpts;
    else cdSvcOptions = newOpts;
    const sel = cdSel(key);
    const allowed = new Set(newOpts);
    [...sel].forEach(s => { if (!allowed.has(s)) sel.delete(s); });
    cdRenderList(key);
    cdUpdateTrigger(key);
}

function populateCdAccounts(accounts) {
    cdAccOptions = [{ id: '__BLANK__', label: '(Blank)' }, ...accounts.map(a => ({ id: a.subscription_id || a.provider_id, label: a.name || a.subscription_id || a.provider_id }))];
    const allowed = new Set(cdAccOptions.map(o => o.id));
    [...cdAccSelected].forEach(s => { if (!allowed.has(s)) cdAccSelected.delete(s); });
    cdRenderList('acc');
    cdUpdateTrigger('acc');
}

function resetCostFilters() {
    const search = document.getElementById('costSearch');
    if (search) search.value = '';
    cdRgSelected.clear();  cdUpdateTrigger('rg');
    cdSvcSelected.clear(); cdUpdateTrigger('svc');
    cdResSelected.clear(); cdUpdateTrigger('res');
    cdAccSelected.clear(); cdUpdateTrigger('acc');
    const costsClient = document.getElementById('costsClientFilter');
    if (costsClient) costsClient.value = '';
    costPageOffset = 0;
    // Reset to the tenant's default cloud (the first one it has data for)
    _pickDefaultCostsCloud().then(cloud => {
        costsSelectedCloud = cloud;
        document.querySelectorAll('[data-costs-cloud]').forEach(b => b.classList.toggle('active', b.dataset.costsCloud === cloud));
        _updateCostsCloudFilters(cloud);
        loadCostsTable();
    });
}

// ─── Per-column header filter popover state (declared before the click handler) ──
let _colFilterKey = null;

// Friendly label for an AWS resource ARN — show the family / short name instead
// of the full ARN in the Resource filter (the full ARN stays the filter value).
//   arn:aws:ecs:…:task/CA-UAT-CLR/64046c99…  → "CA-UAT-CLR (64046c99)"
//   arn:aws:elasticloadbalancing:…:loadbalancer/app/my-lb/abc → "my-lb"
//   arn:aws:rds:…:db:prod-db                 → "prod-db"
//   other ARNs                               → last path segment
function _friendlyAwsResource(name) {
    if (!name || !name.startsWith('arn:')) return name;
    const parts = name.split(':');
    const tail = parts.length >= 6 ? parts.slice(5).join(':') : name;   // strip arn:svc:region:acct:
    if (tail.startsWith('loadbalancer/')) { const p = tail.split('/'); return p[2] || p[p.length - 1]; }
    if (tail.startsWith('db:'))           { return tail.split(':')[1] || tail; }
    if (tail.startsWith('task/'))         { const p = tail.split('/'); return p.length >= 3 ? `${p[1]} (${p[2].slice(0, 8)})` : (p[1] || tail); }
    const seg = tail.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1] : tail;
}

// Friendly label for a resource name. Azure reservation IDs are bare GUIDs with
// no name — show "Reservation (xxxxxxxx…)" so the filter list is readable.
function _friendlyResource(name) {
    if (!name) return name;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name)) {
        return 'Reservation (' + name.slice(0, 8) + '…)';
    }
    return name;
}

// Highlight each column funnel icon when that column has an active filter, so
// it's obvious a filter is applied.
function _updateColFilterIndicators() {
    document.querySelectorAll('[data-colf]').forEach(ic => {
        const key = ic.getAttribute('data-colf');
        const active = cdSel(key) && cdSel(key).size > 0;
        ic.style.opacity = active ? '1' : '0.85';
        ic.style.color   = active ? 'var(--accent)' : '';
        ic.style.fill    = active ? 'var(--accent)' : 'none';
    });
}

// Close CD panels + the column-filter popover when clicking outside them.
document.addEventListener('click', e => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (!t.closest('#cdRgMultiselect'))  document.getElementById('cdRgPanel')?.setAttribute('hidden', '');
    if (!t.closest('#cdSvcMultiselect')) document.getElementById('cdSvcPanel')?.setAttribute('hidden', '');
    if (!t.closest('#cdResMultiselect')) document.getElementById('cdResPanel')?.setAttribute('hidden', '');
    if (!t.closest('#cdAccMultiselect')) document.getElementById('cdAccPanel')?.setAttribute('hidden', '');
    // Per-column header filter popover (the funnel icons themselves stop propagation)
    if (_colFilterKey && !t.closest('#colFilterPop') && !t.closest('.col-filter-ic')) {
        closeColFilter();
    }
});

// ─── Per-column header filter popover (reuses the toolbar multiselect state) ──
// NOTE: toggle display directly — the [hidden] attribute is overridden by the
// popover's inline `display`, so setAttribute('hidden') alone won't hide it.
function closeColFilter() {
    const pop = document.getElementById('colFilterPop');
    if (pop) { pop.style.display = 'none'; pop.setAttribute('hidden', ''); }
    const bd = document.getElementById('colFilterBackdrop');
    if (bd) { bd.style.display = 'none'; bd.setAttribute('hidden', ''); }
    _colFilterKey = null;
}

function openColFilter(ev, key) {
    ev.stopPropagation();              // don't trigger column sort
    ev.preventDefault();
    const pop = document.getElementById('colFilterPop');
    const backdrop = document.getElementById('colFilterBackdrop');
    if (!pop) return;
    const alreadyOpen = pop.style.display !== 'none' && _colFilterKey === key;
    if (alreadyOpen) { closeColFilter(); return; }
    _colFilterKey = key;
    const rect = ev.currentTarget.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 270)) + 'px';
    const search = document.getElementById('colFilterSearch');
    if (search) search.value = '';
    if (backdrop) { backdrop.style.display = 'block'; backdrop.removeAttribute('hidden'); }
    pop.style.display = 'flex';
    pop.removeAttribute('hidden');
    renderColFilter();
    if (search) search.focus();
}

function renderColFilter() {
    const key = _colFilterKey;
    if (!key) return;
    const q = (document.getElementById('colFilterSearch')?.value || '').toLowerCase();
    const sel = cdSel(key);
    const opts = cdOpts(key);
    const items = key === 'acc' ? opts : opts.map(o => ({ id: o, label: o === '__BLANK__' ? '(Blank)' : o === '__RESERVATIONS__' ? 'Reservations' : key === 'res' ? _friendlyAwsResource(o) : o }));
    const filtered = items.filter(o => o.label.toLowerCase().includes(q));
    const list = document.getElementById('colFilterList');
    if (!list) return;
    list.innerHTML = filtered.length
        ? filtered.map(o => {
            const checked = sel.has(o.id) ? 'checked' : '';
            const safeId = String(o.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `<label class="multiselect__option"><input type="checkbox" ${checked} onchange="colFilterToggle('${safeId}',this.checked)"> ${o.label}</label>`;
          }).join('')
        : '<div style="padding:8px 10px;font-size:12px;color:var(--text-secondary)">No options</div>';
}

function colFilterToggle(id, checked) {
    const key = _colFilterKey; if (!key) return;
    const sel = cdSel(key);
    if (checked) sel.add(id); else sel.delete(id);
    cdUpdateTrigger(key);   // keep the toolbar filter chip in sync
    // Stay open so you can tick multiple values; the table updates live and the
    // "Done" button (or clicking outside) closes the popover.
    costPageOffset = 0;
    try { loadCostsTable(); } catch (e) { console.error('loadCostsTable failed', e); }
}

function colFilterSelectAll() {
    const key = _colFilterKey; if (!key) return;
    const sel = cdSel(key);
    cdOpts(key).forEach(o => sel.add(typeof o === 'object' ? o.id : o));
    renderColFilter(); cdUpdateTrigger(key);
    costPageOffset = 0; loadCostsTable();
}

function colFilterClear() {
    const key = _colFilterKey; if (!key) return;
    cdSel(key).clear();
    renderColFilter(); cdUpdateTrigger(key);
    costPageOffset = 0; loadCostsTable();
}

function getMultiSelectValues(id) {
    const sel = document.getElementById(id);
    if (!sel) return [];
    return Array.from(sel.selectedOptions || []).map(o => o.value).filter(v => v !== '');
}

function setCostsCloud(btn, cloud) {
    costsSelectedCloud = cloud;
    costPageOffset = 0;
    document.querySelectorAll('[data-costs-cloud]').forEach(b => b.classList.toggle('active', b.dataset.costsCloud === cloud));
    const awsHint = document.getElementById('costsAwsHint');
    if (awsHint) awsHint.style.display = (cloud === 'aws') ? 'block' : 'none';
    _updateCostsCloudFilters(cloud);
    loadCostsTable();
}

// ── Atlassian user directory (behind the per-user cost) ─────────────────────
let _atlUsers = [];
function openAtlassianUsers() {
    const modal = document.getElementById('atlassianUsersModal');
    // The modal markup lives inside the (hidden) Cloud Providers section; move it
    // to <body> so it renders when opened from the Cost Data page.
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
    if (modal) modal.style.display = 'flex';
    document.getElementById('atlUsersTbody').innerHTML =
        '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted)">Loading…</td></tr>';
    ['atlUsersTotal', 'atlUsersActive', 'atlUsersDeactivated'].forEach(id => document.getElementById(id).textContent = '…');
    fetch('/api/atlassian/users').then(r => r.json()).then(d => {
        _atlUsers = d.users || [];
        const s = d.summary || {};
        document.getElementById('atlUsersTotal').textContent       = s.total || 0;
        document.getElementById('atlUsersActive').textContent      = s.active || 0;
        document.getElementById('atlUsersDeactivated').textContent = s.deactivated || 0;
        document.getElementById('atlUsersSubtitle').textContent =
            `${s.total || 0} users · ${s.active || 0} active · ${s.deactivated || 0} deactivated`
            + (d.has_last_active ? '' : ' · last-active unavailable');
        _renderAtlUsers();
    }).catch(() => {
        document.getElementById('atlUsersTbody').innerHTML =
            '<tr><td colspan="5" style="padding:24px;text-align:center;color:#c53030">Failed to load users</td></tr>';
    });
}

function _renderAtlUsers() {
    const q      = (document.getElementById('atlUserSearch').value || '').toLowerCase();
    const filter = document.getElementById('atlUserFilter').value || 'all';
    const isActive = u => (u.status || '').toLowerCase() === 'active';
    const rows = _atlUsers.filter(u => {
        const mq = !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
        const mf = filter === 'all' || (filter === 'active' ? isActive(u) : !isActive(u));
        return mq && mf;
    });
    const tbody = document.getElementById('atlUsersTbody');
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted)">No users match.</td></tr>';
        document.getElementById('atlUsersCount').textContent = '';
        return;
    }
    const badge = st => {
        const active = (st || '').toLowerCase() === 'active';
        const color  = active ? '#276749' : '#9b2c2c';
        const bg     = active ? '#c6f6d5' : '#fed7d7';
        const label  = st ? st.replace(/_/g, ' ') : '—';
        return `<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:${bg};color:${color};text-transform:capitalize">${label}</span>`;
    };
    tbody.innerHTML = rows.map(u => `
        <tr style="border-top:1px solid var(--border)">
            <td style="padding:10px 14px;font-size:13px;color:var(--text-primary)">${_esc(u.name || '—')}</td>
            <td style="padding:10px 14px;font-size:13px;color:var(--text-secondary)">${_esc(u.email || '—')}</td>
            <td style="padding:10px 14px;text-align:center">${badge(u.status)}</td>
            <td style="padding:10px 14px;font-size:13px;color:var(--text-secondary)">${_esc(u.last_active || '—')}</td>
            <td style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">${(u.products || []).map(_esc).join(', ') || '—'}</td>
        </tr>`).join('');
    document.getElementById('atlUsersCount').textContent =
        `Showing ${rows.length} of ${_atlUsers.length} user${_atlUsers.length !== 1 ? 's' : ''}`;
}

// Group by → User: per-user cost breakdown rendered into #atlUserCostBody.
let _atlUserRows = [];
let _atlMultiOrg = false;
let _atlUserSort = { col: 'cost', dir: 'desc' };
const _atlUserFilters = { status: new Set(), products: new Set() };  // empty = no filter
const _atlMoney = v => '$' + (v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Coloured status pill matching Atlassian Admin's statuses.
function _atlStatusBadge(st) {
    const s = (st || '').toLowerCase();
    const C = {
        active:       ['#c6f6d5', '#276749'],   // green
        invited:      ['#feebc8', '#9c4221'],   // amber
        suspended:    ['#fefcbf', '#975a16'],   // yellow
        deactivated:  ['#e2e8f0', '#4a5568'],   // grey
        for_deletion: ['#fed7d7', '#9b2c2c'],   // red
    };
    const [bg, fg] = C[s] || ['#e2e8f0', '#4a5568'];
    const label = s ? s.replace(/_/g, ' ') : 'unknown';
    return `<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:${bg};color:${fg};text-transform:capitalize;white-space:nowrap">${label}</span>`;
}

// Small provider logo prefixes for the dedicated per-user / usage tables, so the
// cloud is identified on each row (like the Azure cost table's Cloud column).
const _ATL_LOGO = '<img src="/static/img/atlassian-logo.svg" alt="" style="height:14px;width:14px;vertical-align:-3px;margin-right:7px">';
const _CUR_LOGO = '<img src="/static/img/cursor-logo.svg" alt="" style="height:14px;width:14px;vertical-align:-3px;margin-right:7px">';

// Cursor billing-cycle label (e.g. "cycle 14 Jun – 14 Jul"). Cursor bills per
// cycle, not calendar month — show the actual window so it's unambiguous.
let _curCycleInfo = { start: null, end: null };
function _curCycleLabel() {
    if (!_curCycleInfo.start) return 'current billing cycle';
    const f = s => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return _curCycleInfo.end ? `cycle ${f(_curCycleInfo.start)} – ${f(_curCycleInfo.end)}` : `cycle from ${f(_curCycleInfo.start)}`;
}

// Cursor Group By → User: live per-member spend (on-demand cost + included showback).
let _curRows = [];
let _curTotals = { total: 0, included: 0 };
let _curSortState = { col: 'on_demand', dir: 'desc' };
const _curFilters = { role: new Set() };
const _curMoney = v => '$' + (v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function renderCursorUserCosts() {
    const body = document.getElementById('cursorUserBody');
    if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading…</td></tr>';
    try {
        const d = await fetch('/api/cursor/user-costs').then(r => r.json());
        _curRows = d.rows || [];
        _curTotals = { total: d.total || 0, included: d.included_total || 0 };
        _curCycleInfo = { start: d.cycle_start, end: d.cycle_end };
        _curRenderRows();
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:#c53030">Failed to load Cursor per-user costs</td></tr>';
    }
}

function _curRenderRows() {
    const body = document.getElementById('cursorUserBody');
    const subtitleBar = document.getElementById('costsSubtitleBar');
    const countChip = document.getElementById('costRowCountChip');
    if (!body) return;

    let rows = _curRows.filter(u => !_curFilters.role.size || _curFilters.role.has((u.role || '').toLowerCase()));
    const { col, dir } = _curSortState;
    const val = u => (col === 'included' || col === 'on_demand') ? (u[col] || 0) : (u[col] || '');
    rows = rows.slice().sort((a, b) => {
        const va = val(a), vb = val(b);
        const c = (typeof va === 'number') ? va - vb : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' });
        return dir === 'asc' ? c : -c;
    });

    const onDemand = rows.reduce((s, u) => s + (u.on_demand || 0), 0);
    const included = rows.reduce((s, u) => s + (u.included || 0), 0);
    if (subtitleBar) subtitleBar.innerHTML = `Showing ${rows.length} member${rows.length !== 1 ? 's' : ''} · <span style="color:var(--text-muted)">${_curCycleLabel()}</span> · On-Demand <strong>${_curMoney(onDemand)}</strong> <span style="color:var(--text-muted)">· Included usage ${_curMoney(included)}</span>`;
    if (countChip) countChip.textContent = `${rows.length} members`;

    ['name', 'email', 'role', 'included', 'on_demand'].forEach(c => {
        const el = document.getElementById('cur-sort-' + c);
        if (el) el.textContent = (c === col) ? (dir === 'asc' ? '↑' : '↓') : '↕';
    });
    document.querySelectorAll('[data-curf]').forEach(ic => {
        const on = _curFilters[ic.dataset.curf]?.size > 0;
        ic.style.opacity = on ? '1' : '0.85';
        ic.style.color = on ? 'var(--accent)' : '';
        ic.style.fill = on ? 'var(--accent)' : 'none';
    });

    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-secondary)">No members match the filter.</td></tr>';
        return;
    }
    const roleBadge = r => `<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;background:#ede9fe;color:#6d28d9;text-transform:capitalize">${_esc(r || 'member')}</span>`;
    body.innerHTML = rows.map(u => `
        <tr>
            <td style="font-weight:500">${_CUR_LOGO}${_esc(u.name || '—')}</td>
            <td style="color:var(--text-secondary)">${_esc(u.email || '—')}</td>
            <td style="text-align:center">${roleBadge(u.role)}</td>
            <td style="text-align:right;color:var(--text-secondary)">${_curMoney(u.included || 0)}</td>
            <td style="text-align:right;font-weight:600;color:${(u.on_demand || 0) > 0 ? '#c05621' : 'var(--text-primary)'}">${_curMoney(u.on_demand || 0)}</td>
        </tr>`).join('');
}

function _curSort(col) {
    if (_curSortState.col === col) _curSortState.dir = _curSortState.dir === 'asc' ? 'desc' : 'asc';
    else _curSortState = { col, dir: (col === 'included' || col === 'on_demand') ? 'desc' : 'asc' };
    _curRenderRows();
}
function _curOpenFilter(ev) {
    const pop = document.getElementById('curColFilter');
    const list = document.getElementById('curColFilterList');
    const vals = [...new Set(_curRows.map(u => (u.role || '').toLowerCase()).filter(Boolean))].sort();
    const sel = _curFilters.role;
    list.innerHTML = vals.map(v => `
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:2px 0">
            <input type="checkbox" value="${_escAttr(v)}" ${sel.has(v) ? 'checked' : ''} onchange="_curToggleFilter('${_escAttr(v)}',this.checked)">
            <span style="text-transform:capitalize">${_esc(v)}</span>
        </label>`).join('') || '<div style="font-size:12px;color:var(--text-muted)">No roles</div>';
    const r = ev.currentTarget.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.display = 'block';
    document.getElementById('curColFilterBackdrop').style.display = 'block';
}
function _curToggleFilter(v, on) { if (on) _curFilters.role.add(v); else _curFilters.role.delete(v); }
function _curClearFilter() { _curFilters.role.clear(); _curCloseFilter(); }
function _curCloseFilter() {
    document.getElementById('curColFilter').style.display = 'none';
    document.getElementById('curColFilterBackdrop').style.display = 'none';
    _curRenderRows();
}

// Cursor Group By → Model / User × Model (usage-events breakdown).
let _cuRows = [];
let _cuBy = 'model';
let _cuSort = { col: 'on_demand', dir: 'desc' };
const _cuCols = {
    model:      [['model', 'Model', 'l'], ['included', 'Included', 'r'], ['on_demand', 'On-Demand', 'r'], ['tokens', 'Tokens', 'r'], ['events', 'Events', 'r']],
    user_model: [['email', 'User', 'l'], ['model', 'Model', 'l'], ['included', 'Included', 'r'], ['on_demand', 'On-Demand', 'r'], ['tokens', 'Tokens', 'r']],
};
async function renderCursorUsage(by) {
    _cuBy = (by === 'user_model') ? 'user_model' : 'model';
    _cuSort = { col: 'on_demand', dir: 'desc' };
    const body = document.getElementById('cursorUsageBody');
    if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading…</td></tr>';
    try {
        const d = await fetch('/api/cursor/usage?by=' + _cuBy).then(r => r.json());
        _cuRows = d.rows || [];
        _curCycleInfo = { start: d.cycle_start, end: d.cycle_end };
        _cuRenderRows();
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:#c53030">Failed to load Cursor usage</td></tr>';
    }
}
function _cuRenderRows() {
    const head = document.getElementById('cursorUsageHead');
    const body = document.getElementById('cursorUsageBody');
    const subtitleBar = document.getElementById('costsSubtitleBar');
    const countChip = document.getElementById('costRowCountChip');
    const cols = _cuCols[_cuBy];
    const fmt = v => '$' + (v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const num = v => (v || 0).toLocaleString();
    // Header with sort indicators
    head.innerHTML = cols.map(([key, label, align]) => {
        const ind = _cuSort.col === key ? (_cuSort.dir === 'asc' ? '↑' : '↓') : '↕';
        return `<th class="sortable-th" onclick="_cuSortBy('${key}')" style="cursor:pointer;white-space:nowrap;text-align:${align === 'r' ? 'right' : 'left'}">${label} <span class="sort-indicator">${ind}</span></th>`;
    }).join('');
    // Sort
    const { col, dir } = _cuSort;
    const rows = _cuRows.slice().sort((a, b) => {
        const va = a[col], vb = b[col];
        const c = (typeof va === 'number') ? va - vb : String(va || '').localeCompare(String(vb || ''), undefined, { sensitivity: 'base' });
        return dir === 'asc' ? c : -c;
    });
    const od = rows.reduce((s, r) => s + (r.on_demand || 0), 0);
    const inc = rows.reduce((s, r) => s + (r.included || 0), 0);
    const label = _cuBy === 'user_model' ? 'user-model pairs' : 'models';
    if (subtitleBar) subtitleBar.innerHTML = `Showing ${rows.length} ${label} · <span style="color:var(--text-muted)">${_curCycleLabel()}</span> · On-Demand <strong>${fmt(od)}</strong> <span style="color:var(--text-muted)">· Included ${fmt(inc)}</span>`;
    if (countChip) countChip.textContent = `${rows.length} ${label}`;
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${cols.length}" style="text-align:center;padding:40px;color:var(--text-secondary)">No Cursor usage yet — Sync from Integrations → Cursor.</td></tr>`;
        return;
    }
    body.innerHTML = rows.map(r => '<tr>' + cols.map(([key, , align], ci) => {
        let v;
        if (key === 'tokens' || key === 'events') v = num(r[key]);
        else if (key === 'included' || key === 'on_demand') v = fmt(r[key]);
        else v = (ci === 0 ? _CUR_LOGO : '') + _esc(r[key] || '—');
        const style = align === 'r'
            ? `text-align:right;${key === 'on_demand' ? `font-weight:600;color:${(r.on_demand || 0) > 0 ? '#c05621' : 'var(--text-primary)'}` : 'color:var(--text-secondary)'}`
            : 'font-weight:500';
        return `<td style="${style}">${v}</td>`;
    }).join('') + '</tr>').join('');
}
function _cuSortBy(col) {
    if (_cuSort.col === col) _cuSort.dir = _cuSort.dir === 'asc' ? 'desc' : 'asc';
    else _cuSort = { col, dir: (col === 'model' || col === 'email') ? 'asc' : 'desc' };
    _cuRenderRows();
}

// OpenAI Group By → Model / API Capability / Spend Category.
async function renderOpenAIGrouped(by) {
    const labels = { model: 'Model', capability: 'API Capability', category: 'Spend Category' };
    const hdr  = document.getElementById('openaiGroupLabelHeader');
    const body = document.getElementById('openaiGroupBody');
    const subtitleBar = document.getElementById('costsSubtitleBar');
    const countChip = document.getElementById('costRowCountChip');
    if (hdr) hdr.textContent = labels[by] || 'Model';
    if (body) body.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading…</td></tr>';
    const p = new URLSearchParams({ by });
    const df = document.getElementById('costDateFrom')?.value;
    const dt = document.getElementById('costDateTo')?.value;
    if (df) p.set('date_from', df);
    if (dt) p.set('date_to', dt);
    try {
        const d = await fetch('/api/openai/grouped?' + p).then(r => r.json());
        const rows = d.rows || [];
        if (subtitleBar) subtitleBar.innerHTML = `Showing ${rows.length} ${labels[by].toLowerCase()}${rows.length !== 1 ? (by === 'capability' ? ' capabilities' : 's') : ''} · Total <strong>${_atlMoney(d.total || 0)}</strong>`;
        if (countChip) countChip.textContent = `${rows.length} ${labels[by].toLowerCase()}s`;
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:40px;color:var(--text-secondary)">No OpenAI cost data for this range.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(r => `
            <tr>
                <td style="font-weight:500">${_esc(r.label || '—')}</td>
                <td style="text-align:right;font-weight:600">${_atlMoney(r.cost || 0)}</td>
            </tr>`).join('');
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:40px;color:#c53030">Failed to load OpenAI breakdown</td></tr>';
    }
}

async function renderAtlassianUserCosts() {
    const body = document.getElementById('atlUserCostBody');
    if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading…</td></tr>';
    try {
        const d = await fetch('/api/atlassian/user-costs').then(r => r.json());
        _atlUserRows = d.rows || [];
        // Show the Organization column only when more than one Atlassian account exists.
        const orgHdr = document.getElementById('atlUserOrgHeader');
        _atlMultiOrg = (d.org_count || 0) > 1;
        if (orgHdr) orgHdr.style.display = _atlMultiOrg ? '' : 'none';
        _atlRenderUserRows();
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#c53030">Failed to load per-user costs</td></tr>';
    }
}

function _atlRenderUserRows() {
    const body = document.getElementById('atlUserCostBody');
    const subtitleBar = document.getElementById('costsSubtitleBar');
    const countChip = document.getElementById('costRowCountChip');
    if (!body) return;

    // Apply column filters
    let rows = _atlUserRows.filter(u => {
        if (_atlUserFilters.status.size && !_atlUserFilters.status.has((u.status || '').toLowerCase())) return false;
        if (_atlUserFilters.products.size && !(u.products || []).some(p => _atlUserFilters.products.has(p))) return false;
        return true;
    });
    // Apply sort
    const { col, dir } = _atlUserSort;
    const val = u => col === 'cost' ? (u.cost || 0)
                   : col === 'products' ? (u.products || []).join(', ')
                   : (u[col] || '');
    rows = rows.slice().sort((a, b) => {
        const va = val(a), vb = val(b);
        const c = (typeof va === 'number') ? va - vb : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' });
        return dir === 'asc' ? c : -c;
    });

    const total = rows.reduce((s, u) => s + (u.cost || 0), 0);
    if (subtitleBar) subtitleBar.innerHTML = `Showing ${rows.length} user${rows.length !== 1 ? 's' : ''} · <span style="color:var(--text-muted)">current month</span> · Total <strong>${_atlMoney(total)}</strong>`;
    if (countChip) countChip.textContent = `${rows.length} users`;

    // Sort indicators
    ['org_name', 'name', 'email', 'status', 'last_active', 'products', 'cost'].forEach(c => {
        const el = document.getElementById('atl-sort-' + c);
        if (el) el.textContent = (c === col) ? (dir === 'asc' ? '↑' : '↓') : '↕';
    });
    // Active-filter highlight on funnels — solid accent fill when a filter is on,
    // matching the standard cost-table funnels.
    document.querySelectorAll('[data-atlf]').forEach(ic => {
        const on = _atlUserFilters[ic.dataset.atlf]?.size > 0;
        ic.style.opacity = on ? '1' : '0.85';
        ic.style.color = on ? 'var(--accent)' : '';
        ic.style.fill  = on ? 'var(--accent)' : 'none';
    });

    const cols = _atlMultiOrg ? 7 : 6;
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:40px;color:var(--text-secondary)">No users match the filters.</td></tr>`;
        return;
    }
    body.innerHTML = rows.map(u => `
        <tr>
            ${_atlMultiOrg ? `<td style="color:var(--text-secondary)">${_esc(u.org_name || u.org_id || '—')}</td>` : ''}
            <td style="font-weight:500">${_ATL_LOGO}${_esc(u.name || '—')}</td>
            <td style="color:var(--text-secondary)">${_esc(u.email || '—')}</td>
            <td style="text-align:center">${_atlStatusBadge(u.status)}</td>
            <td style="color:var(--text-secondary)">${_esc(u.last_active || '—')}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${(u.products || []).map(_esc).join(', ') || '—'}</td>
            <td style="text-align:right;font-weight:600">${_atlMoney(u.cost || 0)}</td>
        </tr>`).join('');
}

function _atlSort(col) {
    if (_atlUserSort.col === col) _atlUserSort.dir = _atlUserSort.dir === 'asc' ? 'desc' : 'asc';
    else _atlUserSort = { col, dir: col === 'cost' ? 'desc' : 'asc' };
    _atlRenderUserRows();
}

let _atlFilterKey = null;
function _atlOpenFilter(ev, key) {
    _atlFilterKey = key;
    const pop = document.getElementById('atlColFilter');
    const list = document.getElementById('atlColFilterList');
    // Distinct values for this column from the full (unfiltered) row set
    const vals = new Set();
    _atlUserRows.forEach(u => {
        if (key === 'status') vals.add((u.status || '').toLowerCase());
        else (u.products || []).forEach(p => vals.add(p));
    });
    const sel = _atlUserFilters[key];
    list.innerHTML = [...vals].filter(Boolean).sort().map(v => `
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:2px 0">
            <input type="checkbox" value="${_escAttr(v)}" ${sel.has(v) ? 'checked' : ''} onchange="_atlToggleFilter('${_escAttr(v)}',this.checked)">
            <span style="text-transform:${key === 'status' ? 'capitalize' : 'none'}">${_esc(v)}</span>
        </label>`).join('') || '<div style="font-size:12px;color:var(--text-muted)">No values</div>';
    const r = ev.currentTarget.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 230) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.display = 'block';
    document.getElementById('atlColFilterBackdrop').style.display = 'block';
}
function _atlToggleFilter(v, on) {
    if (on) _atlUserFilters[_atlFilterKey].add(v);
    else _atlUserFilters[_atlFilterKey].delete(v);
}
function _atlClearFilter() {
    if (_atlFilterKey) _atlUserFilters[_atlFilterKey].clear();
    _atlCloseFilter();
}
function _atlCloseFilter() {
    document.getElementById('atlColFilter').style.display = 'none';
    document.getElementById('atlColFilterBackdrop').style.display = 'none';
    _atlRenderUserRows();
}

// Pick the default cloud for the Cost Data page: the first cloud this tenant
// actually has data for (preferring azure > aws > gcp > openai). An AWS-only
// tenant defaults to AWS instead of showing an empty Azure view.
async function _pickDefaultCostsCloud() {
    try {
        const clouds = await fetch('/api/connected-clouds').then(r => r.json());
        if (Array.isArray(clouds) && clouds.length) {
            return ['azure', 'aws', 'gcp', 'openai', 'atlassian', 'cursor'].find(c => clouds.includes(c)) || clouds[0];
        }
    } catch (e) { /* fall through */ }
    return 'azure';
}

// Single calendar range picker for Cost Data. Pick start + end in one calendar;
// keeps the hidden #costDateFrom / #costDateTo inputs (YYYY-MM-DD) in sync so the
// rest of loadCostsTable works unchanged.
let _costRangePicker = null;
function _initCostDateRangePicker(fromYmd, toYmd) {
    const el = document.getElementById('costDateRange');
    if (!el || typeof flatpickr === 'undefined') return;
    const _toDate = ymd => new Date(ymd + 'T00:00:00');
    if (_costRangePicker) {
        _costRangePicker.setDate([_toDate(fromYmd), _toDate(toYmd)], false);
        return;
    }
    _costRangePicker = flatpickr(el, {
        mode: 'range',
        dateFormat: 'd/m/y',
        defaultDate: [_toDate(fromYmd), _toDate(toYmd)],
        onClose: function (selectedDates) {
            if (selectedDates.length === 2) {
                const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                document.getElementById('costDateFrom').value = fmt(selectedDates[0]);
                document.getElementById('costDateTo').value   = fmt(selectedDates[1]);
                costPageOffset = 0;
                loadCostsTable();
            }
        }
    });
}

async function _updateCostsCloudFilters(cloud) {
    const accountWrap    = document.getElementById('costAccountWrap');
    const accountLabelEl = document.getElementById('costAccountLabel');
    const rgLabelEl      = document.getElementById('costRGLabel');
    const rgColLabelEl   = document.getElementById('costsRGColumnLabel');
    const groupByWrap    = document.getElementById('costGroupByWrap');
    const rgWrap         = document.getElementById('costRGWrap');
    const resTypeWrap    = document.getElementById('costResourceTypeWrap');
    if (!accountWrap) return;

    const isAws = cloud === 'aws';
    const lbl = rgLabel(cloud);

    // Atlassian-only: a "User" option in Group By (per-user cost breakdown).
    // For Atlassian it moves to the TOP of the list and becomes the default.
    const userOpt = document.getElementById('costGroupByUserOpt');
    const groupByEl = document.getElementById('costGroupBy');
    const showUser = cloud === 'atlassian' || cloud === 'cursor';  // per-user cost views
    if (userOpt && groupByEl) {
        userOpt.style.display = showUser ? '' : 'none';
        if (showUser) groupByEl.insertBefore(userOpt, groupByEl.firstChild); // first
        else          groupByEl.appendChild(userOpt);                        // back to last
    }
    // OpenAI-only Group By options: Model / API Capability / Spend Category.
    const isOpenai = cloud === 'openai';
    document.querySelectorAll('.oai-gb-opt').forEach(o => o.style.display = isOpenai ? '' : 'none');
    if (!isOpenai && groupByEl && (groupByEl.value || '').startsWith('oai_')) groupByEl.value = 'resource';
    // Cursor-only Group By options: Model / User × Model (usage-events breakdown).
    const isCursor = cloud === 'cursor';
    document.querySelectorAll('.cur-gb-opt').forEach(o => o.style.display = isCursor ? '' : 'none');
    if (!isCursor && groupByEl && (groupByEl.value || '').startsWith('cur_')) groupByEl.value = 'resource';

    // Group By is shown for every cloud; the toolbar RG dropdown stays hidden
    // (column-header funnel filters replace it).
    if (groupByWrap) groupByWrap.style.display = '';
    if (rgWrap)      rgWrap.style.display      = 'none';
    // Relabel the first Group By option per cloud: Azure→Resource Group,
    // AWS→Region, GCP→Project (the resource_group column holds that dimension).
    const rgOpt = document.getElementById('costGroupByRgOpt');
    if (rgOpt) rgOpt.textContent = lbl || 'Resource Group';

    // Default: Atlassian/Cursor → User (per-user view); every other cloud → line items.
    if (groupByEl) groupByEl.value = showUser ? 'user' : 'resource';
    if (resTypeWrap) resTypeWrap.style.display  = isAws ? '' : 'none';

    if (accountLabelEl) accountLabelEl.textContent = cloud ? subLabel(cloud) : 'Account / Subscription';

    const subs = await fetch('/api/subscriptions').then(r => r.json()).catch(() => []);
    const filtered = cloud ? subs.filter(s => (s.cloud || 'azure').toLowerCase() === cloud) : subs;
    populateCdAccounts(filtered);

    if (rgLabelEl)    rgLabelEl.textContent    = lbl;
    if (rgColLabelEl) rgColLabelEl.textContent = lbl || 'RG / Region / Project';
}

async function loadCostsTable() {
    // Cloud-specific grouped views (Atlassian per-user, OpenAI model/capability/category)
    // use their own dedicated tables instead of the standard cost table.
    const _gb = document.getElementById('costGroupBy')?.value || 'resource';
    const _mainWrap = document.getElementById('costsTable')?.closest('.cost-table-wrap');
    const _atlWrap  = document.getElementById('atlUserCostWrap');
    const _oaiWrap  = document.getElementById('openaiGroupWrap');
    const _curWrap  = document.getElementById('cursorUserWrap');
    const _curUsageWrap = document.getElementById('cursorUsageWrap');
    const _subCard  = document.querySelector('.sub-table-card');
    const _dateField = document.getElementById('costDateRangeField');
    const _showOnly = which => {
        if (_mainWrap) _mainWrap.style.display = which === 'main' ? '' : 'none';
        if (_atlWrap)  _atlWrap.style.display  = which === 'atl'  ? '' : 'none';
        if (_oaiWrap)  _oaiWrap.style.display  = which === 'oai'  ? '' : 'none';
        if (_curWrap)  _curWrap.style.display  = which === 'cur'  ? '' : 'none';
        if (_curUsageWrap) _curUsageWrap.style.display = which === 'curusage' ? '' : 'none';
        if (_subCard)  _subCard.style.display  = which === 'main' ? '' : 'none';
        // Snapshot views (Atlassian/Cursor current cycle) aren't date-filtered —
        // hide the date picker so it doesn't look broken.
        if (_dateField) _dateField.style.display = ['atl', 'cur', 'curusage'].includes(which) ? 'none' : '';
    };
    if (costsSelectedCloud === 'atlassian' && _gb === 'user') {
        _showOnly('atl'); return renderAtlassianUserCosts();
    }
    if (costsSelectedCloud === 'cursor' && _gb === 'user') {
        _showOnly('cur'); return renderCursorUserCosts();
    }
    if (costsSelectedCloud === 'cursor' && _gb.startsWith('cur_')) {
        _showOnly('curusage'); return renderCursorUsage(_gb.replace('cur_', ''));
    }
    if (costsSelectedCloud === 'openai' && _gb.startsWith('oai_')) {
        _showOnly('oai'); return renderOpenAIGrouped(_gb.replace('oai_', ''));
    }
    _showOnly('main');

    const params = new URLSearchParams();
    const search = document.getElementById('costSearch')?.value;
    const dateFrom = document.getElementById('costDateFrom')?.value;
    const dateTo = document.getElementById('costDateTo')?.value;
    const granularity = document.getElementById('costGranularity')?.value || 'monthly';
    const costGroupBy = document.getElementById('costGroupBy')?.value || 'resource';
    const dateHeader = document.getElementById('costDateHeader');
    if (dateHeader) {
        dateHeader.innerHTML = `${granularity === 'monthly' ? 'Month' : 'Date'} <span id="sort-date" class="sort-indicator">↕</span>`;
    }
    const isRgGroup = costGroupBy === 'resource_group';
    const isSvcGroup = costGroupBy === 'service';
    const cloudHeader = document.getElementById('costCloudHeader');
    const rgHeader = document.getElementById('costRGHeader');
    const serviceHeader = document.getElementById('costServiceHeader');
    const resourceHeader = document.getElementById('costResourceHeader');
    const subscriptionHeader = document.getElementById('costSubscriptionHeader');
    // Column visibility per group mode (Subscription is always shown):
    //   resource_group → Cloud, Date, Subscription, Resource Group, Cost
    //   service        → Cloud, Date, Subscription, Service, Cost
    //   resource       → Cloud, Date, Subscription, Resource Group, Service, Resource, Cost
    if (rgHeader) rgHeader.style.display = isSvcGroup ? 'none' : '';
    if (serviceHeader) serviceHeader.style.display = isRgGroup ? 'none' : '';
    if (resourceHeader) resourceHeader.style.display = (isRgGroup || isSvcGroup) ? 'none' : '';
    if (subscriptionHeader) {
        subscriptionHeader.style.display = '';
        const subHdrText = costsSelectedCloud ? (subLabel(costsSelectedCloud) || 'Account') : 'Subscription';
        subscriptionHeader.innerHTML = `${subHdrText} <span id="sort-subscription_id" class="sort-indicator">↕</span>` +
            `<svg onclick="openColFilter(event,'acc')" data-colf="acc" class="col-filter-ic" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;margin-left:6px;vertical-align:middle;opacity:0.85"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;
    }
    // Column order: Cloud, Date, [Subscription, Resource Group] or [Resource Group, Service, Resource], Cost
    if (cloudHeader && dateHeader && cloudHeader.nextElementSibling !== dateHeader) {
        dateHeader.parentNode.insertBefore(cloudHeader, dateHeader);
    }
    if (subscriptionHeader && rgHeader && subscriptionHeader.nextElementSibling !== rgHeader) {
        rgHeader.parentNode.insertBefore(subscriptionHeader, rgHeader);
    }
    const rgValues = [...cdRgSelected];
    const serviceValues = [...cdSvcSelected];
    const resourceValues = [...cdResSelected];
    const accSelected = [...cdAccSelected];
    const resType = (costsSelectedCloud === 'aws') ? (document.getElementById('costResourceType')?.value || '') : '';
    const activeCloud = costsSelectedCloud || '';
    const includeBlankRG = rgValues.includes('__BLANK__');
    const includeBlankService = serviceValues.includes('__BLANK__');
    const includeBlankSub = accSelected.includes('__BLANK__');
    const rg = rgValues.filter(v => v !== '__BLANK__');
    const services = serviceValues.filter(v => v !== '__BLANK__');
    const resources = resourceValues.filter(v => v !== '__BLANK__');
    const subs = accSelected.filter(v => v !== '__BLANK__');

    if (search) params.set('search', search);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    params.set('granularity', granularity);
    if (costGroupBy && costGroupBy !== 'resource') params.set('group_by', costGroupBy);
    if (rg.length) params.set('resource_groups', rg.join(','));
    if (services.length) params.set('service_names', services.join(','));
    if (resources.length) params.set('resource_names', resources.join(','));
    if (includeBlankRG) params.set('include_blank_resource_group', '1');
    if (includeBlankService) params.set('include_blank_service', '1');
    if (resType) params.set('resource_type', resType);
    if (subs.length) params.set('subscription_ids', subs.join(','));
    if (includeBlankSub) params.set('include_blank_subscription', '1');
    else if (!subs.length && selectedSubscription && activeCloud === 'azure') params.set('subscription_id', selectedSubscription);
    if (costsSelectedCloud) params.set('cloud_provider', costsSelectedCloud);
    const costsClient = document.getElementById('costsClientFilter')?.value || '';
    if (costsClient) params.set('client_id', costsClient);
    params.set('limit', String(costPageLimit));
    params.set('offset', String(costPageOffset));

    try {
        const paramsBySub = new URLSearchParams(params);
        paramsBySub.delete('subscription_id');
        paramsBySub.delete('limit');
        paramsBySub.delete('offset');
        _drillBaseParams = new URLSearchParams(paramsBySub);

        // AWS with a specific account selected → show service breakdown; otherwise show by subscription
        // Always show the summary as totals by Subscription (Azure) / Account (AWS) /
        // Project (GCP) — not a per-service breakdown.
        const showServiceBreakdown = false;
        const subTableUrl = `/api/costs/total-by-subscription?${paramsBySub}`;

        const [costsResp, totals, totalsBySub] = await Promise.all([
            fetch(`/api/costs?${params}`).then(r => r.json()),
            fetch(`/api/costs/total?${params}`).then(r => r.json()),
            fetch(subTableUrl).then(r => r.json())
        ]);
        const data = Array.isArray(costsResp) ? costsResp : (costsResp.rows || []);
        costPageTotal = Array.isArray(costsResp) ? data.length : (costsResp.total || 0);
        costPageOffset = Array.isArray(costsResp) ? 0 : (costsResp.offset || 0);
        costPageLimit = Array.isArray(costsResp) ? costPageLimit : (costsResp.limit || costPageLimit);
        const tbody = document.getElementById('costsTableBody');
        const sortedData = sortCostRows(data);
        updateCostSortIndicators();
        _updateColFilterIndicators();   // highlight funnels for columns with active filters

        const cloudLogoH = { azure: '12', aws: '10', gcp: '12' };
        const cloudNames = { azure: 'Azure', aws: 'AWS', gcp: 'GCP' };
        const subNameMap = {};
        (totalsBySub || []).forEach(s => { subNameMap[s.subscription_id] = s.subscription_name || s.subscription_id; });
        if (!sortedData.length) {
          const hasFilter = (document.getElementById('costSearch')?.value || '') ||
            (document.getElementById('costDateFrom')?.value || '') ||
            costsSelectedCloud;
          tbody.innerHTML = `<tr><td colspan="${(isRgGroup || isSvcGroup) ? 5 : 7}" style="padding:0;border:none">` +
            (hasFilter
              ? _emptyState('neutral',
                  '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
                  'No results match your filters',
                  'Try a wider date range, different cloud, or clear all filters.',
                  [{label:'Clear filters', primary:false, onclick:'clearCostFilters()'}]
                )
              : _emptyState('info',
                  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
                  'No cost data yet',
                  'Sync your connected providers to pull in usage records.',
                  [{label:'Go to dashboard', primary:true, onclick:"navigateTo('executive')"}]
                )
            ) + `</td></tr>`;
        } else {
            tbody.innerHTML = sortedData.map(r => {
                const cp = (r.cloud_provider || 'azure').toLowerCase();
                const logoH = cloudLogoH[cp] || '12';
                const cloudLabel = cloudNames[cp] || cp.charAt(0).toUpperCase() + cp.slice(1);
                const cloudCell = `<div class="cloud-cell"><img src="/static/img/${cp}-logo.svg" alt="${cloudLabel}" style="height:${logoH}px;flex-shrink:0"><span>${cloudLabel}</span></div>`;
                let tags = {};
                try { tags = r.tags ? JSON.parse(r.tags) : {}; } catch(e) {}
                const vmName = tags.name || null;
                let prettyResourceName = r.resource_name || '';
                if (cp === 'aws' && prettyResourceName.startsWith('arn:')) {
                    const parts = prettyResourceName.split(':');
                    const arnResourcePart = parts.length >= 6 ? parts.slice(5).join(':') : prettyResourceName;
                    if (arnResourcePart.startsWith('loadbalancer/')) {
                        const lbParts = arnResourcePart.split('/');
                        prettyResourceName = lbParts[2] || lbParts[lbParts.length - 1] || prettyResourceName;
                    } else if (arnResourcePart.startsWith('db:')) {
                        prettyResourceName = arnResourcePart.split(':')[1] || prettyResourceName;
                    } else {
                        const slashParts = arnResourcePart.split('/');
                        prettyResourceName = slashParts[slashParts.length - 1] || prettyResourceName;
                    }
                }
                // Reservation orders (Azure 'reservationorders' / RIs) are identified by a
                // GUID with no friendly name — show a clear label instead of the raw ID.
                const isReservation = (r.resource_type || '').toLowerCase().includes('reservation');
                if (isReservation) {
                    prettyResourceName = `Reservation — ${r.service_name || 'Commitment'}`;
                }
                const resourceDisplay = vmName
                    ? `<span style="font-weight:500">${vmName}</span><br><span style="font-size:11px;color:var(--text-tertiary)">${prettyResourceName}</span>`
                    : (isReservation
                        ? `<span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:8px;background:#6366f122;color:#6366f1;margin-right:6px">RI</span><span>${prettyResourceName}</span>`
                        : (prettyResourceName || '-'));
                const resourceTitle = vmName ? `${vmName} (${prettyResourceName})` : (prettyResourceName || '');
                const rawDate = (r.date || '').toString();
                const dateOnly = granularity === 'monthly' ? rawDate.slice(0, 7) : rawDate.split('T')[0];
                const rgCell = `<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${r.resource_group||''}">${r.resource_group || '-'}</td>`;
                const subCell = `<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${subNameMap[r.subscription_id]||''}">${subNameMap[r.subscription_id] || '-'}</td>`;
                const serviceCell = `<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${r.service_name||''}">${r.service_name || '-'}</td>`;
                const resourceCell = `<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${resourceTitle}" data-sub="${r.subscription_id||''}" data-rg="${r.resource_group||''}" data-name="${r.resource_name||''}" onclick="showResourceConfig(this.getAttribute('data-sub'), this.getAttribute('data-rg'), this.getAttribute('data-name'))"><span class="res-link">${resourceDisplay}</span></td>`;
                const middleCells = isRgGroup
                    ? `${subCell}${rgCell}`
                    : isSvcGroup
                        ? `${subCell}${serviceCell}`
                        : `${subCell}${rgCell}${serviceCell}${resourceCell}`;
                return `<tr>
                <td>${cloudCell}</td>
                <td style="white-space:nowrap;color:var(--text-secondary)">${dateOnly}</td>
                ${middleCells}
                <td class="cost-cell">${curSym()}${(r.cost || 0).toFixed(2)}</td>
            </tr>`;
            }).join('');
        }

        document.getElementById('costsCount').textContent = `${data.length} records`;
        const from = costPageTotal ? (costPageOffset + 1) : 0;
        const to = Math.min(costPageOffset + costPageLimit, costPageTotal);
        const page = Math.floor(costPageOffset / costPageLimit) + 1;
        const pages = Math.max(1, Math.ceil(costPageTotal / costPageLimit));
        const countChip = document.getElementById('costRowCountChip');
        if (countChip) countChip.textContent = `${costPageTotal.toLocaleString()} records · showing ${from}–${to}`;
        const subtitleBar = document.getElementById('costsSubtitleBar');
        const _money = v => `${curSym()}${(v || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        const filteredAmt = _money(totals.total_cost);
        const hasDimFilter = !!search || rg.length || services.length || resources.length || subs.length
                             || includeBlankRG || includeBlankService || includeBlankSub;
        if (subtitleBar && costPageTotal > 0) {
            const head = `Showing ${from}–${to} of ${costPageTotal.toLocaleString()} records · `;
            if (!hasDimFilter) {
                // No dimension filter → this IS the total for the cloud + date range
                subtitleBar.innerHTML = `${head}Total <strong>${filteredAmt}</strong>`;
            } else {
                // A filter is active → make it obvious this is a subset, and show the
                // unfiltered total (cloud + date [+ client]) for context.
                subtitleBar.innerHTML = `${head}<strong style="color:var(--accent)">Filtered total ${filteredAmt}</strong>`;
                const baseParams = new URLSearchParams();
                if (dateFrom) baseParams.set('date_from', dateFrom);
                if (dateTo) baseParams.set('date_to', dateTo);
                if (costsSelectedCloud) baseParams.set('cloud_provider', costsSelectedCloud);
                if (costsClient) baseParams.set('client_id', costsClient);
                fetch(`/api/costs/total?${baseParams}`).then(r => r.json()).then(bt => {
                    subtitleBar.innerHTML = `${head}<strong style="color:var(--accent)">Filtered total ${filteredAmt}</strong> <span style="color:var(--text-tertiary)">(of ${_money(bt.total_cost)} total)</span>`;
                }).catch(() => {});
            }
        } else if (subtitleBar) {
            subtitleBar.textContent = 'No records match current filters';
        }
        const pageInfo = document.getElementById('costPageInfo');
        if (pageInfo) pageInfo.textContent = `Page ${page} of ${pages}`;
        const prev = document.getElementById('costPrevBtn');
        const next = document.getElementById('costNextBtn');
        if (prev) prev.disabled = costPageOffset <= 0;
        if (next) next.disabled = costPageOffset + costPageLimit >= costPageTotal;
        document.getElementById('costTotalAmount').textContent =
            `${curSym()}${(totals.total_cost || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        document.getElementById('costTotalRecords').textContent =
            (totals.total_records || 0).toLocaleString();

        // Adaptive header label + show/hide extra columns
        const costsSubTitleEl  = document.getElementById('costsSubTitle');
        const subCloudHdr      = document.getElementById('costSubCloudHeader');
        const subAccHdr        = document.getElementById('costSubAccHeader');
        const subColHdr        = document.getElementById('costSubColHeader');
        if (showServiceBreakdown) {
            if (costsSubTitleEl) costsSubTitleEl.textContent = 'Total Cost by Service (Selected Dates)';
            if (subCloudHdr) { subCloudHdr.style.display = ''; subCloudHdr.textContent = 'Cloud'; }
            if (subAccHdr)   { subAccHdr.style.display   = ''; subAccHdr.textContent   = 'Account'; }
            if (subColHdr)   subColHdr.textContent = 'Service';
        } else {
            const activeCloud = costsSelectedCloud || '';
            const subWord = subLabel(activeCloud) || 'Account / Subscription';
            if (costsSubTitleEl) costsSubTitleEl.textContent = `Total Cost by ${subWord} (Selected Dates)`;
            if (subCloudHdr) subCloudHdr.style.display = 'none';
            if (subAccHdr)   subAccHdr.style.display   = 'none';
            if (subColHdr)   subColHdr.textContent = subWord;
        }

        // Store sub-table data and render with sort support
        const selectedAccNames = accSelected.map(id => subNameMap[id] || id).join(', ') || 'All';
        _subTableIsService = showServiceBreakdown;
        _subTableSortBy = 'cost';
        _subTableSortDir = 'desc';
        if (showServiceBreakdown) {
            _subTableData = (totalsBySub || []).map(s => ({ ...s, account: selectedAccNames }));
        } else {
            _subTableData = totalsBySub || [];
        }
        _renderSubTable();

        // Load filter options scoped to the active cloud + account
        const filterParams = new URLSearchParams();
        if (activeCloud) filterParams.set('cloud_provider', activeCloud);
        if (subs.length) filterParams.set('subscription_ids', subs.join(','));
        else if (selectedSubscription && activeCloud === 'azure') filterParams.set('subscription_id', selectedSubscription);
        const filterQs = filterParams.toString() ? '?' + filterParams.toString() : '';
        const filters = await fetch('/api/filters' + filterQs).then(r => r.json());
        populateCdMultiselect('rg', filters.resource_groups || []);
        populateCdMultiselect('svc', filters.services || []);
        populateCdMultiselect('res', filters.resources || []);
        _populateResourceTypeOptions(filters.resource_types || []);
    } catch (err) {
        console.error('Costs load error:', err);
    }
}

// Populate the AWS "Resource Type" dropdown with every resource type present in
// the data (instead of a fixed short list), keeping the current selection.
function _populateResourceTypeOptions(types) {
    const sel = document.getElementById('costResourceType');
    if (!sel) return;
    const prev = sel.value;
    // Keep real resource types (EC2 Instance, EBS Volume, Load Balancer…) and drop
    // instance-size values that AWS stores in resource_type (t2.small, db.t3.medium,
    // m5.2xlarge…). Real types have no dot; instance sizes are "family.size".
    const clean = (types || []).filter(t => t && !t.includes('.'));
    const opts = ['<option value="">All</option>'].concat(
        clean.sort((a, b) => a.localeCompare(b))
            .map(t => `<option value="${_escAttr(t)}">${_esc(t)}</option>`)
    );
    sel.innerHTML = opts.join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function clearCostFilters() {
  const s = document.getElementById('costSearch'); if (s) s.value = '';
  const df = document.getElementById('costDateFrom'); if (df) df.value = '';
  const dt = document.getElementById('costDateTo'); if (dt) dt.value = '';
  document.querySelectorAll('[data-costs-cloud]').forEach(b => {
    b.classList.toggle('active', b.dataset.costsCloud === '');
  });
  costsSelectedCloud = '';
  cdRgSelected.clear();  cdUpdateTrigger('rg');
  cdSvcSelected.clear(); cdUpdateTrigger('svc');
  cdAccSelected.clear(); cdUpdateTrigger('acc');
  loadCostsTable();
}

function changeCostPage(delta) {
    const nextOffset = costPageOffset + (delta * costPageLimit);
    if (nextOffset < 0) return;
    if (nextOffset >= costPageTotal && delta > 0) return;
    costPageOffset = nextOffset;
    loadCostsTable();
}

function sortCostsBy(field) {
    if (costSortBy === field) {
        costSortDir = costSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        costSortBy = field;
        costSortDir = (field === 'cost' || field === 'date') ? 'desc' : 'asc';
    }
    loadCostsTable();
}

function sortCostRows(rows) {
    const out = [...rows];
    out.sort((a, b) => {
        let av = a[costSortBy];
        let bv = b[costSortBy];
        if (costSortBy === 'cost') {
            av = Number(av || 0);
            bv = Number(bv || 0);
        } else if (costSortBy === 'date') {
            av = (av || '').toString();
            bv = (bv || '').toString();
        } else {
            av = (av || '').toString().toLowerCase();
            bv = (bv || '').toString().toLowerCase();
        }

        if (av < bv) return costSortDir === 'asc' ? -1 : 1;
        if (av > bv) return costSortDir === 'asc' ? 1 : -1;
        return 0;
    });
    return out;
}

function updateCostSortIndicators() {
    const fields = ['date', 'cloud_provider', 'resource_group', 'service_name', 'resource_name', 'meter_category', 'cost'];
    fields.forEach(f => {
        const el = document.getElementById(`sort-${f}`);
        if (!el) return;
        if (f === costSortBy) {
            el.textContent = costSortDir === 'asc' ? '↑' : '↓';
            el.style.color = 'var(--text-primary)';
            el.classList.add('active');
        } else {
            el.textContent = '↕';
            el.style.color = 'var(--text-tertiary)';
            el.classList.remove('active');
        }
    });
}

function populateSelect(id, options) {
    const sel = document.getElementById(id);
    if (!sel) return;

    // Rebuild options each time so subscription/date filter changes
    // don't keep stale values from previous context.
    const previous = sel.multiple ? Array.from(sel.selectedOptions || []).map(o => o.value) : [sel.value];
    sel.innerHTML = '';
    if (!sel.multiple) {
        sel.innerHTML = '<option value="">All</option>';
    } else {
        const blank = document.createElement('option');
        blank.value = '__BLANK__';
        blank.textContent = '(Blank)';
        sel.appendChild(blank);
    }
    options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        sel.appendChild(o);
    });

    // Restore previous selection only if still valid
    if (sel.multiple) {
        const allowed = new Set(['__BLANK__', ...options]);
        Array.from(sel.options).forEach(o => {
            o.selected = previous.includes(o.value) && allowed.has(o.value);
        });
    } else if (previous[0] && options.includes(previous[0])) {
        sel.value = previous[0];
    }
}

// ─── Analytics ───────────────────────────────────────────────────────────
async function loadAnalytics() {
    try {
        const [byService, byRG, byMeter, trend] = await Promise.all([
            fetch('/api/summary?group_by=service_name' + subParam('&')).then(r => r.json()),
            fetch('/api/summary?group_by=resource_group' + subParam('&')).then(r => r.json()),
            fetch('/api/summary?group_by=meter_category' + subParam('&')).then(r => r.json()),
            fetch('/api/trend' + subParam()).then(r => r.json())
        ]);

        const colors = CHART_COLORS();

        renderChart('anaServiceChart', 'bar', {
            labels: byService.slice(0, 10).map(r => r.service_name || 'Unknown'),
            datasets: [{
                label: 'Cost ($)',
                data: byService.slice(0, 10).map(r => r.total_cost),
                backgroundColor: colors,
                borderRadius: 6
            }]
        }, 'Cost by Service');

        renderChart('anaRGChart', 'horizontalBar', {
            labels: byRG.slice(0, 10).map(r => r.resource_group || 'Unknown'),
            datasets: [{
                label: 'Cost ($)',
                data: byRG.slice(0, 10).map(r => r.total_cost),
                backgroundColor: colors,
                borderRadius: 6
            }]
        }, 'Cost by Resource Group');

        renderChart('anaMeterChart', 'pie', {
            labels: byMeter.slice(0, 10).map(r => r.meter_category || 'Unknown'),
            datasets: [{
                data: byMeter.slice(0, 10).map(r => r.total_cost),
                backgroundColor: colors,
                borderWidth: 0
            }]
        }, 'Cost by Meter Category');

        // Weekly aggregation
        const weeklyData = aggregateWeekly(trend);
        renderChart('anaWeeklyChart', 'bar', {
            labels: weeklyData.labels,
            datasets: [{
                label: 'Weekly Cost ($)',
                data: weeklyData.values,
                backgroundColor: '#4f6ef7',
                borderRadius: 6
            }]
        }, 'Weekly Cost Trend');

    } catch (err) {
        console.error('Analytics load error:', err);
    }
}

function aggregateWeekly(dailyData) {
    const weeks = {};
    dailyData.forEach(d => {
        const date = new Date(d.date);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const key = weekStart.toISOString().slice(0, 10);
        weeks[key] = (weeks[key] || 0) + d.total_cost;
    });
    const sorted = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
    return {
        labels: sorted.map(w => `Wk ${w[0]}`),
        values: sorted.map(w => w[1])
    };
}

// ─── Monthly Costs ───────────────────────────────────────────────────────
let monthlyData = [];

function _hideMonthlyLoaders() {
    ['monthlyServiceLoader','monthlyRGLoader','monthlyBarLoader'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const tl = document.getElementById('monthlyTableLoader');
    if (tl) tl.style.display = 'none';
}

async function loadMonthly() {
    try {
        monthlyData = await fetch('/api/monthly' + subParam()).then(r => r.json());
        if (!monthlyData.length) {
            _hideMonthlyLoaders();
            const mc = document.getElementById('monthlyCards');
            if (mc) mc.innerHTML = _emptyState('info',
                '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>',
                'Tracking starts as soon as data syncs',
                'Once we have at least one full month of data, your breakdown will appear here.'
            );
            return;
        }

        const colors = CHART_COLORS();
        // Reverse so newest month is on the left
        const chartData = [...monthlyData].reverse();
        const monthLabels = chartData.map(m => formatMonth(m.month));
        const monthlyCosts = chartData.map(m => m.total_cost);

        renderChart('monthlyBarChart', 'bar', {
            labels: monthLabels,
            datasets: [{
                label: 'Monthly Cost ($)',
                data: monthlyCosts,
                backgroundColor: monthlyCosts.map((c, i) => {
                    const olderCost = monthlyCosts[i + 1]; // next bar = older month
                    if (olderCost === undefined) return '#4f6ef7'; // oldest month = neutral
                    return c > olderCost ? '#e74c3c' : '#2ecc71';
                }),
                borderRadius: 8,
                barPercentage: 0.6,
            }]
        }, 'Monthly Cost Overview');

        // ── Monthly Summary Cards (newest month first) ──
        const monthlyCardsOrder = [...monthlyData].reverse();
        const cardsHtml = monthlyCardsOrder.map((m, i) => {
            const hasOlder = i < monthlyCardsOrder.length - 1;
            const prevMonthCost = hasOlder ? monthlyCardsOrder[i + 1].total_cost : null;
            const change = hasOlder && prevMonthCost > 0 ? ((m.total_cost - prevMonthCost) / prevMonthCost * 100) : 0;
            const changeIcon = change > 0 ? '▲' : '▼';
            const changeStr = hasOlder ? `<div class="co-card-lg__delta delta-${change>0?'up':'down'}" style="font-size:13px;margin-top:4px">${changeIcon} ${Math.abs(change).toFixed(1)}% vs prev month</div>` : '';
            const subs = m.by_subscription || [];
            const byCloud = m.by_cloud || {};
            const cloudTotal = m.total_cost || 1;
            const cloudColors = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4', openai: '#10a37f', atlassian: '#0052cc', cursor: '#111111' };
            const cloudLabels = { azure: 'Azure', aws: 'AWS', gcp: 'GCP', openai: 'OpenAI', atlassian: 'Atlassian', cursor: 'Cursor' };
            const cloudOrder = ['aws', 'azure', 'gcp', 'openai', 'atlassian', 'cursor'];
            const activeCloudKeys = cloudOrder.filter(c => byCloud[c] > 0);

            // Cloud breakdown strip
            const cloudBlock = activeCloudKeys.length > 0 ? `
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin-bottom:6px;font-weight:600">By Cloud</div>
                    ${activeCloudKeys.map(c => {
                        const cost = byCloud[c] || 0;
                        const pct = ((cost / cloudTotal) * 100).toFixed(1);
                        const color = cloudColors[c];
                        return `<div style="margin-bottom:5px">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                                <div style="display:flex;align-items:center;gap:5px"><img src="/static/img/${c}-logo.svg" style="height:${c==='aws'?'10':'12'}px"><span style="font-size:11px;color:var(--text-secondary)">${cloudLabels[c]}</span></div>
                                <span style="color:var(--text-primary);flex-shrink:0;font-weight:500;font-variant-numeric:tabular-nums">${curSym()}${Number(cost).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0})}</span>
                            </div>
                            <div style="height:3px;background:var(--border);border-radius:2px;overflow:hidden">
                                <div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div>
                            </div>
                            <div style="font-size:10px;color:var(--text-secondary);margin-top:1px">${pct}%</div>
                        </div>`;
                    }).join('')}
                </div>` : '';

            const showSubBlock = subs.length > 0 && !selectedSubscription;
            let subBlock = '';
            if (showSubBlock) {
                // Group accounts by cloud
                const grouped = {};
                subs.forEach(sub => {
                    const c = sub.cloud || 'azure';
                    if (!grouped[c]) grouped[c] = [];
                    grouped[c].push(sub);
                });
                const cloudGroupOrder = CLOUD_ORDER;
                const cloudGroupLabels = { azure: 'Azure', aws: 'AWS', gcp: 'GCP' };
                const ACCT_SHOWN = 10;
                const groupHtml = cloudGroupOrder.filter(c => grouped[c]).map(c => {
                    const color = cloudColors[c];
                    const all = grouped[c];
                    const items = all.slice(0, ACCT_SHOWN).map(sub => {
                        const raw = (sub.name || sub.subscription_id || '').trim() || '-';
                        const short = raw.length > 20 ? raw.slice(0, 18) + '…' : raw;
                        const esc = raw.replace(/"/g, '&quot;');
                        return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-size:11px;margin-top:2px;line-height:1.3;padding-left:8px">
                            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;color:var(--text-secondary)" title="${esc}">${short}</span>
                            <span style="color:var(--text-primary);flex-shrink:0;font-weight:500;font-variant-numeric:tabular-nums">${curSym()}${Number(sub.cost).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0})}</span>
                        </div>`;
                    }).join('') + (all.length > ACCT_SHOWN
                        ? `<div style="font-size:10px;color:var(--text-tertiary);padding-left:8px;margin-top:2px">+${all.length - ACCT_SHOWN} more</div>` : '');
                    return `<div style="margin-top:5px">
                        <div style="display:flex;align-items:center;gap:5px;margin-bottom:1px">
                            <img src="/static/img/${c}-logo.svg" style="height:${c==='aws'?'9':'11'}px;flex-shrink:0">
                            <span style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.06em">${cloudGroupLabels[c]}</span>
                        </div>
                        ${items}
                    </div>`;
                }).join('');
                subBlock = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin-bottom:4px;font-weight:600">By Account</div>
                    ${groupHtml}
                </div>`;
            }
            return `
                <div class="${i === 0 ? 'month-card month-card--current' : 'month-card'}" onclick="showMonthDetail('${m.month}')">
                    <div class="stat-label">${formatMonth(m.month)}</div>
                    <div class="metric-number" style="font-size:20px">${curSym()}${m.total_cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                    ${changeStr}
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:6px">
                        ${m.service_count} services &bull; ${m.rg_count} RGs &bull; ${m.record_count.toLocaleString()} records
                    </div>
                    ${cloudBlock}
                    ${subBlock}
                </div>
            `;
        }).join('');
        document.getElementById('monthlyCards').innerHTML = cardsHtml;
        const months = monthlyCardsOrder.map(m => formatMonth(m.month));
        const subtitleEl = document.getElementById('monthlySubtitle');
        if (subtitleEl) subtitleEl.textContent = `${monthlyData.length} months tracked · ${months.join(', ')}`;

        // ── Monthly table ──
        renderMonthlyTable();

        // ── Stacked Service Chart ──
        const allServices = [...new Set(monthlyData.flatMap(m => m.top_services.slice(0, 5).map(s => s.service)))];
        const svcDatasets = allServices.map((svc, i) => ({
            label: svc,
            data: monthlyData.map(m => {
                const found = m.top_services.find(s => s.service === svc);
                return found ? found.cost : 0;
            }),
            backgroundColor: colors[i % colors.length],
            borderRadius: 4,
        }));

        renderChart('monthlyServiceStack', 'bar', {
            labels: monthLabels,
            datasets: svcDatasets
        }, 'Services per Month', { stacked: true });

        // ── Stacked RG Chart ──
        const allRGs = [...new Set(monthlyData.flatMap(m => m.top_rgs.slice(0, 5).map(r => r.resource_group)))];
        const rgDatasets = allRGs.map((rg, i) => ({
            label: rg,
            data: monthlyData.map(m => {
                const found = m.top_rgs.find(r => r.resource_group === rg);
                return found ? found.cost : 0;
            }),
            backgroundColor: colors[i % colors.length],
            borderRadius: 4,
        }));

        renderChart('monthlyRGStack', 'bar', {
            labels: monthLabels,
            datasets: rgDatasets
        }, 'Resource Groups per Month', { stacked: true });

        _hideMonthlyLoaders();
    } catch (err) {
        console.error('Monthly load error:', err);
        _hideMonthlyLoaders();
    }
}

function renderMonthlyTable() {
    const viewType = document.getElementById('monthlyViewType')?.value || 'overview';
    const thead = document.getElementById('monthlyTableHead');
    const tbody = document.getElementById('monthlyTableBody');

    if (viewType === 'overview') {
        thead.innerHTML = `<tr><th>Month</th><th>Total Cost</th><th>Change</th><th>Services</th><th>${rgLabel(selectedCloud)}s</th><th>Records</th></tr>`;
        const rows = [...monthlyData].reverse();
        tbody.innerHTML = rows.map((m, i) => {
            const hasOlder = i < rows.length - 1;
            const prevCost = hasOlder ? rows[i + 1].total_cost : null;
            const change = hasOlder && prevCost > 0 ? ((m.total_cost - prevCost) / prevCost * 100) : 0;
            const changeColor = !hasOlder ? 'var(--text-secondary)' : (change > 0 ? 'var(--red)' : 'var(--green)');
            const changeIcon = change > 0 ? '▲' : '▼';
            return `<tr>
                <td style="font-weight:500">${formatMonth(m.month)}</td>
                <td style="font-weight:500;color:var(--text-primary)">${curSym()}${m.total_cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                <td style="color:${changeColor}">${!hasOlder ? '-' : `${changeIcon} ${Math.abs(change).toFixed(1)}%`}</td>
                <td>${m.service_count}</td>
                <td>${m.rg_count}</td>
                <td>${m.record_count.toLocaleString()}</td>
            </tr>`;
        }).join('');

    } else if (viewType === 'services') {
        const months = [...monthlyData].reverse().map(m => m.month);
        const allSvcs = [...new Set(monthlyData.flatMap(m => m.top_services.map(s => s.service)))];
        thead.innerHTML = `<tr><th>Service</th>${months.map(m => `<th>${formatMonth(m)}</th>`).join('')}<th>Total</th></tr>`;
        tbody.innerHTML = allSvcs.map(svc => {
            const costs = months.map(month => {
                const mData = monthlyData.find(m => m.month === month);
                const s = mData?.top_services.find(s => s.service === svc);
                return s ? s.cost : 0;
            });
            const total = costs.reduce((a, b) => a + b, 0);
            return `<tr>
                <td style="font-weight:500">${svc}</td>
                ${costs.map(c => `<td>${c > 0 ? curSym() + c.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '-'}</td>`).join('')}
                <td style="font-weight:500;color:var(--text-primary)">${curSym()}${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
            </tr>`;
        }).join('');

    } else if (viewType === 'rgs') {
        const months = [...monthlyData].reverse().map(m => m.month);
        const allRGs = [...new Set(monthlyData.flatMap(m => m.top_rgs.map(r => r.resource_group)))];
        thead.innerHTML = `<tr><th>${rgLabel(selectedCloud)}</th>${months.map(m => `<th>${formatMonth(m)}</th>`).join('')}<th>Total</th></tr>`;
        tbody.innerHTML = allRGs.map(rg => {
            const costs = months.map(month => {
                const mData = monthlyData.find(m => m.month === month);
                const r = mData?.top_rgs.find(r => r.resource_group === rg);
                return r ? r.cost : 0;
            });
            const total = costs.reduce((a, b) => a + b, 0);
            return `<tr>
                <td style="font-weight:500">${rg}</td>
                ${costs.map(c => `<td>${c > 0 ? curSym() + c.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '-'}</td>`).join('')}
                <td style="font-weight:500;color:var(--text-primary)">${curSym()}${total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
            </tr>`;
        }).join('');
    }
}

function showMonthDetail(month) {
    const m = monthlyData.find(d => d.month === month);
    if (!m) return;
    const svcs = m.top_services.slice(0, 5).map((s, i) => `${i+1}. ${s.service}: $${s.cost.toLocaleString()}`).join('\n');
    const rgs = m.top_rgs.slice(0, 5).map((r, i) => `${i+1}. ${r.resource_group}: $${r.cost.toLocaleString()}`).join('\n');
    alert(`${formatMonth(month)} - $${m.total_cost.toLocaleString()}\n\nTop Services:\n${svcs}\n\nTop ${rgLabel(selectedCloud)}s:\n${rgs}`);
}

function formatMonth(monthStr) {
    const [year, month] = monthStr.split('-');
    const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${names[parseInt(month)]} ${year}`;
}

// ─── Comparison ──────────────────────────────────────────────────────────
let comparePeriods = { months: [], weeks: [] };
/** @type {{ groupBy: string, periodSpecs: {from:string,to:string,label:string}[], rgsParam: string }} */
let cmpContext = { groupBy: '', periodSpecs: [], rgsParam: '' };

const CMP_PERIOD_COLORS = CHART_COLORS();

/** Period indices 1–6 to include in monthly compare (always starts with 1, 2). */
function getActiveMonthlyPeriodIndices() {
    const indices = [1, 2];
    for (let i = 3; i <= 6; i++) {
        const wrap = document.getElementById('cmpMonthWrap' + i);
        if (wrap && wrap.style.display !== 'none') indices.push(i);
    }
    return indices;
}

function onCmpExtraPeriodToggle() {
    // No-op: extra periods now managed via cmpAddPeriod / cmpRemovePeriod buttons
}

function cmpAddPeriod() {
    const nM = comparePeriods.months.length;
    for (let i = 3; i <= 6; i++) {
        const wrap = document.getElementById('cmpMonthWrap' + i);
        if (wrap && wrap.style.display === 'none') {
            wrap.style.display = '';
            const sel = document.getElementById('cmpMonth' + i);
            if (sel && nM > 0) {
                const idx = Math.max(0, nM - i);
                sel.selectedIndex = Math.min(idx, sel.options.length - 1);
            }
            break;
        }
    }
    const allShown = [3, 4, 5, 6].every(i => {
        const w = document.getElementById('cmpMonthWrap' + i);
        return w && w.style.display !== 'none';
    });
    const btn = document.getElementById('cmpAddPeriodBtn');
    if (btn) btn.style.display = allShown ? 'none' : '';
}

function cmpRemovePeriod(n) {
    const wrap = document.getElementById('cmpMonthWrap' + n);
    if (wrap) wrap.style.display = 'none';
    const btn = document.getElementById('cmpAddPeriodBtn');
    if (btn) btn.style.display = '';
}

async function loadCompare() {
    try {
        // Default to the biggest-spend cloud (no "All") if not already chosen.
        if (!cmpSelectedCloud) {
            const dc = await defaultCloud();
            const chip = document.querySelector(`[data-cmp-cloud="${dc}"]`);
            if (chip) { setCmpCloud(chip, dc); }
            else cmpSelectedCloud = dc;
        }
        const filterParams = new URLSearchParams();
        if (cmpSelectedCloud) filterParams.set('cloud_provider', cmpSelectedCloud);
        else if (selectedCloud) filterParams.set('cloud_provider', selectedCloud);
        if (selectedSubscription) filterParams.set('subscription_id', selectedSubscription);
        const filterQs = filterParams.toString() ? '?' + filterParams.toString() : '';

        const [periods, filters] = await Promise.all([
            fetch('/api/compare/periods' + subParam()).then(r => r.json()),
            fetch('/api/filters' + filterQs).then(r => r.json()),
        ]);
        comparePeriods = periods;
        populateCompareDropdowns();
        populateCmpRG(filters.resource_groups || []);
        onCompareModeChange();
        // Auto-run the period dropdowns so changing a period re-runs without the button.
        ['cmpMonth1', 'cmpMonth2', 'cmpGroupBy'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el._cmpAutoBound) { el._cmpAutoBound = true; el.addEventListener('change', cmpAutoRun); }
        });
        await runComparison();
    } catch (err) {
        console.error('Compare load error:', err);
    }
}

// Debounced auto-run for Compare (so picking periods/cloud re-compares automatically).
let _cmpAutoTimer = null;
function cmpAutoRun() {
    clearTimeout(_cmpAutoTimer);
    _cmpAutoTimer = setTimeout(() => { if (typeof runComparison === 'function') runComparison(); }, 350);
}

let cmpRGOptions = [];       // array of display strings
let cmpAccountIdMap = {};    // display name → provider_id (for AWS/GCP accounts)
let cmpSelectedRGs = new Set();
let cmpSelectedCloud = '';

function setCmpCloud(btn, cloud) {
    cmpSelectedCloud = cloud;
    document.querySelectorAll('[data-cmp-cloud]').forEach(b => b.classList.toggle('active', b.dataset.cmpCloud === cloud));

    // Update Group By options based on cloud
    const groupBySel = document.getElementById('cmpGroupBy');
    if (groupBySel) {
        const current = groupBySel.value;
        if (cloud === 'aws') {
            groupBySel.innerHTML = `
                <option value="service_name">Service</option>
                <option value="subscription_id">Account</option>
                <option value="resource_name">Resource Name</option>`;
        } else if (cloud === 'gcp') {
            groupBySel.innerHTML = `
                <option value="service_name">Service</option>
                <option value="subscription_id">Project</option>
                <option value="resource_name">Resource Name</option>`;
        } else {
            groupBySel.innerHTML = `
                <option value="service_name">Service</option>
                <option value="resource_group">Resource Group</option>
                <option value="resource_name">Resource Name</option>`;
        }
        // Restore previous selection if still valid
        if ([...groupBySel.options].some(o => o.value === current)) groupBySel.value = current;
    }

    // Update filter section label and search placeholder
    const rgSectionLabel = document.getElementById('cmpRGSectionLabel');
    const rgSearch = document.getElementById('cmpRGSearch');
    const newLabel = rgLabel(cloud) || 'Resource Group / Region / Project';
    const newPlaceholder = cloud === 'aws' ? 'Search accounts...' : cloud === 'gcp' ? 'Search projects...' : 'Search RGs...';
    if (rgSectionLabel) rgSectionLabel.textContent = newLabel;
    if (rgSearch) rgSearch.placeholder = newPlaceholder;

    // Reload filter values scoped to the selected cloud
    if (cloud === 'aws') {
        fetch('/api/cloud-providers').then(r => r.json()).then(providers => {
            const awsAccounts = providers.filter(p => p.provider_type === 'aws');
            const idMap = {};
            awsAccounts.forEach(a => { idMap[a.name || a.provider_id] = a.provider_id; });
            populateCmpRG(awsAccounts.map(a => a.name || a.provider_id), idMap);
            _populateCmpAccountFilter(awsAccounts, 'aws');
        }).catch(() => { populateCmpRG([]); _hideCmpAccountFilter(); });
    } else if (cloud === 'gcp') {
        fetch('/api/cloud-providers').then(r => r.json()).then(providers => {
            const gcpProjects = providers.filter(p => p.provider_type === 'gcp');
            const idMap = {};
            gcpProjects.forEach(p => { idMap[p.name || p.provider_id] = p.provider_id; });
            populateCmpRG(gcpProjects.map(p => p.name || p.provider_id), idMap);
            _populateCmpAccountFilter(gcpProjects, 'gcp');
        }).catch(() => { populateCmpRG([]); _hideCmpAccountFilter(); });
    } else {
        _hideCmpAccountFilter();
        const filterParams = new URLSearchParams();
        if (cloud) filterParams.set('cloud_provider', cloud);
        else if (selectedCloud) filterParams.set('cloud_provider', selectedCloud);
        if (selectedSubscription) filterParams.set('subscription_id', selectedSubscription);
        const qs = filterParams.toString() ? '?' + filterParams.toString() : '';
        fetch('/api/filters' + qs).then(r => r.json()).then(f => {
            populateCmpRG(f.resource_groups || []);
        }).catch(() => populateCmpRG([]));
    }
    cmpAutoRun();   // auto-apply on cloud change
}

// ── Account filter for AWS/GCP when grouping by service ──────────────────
let _cmpAccountFilterMap = {};  // name → provider_id

function _populateCmpAccountFilter(providers, cloudType) {
    const field  = document.getElementById('cmpAccountFilterField');
    const sel    = document.getElementById('cmpAccountFilterSelect');
    const label  = document.getElementById('cmpAccountFilterLabel');
    if (!field || !sel) return;

    _cmpAccountFilterMap = {};
    providers.forEach(p => { _cmpAccountFilterMap[p.name || p.provider_id] = p.provider_id; });

    sel.innerHTML = `<option value="">All ${cloudType === 'gcp' ? 'projects' : 'accounts'}</option>` +
        providers.map(p => `<option value="${p.provider_id}">${_esc(p.name || p.provider_id)}</option>`).join('');

    if (label) label.textContent = cloudType === 'gcp' ? 'Filter by Project' : 'Filter by Account';
    field.style.display = '';
}

function _hideCmpAccountFilter() {
    const field = document.getElementById('cmpAccountFilterField');
    const sel   = document.getElementById('cmpAccountFilterSelect');
    if (field) field.style.display = 'none';
    if (sel)   sel.value = '';
}

function onCmpAccountFilterChange() {
    // Nothing needed — value is read at compare time
}

function populateCmpRG(rgs, idMap) {
    cmpRGOptions = rgs;
    cmpAccountIdMap = idMap || {};
    cmpSelectedRGs.clear();
    renderCmpRGList();
    updateCmpRGLabel();
}

function toggleCmpRGDropdown() {
    const dd = document.getElementById('cmpRGDropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function renderCmpRGList() {
    const el = document.getElementById('cmpRGList');
    const searchVal = document.getElementById('cmpRGSearch')?.value?.toLowerCase() || '';
    const filtered = searchVal ? cmpRGOptions.filter(rg => rg.toLowerCase().includes(searchVal)) : cmpRGOptions;

    if (!filtered.length) {
        el.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-secondary);font-size:12px">No RGs found</div>';
        return;
    }
    el.innerHTML = filtered.map(rg => {
        const checked = cmpSelectedRGs.has(rg) ? 'checked' : '';
        const esc = rg.replace(/'/g, "\\'");
        return `<label class="multi-select-item ${checked ? 'selected' : ''}">
            <input type="checkbox" ${checked} onchange="cmpRGToggle('${esc}', this)">
            <span>${rg}</span>
        </label>`;
    }).join('');
}

function cmpRGToggle(rg, cb) {
    if (cb.checked) { cmpSelectedRGs.add(rg); cb.parentElement.classList.add('selected'); }
    else { cmpSelectedRGs.delete(rg); cb.parentElement.classList.remove('selected'); }
    updateCmpRGLabel();
}

function cmpRGSelectAll() {
    const searchVal = document.getElementById('cmpRGSearch')?.value?.toLowerCase() || '';
    const filtered = searchVal ? cmpRGOptions.filter(rg => rg.toLowerCase().includes(searchVal)) : cmpRGOptions;
    filtered.forEach(rg => cmpSelectedRGs.add(rg));
    renderCmpRGList();
    updateCmpRGLabel();
}

function cmpRGClearAll() {
    cmpSelectedRGs.clear();
    renderCmpRGList();
    updateCmpRGLabel();
}

function updateCmpRGLabel() {
    const label = document.getElementById('cmpRGLabel');
    const count = document.getElementById('cmpRGCount');
    if (cmpSelectedRGs.size === 0) {
        label.textContent = 'All';
        count.textContent = '';
    } else if (cmpSelectedRGs.size === 1) {
        label.textContent = [...cmpSelectedRGs][0].length > 20 ? [...cmpSelectedRGs][0].substring(0, 20) + '...' : [...cmpSelectedRGs][0];
        count.textContent = '(1)';
    } else {
        label.textContent = `${cmpSelectedRGs.size} selected`;
        count.textContent = `(${cmpSelectedRGs.size})`;
    }
}

function populateCompareDropdowns() {
    const w1 = document.getElementById('cmpWeek1');
    const w2 = document.getElementById('cmpWeek2');

    for (let i = 1; i <= 6; i++) {
        const sel = document.getElementById('cmpMonth' + i);
        if (!sel) continue;
        sel.innerHTML = '';
        comparePeriods.months.forEach((m) => {
            const label = `${formatMonth(m.month)} ($${Number(m.total_cost).toLocaleString(undefined, {maximumFractionDigits:0})})`;
            sel.add(new Option(label, `${m.start_date}|${m.end_date}`));
        });
    }

    const nM = comparePeriods.months.length;
    if (nM >= 2) {
        const m1 = document.getElementById('cmpMonth1');
        const m2 = document.getElementById('cmpMonth2');
        if (m1) m1.selectedIndex = nM - 2;
        if (m2) m2.selectedIndex = nM - 1;
    }

    onCmpExtraPeriodToggle();

    [w1, w2].forEach(sel => { if (sel) sel.innerHTML = ''; });

    // Populate weeks
    comparePeriods.weeks.forEach((w, i) => {
        const label = `${w.week} (${w.start_date} to ${w.end_date}) - $${Number(w.total_cost).toLocaleString(undefined, {maximumFractionDigits:0})}`;
        w1.add(new Option(label, `${w.start_date}|${w.end_date}`));
        w2.add(new Option(label, `${w.start_date}|${w.end_date}`));
    });

    if (comparePeriods.weeks.length >= 2) {
        w1.selectedIndex = comparePeriods.weeks.length - 2;
        w2.selectedIndex = comparePeriods.weeks.length - 1;
    }
}

function onCompareModeChange() {
    const modeEl = document.getElementById('cmpMode');
    const mode = modeEl ? modeEl.value : 'monthly';
    // Use explicit flex so layout is not lost after toggling weekly/monthly (display '' can drop flex)
    document.querySelectorAll('.cmp-monthly').forEach((el) => {
        el.style.display = mode === 'monthly' ? 'flex' : 'none';
    });
    document.querySelectorAll('.cmp-weekly').forEach((el) => {
        el.style.display = mode === 'weekly' ? '' : 'none';
    });
    document.querySelectorAll('.cmp-custom').forEach((el) => {
        el.style.display = mode === 'custom' ? '' : 'none';
    });
    if (mode === 'monthly') onCmpExtraPeriodToggle();
}

/** Normalize /api/compare responses: new shape {labels, rows with costs}, legacy JSON array, or rows with period1_cost. */
function normalizeCompareApiResponse(data) {
    if (data == null) return { error: 'Empty compare response' };
    if (typeof data === 'object' && data.error) return data;
    if (Array.isArray(data)) {
        return {
            labels: ['Period 1', 'Period 2'],
            rows: data.map((r) => ({
                name: r.name,
                costs: [Number(r.period1_cost ?? 0), Number(r.period2_cost ?? 0)],
                difference: r.difference,
                change_pct: r.change_pct,
            })),
        };
    }
    if (typeof data === 'object' && Array.isArray(data.rows)) {
        const rows = data.rows.map((r) => {
            if (Array.isArray(r.costs)) return r;
            if (r.period1_cost !== undefined && r.period2_cost !== undefined) {
                return {
                    name: r.name,
                    costs: [Number(r.period1_cost), Number(r.period2_cost)],
                    difference: r.difference,
                    change_pct: r.change_pct,
                };
            }
            return r;
        });
        return {
            labels: data.labels && data.labels.length ? data.labels : ['Period 1', 'Period 2'],
            rows,
        };
    }
    return { error: 'Unexpected compare response' };
}

function _cmpSetLoading(on) {
    const btn     = document.getElementById('cmpRunBtn');
    const icon    = document.getElementById('cmpBtnIcon');
    const spinner = document.getElementById('cmpBtnSpinner');
    const label   = document.getElementById('cmpBtnLabel');
    if (btn)     btn.disabled              = on;
    if (icon)    icon.style.display        = on ? 'none'         : '';
    if (spinner) spinner.style.display     = on ? 'inline-block' : 'none';
    if (label)   label.textContent         = on ? 'Comparing…'   : 'Compare';

    // Skeleton table loader (same as Monthly Costs)
    const tableLoader = document.getElementById('cmpTableLoader');
    const tableWrap   = tableLoader?.nextElementSibling;  // .table-container
    if (tableLoader) tableLoader.style.display = on ? 'block' : 'none';
    if (tableWrap)   tableWrap.style.display   = on ? 'none'  : '';

    // Chart loaders
    ['cmpBarLoader', 'cmpChangeLoader'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
    });
}

async function runComparison() {
    _cmpSetLoading(true);
    const mode = document.getElementById('cmpMode').value;
    const groupBy = document.getElementById('cmpGroupBy').value;
    /** @type {{from:string,to:string,label:string}[]} */
    let periodSpecs = [];

    if (mode === 'monthly') {
        const indices = getActiveMonthlyPeriodIndices();
        for (const i of indices) {
            const sel = document.getElementById('cmpMonth' + i);
            if (!sel || !sel.value) {
                showToast('Please select each active period month', 'error');
                return;
            }
            const [from, to] = sel.value.split('|');
            const label = sel.options[sel.selectedIndex].text.split(' (')[0];
            periodSpecs.push({ from, to, label });
        }
    } else if (mode === 'weekly') {
        const v1 = document.getElementById('cmpWeek1').value.split('|');
        const v2 = document.getElementById('cmpWeek2').value.split('|');
        if (v1.length < 2 || v2.length < 2) {
            showToast('Please select both weeks', 'error');
            return;
        }
        periodSpecs = [
            { from: v1[0], to: v1[1], label: `${v1[0]} to ${v1[1]}` },
            { from: v2[0], to: v2[1], label: `${v2[0]} to ${v2[1]}` },
        ];
    } else {
        const p1From = document.getElementById('cmpCustom1From').value;
        const p1To = document.getElementById('cmpCustom1To').value;
        const p2From = document.getElementById('cmpCustom2From').value;
        const p2To = document.getElementById('cmpCustom2To').value;
        if (!p1From || !p1To || !p2From || !p2To) {
            showToast('Please fill all custom date ranges', 'error');
            return;
        }
        periodSpecs = [
            { from: p1From, to: p1To, label: `${p1From} to ${p1To}` },
            { from: p2From, to: p2To, label: `${p2From} to ${p2To}` },
        ];
    }

    const rgsParam = cmpSelectedRGs.size > 0 ? [...cmpSelectedRGs].join(',') : '';
    cmpContext = { groupBy, periodSpecs, rgsParam };

    const isAccountCloud = cmpSelectedCloud === 'aws' || cmpSelectedCloud === 'gcp';
    const selectedAccountIds = isAccountCloud && cmpSelectedRGs.size > 0
        ? [...cmpSelectedRGs].map(name => cmpAccountIdMap[name] || name)
        : [];

    // Dedicated account filter (the dropdown shown when grouping by service)
    const accountFilterSel = document.getElementById('cmpAccountFilterSelect');
    const accountFilterId  = accountFilterSel?.value || '';  // single provider_id or ''

    const subQs = () => {
        const q = new URLSearchParams({ group_by: groupBy });
        if (selectedSubscription) q.set('subscription_id', selectedSubscription);
        if (cmpSelectedCloud) q.set('cloud_provider', cmpSelectedCloud);

        // Account filter takes priority over the RG multi-select for scoping
        if (accountFilterId) {
            q.set('subscription_ids', accountFilterId);
        } else if (isAccountCloud && selectedAccountIds.length > 0) {
            q.set('subscription_ids', selectedAccountIds.join(','));
        } else if (!isAccountCloud && cmpSelectedRGs.size > 0) {
            q.set('resource_groups', [...cmpSelectedRGs].join(','));
        }
        return q;
    };

    try {
        let data;

        // 1) Two periods: legacy GET (p1_from … p2_to) — works on older Flask builds that lack POST / periods= param
        if (periodSpecs.length === 2) {
            const q = subQs();
            q.set('p1_from', periodSpecs[0].from);
            q.set('p1_to', periodSpecs[0].to);
            q.set('p2_from', periodSpecs[1].from);
            q.set('p2_to', periodSpecs[1].to);
            let resp = await fetch(`/api/compare?${q}`, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            data = normalizeCompareApiResponse(await resp.json().catch(() => ({})));
            if (!data.error && Array.isArray(data.rows)) {
                data.labels = [periodSpecs[0].label, periodSpecs[1].label];
                renderComparisonResults(data, groupBy);
                return;
            }
        }

        // 2) POST JSON (3+ periods, or fallback when legacy GET failed)
        const body = {
            group_by: groupBy,
            periods: periodSpecs,
        };
        if (selectedSubscription) body.subscription_id = selectedSubscription;
        if (cmpSelectedCloud) body.cloud_provider = cmpSelectedCloud;
        if (isAccountCloud && selectedAccountIds.length > 0) {
            body.subscription_ids = selectedAccountIds;
        } else if (!isAccountCloud && cmpSelectedRGs.size > 0) {
            body.resource_groups = [...cmpSelectedRGs];
        }

        let resp = await fetch('/api/compare', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        data = normalizeCompareApiResponse(await resp.json().catch(() => ({})));

        if (!data.error && Array.isArray(data.rows)) {
            renderComparisonResults(data, groupBy);
            return;
        }

        // 3) GET with periods= JSON (last resort)
        const q2 = subQs();
        q2.set('periods', JSON.stringify(periodSpecs));
        resp = await fetch(`/api/compare?${q2}`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        data = normalizeCompareApiResponse(await resp.json().catch(() => ({})));

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        if (!Array.isArray(data.rows)) {
            showToast('Compare failed: unexpected response', 'error');
            return;
        }
        renderComparisonResults(data, groupBy);
    } catch (err) {
        console.error('Comparison error:', err);
        showToast('Comparison failed', 'error');
    } finally {
        _cmpSetLoading(false);
    }
}

function buildDrilldownUrl(name) {
    const { groupBy, periodSpecs, rgsParam } = cmpContext;
    const qp = new URLSearchParams({
        name,
        group_by: groupBy,
        periods: JSON.stringify(periodSpecs || []),
    });
    if (selectedSubscription) qp.set('subscription_id', selectedSubscription);
    if (rgsParam) qp.set('resource_groups', rgsParam);
    return `/drilldown?${qp}`;
}

function renderComparisonResults(payload, groupBy) {
    const labels = payload.labels || [];
    const data = payload.rows || [];
    const n = labels.length;
    const groupLabel = groupBy === 'service_name' ? 'Service' : (groupBy === 'resource_group' ? rgLabel(selectedCloud) : (groupBy === 'resource_name' ? 'Resource' : 'Meter Category'));

    const periodTotals = labels.map((_, pi) => data.reduce((s, r) => s + (r.costs[pi] || 0), 0));
    const firstTotal = periodTotals[0] || 0;
    const lastTotal = periodTotals[n - 1] || 0;
    const totalDiff = lastTotal - firstTotal;
    const totalPct = firstTotal > 0 ? (totalDiff / firstTotal * 100) : 0;
    const increased = data.filter(r => r.difference > 0).length;
    const decreased = data.filter(r => r.difference < 0).length;

    const _cmpVal  = 'font-size:18px;font-weight:700;line-height:1.2;margin-top:3px';
    const _cmpSub  = 'font-size:10px;margin-top:3px;';

    const periodCards = labels.map((lb, i) => `
        <div class="stat-card" style="padding:8px 12px;border-radius:8px;min-width:120px">
            <div class="stat-label" style="font-size:9px;margin-bottom:0">${lb}</div>
            <div style="${_cmpVal};color:var(--accent)">${curSym()}${periodTotals[i].toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>
    `).join('');

    document.getElementById('cmpSummaryCards').innerHTML = periodCards + `
        <div class="stat-card" style="padding:8px 12px;border-radius:8px;min-width:120px">
            <div class="stat-label" style="font-size:9px;margin-bottom:0">${n > 2 ? 'Last vs first' : 'Difference'}</div>
            <div style="${_cmpVal};color:${totalDiff > 0 ? 'var(--red)' : 'var(--green)'}">
                ${totalDiff > 0 ? '+' : ''}${curSym()}${totalDiff.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
            </div>
            <div style="${_cmpSub}color:${totalDiff > 0 ? 'var(--red)' : 'var(--green)'}">${totalDiff > 0 ? '▲' : '▼'} ${Math.abs(totalPct).toFixed(1)}%</div>
        </div>
        <div class="stat-card" style="padding:8px 12px;border-radius:8px;min-width:120px">
            <div class="stat-label" style="font-size:9px;margin-bottom:0">Items changed</div>
            <div style="${_cmpVal}">
                <span style="color:var(--red)">${increased} ▲</span>
                <span style="color:var(--text-tertiary);margin:0 4px;font-size:13px">|</span>
                <span style="color:var(--green)">${decreased} ▼</span>
            </div>
            <div style="${_cmpSub}color:var(--text-tertiary)">of ${data.length.toLocaleString()} ${groupLabel}s</div>
        </div>
    `;

    const thPeriods = labels.map((lb) => `<th>${lb.replace(/</g, '&lt;')}</th>`).join('');
    document.getElementById('cmpTableHead').innerHTML = `<tr>
        <th>Name</th>${thPeriods}
        <th>${n > 2 ? 'Last − first' : 'Difference'}</th>
        <th>Change %</th>
        <th>Trend</th>
    </tr>`;

    const titleSuffix = labels.length <= 2 ? `${labels[0] || ''} vs ${labels[1] || ''}` : `${n} periods`;
    document.getElementById('cmpTableTitle').textContent = `${groupLabel} comparison: ${titleSuffix}`;
    document.getElementById('cmpTableCount').textContent = `${data.length} items`;
    document.getElementById('cmpBarTitle').textContent = `${groupLabel}: ${titleSuffix}`;

    const maxDiff = Math.max(...data.map(r => Math.abs(r.difference)), 1);
    document.getElementById('cmpTableBody').innerHTML = data.map(r => {
        const costs = r.costs || [];
        const costCells = labels.map((_, i) =>
            `<td>${curSym()}${(costs[i] ?? 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>`
        ).join('');
        const barWidth = Math.max(4, Math.min(120, Math.abs(r.difference) / maxDiff * 120));
        const barClass = r.difference > 0 ? 'up' : (r.difference < 0 ? 'down' : 'neutral');
        const badgeClass = r.change_pct > 0 ? 'up' : (r.change_pct < 0 ? 'down' : 'neutral');
        const arrow = r.change_pct > 0 ? '▲' : (r.change_pct < 0 ? '▼' : '–');
        const ddUrl = buildDrilldownUrl(r.name);
        const escName = String(r.name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        return `<tr style="cursor:pointer" title="Click to open details — Right-click to open in new tab">
            <td><a href="${ddUrl}" target="_blank" style="font-weight:500;color:var(--accent);text-decoration:underline">${escName}</a></td>
            ${costCells}
            <td style="color:${r.difference > 0 ? 'var(--red)' : 'var(--green)'};font-weight:500">
                ${r.difference > 0 ? '+' : ''}${curSym()}${r.difference.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
            </td>
            <td><span class="cmp-badge ${badgeClass}">${arrow} ${Math.abs(r.change_pct).toFixed(1)}%</span></td>
            <td><span class="trend-bar ${barClass}" style="width:${barWidth}px"></span></td>
        </tr>`;
    }).join('');

    const top15 = data.filter(r => (r.costs || []).some(c => c > 0)).slice(0, 15);
    const barDatasets = labels.map((lb, i) => ({
        label: lb,
        data: top15.map(r => (r.costs || [])[i] ?? 0),
        backgroundColor: CMP_PERIOD_COLORS[i % CMP_PERIOD_COLORS.length],
        borderRadius: 6,
        barPercentage: n > 3 ? 0.65 : 0.4,
    }));
    renderChart('cmpBarChart', 'bar', {
        labels: top15.map(r => r.name.length > 20 ? r.name.substring(0, 20) + '...' : r.name),
        datasets: barDatasets,
    }, 'Comparison', { stacked: false });

    const byChange = [...data].filter(r => (r.costs && r.costs[0] > 0)).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 15);
    const chTitle = document.querySelector('#page-compare .charts-grid .chart-card:nth-child(2) h3');
    if (chTitle) chTitle.textContent = n > 2 ? 'Change % (last vs first period)' : 'Change % by item';
    // Hide chart loaders once charts are drawn
    document.getElementById('cmpBarLoader')?.classList.add('hidden');
    document.getElementById('cmpChangeLoader')?.classList.add('hidden');

    renderChart('cmpChangeChart', 'bar', {
        labels: byChange.map(r => r.name.length > 20 ? r.name.substring(0, 20) + '...' : r.name),
        datasets: [{
            label: 'Change %',
            data: byChange.map(r => r.change_pct),
            backgroundColor: byChange.map(r => r.change_pct > 0 ? 'rgba(231,76,60,0.7)' : 'rgba(46,204,113,0.7)'),
            borderRadius: 6,
        }],
    }, 'Change %');
}

// ─── Chart Rendering ─────────────────────────────────────────────────────
function renderChart(canvasId, type, data, title, extraOpts = {}) {
    if (chartInstances[canvasId]) {
        chartInstances[canvasId].destroy();
    }

    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    let actualType = type;
    let indexAxis = undefined;
    if (type === 'horizontalBar') {
        actualType = 'bar';
        indexAxis = 'y';
    }

    const isStacked = extraOpts.stacked || false;
    Chart.defaults.color = CHART_TEXT();
    Chart.defaults.borderColor = CHART_GRID();
    const showLegend = type === 'doughnut' || type === 'pie' || isStacked || (data.datasets && data.datasets.length > 1);
    const chartData = JSON.parse(JSON.stringify(data || {}));
    const centerLabelPlugin = {
        id: `centerLabel-${canvasId}`,
        afterDraw(chart) {
            if (!(type === 'doughnut' || type === 'pie')) return;
            const text = chart?.config?.options?.plugins?.centerLabel?.text;
            if (!text) return;
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            ctx.save();
            ctx.fillStyle = CHART_TEXT();
            ctx.font = "500 12px Inter, sans-serif";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2);
            ctx.restore();
        }
    };

    if (type === 'doughnut' || type === 'pie') {
        const ds = chartData.datasets?.[0];
        const labels = chartData.labels || [];
        const values = (ds?.data || []).map(v => Number(v || 0));
        const zipped = labels.map((l, i) => ({ label: l, value: values[i] || 0 })).sort((a, b) => b.value - a.value);
        const top = zipped.slice(0, 5);
        const other = zipped.slice(5).reduce((s, r) => s + r.value, 0);
        if (other > 0) top.push({ label: 'Other', value: other });
        chartData.labels = top.map(r => r.label);
        ds.data = top.map(r => r.value);
        const base = CHART_COLORS();
        ds.backgroundColor = top.map((_, i) => i < base.length - 1 ? base[i] : cssVar('--chart-other'));
        ds.borderColor = cssVar('--bg-card');
        ds.borderWidth = 1;
        const total = top.reduce((s, r) => s + r.value, 0);
        extraOpts.centerLabel = { text: curSym() + total.toLocaleString(undefined, { maximumFractionDigits: 0 }) };
    }

    chartInstances[canvasId] = new Chart(ctx, {
        type: actualType,
        data: chartData,
        plugins: [centerLabelPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: indexAxis,
            plugins: {
                legend: {
                    display: showLegend,
                    position: isStacked ? 'top' : 'right',
                    labels: { color: CHART_TEXT(), font: { size: 10 }, padding: 8, boxWidth: 12 }
                },
                title: { display: false },
                centerLabel: extraOpts.centerLabel || {}
            },
            scales: (type !== 'doughnut' && type !== 'pie') ? {
                x: {
                    stacked: isStacked,
                    ticks: { color: CHART_TEXT(), font: { size: 10 }, maxTicksLimit: 15 },
                    grid: { color: CHART_GRID() }
                },
                y: {
                    stacked: isStacked,
                    ticks: { color: CHART_TEXT(), font: { size: 10 } },
                    grid: { color: CHART_GRID() }
                }
            } : undefined
        }
    });
}

// ─── Sync ────────────────────────────────────────────────────────────────
async function startSync(mode = 'incremental') {
    // Redirect all sync calls to Sync Center
    openSyncCenter();
    await scStartSync(mode);
}

function monitorSync() {
    _scMonitorSync();
}

// ─── Export ──────────────────────────────────────────────────────────────
function exportCSV() {
    const params = new URLSearchParams();
    const search = document.getElementById('costSearch')?.value;
    const dateFrom = document.getElementById('costDateFrom')?.value;
    const dateTo = document.getElementById('costDateTo')?.value;
    const granularity = document.getElementById('costGranularity')?.value || 'monthly';
    const rgValues = [...cdRgSelected];
    const serviceValues = [...cdSvcSelected];
    const accSelected = [...cdAccSelected];
    const resType = (costsSelectedCloud === 'aws') ? (document.getElementById('costResourceType')?.value || '') : '';
    const activeCloud = costsSelectedCloud || '';
    const includeBlankRG = rgValues.includes('__BLANK__');
    const includeBlankService = serviceValues.includes('__BLANK__');
    const includeBlankSub = accSelected.includes('__BLANK__');
    const rg = rgValues.filter(v => v !== '__BLANK__');
    const services = serviceValues.filter(v => v !== '__BLANK__');
    const subs = accSelected.filter(v => v !== '__BLANK__');
    if (search) params.set('search', search);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    params.set('granularity', granularity);
    if (rg.length) params.set('resource_groups', rg.join(','));
    if (services.length) params.set('service_names', services.join(','));
    if (includeBlankRG) params.set('include_blank_resource_group', '1');
    if (includeBlankService) params.set('include_blank_service', '1');
    if (resType) params.set('resource_type', resType);
    if (subs.length) params.set('subscription_ids', subs.join(','));
    if (includeBlankSub) params.set('include_blank_subscription', '1');
    else if (!subs.length && selectedSubscription && activeCloud === 'azure') params.set('subscription_id', selectedSubscription);
    if (costsSelectedCloud) params.set('cloud_provider', costsSelectedCloud);
    window.location.href = `/api/export?${params}`;
}

// ─── Chatbot ─────────────────────────────────────────────────────────────
let chatChartCount = 0;

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message) return;

    appendMessage(message, 'user');
    input.value = '';

    // Show typing indicator
    const typingId = appendMessage('<span class="spinner"></span> Thinking...', 'bot');

    try {
        const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await resp.json();

        // Remove typing indicator
        document.getElementById(typingId)?.remove();

        // Format reply (convert **bold** to <strong>)
        let formattedReply = data.reply
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');

        // Add chart if present
        if (data.chart_data) {
            chatChartCount++;
            const chartId = `chatChart${chatChartCount}`;
            formattedReply += `<div class="chart-inline"><canvas id="${chartId}" height="200"></canvas></div>`;
            const msgId = appendMessage(formattedReply, 'bot', true);

            // Render chart after DOM update
            setTimeout(() => renderChatChart(chartId, data.chart_data), 100);
        } else {
            appendMessage(formattedReply, 'bot', true);
        }
    } catch (err) {
        document.getElementById(typingId)?.remove();
        appendMessage('Sorry, something went wrong. Please try again.', 'bot');
    }
}

function appendMessage(content, type, isHTML = false) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    const id = `msg-${Date.now()}`;
    div.id = id;
    div.className = `message ${type}`;
    if (isHTML) {
        div.innerHTML = content;
    } else {
        div.innerHTML = content;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return id;
}

function renderChatChart(canvasId, chartData) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

        const colors = CHART_COLORS();

    let config;
    if (chartData.type === 'comparison') {
        config = {
            type: 'line',
            data: {
                labels: chartData.labels,
                datasets: chartData.datasets.map((ds, i) => ({
                    label: ds.label,
                    data: ds.values,
                    borderColor: colors[i],
                    backgroundColor: `${colors[i]}22`,
                    fill: true,
                    tension: 0.3
                }))
            }
        };
    } else if (chartData.type === 'pie' || chartData.type === 'doughnut') {
        config = {
            type: chartData.type,
            data: {
                labels: chartData.labels,
                datasets: [{ data: chartData.values, backgroundColor: colors, borderWidth: 0 }]
            }
        };
    } else {
        config = {
            type: chartData.type === 'bar' ? 'bar' : 'line',
            data: {
                labels: chartData.labels,
                datasets: [{
                    label: 'Cost ($)',
                    data: chartData.values,
                    borderColor: '#4f6ef7',
                    backgroundColor: chartData.type === 'bar' ? '#4f6ef7' : 'rgba(79,110,247,0.1)',
                    fill: chartData.type !== 'bar',
                    tension: 0.3,
                    borderRadius: chartData.type === 'bar' ? 6 : 0
                }]
            }
        };
    }

    config.options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#8b8fa3', font: { size: 10 } } }
        },
        scales: (chartData.type !== 'pie' && chartData.type !== 'doughnut') ? {
            x: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(45,49,72,0.5)' } },
            y: { ticks: { color: '#8b8fa3', font: { size: 9 } }, grid: { color: 'rgba(45,49,72,0.5)' } }
        } : undefined
    };

    new Chart(ctx, config);
}

// ─── Drilldown Modal ─────────────────────────────────────────────────────
let drilldownData = null;

let drilldownLabels = [];

async function openDrilldown(name) {
    const { groupBy, periodSpecs } = cmpContext;
    if (!groupBy || !periodSpecs || periodSpecs.length < 2) return;

    drilldownLabels = periodSpecs.map((p) => p.label);
    const n = drilldownLabels.length;

    try {
        const params = new URLSearchParams({
            group_by: groupBy,
            name,
            periods: JSON.stringify(periodSpecs.map(({ from, to, label }) => ({ from, to, label }))),
        });
        if (selectedSubscription) params.set('subscription_id', selectedSubscription);
        if (cmpContext.rgsParam) params.set('resource_groups', cmpContext.rgsParam);
        drilldownData = await fetch(`/api/compare/drilldown?${params}`).then(r => r.json());

        document.getElementById('drilldownTitle').textContent =
            n <= 2 ? `${name} — ${drilldownLabels[0]} vs ${drilldownLabels[1]}` : `${name} — ${n} periods`;

        const thP = drilldownLabels.map((lb) => `<th>${lb.replace(/</g, '&lt;')}</th>`).join('');
        document.getElementById('drilldownTableHead').innerHTML = `<tr>
            <th>Name</th>${thP}
            <th>${n > 2 ? 'Last − first' : 'Difference'}</th>
            <th>Change %</th>
            <th>Trend</th>
        </tr>`;

        const dailyTrend = drilldownData.daily_trend || [];
        function sumRange(from, to) {
            const days = dailyTrend.filter((d) => d.date >= from && d.date <= to);
            return { total: days.reduce((s, d) => s + Number(d.total_cost || 0), 0), count: days.length };
        }
        const stats = periodSpecs.map((p) => sumRange(p.from, p.to));
        const firstT = stats[0].total;
        const lastT = stats[n - 1].total;
        const diff = lastT - firstT;
        const pct = firstT > 0 ? (diff / firstT * 100) : 0;

        const periodCards = stats.map((s, i) => `
            <div class="stat-card">
                <div class="stat-label">${drilldownLabels[i].replace(/</g, '&lt;')}</div>
                <div class="stat-value" style="font-size:20px;color:var(--accent)">$${s.total.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                <div style="font-size:12px;color:var(--text-secondary)">${s.count} days</div>
            </div>
        `).join('');

        document.getElementById('drilldownSummary').innerHTML = periodCards + `
            <div class="stat-card">
                <div class="stat-label">${n > 2 ? 'Last vs first' : 'Change'}</div>
                <div class="stat-value" style="font-size:20px;color:${diff > 0 ? 'var(--red)' : 'var(--green)'}">
                    ${diff > 0 ? '+' : ''}$${diff.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
                </div>
                <div style="font-size:12px;color:${diff > 0 ? 'var(--red)' : 'var(--green)'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</div>
            </div>
        `;

        // Daily trend chart
        renderChart('drilldownTrendChart', 'line', {
            labels: dailyTrend.map(d => d.date),
            datasets: [{
                label: 'Daily Cost ($)',
                data: dailyTrend.map(d => d.total_cost),
                borderColor: '#4f6ef7',
                backgroundColor: 'rgba(79,110,247,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
            }]
        }, 'Daily Trend');

        // Build tabs
        const tabKeys = Object.keys(drilldownData).filter(k => k !== 'daily_trend');
        const tabsHtml = tabKeys.map((key, i) =>
            `<button class="tab-btn ${i === 0 ? 'active' : ''}" onclick="switchDrilldownTab('${key}', this)">${key}</button>`
        ).join('');
        document.getElementById('drilldownTabs').innerHTML = tabsHtml;

        // Show first tab
        if (tabKeys.length > 0) {
            renderDrilldownTab(tabKeys[0]);
        }

        // Show modal
        document.getElementById('drilldownModal').style.display = 'flex';

    } catch (err) {
        console.error('Drilldown error:', err);
        showToast('Failed to load details', 'error');
    }
}

function switchDrilldownTab(key, btn) {
    document.querySelectorAll('#drilldownTabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderDrilldownTab(key);
}

function renderDrilldownTab(key) {
    const items = drilldownData[key] || [];
    const lbls = drilldownLabels.length ? drilldownLabels : ['Period 1', 'Period 2'];
    const nc = lbls.length;

    const maxDiff = Math.max(...items.map(r => Math.abs(r.difference || 0)), 1);
    document.getElementById('drilldownTableBody').innerHTML = items.map(r => {
        const costs = r.costs || [r.period1_cost, r.period2_cost];
        const costCells = lbls.map((_, i) => {
            const v = costs[i] ?? 0;
            return `<td>$${Number(v).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>`;
        }).join('');
        const barWidth = Math.max(4, Math.min(100, Math.abs(r.difference) / maxDiff * 100));
        const barClass = r.difference > 0 ? 'up' : (r.difference < 0 ? 'down' : 'neutral');
        const badgeClass = r.change_pct > 0 ? 'up' : (r.change_pct < 0 ? 'down' : 'neutral');
        const arrow = r.change_pct > 0 ? '▲' : (r.change_pct < 0 ? '▼' : '–');
        const esc = String(r.name).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return `<tr>
            <td style="font-weight:500">${esc}</td>
            ${costCells}
            <td style="color:${r.difference > 0 ? 'var(--red)' : 'var(--green)'};font-weight:500">
                ${r.difference > 0 ? '+' : ''}$${r.difference.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}
            </td>
            <td><span class="cmp-badge ${badgeClass}">${arrow} ${Math.abs(r.change_pct).toFixed(1)}%</span></td>
            <td><span class="trend-bar ${barClass}" style="width:${barWidth}px"></span></td>
        </tr>`;
    }).join('');

    document.getElementById('drilldownChartTitle').textContent = `${key} Breakdown`;
    const top10 = items.slice(0, 10);
    const datasets = lbls.map((lb, i) => ({
        label: lb,
        data: top10.map(r => (r.costs || [])[i] ?? 0),
        backgroundColor: CMP_PERIOD_COLORS[i % CMP_PERIOD_COLORS.length],
        borderRadius: 6,
        barPercentage: nc > 3 ? 0.65 : 0.4,
    }));
    renderChart('drilldownBarChart', 'bar', {
        labels: top10.map(r => r.name.length > 25 ? r.name.substring(0, 25) + '...' : r.name),
        datasets,
    }, key);
}

function closeDrilldown(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('drilldownModal').style.display = 'none';
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeDrilldown();
        document.getElementById('cmpRGDropdown').style.display = 'none';
    }
});

document.addEventListener('click', (e) => {
    const dd = document.getElementById('cmpRGDropdown');
    const btn = document.getElementById('cmpRGBtn');
    if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) {
        dd.style.display = 'none';
    }
});

// ─── Toast Notifications ─────────────────────────────────────────────────
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ─── Activity Log ────────────────────────────────────────────────────────
let actSyncInterval = null;
let currentActTab = 'overview';

function switchActTab(tab, btn) {
    currentActTab = tab;
    document.querySelectorAll('.act-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.act-tab-content').forEach(c => c.style.display = 'none');
    const el = document.getElementById(`actTab-${tab}`);
    if (el) el.style.display = '';
    if (tab === 'overview') loadActOverview();
    else if (tab === 'users') loadActUsers();
    else if (tab === 'timeline') loadResourceTimeline();
    else if (tab === 'failed') loadActFailed();
    else if (tab === 'security') loadActSecurity();
    else if (tab === 'logs') loadActivityTable();
}

function setActCloud(btn, cloud) {
    selectedActCloud = cloud;
    document.querySelectorAll('[data-act-cloud]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Reload current tab with new filter
    const activeTab = document.querySelector('.act-tabs .tab-btn.active');
    if (activeTab) activeTab.click();
}

async function loadActivityPage() {
    try {
        await loadActivityAutoSyncStatus();
        const filters = await fetch('/api/activity/filters').then(r => r.json());
        const callerSel = document.getElementById('actCaller');
        if (callerSel && callerSel.options.length <= 1) {
            (filters.callers || []).forEach(c => {
                const o = document.createElement('option');
                o.value = c.id || c;
                o.textContent = c.name || c.id || c;
                callerSel.appendChild(o);
            });
        }
        const tlRG = document.getElementById('tlRG');
        if (tlRG && tlRG.options.length <= 1) {
            (filters.resource_groups || []).forEach(rg => {
                const o = document.createElement('option');
                o.value = rg; o.textContent = rg;
                tlRG.appendChild(o);
            });
        }
    } catch (e) {}
    loadActOverview();
}

function toggleActAutoSyncPanel() {
    const panel = document.getElementById('actAutoSyncPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function loadActivityAutoSyncStatus() {
    try {
        const s = await fetch('/api/activity-auto-sync').then(r => r.json());
        const badge = document.getElementById('actAutoSyncBadge');
        const en = document.getElementById('actAutoEnabled');
        const iv = document.getElementById('actAutoInterval');
        const info = document.getElementById('actAutoInfo');
        if (en) en.checked = !!s.enabled;
        if (iv) iv.value = String(s.interval_minutes || 60);
        const next = s.next_auto_sync ? new Date(s.next_auto_sync).toLocaleString() : 'Not scheduled';
        const last = s.last_auto_sync ? new Date(s.last_auto_sync).toLocaleString() : 'Never';
        if (s.enabled) {
            if (badge) {
                badge.className = 'auto-sync-badge enabled';
                const label = s.interval_minutes >= 60 ? `${s.interval_minutes / 60}h` : `${s.interval_minutes}m`;
                badge.innerHTML = `<span class="auto-sync-dot on"></span> Activity auto-sync: every ${label}`;
            }
            if (info) info.textContent = `Next: ${next} | Last: ${last}`;
        } else {
            if (badge) {
                badge.className = 'auto-sync-badge disabled';
                badge.innerHTML = '<span class="auto-sync-dot off"></span> Activity auto-sync: off';
            }
            if (info) info.textContent = 'Activity auto-sync is disabled';
        }
    } catch (e) {
        console.error('Activity auto-sync status error:', e);
    }
}

async function saveActivityAutoSyncSettings() {
    const enabled = document.getElementById('actAutoEnabled')?.checked || false;
    const interval_minutes = parseInt(document.getElementById('actAutoInterval')?.value || '60', 10);
    try {
        const resp = await fetch('/api/activity-auto-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, interval_minutes })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showToast(data.error || 'Failed to save activity auto-sync settings', 'error');
            return;
        }
        showToast(data.message || 'Activity auto-sync settings saved', 'success');
        loadActivityAutoSyncStatus();
    } catch (e) {
        showToast('Failed to save activity auto-sync settings', 'error');
    }
}

async function runActivityAutoSyncNow() {
    try {
        const resp = await fetch('/api/activity-auto-sync/run-now', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) {
            showToast(data.error || 'Failed to run activity auto-sync', 'error');
            return;
        }
        showToast(data.message || 'Activity auto-sync started', 'success');
        document.getElementById('actSyncBar')?.classList.add('active');
        monitorActivitySync();
        loadActivityAutoSyncStatus();
    } catch (e) {
        showToast('Failed to run activity auto-sync', 'error');
    }
}

// ─── Overview Tab ─────────────────────────────────────────────────────
async function loadActOverview() {
    try {
        const params = new URLSearchParams();
        if (selectedSubscription) params.set('subscription_id', selectedSubscription);
        if (selectedActCloud) params.set('cloud_provider', selectedActCloud);
        const qs = params.toString() ? '?' + params.toString() : '';
        const data = await fetch(`/api/activity/overview${qs}`).then(r => r.json());
        const bs = data.by_status || {};
        const bl = data.by_level || {};
        const bot = data.by_operation_type || {};

        if (!data.total_events || data.total_events === 0) {
            document.getElementById('actOverviewStats').innerHTML = _emptyState('success',
                '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
                'No activity data',
                'Sync activity logs to see events here.',
                [{label:'Sync 7 days', primary:true, onclick:'syncActivityLogs(7)'}]
            );
        } else {
        document.getElementById('actOverviewStats').innerHTML = `
            <div class="stat-card"><div class="stat-label">Total Events</div><div class="stat-value accent">${(data.total_events||0).toLocaleString()}</div></div>
            <div class="stat-card"><div class="stat-label">Succeeded</div><div class="stat-value" style="color:var(--green)">${(bs.Succeeded||0).toLocaleString()}</div></div>
            <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:var(--red)">${(bs.Failed||0).toLocaleString()}</div>
                ${bs.Failed > 0 ? `<div style="font-size:11px;color:var(--red);margin-top:4px;cursor:pointer" onclick="document.querySelector('.act-tabs .tab-btn:nth-child(4)').click()">View details &rarr;</div>` : ''}</div>
            <div class="stat-card"><div class="stat-label">Unique Users</div><div class="stat-value" style="color:var(--purple)">${data.unique_callers||0}</div></div>
            <div class="stat-card"><div class="stat-label">${rgLabel(selectedCloud)}s</div><div class="stat-value" style="color:var(--cyan)">${data.unique_rgs||0}</div></div>
            <div class="stat-card"><div class="stat-label">Warnings</div><div class="stat-value" style="color:var(--orange)">${(bl.Warning||0).toLocaleString()}</div></div>
        `;

        const trend = data.daily_trend || [];
        renderChart('actDailyChart', 'bar', {
            labels: trend.map(d => d.day),
            datasets: [
                { label: 'Total', data: trend.map(d => d.cnt), backgroundColor: 'rgba(79,110,247,0.7)', borderRadius: 4 },
                { label: 'Failed', data: trend.map(d => d.failed_cnt), backgroundColor: 'rgba(231,76,60,0.7)', borderRadius: 4 }
            ]
        }, 'Daily Activity', { stacked: true });

        const opLabels = Object.keys(bot);
        const opColors = { 'Create/Update': '#2ecc71', 'Delete': '#e74c3c', 'Read': '#4f6ef7', 'Action': '#f39c12', 'Health/Advisory': '#9b59b6', 'Other': '#8b8fa3' };
        renderChart('actOpTypeChart', 'doughnut', {
            labels: opLabels,
            datasets: [{ data: opLabels.map(k => bot[k]), backgroundColor: opLabels.map(k => opColors[k] || '#8b8fa3'), borderWidth: 0 }]
        }, 'Operation Types');

        const statusLabels = Object.keys(bs);
        const statusColors = { 'Succeeded': '#2ecc71', 'Failed': '#e74c3c', 'Started': '#4f6ef7', 'Accepted': '#f39c12' };
        renderChart('actStatusChart', 'doughnut', {
            labels: statusLabels,
            datasets: [{ data: statusLabels.map(k => bs[k]), backgroundColor: statusLabels.map(k => statusColors[k] || '#8b8fa3'), borderWidth: 0 }]
        }, 'By Status');

        // Heatmap as a bubble/matrix chart using bar
        const hm = data.hourly_heatmap || [];
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const hmData = Array.from({length: 7}, () => Array(24).fill(0));
        hm.forEach(h => { if (h.dow >= 0 && h.dow < 7 && h.hour >= 0 && h.hour < 24) hmData[h.dow][h.hour] = h.cnt; });
        const hmLabels = Array.from({length: 24}, (_, i) => `${i}:00`);
        const hmDatasets = days.map((d, di) => ({
            label: d,
            data: hmData[di],
            backgroundColor: `rgba(79,110,247,${0.15 + di * 0.1})`,
            borderRadius: 2,
        }));
        renderChart('actHeatmapChart', 'bar', { labels: hmLabels, datasets: hmDatasets }, 'Heatmap', { stacked: true });

        const topRes = data.top_resources || [];
        document.getElementById('actTopResourcesBody').innerHTML = topRes.length ? topRes.map(r =>
            `<tr style="cursor:pointer" onclick="viewResourceTimeline('${(r.resource_name||'').replace(/'/g,"\\'")}')">
                <td style="color:var(--accent);font-weight:500">${r.resource_name||'-'}</td>
                <td style="font-size:12px">${(r.resource_type||'').split('/').pop()}</td>
                <td style="font-size:12px">${r.resource_group||'-'}</td>
                <td><strong>${r.cnt}</strong></td>
            </tr>`
        ).join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-secondary)">No data</td></tr>';
        } // end else (total_events > 0)

    } catch (err) { console.error('Activity overview error:', err); }
}

// ─── User Activity Tab ────────────────────────────────────────────────
async function loadActUsers() {
    try {
        const params = new URLSearchParams();
        if (selectedSubscription) params.set('subscription_id', selectedSubscription);
        if (selectedActCloud) params.set('cloud_provider', selectedActCloud);
        const qs = params.toString() ? '?' + params.toString() : '';
        const data = await fetch(`/api/activity/users${qs}`).then(r => r.json());
        const users = data.users || [];

        if (!users.length) {
            document.getElementById('userActStats').innerHTML = '<div class="stat-card"><div class="stat-label">No user data</div></div>';
            return;
        }

        const topUser = users[0];
        const totalOps = users.reduce((s, u) => s + u.total_ops, 0);
        document.getElementById('userActStats').innerHTML = `
            <div class="stat-card"><div class="stat-label">Total Users</div><div class="stat-value accent">${users.length}</div></div>
            <div class="stat-card"><div class="stat-label">Most Active</div><div class="stat-value" style="font-size:16px;color:var(--cyan)">${(topUser.caller_display||topUser.caller||'').substring(0,25)}</div>
                <div style="font-size:12px;color:var(--text-secondary)">${topUser.total_ops} operations</div></div>
            <div class="stat-card"><div class="stat-label">Total Creates</div><div class="stat-value" style="color:var(--green)">${users.reduce((s,u)=>s+u.creates,0)}</div></div>
            <div class="stat-card"><div class="stat-label">Total Deletes</div><div class="stat-value" style="color:var(--red)">${users.reduce((s,u)=>s+u.deletes,0)}</div></div>
        `;

        const top10 = users.slice(0, 10);
        renderChart('userActChart', 'bar', {
            labels: top10.map(u => (u.caller_display||u.caller||'?').substring(0, 20)),
            datasets: [
                { label: 'Succeeded', data: top10.map(u => u.succeeded), backgroundColor: '#2ecc71', borderRadius: 4, barPercentage: 0.5 },
                { label: 'Failed', data: top10.map(u => u.failed), backgroundColor: '#e74c3c', borderRadius: 4, barPercentage: 0.5 }
            ]
        }, 'User Operations', { stacked: true });

        document.getElementById('userActTableBody').innerHTML = users.map(u => {
            const name = u.caller_display || u.caller || '';
            const nameShort = name.length > 35 ? name.substring(0,35)+'...' : name;
            const failPct = u.total_ops > 0 ? (u.failed / u.total_ops * 100).toFixed(1) : 0;
            const lastSeen = u.last_seen ? new Date(u.last_seen).toLocaleString() : '-';
            return `<tr>
                <td title="${name}" style="color:var(--cyan);font-size:12px;font-weight:500">${nameShort}</td>
                <td><strong>${u.total_ops}</strong></td>
                <td style="color:var(--green)">${u.succeeded}</td>
                <td style="color:var(--red)">${u.failed}${u.failed > 0 ? ` <span style="font-size:11px;color:var(--text-secondary)">(${failPct}%)</span>` : ''}</td>
                <td style="color:var(--green)">${u.creates}</td>
                <td style="color:var(--red)">${u.deletes}</td>
                <td>${u.resource_count}</td>
                <td style="font-size:12px;white-space:nowrap">${lastSeen}</td>
            </tr>`;
        }).join('');

    } catch (err) { console.error('User activity error:', err); }
}

// ─── Resource Timeline Tab ────────────────────────────────────────────
async function loadResourceTimeline() {
    const rg = document.getElementById('tlRG')?.value || '';
    const resName = document.getElementById('tlResName')?.value || '';
    document.getElementById('tlEventTimeline').style.display = 'none';
    document.getElementById('tlResourceList').style.display = '';

    try {
        const params = new URLSearchParams();
        if (rg) params.set('resource_group', rg);
        if (resName) params.set('resource_name', resName);
        if (selectedSubscription) params.set('subscription_id', selectedSubscription);
        if (selectedActCloud) params.set('cloud_provider', selectedActCloud);

        let url = `/api/activity/resource-timeline?${params}`;
        if (resName && resName.length >= 2) {
            // If user typed a resource name, try exact match
        }
        const data = await fetch(url).then(r => r.json());
        const resources = data.resources || [];

        if (!resources.length) {
            document.getElementById('tlResourceList').innerHTML = '<div class="stat-card" style="text-align:center;padding:30px;color:var(--text-secondary)">No resources found. Sync activity logs first.</div>';
            return;
        }

        document.getElementById('tlResourceList').innerHTML = resources.map(r => {
            const ops = (r.op_types || '').split(',');
            const opTags = ops.map(o => {
                const cls = o.trim().toLowerCase() === 'create' ? 'create' : (o.trim().toLowerCase() === 'delete' ? 'delete' : (o.trim().toLowerCase() === 'action' ? 'action' : 'other'));
                return `<span class="tl-op-tag ${cls}">${o.trim()}</span>`;
            }).join('');
            const firstDate = r.first_event ? new Date(r.first_event).toLocaleDateString() : '';
            const lastDate = r.last_event ? new Date(r.last_event).toLocaleDateString() : '';
            return `<div class="tl-resource-card" onclick="viewResourceTimeline('${(r.resource_name||'').replace(/'/g,"\\'")}')">
                <div style="flex:1">
                    <div class="tl-resource-name">${r.resource_name||'-'}</div>
                    <div class="tl-resource-type">${(r.resource_type||'').split('/').pop()} ${r.resource_group ? '&bull; ' + r.resource_group : ''}</div>
                    <div class="tl-resource-meta">
                        <span>${r.event_count} events</span>
                        ${r.failures > 0 ? `<span style="color:var(--red)">${r.failures} failures</span>` : ''}
                        <span>${firstDate} &ndash; ${lastDate}</span>
                    </div>
                </div>
                <div class="tl-op-tags">${opTags}</div>
            </div>`;
        }).join('');

    } catch (err) { console.error('Resource timeline error:', err); }
}

async function viewResourceTimeline(resourceName) {
    document.getElementById('tlResourceList').style.display = 'none';
    document.getElementById('tlEventTimeline').style.display = '';
    document.getElementById('tlResourceTitle').textContent = resourceName;

    try {
        const params = new URLSearchParams({ resource_name: resourceName });
        if (selectedSubscription) params.set('subscription_id', selectedSubscription);
        const data = await fetch(`/api/activity/resource-timeline?${params}`).then(r => r.json());
        const events = data.events || [];

        if (!events.length) {
            document.getElementById('tlTimelineEvents').innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-secondary)">No events found.</div>';
            return;
        }

        document.getElementById('tlTimelineEvents').innerHTML = events.map(e => {
            const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
            const cls = e.status === 'Failed' ? 'failed' : (e.level === 'Warning' ? 'warning' : 'succeeded');
            const opClean = (e.operation_name || '').replace(/Microsoft\.\w+\//gi, '');
            const caller = e.caller_display || e.caller || '';
            const callerShort = caller.length > 40 ? caller.substring(0,40)+'...' : caller;
            return `<div class="tl-event ${cls}">
                <div class="tl-event-time">${time}</div>
                <div class="tl-event-op">${opClean}</div>
                <div class="tl-event-meta">
                    <span>User: <span style="color:var(--cyan)">${callerShort}</span></span>
                    <span>Status: <span class="act-badge ${e.status === 'Succeeded' ? 'act-success' : (e.status === 'Failed' ? 'act-failed' : 'act-info')}">${e.status||'-'}</span></span>
                    ${e.resource_group ? `<span>RG: ${e.resource_group}</span>` : ''}
                </div>
            </div>`;
        }).join('');

    } catch (err) { console.error('Resource timeline events error:', err); }
}

function backToResourceList() {
    document.getElementById('tlEventTimeline').style.display = 'none';
    document.getElementById('tlResourceList').style.display = '';
}

// ─── Failed Operations Tab ────────────────────────────────────────────
async function loadActFailed() {
    try {
        const failParams = new URLSearchParams();
        if (selectedSubscription) failParams.set('subscription_id', selectedSubscription);
        if (selectedActCloud) failParams.set('cloud_provider', selectedActCloud);
        const failQs = failParams.toString() ? '?' + failParams.toString() : '';
        const data = await fetch(`/api/activity/failed${failQs}`).then(r => r.json());

        document.getElementById('failedStats').innerHTML = `
            <div class="stat-card"><div class="stat-label">Total Failures</div><div class="stat-value" style="color:var(--red)">${(data.total_failed||0).toLocaleString()}</div></div>
            <div class="stat-card"><div class="stat-label">Affected Operations</div><div class="stat-value accent">${(data.by_operation||[]).length}</div></div>
            <div class="stat-card"><div class="stat-label">Affected Resources</div><div class="stat-value" style="color:var(--orange)">${(data.by_resource||[]).length}</div></div>
            <div class="stat-card"><div class="stat-label">Users with Failures</div><div class="stat-value" style="color:var(--cyan)">${(data.by_caller||[]).length}</div></div>
        `;

        const ft = data.daily_trend || [];
        renderChart('failedTrendChart', 'bar', {
            labels: ft.map(d => d.day),
            datasets: [{ label: 'Failures', data: ft.map(d => d.cnt), backgroundColor: 'rgba(231,76,60,0.7)', borderRadius: 4 }]
        }, 'Daily Failures');

        const topOps = (data.by_operation || []).slice(0, 8);
        renderChart('failedOpChart', 'bar', {
            labels: topOps.map(o => (o.operation_name||'').replace(/Microsoft\.\w+\//gi, '').substring(0,25)),
            datasets: [{ label: 'Count', data: topOps.map(o => o.cnt), backgroundColor: '#e74c3c', borderRadius: 4 }]
        }, 'Failed Ops');

        const byRes = data.by_resource || [];
        document.getElementById('failedByResourceBody').innerHTML = byRes.length ? byRes.map(r => {
            const opsClean = (r.operations||'').split(',').map(o => o.replace(/Microsoft\.\w+\//gi, '').trim()).slice(0,3).join(', ');
            const last = r.last_occurred ? new Date(r.last_occurred).toLocaleDateString() : '-';
            return `<tr>
                <td style="color:var(--accent);font-weight:500;cursor:pointer" onclick="viewResourceTimeline('${(r.resource_name||'').replace(/'/g,"\\'")}')">${r.resource_name||'-'}</td>
                <td style="font-size:12px">${r.resource_group||'-'}</td>
                <td><strong style="color:var(--red)">${r.cnt}</strong></td>
                <td style="font-size:12px" title="${r.operations||''}">${opsClean}</td>
                <td style="font-size:12px">${last}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-secondary)">No failures found</td></tr>';

        const recent = data.recent || [];
        document.getElementById('failedRecentBody').innerHTML = recent.slice(0,50).map(r => {
            const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
            const opClean = (r.operation_name||'').replace(/Microsoft\.\w+\//gi, '');
            const caller = r.caller_display || r.caller || '';
            return `<tr>
                <td style="font-size:12px;white-space:nowrap">${time}</td>
                <td style="font-size:12px;color:var(--cyan)" title="${caller}">${caller.substring(0,25)}</td>
                <td style="font-size:12px" title="${r.operation_name||''}">${opClean.substring(0,40)}</td>
                <td style="font-size:12px;color:var(--accent)">${r.resource_name||'-'}</td>
                <td><span class="act-badge ${r.level === 'Error' ? 'act-failed' : 'act-warning'}">${r.level||'-'}</span></td>
            </tr>`;
        }).join('');

    } catch (err) { console.error('Failed ops error:', err); }
}

// ─── Security Audit Tab ───────────────────────────────────────────────
async function loadActSecurity() {
    try {
        const secParams = new URLSearchParams();
        if (selectedSubscription) secParams.set('subscription_id', selectedSubscription);
        if (selectedActCloud) secParams.set('cloud_provider', selectedActCloud);
        const secQs = secParams.toString() ? '?' + secParams.toString() : '';
        const data = await fetch(`/api/activity/security${secQs}`).then(r => r.json());
        const byType = data.by_type || {};
        const topCallers = data.top_callers || [];

        document.getElementById('securityStats').innerHTML = `
            <div class="stat-card"><div class="stat-label">Security Events</div><div class="stat-value" style="color:var(--orange)">${(data.total||0).toLocaleString()}</div></div>
            <div class="stat-card"><div class="stat-label">Role Assignments</div><div class="stat-value accent">${byType['Role Assignments']||0}</div></div>
            <div class="stat-card"><div class="stat-label">Network Security</div><div class="stat-value" style="color:var(--red)">${byType['Network Security']||0}</div></div>
            <div class="stat-card"><div class="stat-label">Key Vault</div><div class="stat-value" style="color:var(--purple)">${byType['Key Vault']||0}</div></div>
        `;

        const catLabels = Object.keys(byType);
        const catColors = ['#e74c3c','#f39c12','#4f6ef7','#9b59b6','#2ecc71','#00d2d3','#e84393'];
        renderChart('secCatChart', 'doughnut', {
            labels: catLabels,
            datasets: [{ data: catLabels.map(k => byType[k]), backgroundColor: catColors, borderWidth: 0 }]
        }, 'Security Categories');

        renderChart('secUserChart', 'bar', {
            labels: topCallers.slice(0,8).map(c => (c[0]||'?').substring(0,20)),
            datasets: [{ label: 'Events', data: topCallers.slice(0,8).map(c => c[1]), backgroundColor: '#f39c12', borderRadius: 4 }]
        }, 'Top Users');

        const events = data.events || [];
        document.getElementById('securityEventsBody').innerHTML = events.length ? events.slice(0,100).map(e => {
            const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : '';
            const opClean = (e.operation_name||'').replace(/Microsoft\.\w+\//gi, '');
            const caller = e.caller_display || e.caller || '';
            const statusCls = e.status === 'Succeeded' ? 'act-success' : (e.status === 'Failed' ? 'act-failed' : 'act-info');
            const levelCls = e.level === 'Error' ? 'act-failed' : (e.level === 'Warning' ? 'act-warning' : 'act-info');
            return `<tr>
                <td style="font-size:12px;white-space:nowrap">${time}</td>
                <td style="font-size:12px;color:var(--cyan)" title="${caller}">${caller.substring(0,25)}</td>
                <td style="font-size:12px" title="${e.operation_name||''}">${opClean.substring(0,45)}</td>
                <td style="font-size:12px;color:var(--accent)">${e.resource_name||'-'}</td>
                <td><span class="act-badge ${statusCls}">${e.status||'-'}</span></td>
                <td><span class="act-badge ${levelCls}">${e.level||'-'}</span></td>
            </tr>`;
        }).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-secondary)">No security events found</td></tr>';

    } catch (err) { console.error('Security audit error:', err); }
}

// ─── All Logs Tab ─────────────────────────────────────────────────────
async function loadActivityTable() {
    const params = new URLSearchParams();
    const search = document.getElementById('actSearch')?.value;
    const dateFrom = document.getElementById('actDateFrom')?.value;
    const dateTo = document.getElementById('actDateTo')?.value;
    const caller = document.getElementById('actCaller')?.value;
    const status = document.getElementById('actStatus')?.value;
    const level = document.getElementById('actLevel')?.value;

    if (search) params.set('search', search);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (caller) params.set('caller', caller);
    if (status) params.set('status', status);
    if (level) params.set('level', level);
    if (selectedSubscription) params.set('subscription_id', selectedSubscription);
    if (selectedActCloud) params.set('cloud_provider', selectedActCloud);

    try {
        const data = await fetch(`/api/activity?${params}`).then(r => r.json());
        const tbody = document.getElementById('activityTableBody');

        if (!data.length) {
            const hasFilter = (document.getElementById('actSearch')?.value || '') ||
                (document.getElementById('actDateFrom')?.value || '') ||
                (document.getElementById('actStatus')?.value || '') ||
                (document.getElementById('actLevel')?.value || '');
            tbody.innerHTML = `<tr><td colspan="8" style="padding:0;border:none">` +
                _emptyState('success',
                    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
                    'All quiet here',
                    'No events match your filters. Try widening the date range or syncing more days.',
                    hasFilter ? [{label:'Reset filters', primary:false, onclick:'resetActivityFilters()'}] : []
                ) + `</td></tr>`;
            document.getElementById('activityCount').textContent = '';
            return;
        }

        const preparedRows = data.map(r => {
            const rawRid = r.resource_id || '';
            const ridParts = rawRid ? rawRid.split('/').filter(Boolean) : [];
            const ridName = ridParts.length ? ridParts[ridParts.length - 1] : '';
            const friendlyName = (r.resource_name && r.resource_name.trim()) ? r.resource_name : ridName;
            return {
                ...r,
                resource_display: friendlyName || '-',
                caller_display: r.caller_display || r.caller || '',
                subscription_name: r.subscription_name || '-',
            };
        });
        const sortedRows = sortActivityRows(preparedRows);
        updateActivitySortIndicators();

        tbody.innerHTML = sortedRows.map(r => {
            const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
            const statusClass = r.status === 'Succeeded' ? 'act-success' : (r.status === 'Failed' ? 'act-failed' : 'act-info');
            const levelClass = r.level === 'Error' ? 'act-failed' : (r.level === 'Warning' ? 'act-warning' : 'act-info');
            const opShort = (r.operation_name || '').replace(/Microsoft\.\w+\//gi, '');
            const callerDisplay = r.caller_display || '';
            const callerShort = callerDisplay.length > 30 ? callerDisplay.substring(0, 30) + '...' : callerDisplay;
            const resDisplay = r.resource_display || '-';
            const resShort = resDisplay.length > 35 ? resDisplay.substring(0, 35) + '...' : resDisplay;
            const subName = r.subscription_name || '-';
            const subShort = subName.length > 28 ? subName.substring(0, 28) + '...' : subName;

            return `<tr>
                <td style="white-space:nowrap;font-size:12px">${time}</td>
                <td title="${callerDisplay}" style="font-size:12px;color:var(--cyan)"><span class="ellipsis-cell">${callerShort}</span></td>
                <td title="${r.operation_name || ''}" style="font-size:12px"><span class="ellipsis-cell">${opShort}</span></td>
                <td title="${resDisplay}" style="font-size:12px"><span class="ellipsis-cell">${resShort}</span></td>
                <td title="${subName}" style="font-size:12px"><span class="ellipsis-cell">${subShort}</span></td>
                <td style="font-size:12px"><span class="ellipsis-cell">${r.resource_group || '-'}</span></td>
                <td><span class="act-badge ${statusClass}">${r.status || '-'}</span></td>
                <td><span class="act-badge ${levelClass}">${r.level || '-'}</span></td>
            </tr>`;
        }).join('');

        document.getElementById('activityCount').textContent = `${data.length} events`;
    } catch (err) {
        console.error('Activity table error:', err);
    }
}

function resetActivityFilters() {
  const s = document.getElementById('actSearch'); if (s) s.value = '';
  const df = document.getElementById('actDateFrom'); if (df) df.value = '';
  const dt = document.getElementById('actDateTo'); if (dt) dt.value = '';
  const st = document.getElementById('actStatus'); if (st) st.value = '';
  const lv = document.getElementById('actLevel'); if (lv) lv.value = '';
  loadActivityTable();
}

function sortActivityBy(field) {
    if (actSortBy === field) {
        actSortDir = actSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        actSortBy = field;
        actSortDir = field === 'timestamp' ? 'desc' : 'asc';
    }
    loadActivityTable();
}

function sortActivityRows(rows) {
    const out = [...rows];
    out.sort((a, b) => {
        let av = a[actSortBy];
        let bv = b[actSortBy];

        if (actSortBy === 'timestamp') {
            av = new Date(av || 0).getTime();
            bv = new Date(bv || 0).getTime();
        } else {
            av = (av || '').toString().toLowerCase();
            bv = (bv || '').toString().toLowerCase();
        }

        if (av < bv) return actSortDir === 'asc' ? -1 : 1;
        if (av > bv) return actSortDir === 'asc' ? 1 : -1;
        return 0;
    });
    return out;
}

function updateActivitySortIndicators() {
    const fields = ['timestamp', 'caller_display', 'operation_name', 'resource_display', 'subscription_name', 'resource_group', 'status', 'level'];
    fields.forEach(f => {
        const el = document.getElementById(`act-sort-${f}`);
        if (!el) return;
        if (f === actSortBy) {
            el.textContent = actSortDir === 'asc' ? '↑' : '↓';
            el.classList.add('active');
        } else {
            el.textContent = '↕';
            el.classList.remove('active');
        }
    });
}

function exportActivityCSV() {
    const params = new URLSearchParams();
    const search = document.getElementById('actSearch')?.value;
    const dateFrom = document.getElementById('actDateFrom')?.value;
    const dateTo = document.getElementById('actDateTo')?.value;
    const caller = document.getElementById('actCaller')?.value;
    const status = document.getElementById('actStatus')?.value;
    if (search) params.set('search', search);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (caller) params.set('caller', caller);
    if (status) params.set('status', status);
    if (selectedSubscription) params.set('subscription_id', selectedSubscription);
    if (selectedActCloud) params.set('cloud_provider', selectedActCloud);
    window.open(`/api/activity/export?${params}`, '_blank');
}

async function syncActivityLogs(days) {
    const btn = document.getElementById('actSyncBtn');
    btn.disabled = true;

    const body = { days };
    if (selectedActCloud) body.cloud_provider = selectedActCloud;

    try {
        await fetch('/api/activity/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        document.getElementById('actSyncBar').classList.add('active');
        monitorActivitySync();
    } catch (err) {
        showToast('Activity sync failed', 'error');
        btn.disabled = false;
    }
}

function monitorActivitySync() {
    if (actSyncInterval) clearInterval(actSyncInterval);
    actSyncInterval = setInterval(async () => {
        try {
            const status = await fetch('/api/activity/sync/status').then(r => r.json());
            document.getElementById('actSyncMessage').textContent = status.message;
            document.getElementById('actSyncProgress').style.width = `${status.progress}%`;

            if (!status.running) {
                clearInterval(actSyncInterval);
                actSyncInterval = null;
                document.getElementById('actSyncBtn').disabled = false;

                if (status.progress === 100) {
                    showToast(status.message, 'success');
                    setTimeout(() => {
                        document.getElementById('actSyncBar').classList.remove('active');
                        loadActivityPage();
                    }, 1500);
                } else {
                    showToast(status.message, 'error');
                    document.getElementById('actSyncBar').classList.remove('active');
                }
            }
        } catch (err) {
            clearInterval(actSyncInterval);
        }
    }, 1000);
}

// ─── Subscriptions ────────────────────────────────────────────────────────

async function loadSubscriptionsPage() {
    const list = document.getElementById('subscriptionsList');
    list.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span> Loading...</div>';

    try {
        const subs = await fetch('/api/subscriptions').then(r => r.json());
        document.getElementById('subCount').textContent = `${subs.length} subscription(s)`;

        if (subs.length === 0) {
            list.innerHTML = '<div class="stat-card"><p style="color:var(--text-secondary)">No subscriptions found. Click "Refresh from Azure" to discover.</p></div>';
            return;
        }

        list.innerHTML = subs.map(s => {
            const stateColor = s.state === 'Enabled' ? 'var(--green)' : 'var(--red)';
            const costSync = s.last_cost_sync ? new Date(s.last_cost_sync).toLocaleString() : 'Never';
            const actSync = s.last_activity_sync ? new Date(s.last_activity_sync).toLocaleString() : 'Never';
            return `<div class="stat-card subscription-card" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;margin-bottom:8px">
                <div style="flex:1">
                    <div class="subscription-name" style="font-size:16px;font-weight:700;margin-bottom:6px">${s.name}</div>
                    <div class="subscription-id" style="font-size:12px;font-family:monospace">${s.subscription_id}</div>
                    <div class="subscription-meta" style="margin-top:10px;display:flex;gap:14px;font-size:12px;flex-wrap:wrap">
                        <span>State: <span style="color:${stateColor};font-weight:600">${s.state}</span></span>
                        <span>Cost sync: ${costSync}</span>
                        <span>Activity sync: ${actSync}</span>
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    <label class="toggle-switch">
                        <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSub('${s.subscription_id}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <span style="font-size:12px;color:var(--text-secondary);min-width:60px">${s.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<div class="stat-card"><p style="color:var(--red)">Error: ${err.message}</p></div>`;
    }
}

async function toggleSub(subId, enabled) {
    try {
        await fetch(`/api/subscriptions/${subId}/toggle`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({enabled})
        });
        loadSubscriptionsPage();
        showToast(`Subscription ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

async function discoverSubscriptions() {
    try {
        const resp = await fetch('/api/subscriptions/discover', {method: 'POST'});
        const data = await resp.json();
        showToast(data.message, 'success');
        loadSubscriptionsPage();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ─── Caller Names Modal ───────────────────────────────────────────────────
let _callerNamesData = {};

async function openCallerNamesModal() {
    const modal = document.getElementById('callerNamesModal');
    const list = document.getElementById('callerNamesList');
    list.innerHTML = '<div style="text-align:center;padding:20px"><span class="spinner"></span> Loading...</div>';
    modal.style.display = 'flex';

    try {
        const resp = await fetch('/api/caller-names');
        _callerNamesData = await resp.json();

        const callers = Object.keys(_callerNamesData).sort((a, b) => {
            const aIsEmail = a.includes('@');
            const bIsEmail = b.includes('@');
            if (aIsEmail !== bIsEmail) return aIsEmail ? 1 : -1;
            return a.localeCompare(b);
        });

        if (callers.length === 0) {
            list.innerHTML = '<p style="color:var(--text-secondary)">No callers found. Sync activity logs first.</p>';
            return;
        }

        list.innerHTML = callers.map(id => {
            const name = _callerNamesData[id] || '';
            const isEmail = id.includes('@');
            return `<div class="caller-name-row">
                <span class="caller-id" title="${id}">${id}</span>
                <input type="text" value="${name}" data-caller-id="${id}"
                    placeholder="${isEmail ? '(auto: email)' : 'Enter display name...'}"
                    ${isEmail ? 'disabled style="opacity:0.5"' : ''}>
            </div>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<p style="color:var(--red)">Error: ${err.message}</p>`;
    }
}

function closeCallerNamesModal() {
    document.getElementById('callerNamesModal').style.display = 'none';
}

async function saveCallerNames() {
    const inputs = document.querySelectorAll('#callerNamesList input:not([disabled])');
    const updates = {};
    inputs.forEach(inp => {
        const id = inp.dataset.callerId;
        const name = inp.value.trim();
        if (name && name !== _callerNamesData[id]) {
            updates[id] = name;
        }
    });

    if (Object.keys(updates).length === 0) {
        closeCallerNamesModal();
        return;
    }

    try {
        const resp = await fetch('/api/caller-names', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updates)
        });
        const data = await resp.json();
        closeCallerNamesModal();
        loadActivityPage();
        showToast(data.message || 'Names updated!', 'success');
    } catch (err) {
        showToast('Failed to save: ' + err.message, 'error');
    }
}

function showToast(msg, type) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// ─── Custom Cost Calculator ───────────────────────────────────────────────
let ccSubOptions = [];
let ccSubMap = {};
let ccSubCloud = {};
let ccRgOptions = [];
let ccSvcOptions = [];
let ccSelectedSubs = new Set();
let ccSelectedRgs = new Set();
let ccSelectedSvcs = new Set();
let ccCloudFilter = 'all';
let _ccListenersAttached = false;

async function loadCustomCostPage() {
    try {
        const subs = await fetch('/api/subscriptions').then(r => r.json());
        ccSubOptions = subs.filter(s => s.enabled).map(s => s.subscription_id);
        ccSubMap = {};
        ccSubCloud = {};
        subs.filter(s => s.enabled).forEach(s => {
            ccSubMap[s.subscription_id] = s.name;
            ccSubCloud[s.subscription_id] = (s.cloud || 'azure').toLowerCase();
        });
    } catch (err) { /* ignore */ }

    // Default date range = This month (preview only shows when a filter is selected, not just dates)
    ccApplyDatePreset('month');

    // Cloud filter buttons
    document.querySelectorAll('#ccCloudsFilter .seg').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('#ccCloudsFilter .seg').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            ccCloudFilter = btn.dataset.cloud;
            ccSelectedSubs.clear();
            ccSelectedRgs.clear();
            ccSelectedSvcs.clear();
            ccUpdateCloudLabels(ccCloudFilter);
            ccRenderList('sub');
            await ccLoadFilters();
            ccAutoCalc();   // auto-apply — no Calculate button needed
        });
    });
    // Default to the biggest-spend cloud (no "All"); auto-calculate on landing.
    defaultCloud().then(dc => {
        const chips = document.querySelectorAll('#ccCloudsFilter .seg');
        const target = [...chips].find(b => b.dataset.cloud === dc) || chips[0];
        if (target) {
            chips.forEach(b => b.classList.remove('active'));
            target.classList.add('active');
            ccCloudFilter = target.dataset.cloud;
        }
        ccUpdateCloudLabels(ccCloudFilter);
        ccRenderList('sub');
        ccLoadFilters().then(() => ccAutoCalc());
    });

    // Date range seg buttons
    document.querySelectorAll('#ccDateFilter .seg').forEach(btn => {
        btn.addEventListener('click', () => {
            const range = btn.dataset.range;
            if (range === 'custom') {
                document.querySelectorAll('#ccDateFilter .seg').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const cd = document.getElementById('customDateInputs');
                if (cd) cd.style.display = 'flex';
                ccUpdateSelectionPreview();
            } else {
                ccApplyDatePreset(range);
            }
        });
    });

    // Manual date edits → mark Custom active
    ['ccDateFrom', 'ccDateTo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => {
            document.querySelectorAll('#ccDateFilter .seg').forEach(b => b.classList.remove('active'));
            const custom = document.querySelector('#ccDateFilter .seg[data-range="custom"]');
            if (custom) custom.classList.add('active');
            ccUpdateSelectionPreview();
            ccAutoCalc();
        });
    });

    // Close panels on outside click / ESC (attach once per page load)
    if (!_ccListenersAttached) {
        _ccListenersAttached = true;
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.multiselect')) {
                ['ccSubPanel', 'ccRgPanel', 'ccSvcPanel'].forEach(id => {
                    const el = document.getElementById(id); if (el) el.hidden = true;
                });
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                ['ccSubPanel', 'ccRgPanel', 'ccSvcPanel'].forEach(id => {
                    const el = document.getElementById(id); if (el) el.hidden = true;
                });
            }
        });
    }

    ccRenderList('sub');
    ccUpdateCounts();
    ccLoadFilters();
    ccLoadSavedFilters();
}

function ccApplyDatePreset(range) {
    const now = new Date();
    let from, to;
    if (range === '7d') {
        to = new Date(now); from = new Date(now); from.setDate(from.getDate() - 6);
    } else if (range === '30d') {
        to = new Date(now); from = new Date(now); from.setDate(from.getDate() - 29);
    } else if (range === 'month') {
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (range === 'last-month') {
        from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        to = new Date(now.getFullYear(), now.getMonth(), 0);
    } else {
        return;
    }
    // Local-time formatting — toISOString() converts to UTC and shifts the
    // 1st-of-month back a day in UTC+ timezones (off-by-one).
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const fromEl = document.getElementById('ccDateFrom');
    const toEl = document.getElementById('ccDateTo');
    if (fromEl) fromEl.value = fmt(from);
    if (toEl) toEl.value = fmt(to);
    document.querySelectorAll('#ccDateFilter .seg').forEach(b => b.classList.remove('active'));
    const active = document.querySelector(`#ccDateFilter .seg[data-range="${range}"]`);
    if (active) active.classList.add('active');
    const cd = document.getElementById('customDateInputs');
    if (cd) cd.style.display = 'none';
    ccUpdateSelectionPreview();
    ccAutoCalc();
}

function ccTogglePanel(type) {
    const panelId = type === 'sub' ? 'ccSubPanel' : (type === 'rg' ? 'ccRgPanel' : 'ccSvcPanel');
    const others = ['ccSubPanel', 'ccRgPanel', 'ccSvcPanel'].filter(id => id !== panelId);
    others.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            const search = panel.querySelector('.multiselect__search');
            if (search) search.focus();
        }
    }
}

function ccUpdateCloudLabels(cloud) {
    // Labels per cloud
    const labels = {
        all:   { sub: 'Subscriptions', subPh: 'All subscriptions', subSearch: 'Search subscriptions...', rg: 'Resource Groups', rgPh: 'All resource groups', rgSearch: 'Search resource groups...', showSub: true },
        azure: { sub: 'Subscriptions', subPh: 'All subscriptions', subSearch: 'Search subscriptions...', rg: 'Resource Groups', rgPh: 'All resource groups', rgSearch: 'Search resource groups...', showSub: true },
        aws:   { sub: 'Accounts',      subPh: 'All accounts',      subSearch: 'Search accounts...',      rg: 'Regions',         rgPh: 'All regions',         rgSearch: 'Search regions...',         showSub: true },
        gcp:   { sub: 'Projects',      subPh: 'All projects',      subSearch: 'Search projects...',      rg: 'Projects',        rgPh: 'All projects',        rgSearch: 'Search projects...',        showSub: false },
    };
    const l = labels[cloud] || labels.all;

    // Update sub field
    const subField = document.getElementById('ccSubField');
    const subLabel = document.getElementById('ccSubLabel');
    const subCount = document.getElementById('ccSubCount');
    const subTrigger = document.getElementById('ccSubTriggerText');
    const subSearch = document.getElementById('ccSubSearch');
    if (subField) subField.style.display = l.showSub ? '' : 'none';
    if (subLabel) subLabel.childNodes[0].textContent = l.sub + ' ';
    if (subTrigger && ccSelectedSubs.size === 0) subTrigger.textContent = l.subPh;
    if (subSearch) subSearch.placeholder = l.subSearch;

    // Update rg field
    const rgLabel = document.getElementById('ccRgLabel');
    const rgTrigger = document.getElementById('ccRgTriggerText');
    const rgSearch = document.getElementById('ccRgSearch');
    if (rgLabel) rgLabel.childNodes[0].textContent = l.rg + ' ';
    if (rgTrigger && ccSelectedRgs.size === 0) rgTrigger.textContent = l.rgPh;
    if (rgSearch) rgSearch.placeholder = l.rgSearch;

    // Update results table header
    const rgHeader = document.getElementById('ccRgTableHeader');
    if (rgHeader) rgHeader.textContent = l.rg;
}

async function ccLoadFilters() {
    try {
        const cloudParam = ccCloudFilter !== 'all' ? `cloud_provider=${ccCloudFilter}` : '';

        // For GCP: resource_group = project_id, so subscription filtering would restrict
        // to one project only. Always fetch all GCP resource groups by cloud only.
        // For AWS: same — accounts/regions span subscription boundaries.
        const skipSubFilter = ccCloudFilter === 'gcp' || ccCloudFilter === 'aws';

        const activeSubIds = (!skipSubFilter && ccSelectedSubs.size)
            ? [...ccSelectedSubs]
            : (!skipSubFilter && ccCloudFilter !== 'all'
                ? ccSubOptions.filter(id => (ccSubCloud[id] || 'azure') === ccCloudFilter)
                : null);

        if (activeSubIds && activeSubIds.length === 1) {
            const filters = await fetch(`/api/filters?subscription_id=${activeSubIds[0]}&${cloudParam}`).then(r => r.json());
            ccRgOptions = filters.resource_groups || [];
            ccSvcOptions = filters.services || [];
        } else if (activeSubIds && activeSubIds.length > 1) {
            const allRgs = new Set(), allSvcs = new Set();
            const results = await Promise.all(activeSubIds.map(id =>
                fetch(`/api/filters?subscription_id=${id}&${cloudParam}`).then(r => r.json())
            ));
            results.forEach(f => {
                (f.resource_groups || []).forEach(rg => allRgs.add(rg));
                (f.services || []).forEach(svc => allSvcs.add(svc));
            });
            ccRgOptions = [...allRgs].sort();
            ccSvcOptions = [...allSvcs].sort();
        } else {
            const filters = await fetch(`/api/filters?${cloudParam}`).then(r => r.json());
            ccRgOptions = filters.resource_groups || [];
            ccSvcOptions = filters.services || [];
        }
        ccSelectedRgs.clear();
        ccSelectedSvcs.clear();
        ccRenderList('rg');
        ccRenderList('svc');
        ccUpdateCounts();
    } catch (err) {
        console.error('CC filter load error:', err);
    }
}

function ccVisibleSubOptions() {
    if (ccCloudFilter === 'all') return ccSubOptions;
    return ccSubOptions.filter(id => (ccSubCloud[id] || 'azure') === ccCloudFilter);
}

function ccRenderList(type) {
    const listElId = type === 'sub' ? 'ccSubList' : (type === 'rg' ? 'ccRgList' : 'ccSvcList');
    const listEl = document.getElementById(listElId);
    if (!listEl) return;
    const searchElId = type === 'sub' ? 'ccSubSearch' : (type === 'rg' ? 'ccRgSearch' : 'ccSvcSearch');

    let items, selected;
    if (type === 'sub') { items = ccVisibleSubOptions(); selected = ccSelectedSubs; }
    else if (type === 'rg') { items = ccRgOptions; selected = ccSelectedRgs; }
    else { items = ccSvcOptions; selected = ccSelectedSvcs; }

    const searchVal = document.getElementById(searchElId)?.value?.toLowerCase() || '';
    const filtered = searchVal ? items.filter(i => {
        let label = (type === 'sub') ? (ccSubMap[i] || i) : (type === 'rg' ? (i.trim() ? i : 'reservation') : i);
        return label.toLowerCase().includes(searchVal);
    }) : items;

    if (filtered.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">No items found</div>';
        return;
    }

    listEl.innerHTML = filtered.map(item => {
        const checked = selected.has(item) ? 'checked' : '';
        const escaped = item.replace(/"/g, '&quot;').replace(/'/g, "\\'");
        let label = (type === 'sub') ? (ccSubMap[item] || item) : (type === 'rg' ? (item.trim() ? item : 'Reservation') : item);
        return `<label class="multiselect__option">
            <input type="checkbox" ${checked} onchange="ccToggleItem('${type}', '${escaped}', this)">
            <span>${label}</span>
        </label>`;
    }).join('');
}

// Debounced auto-calculate — runs ccCalculate shortly after any filter change so
// the user doesn't have to click Calculate.
let _ccAutoTimer = null;
function ccAutoCalc() {
    clearTimeout(_ccAutoTimer);
    _ccAutoTimer = setTimeout(() => { if (typeof ccCalculate === 'function') ccCalculate(); }, 400);
}

function ccToggleItem(type, item, checkbox) {
    const selected = type === 'sub' ? ccSelectedSubs : (type === 'rg' ? ccSelectedRgs : ccSelectedSvcs);
    if (checkbox.checked) selected.add(item);
    else selected.delete(item);
    ccUpdateCounts();
    if (type === 'sub') ccLoadFilters();
    ccAutoCalc();
}

function ccSelectAll(type) {
    const items = type === 'sub' ? ccVisibleSubOptions() : (type === 'rg' ? ccRgOptions : ccSvcOptions);
    const selected = type === 'sub' ? ccSelectedSubs : (type === 'rg' ? ccSelectedRgs : ccSelectedSvcs);
    const searchElId = type === 'sub' ? 'ccSubSearch' : (type === 'rg' ? 'ccRgSearch' : 'ccSvcSearch');
    const searchVal = document.getElementById(searchElId)?.value?.toLowerCase() || '';
    const filtered = searchVal ? items.filter(i => {
        let label = (type === 'sub') ? (ccSubMap[i] || i) : (type === 'rg' ? (i.trim() ? i : 'reservation') : i);
        return label.toLowerCase().includes(searchVal);
    }) : items;
    filtered.forEach(i => selected.add(i));
    ccRenderList(type);
    ccUpdateCounts();
    if (type === 'sub') ccLoadFilters();
    ccAutoCalc();
}

function ccDeselectAll(type) {
    const selected = type === 'sub' ? ccSelectedSubs : (type === 'rg' ? ccSelectedRgs : ccSelectedSvcs);
    selected.clear();
    ccRenderList(type);
    ccUpdateCounts();
    if (type === 'sub') ccLoadFilters();
    ccAutoCalc();
}

function ccFilterList(type) { ccRenderList(type); }

function ccUpdateCounts() {
    const update = (countId, textId, size, placeholder) => {
        const chip = document.getElementById(countId);
        const triggerText = document.getElementById(textId);
        if (chip) { chip.textContent = size; chip.style.display = size > 0 ? '' : 'none'; }
        if (triggerText) {
            if (size === 0) {
                triggerText.textContent = placeholder;
                triggerText.className = 'multiselect__placeholder';
            } else {
                triggerText.textContent = `${size} selected`;
                triggerText.className = 'multiselect__summary';
            }
        }
    };
    const _ccL = { all:'All subscriptions', azure:'All subscriptions', aws:'All accounts', gcp:'All projects' };
    const _ccRgL = { all:'All resource groups', azure:'All resource groups', aws:'All regions', gcp:'All projects' };
    update('ccSubCount', 'ccSubTriggerText', ccSelectedSubs.size, _ccL[ccCloudFilter] || 'All subscriptions');
    update('ccRgCount', 'ccRgTriggerText', ccSelectedRgs.size, _ccRgL[ccCloudFilter] || 'All resource groups');
    update('ccSvcCount', 'ccSvcTriggerText', ccSelectedSvcs.size, 'All services');
    ccUpdateSelectionPreview();
}

function ccUpdateSelectionPreview() {
    const preview = document.getElementById('ccSelectionPreview');
    if (!preview) return;
    const dateFrom = document.getElementById('ccDateFrom')?.value || '';
    const dateTo = document.getElementById('ccDateTo')?.value || '';
    const hasFilters = ccSelectedSubs.size || ccSelectedRgs.size || ccSelectedSvcs.size || dateFrom || dateTo;
    if (!hasFilters) { preview.style.display = 'none'; return; }

    const subsText = ccSelectedSubs.size ? `${ccSelectedSubs.size} sub${ccSelectedSubs.size > 1 ? 's' : ''}` : 'all subs';
    const rgsText = ccSelectedRgs.size ? `${ccSelectedRgs.size} RG${ccSelectedRgs.size > 1 ? 's' : ''}` : 'all RGs';
    const svcsText = ccSelectedSvcs.size ? `${ccSelectedSvcs.size} service${ccSelectedSvcs.size > 1 ? 's' : ''}` : 'all services';
    const rangeText = (dateFrom || dateTo) ? `${dateFrom || '…'} → ${dateTo || '…'}` : 'all dates';

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ccPreviewSubs', subsText);
    set('ccPreviewRgs', rgsText);
    set('ccPreviewSvcs', svcsText);
    set('ccPreviewRange', rangeText);
    preview.style.display = 'flex';
}

async function ccCalculate() {
    const dateFrom = document.getElementById('ccDateFrom')?.value || '';
    const dateTo = document.getElementById('ccDateTo')?.value || '';

    const body = {
        subscription_ids: [...ccSelectedSubs],
        resource_groups: [...ccSelectedRgs],
        services: [...ccSelectedSvcs],
        date_from: dateFrom || null,
        date_to: dateTo || null,
        cloud_provider: ccCloudFilter !== 'all' ? ccCloudFilter : null,
    };

    const btn = document.getElementById('ccCalcBtn');
    const statusEl = document.getElementById('ccCalcStatus');
    btn.disabled = true;
    statusEl.textContent = 'Calculating...';

    try {
        const resp = await fetch('/api/custom-cost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        ccRenderResults(data);
        statusEl.textContent = '';
    } catch (err) {
        showToast('Calculation failed: ' + err.message, 'error');
        statusEl.textContent = 'Error';
    } finally {
        btn.disabled = false;
    }
}

function ccShowSelectionSummary() {
    const sumEl = document.getElementById('ccSelectionSummary');
    if (!sumEl) return;
    const subCount = ccSelectedSubs.size;
    const rgCount = ccSelectedRgs.size;
    const svcCount = ccSelectedSvcs.size;
    const dateFrom = document.getElementById('ccDateFrom')?.value || '';
    const dateTo = document.getElementById('ccDateTo')?.value || '';

    const subsText = subCount ? `${subCount} subscription${subCount > 1 ? 's' : ''}` : 'all subscriptions';
    const rgsText = rgCount ? `${rgCount} resource group${rgCount > 1 ? 's' : ''}` : 'all RGs';
    const svcsText = svcCount ? `${svcCount} service${svcCount > 1 ? 's' : ''}` : 'all services';
    const rangeText = (dateFrom || dateTo) ? `${dateFrom || '…'} → ${dateTo || '…'}` : 'all dates';

    document.getElementById('ccSummarySubs').textContent = subsText;
    document.getElementById('ccSummaryRgs').textContent = rgsText;
    document.getElementById('ccSummaryServices').textContent = svcsText;
    document.getElementById('ccSummaryRange').textContent = rangeText;
    sumEl.style.display = 'flex';
}

function ccRenderResults(data) {
    document.getElementById('ccResults').style.display = 'block';
    const emptyState = document.getElementById('ccEmptyState'); if(emptyState) emptyState.style.display = 'none';
    const preview = document.getElementById('ccSelectionPreview'); if(preview) preview.style.display = 'none';
    ccShowSelectionSummary();

    document.getElementById('ccTotalCost').textContent =
        `${curSym()}${data.total_cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}`;
    document.getElementById('ccTotalRecords').textContent = data.total_records.toLocaleString();
    document.getElementById('ccRgTotal').textContent = (data.by_rg || []).length;
    document.getElementById('ccSvcTotal').textContent = (data.by_service || []).length;
    const byRes = data.by_resource || [];

    const colors = CHART_COLORS();

    // Daily trend
    const trend = data.daily_trend || [];
    renderChart('ccTrendChart', 'line', {
        labels: trend.map(d => d.date),
        datasets: [{
            label: 'Daily Cost ($)',
            data: trend.map(d => d.cost),
            borderColor: '#4f6ef7',
            backgroundColor: 'rgba(79,110,247,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: trend.length > 60 ? 0 : 3,
            pointBackgroundColor: '#4f6ef7',
        }]
    }, 'Custom Cost Daily Trend');

    // RG breakdown chart
    const rgData = (data.by_rg || []).slice(0, 10);
    renderChart('ccRgChart', 'doughnut', {
        labels: rgData.map(r => r.name),
        datasets: [{ data: rgData.map(r => r.cost), backgroundColor: colors, borderWidth: 0 }]
    }, 'RG Breakdown');

    // RG table
    document.getElementById('ccRgTableBody').innerHTML = (data.by_rg || []).map(r =>
        `<tr><td>${r.name}</td>
         <td style="font-weight:600;color:var(--green)">${curSym()}${r.cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
         <td>${r.records.toLocaleString()}</td></tr>`
    ).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-secondary)">No data</td></tr>';

    // Service breakdown chart
    const svcData = (data.by_service || []).slice(0, 10);
    renderChart('ccSvcChart', 'doughnut', {
        labels: svcData.map(s => s.name),
        datasets: [{ data: svcData.map(s => s.cost), backgroundColor: colors, borderWidth: 0 }]
    }, 'Service Breakdown');

    // Service table
    document.getElementById('ccSvcTableBody').innerHTML = (data.by_service || []).map(s =>
        `<tr><td>${s.name}</td>
         <td style="font-weight:600;color:var(--green)">${curSym()}${s.cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
         <td>${s.records.toLocaleString()}</td></tr>`
    ).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text-secondary)">No data</td></tr>';

    // Friendly resource name: EC2 Name tag (display_name) > short ARN id > type.
    const resShort = (name) => {
        let s = String(name || '').trim();
        if (s.toLowerCase().startsWith('arn:')) s = s.split(':').pop().split('/').pop();
        return s;
    };
    const resLabel = (r) => {
        if (r.display_name) return String(r.display_name);
        const s = resShort(r.resource_name);
        if (s) return s;
        const t = (r.resource_type || '').trim();
        if (t) return `(${t})`;
        return '— (no resource id)';
    };
    document.getElementById('ccResourceTableBody').innerHTML = byRes.map(r =>
        `<tr><td title="${(r.resource_name || '').replace(/"/g, '&quot;')}">${resLabel(r)}</td>
         <td style="font-size:13px;color:var(--text-secondary)">${r.resource_type || '—'}</td>
         <td>${r.resource_group || '—'}</td>
         <td style="font-weight:600;color:var(--green)">${curSym()}${r.cost.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
         <td>${r.records.toLocaleString()}</td></tr>`
    ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-secondary)">No data</td></tr>';

    const truncEl = document.getElementById('ccResourceTruncNote');
    if (truncEl) truncEl.style.display = data.by_resource_truncated ? 'block' : 'none';
}

function ccReset() {
    // Reset cloud filter to All
    ccCloudFilter = 'all';
    document.querySelectorAll('#ccCloudsFilter .seg').forEach(b => b.classList.remove('active'));
    const allBtn = document.querySelector('#ccCloudsFilter .seg[data-cloud="all"]');
    if (allBtn) allBtn.classList.add('active');

    // Reset dates to This month
    ccApplyDatePreset('month');

    // Clear selections and searches
    ['ccSubSearch', 'ccRgSearch', 'ccSvcSearch'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    ccSelectedSubs.clear();
    ccSelectedRgs.clear();
    ccSelectedSvcs.clear();

    // Close panels and custom date inputs
    ['ccSubPanel', 'ccRgPanel', 'ccSvcPanel'].forEach(id => {
        const el = document.getElementById(id); if (el) el.hidden = true;
    });
    const cd = document.getElementById('customDateInputs');
    if (cd) cd.style.display = 'none';

    document.getElementById('ccResults').style.display = 'none';
    const sumEl = document.getElementById('ccSelectionSummary'); if (sumEl) sumEl.style.display = 'none';
    const previewEl = document.getElementById('ccSelectionPreview'); if (previewEl) previewEl.style.display = 'none';
    document.getElementById('ccCalcStatus').textContent = '';
    ccRenderList('sub');
    ccLoadFilters();
}

function ccGetCurrentFilters() {
    return {
        subscription_ids: [...ccSelectedSubs],
        date_from: document.getElementById('ccDateFrom')?.value || '',
        date_to: document.getElementById('ccDateTo')?.value || '',
        resource_groups: [...ccSelectedRgs],
        services: [...ccSelectedSvcs],
    };
}

async function ccSaveFilterPrompt() {
    const name = prompt('Enter a name for this filter preset:');
    if (!name || !name.trim()) return;

    const filters = ccGetCurrentFilters();
    if (!filters.subscription_ids.length && !filters.resource_groups.length && !filters.services.length && !filters.date_from && !filters.date_to) {
        showToast('Please set at least one filter before saving', 'error');
        return;
    }

    try {
        const resp = await fetch('/api/saved-filters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), filters }),
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message, 'success');
            ccLoadSavedFilters();
        } else {
            showToast(data.error || 'Save failed', 'error');
        }
    } catch (err) {
        showToast('Failed to save filter', 'error');
    }
}

async function ccLoadSavedFilters() {
    try {
        const filters = await fetch('/api/saved-filters').then(r => r.json());
        const el = document.getElementById('ccSavedList');

        if (!filters.length) {
            el.innerHTML = '<span class="preset-bar__empty">No saved presets yet</span>';
            return;
        }

        el.innerHTML = filters.map(f => {
            const fl = f.filters;
            const parts = [];
            const subIds = fl.subscription_ids || (fl.subscription_id ? [fl.subscription_id] : []);
            if (subIds.length) parts.push(`${subIds.length} sub${subIds.length > 1 ? 's' : ''}`);
            if (fl.resource_groups?.length) parts.push(`${fl.resource_groups.length} RG${fl.resource_groups.length > 1 ? 's' : ''}`);
            if (fl.services?.length) parts.push(`${fl.services.length} svc${fl.services.length > 1 ? 's' : ''}`);
            if (fl.date_from || fl.date_to) parts.push(`${fl.date_from || '…'} → ${fl.date_to || '…'}`);
            const safeName = f.name.replace(/'/g, "\\'");
            const summary = parts.length ? parts.join(' · ') : 'All data';

            return `<button class="preset-chip" title="${summary}" onclick="ccApplyFilter(${f.id})">
                <span class="preset-chip__name">${f.name}</span>
                <button class="preset-chip__delete" aria-label="Delete preset" onclick="event.stopPropagation();ccDeleteFilter(${f.id},'${safeName}')">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </button>`;
        }).join('');
    } catch (err) {
        console.error('Load saved filters error:', err);
    }
}

let _savedFiltersCache = [];

async function ccApplyFilter(filterId) {
    try {
        if (!_savedFiltersCache.length) {
            _savedFiltersCache = await fetch('/api/saved-filters').then(r => r.json());
        }
        const saved = _savedFiltersCache.find(f => f.id === filterId);
        if (!saved) {
            _savedFiltersCache = await fetch('/api/saved-filters').then(r => r.json());
            const retry = _savedFiltersCache.find(f => f.id === filterId);
            if (!retry) { showToast('Filter not found', 'error'); return; }
            return ccApplyFilterData(retry);
        }
        ccApplyFilterData(saved);
    } catch (err) {
        showToast('Failed to load filter', 'error');
    }
}

async function ccApplyFilterData(saved) {
    const fl = saved.filters;

    // Apply dates and mark Custom preset active
    const fromEl = document.getElementById('ccDateFrom');
    const toEl = document.getElementById('ccDateTo');
    if (fromEl) fromEl.value = fl.date_from || '';
    if (toEl) toEl.value = fl.date_to || '';
    if (fl.date_from || fl.date_to) {
        document.querySelectorAll('#ccDateFilter .seg').forEach(b => b.classList.remove('active'));
        const c = document.querySelector('#ccDateFilter .seg[data-range="custom"]');
        if (c) c.classList.add('active');
        const cd = document.getElementById('customDateInputs');
        if (cd) cd.style.display = 'flex';
    }

    ccSelectedSubs.clear();
    const subIds = fl.subscription_ids || (fl.subscription_id ? [fl.subscription_id] : []);
    subIds.forEach(id => { if (ccSubOptions.includes(id)) ccSelectedSubs.add(id); });
    ccRenderList('sub');

    await ccLoadFilters();

    ccSelectedRgs.clear();
    ccSelectedSvcs.clear();
    (fl.resource_groups || []).forEach(rg => { if (ccRgOptions.includes(rg)) ccSelectedRgs.add(rg); });
    (fl.services || []).forEach(svc => { if (ccSvcOptions.includes(svc)) ccSelectedSvcs.add(svc); });

    ccRenderList('rg');
    ccRenderList('svc');
    ccUpdateCounts();

    showToast(`Loaded "${saved.name}" — calculating...`, 'info');
    ccCalculate();
}

async function ccDeleteFilter(filterId, name) {
    if (!confirm(`Delete saved filter "${name}"?`)) return;
    try {
        await fetch(`/api/saved-filters/${filterId}`, { method: 'DELETE' });
        _savedFiltersCache = [];
        showToast('Filter deleted', 'success');
        ccLoadSavedFilters();
    } catch (err) {
        showToast('Delete failed', 'error');
    }
}

function ccTimeAgo(dateStr) {
    if (!dateStr) return '';
    const now = new Date();
    const d = new Date(dateStr + 'Z');
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
}

// ─── Tenant-scoped cloud provider dropdown helper ─────────────────────────

let _cachedTenantProviderTypes = null;

async function _getTenantProviderTypes() {
    if (_cachedTenantProviderTypes) return _cachedTenantProviderTypes;
    try {
        const providers = await fetch('/api/cloud-providers').then(r => r.json());
        const types = [...new Set((providers || []).map(p => p.provider_type).filter(Boolean))];
        if (types.length) _cachedTenantProviderTypes = types;
        return types;
    } catch { return []; }
}

// Rebuilds a <select> with only the current tenant's actual provider types.
// opts.allValue / opts.allLabel control the "All" option (default value="" label="All Clouds").
// Preserves whatever value was selected before.
async function _populateCloudProviderSelect(selectId, opts = {}) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    // Authoritative list = clouds the tenant actually has data/providers for
    // (covers OpenAI/Cursor which live in integration_settings, not cloud_providers).
    if (!connectedClouds) {
        try { connectedClouds = new Set(await fetch('/api/connected-clouds').then(r => r.json())); } catch (e) {}
    }
    const allValue = opts.allValue !== undefined ? opts.allValue : '';
    const allLabel = opts.allLabel || 'All Clouds';
    const savedValue = sel.value;
    sel.innerHTML = `<option value="${allValue}">${allLabel}</option>`;
    activeClouds().forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = CLOUD_META[t]?.label || t.toUpperCase();
        sel.appendChild(opt);
    });
    if (savedValue && [...sel.options].some(o => o.value === savedValue)) sel.value = savedValue;
}

// ─── Email Reports ───────────────────────────────────────────────────────

async function loadReportsPage() {
    try {
        const settings = await fetch('/api/email/settings').then(r => r.json());
        document.getElementById('emSmtpHost').value = settings.smtp_host || '';
        document.getElementById('emSmtpPort').value = settings.smtp_port || 587;
        document.getElementById('emSmtpUser').value = settings.smtp_user || '';
        document.getElementById('emSmtpPass').value = settings.smtp_password || '';
        document.getElementById('emSmtpFrom').value = settings.smtp_from || '';
        document.getElementById('emSmtpTls').checked = settings.smtp_use_tls !== false;
        document.getElementById('emRecipients').value = settings.recipients || '';
        document.getElementById('emSchedule').value = settings.schedule || 'weekly';
        document.getElementById('emScheduleDay').value = settings.schedule_day ?? 1;
        setScheduleTime('emScheduleTime', settings.schedule_hour ?? 8, settings.schedule_minute ?? 0);
        document.getElementById('emScheduleTz').value = settings.schedule_tz || 'UTC';
        document.getElementById('emEnabled').checked = settings.enabled || false;
        document.getElementById('emReportDateRange').value = settings.report_date_range || 'this_month';
        document.getElementById('emReportDateFrom').value = settings.report_date_from || '';
        document.getElementById('emReportDateTo').value = settings.report_date_to || '';
        await _populateCloudProviderSelect('emReportCloudProvider');
        document.getElementById('emReportCloudProvider').value = settings.report_cloud_provider || '';

        const sections = settings.report_sections || [];
        document.querySelectorAll('#emSections .report-section-check input').forEach(cb => {
            cb.checked = sections.includes(cb.value);
        });

        onScheduleChange();
        onEmailReportDateRangeChange();
        loadEmailLog();
        loadCustomReportsList();
    } catch (err) {
        console.error('Load reports page error:', err);
    }
}

function onScheduleChange() {
    const sched = document.getElementById('emSchedule').value;
    document.getElementById('emDayGroup').style.display = sched === 'weekly' ? '' : 'none';
}

function onEmailReportDateRangeChange() {
    const range = document.getElementById('emReportDateRange').value;
    const show = range === 'custom';
    document.getElementById('emReportFromGroup').style.display = show ? '' : 'none';
    document.getElementById('emReportToGroup').style.display = show ? '' : 'none';
}

async function saveEmailSettings() {
    const body = {
        smtp_host: document.getElementById('emSmtpHost').value.trim(),
        smtp_port: parseInt(document.getElementById('emSmtpPort').value) || 587,
        smtp_user: document.getElementById('emSmtpUser').value.trim(),
        smtp_password: document.getElementById('emSmtpPass').value,
        smtp_from: document.getElementById('emSmtpFrom').value.trim(),
        smtp_use_tls: document.getElementById('emSmtpTls').checked,
    };
    try {
        await fetch('/api/email/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        showToast('SMTP settings saved', 'success');
    } catch (err) {
        showToast('Failed to save settings', 'error');
    }
}

async function saveReportSettings() {
    const sections = [];
    document.querySelectorAll('#emSections .report-section-check input:checked').forEach(cb => sections.push(cb.value));

    const body = {
        recipients: document.getElementById('emRecipients').value.trim(),
        schedule: document.getElementById('emSchedule').value,
        schedule_day: parseInt(document.getElementById('emScheduleDay').value),
        schedule_hour: _timeToHM(document.getElementById('emScheduleTime').value).hour,
        schedule_minute: _timeToHM(document.getElementById('emScheduleTime').value).minute,
        schedule_tz: document.getElementById('emScheduleTz').value,
        report_date_range: document.getElementById('emReportDateRange').value,
        report_date_from: document.getElementById('emReportDateFrom').value,
        report_date_to: document.getElementById('emReportDateTo').value,
        report_cloud_provider: document.getElementById('emReportCloudProvider').value,
        report_sections: sections,
        enabled: document.getElementById('emEnabled').checked,
    };
    try {
        await fetch('/api/email/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        showToast('Report settings saved', 'success');
    } catch (err) {
        showToast('Failed to save settings', 'error');
    }
}

async function testEmail() {
    const recipients = document.getElementById('emRecipients').value.trim();
    const fromAddr = document.getElementById('emSmtpFrom').value.trim();
    const user = document.getElementById('emSmtpUser').value.trim();
    const candidate = recipients.split(',')[0]?.trim() || fromAddr || (user.includes('@') ? user : '');
    const recipient = prompt('Send test email to:', candidate);
    if (!recipient || !recipient.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
    }
    try {
        await saveEmailSettings();
        const resp = await fetch('/api/email/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient })
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message, 'success');
            loadEmailLog();
        } else {
            showToast(data.error || 'Test failed', 'error');
        }
    } catch (err) {
        showToast('Test email failed: ' + err.message, 'error');
    }
}

async function sendReportNow() {
    const btn = document.getElementById('sendReportBtn');
    btn.disabled = true;
    try {
        // Save current settings first so recipients are up to date
        await saveReportSettings();
        await saveEmailSettings();

        const resp = await fetch('/api/email/send-report', { method: 'POST' });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message, 'success');
            loadEmailLog();
        } else {
            showToast(data.error || 'Send failed', 'error');
        }
    } catch (err) {
        showToast('Send failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function previewReport() {
    const sections = [];
    document.querySelectorAll('#emSections .report-section-check input:checked').forEach(cb => sections.push(cb.value));
    const params = new URLSearchParams();
    if (sections.length) params.set('sections', sections.join(','));
    const cp = document.getElementById('emReportCloudProvider')?.value;
    if (cp) params.set('cloud_provider', cp);
    const dateRange = document.getElementById('emReportDateRange')?.value;
    if (dateRange) params.set('date_range', dateRange);
    if (dateRange === 'custom') {
        const df = document.getElementById('emReportDateFrom')?.value;
        const dt = document.getElementById('emReportDateTo')?.value;
        if (df) params.set('date_from', df);
        if (dt) params.set('date_to', dt);
    }
    const qs = params.toString() ? '?' + params.toString() : '';
    window.open('/api/email/preview' + qs, '_blank');
}

async function loadEmailLog() {
    try {
        const log = await fetch('/api/email/log').then(r => r.json());
        const tbody = document.getElementById('emailLogBody');
        if (!log.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:0;border:none">` +
                _emptyState('neutral',
                    '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
                    'No deliveries yet',
                    'Reports you send or schedule will show up here.'
                ) + `</td></tr>`;
            return;
        }
        tbody.innerHTML = log.map(r => {
            const time = r.sent_at ? new Date(r.sent_at + 'Z').toLocaleString() : '';
            const statusClass = r.status === 'sent' ? 'act-success' : 'act-failed';
            const recipShort = (r.recipients || '').length > 40 ? r.recipients.substring(0, 40) + '...' : r.recipients;
            return `<tr>
                <td style="font-size:12px;white-space:nowrap">${time}</td>
                <td style="font-size:12px" title="${r.recipients || ''}">${recipShort}</td>
                <td style="font-size:12px">${r.subject || ''}</td>
                <td><span class="sf-tag">${r.report_type || 'manual'}</span></td>
                <td><span class="act-badge ${statusClass}">${r.status || ''}</span>${r.error ? `<span style="font-size:11px;color:var(--red);margin-left:6px" title="${r.error}">!</span>` : ''}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        console.error('Email log error:', err);
    }
}

// ─── Custom Reports Builder ──────────────────────────────────────────────

let crSubOptions = [];
let crSubMap = {};
let crRgOptions = [];
let crSvcOptions = [];
let crSelectedSubs = new Set();
let crSelectedRgs = new Set();
let crSelectedSvcs = new Set();

async function loadCustomReportsList() {
    try {
        const reports = await fetch('/api/custom-reports').then(r => r.json());
        const el = document.getElementById('customReportsList');
        if (!reports.length) {
            el.innerHTML = _emptyState('info',
                '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
                'No scheduled reports yet',
                'Set up recurring cost reports to keep your team in the loop.',
                [{label:'+ New custom report', primary:true, onclick:'openCustomReportBuilder()'}]
            );
            return;
        }
        el.innerHTML = reports.map(r => {
            const fl = r.filters || {};
            const tags = [];
            const subIds = fl.subscription_ids || [];
            if (subIds.length) tags.push(`${subIds.length} sub${subIds.length > 1 ? 's' : ''}`);
            if (fl.resource_groups?.length) tags.push(`${fl.resource_groups.length} RGs`);
            if (fl.services?.length) tags.push(`${fl.services.length} svcs`);
            tags.push(fl.date_range || 'this_month');
            const schedBadge = r.schedule === 'none' ? 'Manual' : `${r.schedule} @ ${_hmToTime(r.schedule_hour, r.schedule_minute)} ${r.schedule_tz || 'UTC'}`;
            const statusDot = r.enabled && r.schedule !== 'none' ? '<span class="auto-sync-dot on"></span>' : '<span class="auto-sync-dot off"></span>';
            const lastSent = r.last_sent ? new Date(r.last_sent + 'Z').toLocaleString() : 'Never';
            return `<div class="saved-filter-card" style="margin-bottom:8px">
                <div class="saved-filter-body" style="cursor:default">
                    <div class="saved-filter-name">${r.name}</div>
                    <div class="saved-filter-tags">${tags.map(t => `<span class="sf-tag">${t}</span>`).join('')}<span class="sf-tag" style="background:rgba(155,89,182,0.12);color:#9b59b6">${statusDot} ${schedBadge}</span></div>
                    <div class="saved-filter-time">Last sent: ${lastSent} &bull; Recipients: ${r.recipients || '(global)'}</div>
                </div>
                <div class="saved-filter-actions" style="gap:4px;flex-direction:column;padding:8px 10px">
                    <button class="btn-mini" onclick="sendCustomReport(${r.id})" title="Send Now" style="color:var(--green)">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></svg>
                    </button>
                    <button class="btn-mini" onclick="previewCustomReport(${r.id})" title="Preview" style="color:var(--accent)">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    <button class="btn-mini" onclick="editCustomReport(${r.id})" title="Edit">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-mini" onclick="deleteCustomReport(${r.id},'${r.name.replace(/'/g, "\\'")}')" title="Delete">
                        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    </button>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        console.error('Custom reports list error:', err);
    }
}

// Clouds selected for the custom-report builder (supports multiple).
let crSelectedClouds = new Set();

// Load accounts/subscriptions + resource groups + services for ALL selected
// clouds (union), via the shared filter-values endpoint. When more than one
// cloud is selected, each option label is tagged with its cloud for clarity.
async function crLoadCloudFilters(clouds) {
    const list = (Array.isArray(clouds) ? clouds : [clouds]).filter(Boolean);
    if (!list.length) list.push('azure');
    const multi = list.length > 1;
    crSubMap = {};
    const subs = [], rgSet = new Set(), svcSet = new Set();
    for (const cloud of list) {
        const tag = multi ? ` · ${CLOUD_META[cloud]?.label || cloud}` : '';
        try {
            const accts = await fetch(`/api/clients/filter-values?cloud=${cloud}&filter_type=subscription_id`).then(r => r.json());
            (accts || []).forEach(a => { if (!subs.includes(a.value)) subs.push(a.value); crSubMap[a.value] = (a.label || a.value) + tag; });
        } catch (e) {}
        try {
            const rgs = await fetch(`/api/clients/filter-values?cloud=${cloud}&filter_type=resource_group`).then(r => r.json());
            (rgs || []).forEach(a => rgSet.add(a.value));
        } catch (e) {}
        try {
            const svcs = await fetch(`/api/clients/filter-values?cloud=${cloud}&filter_type=service_name`).then(r => r.json());
            (svcs || []).forEach(a => svcSet.add(a.value));
        } catch (e) {}
    }
    crSubOptions = subs;
    crRgOptions = [...rgSet];
    crSvcOptions = [...svcSet];
}

// Per-cloud labels for the three filter columns (plural, report-friendly).
const CR_LABELS = {
    azure:     { sub: 'Subscriptions', rg: 'Resource Groups', svc: 'Services' },
    aws:       { sub: 'Accounts',      rg: 'Regions',         svc: 'Services' },
    gcp:       { sub: 'Projects',      rg: 'Projects',        svc: 'Services' },
    openai:    { sub: 'API Keys',      rg: 'Models',          svc: 'Services' },
    atlassian: { sub: 'Organizations', rg: 'Plans',           svc: 'Products' },
    cursor:    { sub: 'Teams',         rg: 'Roles',           svc: 'Services' },
};

// Relabel the Subscriptions/Resource-Groups/Services columns to match the
// selected cloud(s): "Accounts / Regions" for AWS, "Projects" for GCP, etc.
// When multiple clouds are selected the distinct names are joined with " / ".
function crUpdateLabels() {
    const clouds = [...crSelectedClouds];
    const join = key => {
        const seen = [];
        clouds.forEach(c => { const w = (CR_LABELS[c] || CR_LABELS.azure)[key]; if (!seen.includes(w)) seen.push(w); });
        return seen.join(' / ') || 'Items';
    };
    const setLabel = (id, txt) => { const el = document.getElementById(id); if (el && el.childNodes[0]) el.childNodes[0].nodeValue = txt + ' '; };
    setLabel('crSubLabel', join('sub'));
    setLabel('crRgLabel', join('rg'));
    setLabel('crSvcLabel', join('svc'));
    const rs = document.getElementById('crRgSearch');  if (rs) rs.placeholder = 'Search ' + join('rg').toLowerCase() + '...';
    const ss = document.getElementById('crSvcSearch'); if (ss) ss.placeholder = 'Search ' + join('svc').toLowerCase() + '...';
}

// Render the cloud multi-select chips (one per connected cloud).
function crRenderCloudChips() {
    const box = document.getElementById('crCloudChips');
    if (!box) return;
    box.innerHTML = activeClouds().map(c => {
        const on = crSelectedClouds.has(c);
        const label = CLOUD_META[c]?.label || c;
        return `<button type="button" data-cr-cloud="${c}" onclick="crToggleCloud('${c}')"
            style="font-size:12px;padding:5px 13px;border-radius:16px;cursor:pointer;
                   border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};
                   background:${on ? 'var(--accent)' : 'transparent'};
                   color:${on ? '#fff' : 'var(--text)'};font-weight:${on ? 600 : 400}">${label}</button>`;
    }).join('');
    crUpdateLabels();
}

async function crToggleCloud(cloud) {
    if (crSelectedClouds.has(cloud)) {
        if (crSelectedClouds.size === 1) return;   // keep at least one selected
        crSelectedClouds.delete(cloud);
    } else {
        crSelectedClouds.add(cloud);
    }
    crRenderCloudChips();
    crSelectedSubs.clear(); crSelectedRgs.clear(); crSelectedSvcs.clear();
    await crLoadCloudFilters([...crSelectedClouds]);
    crRenderAllLists();
}

async function openCustomReportBuilder(editData) {
    document.getElementById('crBuilderModal').style.display = 'flex';
    document.getElementById('crEditId').value = '';
    document.getElementById('crBuilderTitle').textContent = 'New Custom Report';
    document.getElementById('crName').value = '';
    document.getElementById('crRecipients').value = '';
    document.getElementById('crDateRange').value = 'this_month';
    document.getElementById('crDateFrom').value = '';
    document.getElementById('crDateTo').value = '';
    document.getElementById('crSchedule').value = 'none';
    document.getElementById('crScheduleDay').value = '1';
    setScheduleTime('crScheduleTime', 8, 0);
    document.getElementById('crScheduleTz').value = 'UTC';
    document.getElementById('crEnabled').checked = false;
    crSelectedSubs.clear();
    crSelectedRgs.clear();
    crSelectedSvcs.clear();

    document.querySelectorAll('#crSections input').forEach(cb => {
        cb.checked = ['summary', 'by_service', 'by_rg', 'trend'].includes(cb.value);
    });

    // Default selected clouds: saved on the report (cloud_providers / legacy
    // cloud_provider) when editing, otherwise the biggest-spend cloud.
    crSelectedClouds = new Set();
    const active = activeClouds();
    let savedClouds = [];
    if (editData && editData.filters) {
        if (Array.isArray(editData.filters.cloud_providers)) savedClouds = editData.filters.cloud_providers;
        else if (editData.filters.cloud_provider) savedClouds = [editData.filters.cloud_provider];
    }
    savedClouds = savedClouds.filter(c => active.includes(c));
    if (!savedClouds.length) {
        const dc = await defaultCloud();
        savedClouds = [active.includes(dc) ? dc : (active[0] || 'azure')];
    }
    savedClouds.forEach(c => crSelectedClouds.add(c));
    crRenderCloudChips();
    await crLoadCloudFilters([...crSelectedClouds]);

    crRenderAllLists();
    onCRDateRangeChange();
    onCRScheduleChange();

    if (editData) {
        document.getElementById('crEditId').value = editData.id;
        document.getElementById('crBuilderTitle').textContent = 'Edit Report';
        document.getElementById('crName').value = editData.name || '';
        document.getElementById('crRecipients').value = editData.recipients || '';
        const fl = editData.filters || {};
        document.getElementById('crDateRange').value = fl.date_range || 'this_month';
        document.getElementById('crDateFrom').value = fl.date_from || '';
        document.getElementById('crDateTo').value = fl.date_to || '';
        document.getElementById('crSchedule').value = editData.schedule || 'none';
        document.getElementById('crScheduleDay').value = editData.schedule_day ?? 1;
        setScheduleTime('crScheduleTime', editData.schedule_hour ?? 8, editData.schedule_minute ?? 0);
        document.getElementById('crScheduleTz').value = editData.schedule_tz || 'UTC';
        document.getElementById('crEnabled').checked = editData.enabled || false;

        (fl.subscription_ids || []).forEach(id => { if (crSubOptions.includes(id)) crSelectedSubs.add(id); });
        (fl.resource_groups || []).forEach(rg => { if (crRgOptions.includes(rg)) crSelectedRgs.add(rg); });
        (fl.services || []).forEach(svc => { if (crSvcOptions.includes(svc)) crSelectedSvcs.add(svc); });

        (editData.sections || []).forEach(s => {
            const cb = document.querySelector(`#crSections input[value="${s}"]`);
            if (cb) cb.checked = true;
        });

        crRenderAllLists();
        onCRDateRangeChange();
        onCRScheduleChange();
    }
}

function closeCRBuilder() {
    document.getElementById('crBuilderModal').style.display = 'none';
}

function crRenderAllLists() {
    crRenderList('sub');
    crRenderList('rg');
    crRenderList('svc');
    document.getElementById('crSubCount').textContent = `(${crSelectedSubs.size})`;
    document.getElementById('crRgCount').textContent = `(${crSelectedRgs.size})`;
    document.getElementById('crSvcCount').textContent = `(${crSelectedSvcs.size})`;
}

function crRenderList(type) {
    const listId = type === 'sub' ? 'crSubList' : (type === 'rg' ? 'crRgList' : 'crSvcList');
    const el = document.getElementById(listId);
    let items, selected;
    if (type === 'sub') { items = crSubOptions; selected = crSelectedSubs; }
    else if (type === 'rg') { items = crRgOptions; selected = crSelectedRgs; }
    else { items = crSvcOptions; selected = crSelectedSvcs; }

    const searchId = type === 'rg' ? 'crRgSearch' : (type === 'svc' ? 'crSvcSearch' : null);
    const searchVal = searchId ? (document.getElementById(searchId)?.value?.toLowerCase() || '') : '';
    const filtered = searchVal ? items.filter(i => {
        const label = type === 'sub' ? (crSubMap[i] || i) : i;
        return label.toLowerCase().includes(searchVal);
    }) : items;

    if (!filtered.length) { el.innerHTML = '<div style="padding:8px;text-align:center;color:var(--text-secondary);font-size:11px">None</div>'; return; }

    el.innerHTML = filtered.map(item => {
        const checked = selected.has(item) ? 'checked' : '';
        const esc = item.replace(/"/g, '&quot;').replace(/'/g, "\\'");
        const label = type === 'sub' ? (crSubMap[item] || item) : item;
        return `<label class="multi-select-item ${checked ? 'selected' : ''}" style="padding:4px 8px;font-size:12px">
            <input type="checkbox" ${checked} onchange="crToggle('${type}','${esc}',this)">
            <span>${label}</span>
        </label>`;
    }).join('');
}

function crToggle(type, item, cb) {
    const selected = type === 'sub' ? crSelectedSubs : (type === 'rg' ? crSelectedRgs : crSelectedSvcs);
    if (cb.checked) { selected.add(item); cb.parentElement.classList.add('selected'); }
    else { selected.delete(item); cb.parentElement.classList.remove('selected'); }
    document.getElementById('crSubCount').textContent = `(${crSelectedSubs.size})`;
    document.getElementById('crRgCount').textContent = `(${crSelectedRgs.size})`;
    document.getElementById('crSvcCount').textContent = `(${crSelectedSvcs.size})`;
    // Changing the subscription selection re-scopes the RG/Service lists.
    if (type === 'sub') crReloadScopedFilters();
}

// Scope the Resource Groups / Services lists to the selected subscriptions
// (across whatever clouds they belong to). With none selected, fall back to the
// union across the chosen clouds.
async function crReloadScopedFilters() {
    if (crSelectedSubs.size > 0) {
        try {
            const ids = [...crSelectedSubs].map(encodeURIComponent).join(',');
            const f = await fetch(`/api/filters?subscription_ids=${ids}`).then(r => r.json());
            crRgOptions = (f.resource_groups || []).slice().sort();
            crSvcOptions = (f.services || []).slice().sort();
        } catch (e) { /* keep current lists on error */ }
    } else {
        await crLoadCloudFilters([...crSelectedClouds]);
    }
    crSelectedRgs.clear();
    crSelectedSvcs.clear();
    crRenderList('rg');
    crRenderList('svc');
    document.getElementById('crRgCount').textContent = `(${crSelectedRgs.size})`;
    document.getElementById('crSvcCount').textContent = `(${crSelectedSvcs.size})`;
}

function crFilterList(type) { crRenderList(type); }

function onCRDateRangeChange() {
    const isCustom = document.getElementById('crDateRange').value === 'custom';
    document.getElementById('crDateFromGroup').style.display = isCustom ? '' : 'none';
    document.getElementById('crDateToGroup').style.display = isCustom ? '' : 'none';
}

function onCRScheduleChange() {
    const sched = document.getElementById('crSchedule').value;
    document.getElementById('crDayGroup').style.display = sched === 'weekly' ? '' : 'none';
    document.getElementById('crHourGroup').style.display = sched !== 'none' ? '' : 'none';
}

async function saveCRBuilder() {
    const name = document.getElementById('crName').value.trim();
    if (!name) { showToast('Report name is required', 'error'); return; }

    const sections = [];
    document.querySelectorAll('#crSections input:checked').forEach(cb => sections.push(cb.value));

    const body = {
        name,
        recipients: document.getElementById('crRecipients').value.trim(),
        filters: {
            cloud_providers: [...crSelectedClouds],
            subscription_ids: [...crSelectedSubs],
            resource_groups: [...crSelectedRgs],
            services: [...crSelectedSvcs],
            date_range: document.getElementById('crDateRange').value,
            date_from: document.getElementById('crDateFrom').value,
            date_to: document.getElementById('crDateTo').value,
        },
        sections,
        schedule: document.getElementById('crSchedule').value,
        schedule_day: parseInt(document.getElementById('crScheduleDay').value),
        schedule_hour: _timeToHM(document.getElementById('crScheduleTime').value).hour,
        schedule_minute: _timeToHM(document.getElementById('crScheduleTime').value).minute,
        schedule_tz: document.getElementById('crScheduleTz').value,
        enabled: document.getElementById('crEnabled').checked,
    };

    const editId = document.getElementById('crEditId').value;
    try {
        if (editId) {
            await fetch(`/api/custom-reports/${editId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast('Report updated', 'success');
        } else {
            await fetch('/api/custom-reports', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
            showToast(`Report "${name}" created`, 'success');
        }
        closeCRBuilder();
        loadCustomReportsList();
    } catch (err) {
        showToast('Failed to save report', 'error');
    }
}

async function editCustomReport(rid) {
    try {
        const reports = await fetch('/api/custom-reports').then(r => r.json());
        const report = reports.find(r => r.id === rid);
        if (report) openCustomReportBuilder(report);
    } catch (err) {
        showToast('Failed to load report', 'error');
    }
}

async function deleteCustomReport(rid, name) {
    if (!confirm(`Delete report "${name}"?`)) return;
    try {
        await fetch(`/api/custom-reports/${rid}`, { method: 'DELETE' });
        showToast('Report deleted', 'success');
        loadCustomReportsList();
    } catch (err) {
        showToast('Delete failed', 'error');
    }
}

async function sendCustomReport(rid) {
    try {
        const resp = await fetch(`/api/custom-reports/${rid}/send`, { method: 'POST' });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message, 'success');
            loadCustomReportsList();
            loadEmailLog();
        } else {
            showToast(data.error || 'Send failed', 'error');
        }
    } catch (err) {
        showToast('Send failed', 'error');
    }
}

function previewCustomReport(rid) {
    window.open(`/api/custom-reports/${rid}/preview`, '_blank');
}

// ─── Sync Center ─────────────────────────────────────────────────────────────

function openSyncCenter() {
    document.getElementById('scDrawer').classList.add('open');
    document.getElementById('scOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    loadSyncCenter();
}

function closeSyncCenter() {
    document.getElementById('scDrawer').classList.remove('open');
    document.getElementById('scOverlay').classList.remove('open');
    document.body.style.overflow = '';
}

async function loadSyncCenter() {
    await Promise.all([
        _scLoadStatus(),
        _scLoadAutoSync(),
        _scLoadProviders(),
        _scLoadHistory(),
    ]);
}

async function _scLoadStatus() {
    try {
        const hist = await fetch('/api/sync/history').then(r => r.json());
        const last = hist[0];
        const el = document.getElementById('scLastSyncText');
        const globalEl = document.getElementById('scGlobalStatus');
        if (last) {
            const t = new Date((last.sync_end || last.sync_start) + 'Z').toLocaleString();
            const ok = last.status === 'success';
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? 'var(--green)' : 'var(--red)'};margin-right:6px"></span>`;
            if (el) el.innerHTML = `${dot}Last sync: ${t} &bull; ${last.records_fetched || 0} records`;
            if (globalEl) globalEl.innerHTML = `${dot}${t}`;
        } else {
            if (el) el.textContent = 'No sync history yet';
            if (globalEl) globalEl.textContent = 'Never synced';
        }
    } catch(e) { /* skip */ }
}

async function _scLoadAutoSync() {
    try {
        const data = await fetch('/api/sync/schedule').then(r => r.json());
        const tog = document.getElementById('scAutoSyncToggle');
        const intv = document.getElementById('scAutoSyncInterval');
        const info = document.getElementById('scAutoSyncInfo');
        if (tog)  tog.checked   = data.enabled;
        if (intv) intv.value    = data.interval_hours;
        if (info) {
            if (data.enabled && data.next_auto_sync) {
                const next = new Date(data.next_auto_sync + 'Z').toLocaleTimeString();
                info.textContent = `Next auto-sync at ${next}`;
            } else {
                info.textContent = data.enabled ? 'Auto-sync every ' + data.interval_hours + 'h' : 'Auto-sync is off';
            }
        }
        // Also update old badge (dashboard)
        const badge = document.getElementById('autoSyncBadge');
        if (badge) {
            badge.className = data.enabled ? 'auto-sync-badge enabled' : 'auto-sync-badge disabled';
            badge.innerHTML  = data.enabled
                ? `<span class="auto-sync-dot on"></span> Auto-sync: every ${data.interval_hours}h`
                : '<span class="auto-sync-dot off"></span> Auto-sync: off';
        }
    } catch(e) { /* skip */ }
}

async function _scLoadProviders() {
    const container = document.getElementById('scProviderCards');
    if (!container) return;
    try {
        const [providers, subsRaw, histRaw] = await Promise.all([
            fetch('/api/cloud-providers').then(r => r.json()),
            fetch('/api/subscriptions').then(r => r.json()).catch(() => []),
            fetch('/api/sync/history').then(r => r.json()).catch(() => [])
        ]);

        const icons = { azure: '⊞', aws: '⚙', gcp: '◉' };
        const colors = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4' };

        // Build Azure card from subscriptions + main sync history
        // (count only legacy Azure subs — /api/subscriptions also returns AWS/GCP accounts)
        const subCount = Array.isArray(subsRaw) ? subsRaw.filter(s => s.cloud === 'azure').length : 0;
        const lastAzureSync = histRaw.find(h => h.status === 'success' || h.status === 'running');
        const azureLastSyncStr = lastAzureSync && (lastAzureSync.sync_end || lastAzureSync.sync_start)
            ? _fmtSyncTime(lastAzureSync.sync_end || lastAzureSync.sync_start)
            : null;
        const azureCard = `
        <div class="sc-provider-card" id="sc-pcard-azure">
            <div class="sc-provider-header">
                <span class="sc-logo" style="color:#0078d4">⊞</span>
                <span class="sc-name">Azure</span>
                <span class="sc-lastsync" id="sc-lastsync-azure">
                    ${azureLastSyncStr
                        ? `<span style="color:var(--green)">✓</span> ${azureLastSyncStr}`
                        : '<span style="color:var(--text-secondary)">Never</span>'}
                </span>
            </div>
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px">
                ${subCount} subscription${subCount !== 1 ? 's' : ''} configured
            </div>
            <div class="sc-provider-actions">
                <button class="btn-mini" id="sc-sync-btn-azure"
                    onclick="scStartSync('incremental')">
                    Quick Sync
                </button>
                <button class="btn-mini" style="background:var(--bg)"
                    onclick="scStartSync('full')">
                    Full Sync
                </button>
            </div>
        </div>`;

        // Build other-provider cards (AWS, GCP, etc.)
        const otherCards = providers.map(p => {
            const lastSync = p.last_sync ? _fmtSyncTime(p.last_sync) : 'Never';
            const col = colors[p.provider_type] || 'var(--accent)';
            return `
            <div class="sc-provider-card" id="sc-pcard-${p.id}">
                <div class="sc-provider-header">
                    <span class="sc-logo" style="color:${col}">${icons[p.provider_type]||'☁'}</span>
                    <span class="sc-name">${_esc(p.name)}</span>
                    <span class="sc-lastsync" id="sc-lastsync-${p.id}">
                        ${syncStatusBadge(p)}
                    </span>
                </div>
                <div style="font-size:11px;color:var(--text-secondary);margin-bottom:${p.sync_error ? '4px' : '8px'};font-family:monospace">${_esc(p.provider_id)}</div>
                ${syncErrIsPending(p.sync_error)
                    ? `<div style="font-size:11px;color:#f59e0b;margin-bottom:8px;word-break:break-all">⏳ ${_esc(syncErrText(p.sync_error).slice(0,160))}</div>`
                    : (p.sync_error ? `<div style="font-size:11px;color:var(--red);margin-bottom:8px;word-break:break-all">${_esc(p.sync_error.slice(0,120))}</div>` : '')}
                <div class="sc-provider-actions">
                    <button class="btn-mini" id="sc-sync-btn-${p.id}"
                        onclick="scSyncProvider(${p.id}, '${_escAttr(p.name)}')">
                        Quick Sync
                    </button>
                    <button class="btn-mini" style="background:var(--bg)"
                        onclick="scSyncProvider(${p.id}, '${_escAttr(p.name)}', 'full')">
                        Full Sync
                    </button>
                </div>
            </div>`;
        }).join('');

        // Hide the legacy shared-credentials Azure card when this tenant has no
        // subscriptions in it (self-service Azure accounts get their own card below)
        const showAzureCard = subCount > 0;
        container.innerHTML = (showAzureCard ? azureCard : '') + otherCards
            || '<div style="font-size:12px;color:var(--text-secondary)">No providers connected yet</div>';
    } catch(e) {
        container.innerHTML = '<div style="font-size:12px;color:var(--red)">Failed to load providers</div>';
    }
}

async function _scLoadHistory() {
    const list = document.getElementById('scHistoryList');
    if (!list) return;
    try {
        const hist = await fetch('/api/sync/history').then(r => r.json());
        if (!hist.length) {
            list.innerHTML = '<div style="color:var(--text-secondary)">No sync history yet</div>';
            return;
        }
        list.innerHTML = hist.slice(0, 15).map(h => {
            const t = h.sync_end ? new Date(h.sync_end + 'Z').toLocaleString() : (h.sync_start ? new Date(h.sync_start + 'Z').toLocaleString() : '');
            const dotClass = h.status === 'success' ? 'success' : (h.status === 'running' ? 'running' : 'error');
            const records = h.records_fetched ? `${h.records_fetched.toLocaleString()} records` : '';
            const fromTo = h.date_from && h.date_to ? `${h.date_from} → ${h.date_to}` : '';
            const errSnip = h.error_message ? `<div style="color:var(--red);margin-top:2px;font-size:11px">${_esc(h.error_message.slice(0,80))}</div>` : '';
            const isAuto = h.triggered_by === 'auto';
            const triggerTag = `<span style="font-size:10px;padding:1px 6px;border-radius:10px;font-weight:600;background:${isAuto ? 'rgba(99,102,241,0.12)' : 'rgba(100,116,139,0.12)'};color:${isAuto ? 'var(--accent)' : 'var(--text-secondary)'}">${isAuto ? 'Auto' : 'Manual'}</span>`;
            return `<div class="sc-history-item">
                <div class="sc-history-dot ${dotClass}"></div>
                <div style="flex:1;min-width:0">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                        <span style="font-weight:600;color:var(--text-primary);text-transform:capitalize">${h.status}</span>
                        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                            ${triggerTag}
                            <span style="color:var(--text-secondary);white-space:nowrap;font-size:11px">${t}</span>
                        </div>
                    </div>
                    ${records ? `<div style="color:var(--text-secondary)">${records}${fromTo ? ' &bull; ' + fromTo : ''}</div>` : ''}
                    ${errSnip}
                </div>
            </div>`;
        }).join('');
    } catch(e) {
        list.innerHTML = '<div style="color:var(--red)">Failed to load history</div>';
    }
}

async function scSaveAutoSync() {
    const enabled  = document.getElementById('scAutoSyncToggle').checked;
    const interval = parseInt(document.getElementById('scAutoSyncInterval').value);
    try {
        await Promise.all([
            fetch('/api/sync/schedule', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ interval_hours: interval }) }),
            fetch('/api/auto-sync',    { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) })
        ]);
        _scLoadAutoSync();
        showToast(`Auto-sync ${enabled ? 'enabled every ' + interval + 'h' : 'disabled'}`, 'success');
    } catch(e) {
        showToast('Failed to update auto-sync', 'error');
    }
}

async function scStartSync(mode = 'incremental') {
    if (mode === 'full' && !confirm('Full Re-sync fetches the entire cost history (12 months). Existing data is only replaced after a successful fetch — safe to run.\n\nThis may take 30-45 minutes for multiple subscriptions.\n\nContinue?')) return;
    try {
        await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        document.querySelector('.sync-bar').classList.add('active');
        _scMonitorSync();
    } catch(e) {
        showToast('Sync failed to start', 'error');
    }
}

function _scMonitorSync() {
    const wrap = document.getElementById('scProgressWrap');
    const msg  = document.getElementById('scProgressMsg');
    const fill = document.getElementById('scProgressFill');
    if (wrap) wrap.style.display = 'block';

    let _syncStart = Date.now();
    let _lastDoneCount = 0;

    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(async () => {
        try {
            const status = await fetch('/api/sync/status').then(r => r.json());
            const pct = status.progress || 0;

            // ── Sync Center panel ──
            if (msg)  msg.textContent = status.message;
            if (fill) fill.style.width = `${pct}%`;

            // ── Top sync bar ──
            const barMsg  = document.getElementById('syncMessage');
            const barFill = document.getElementById('syncProgress');
            const barPct  = document.getElementById('syncPct');
            const barETA  = document.getElementById('syncETA');
            const barList = document.getElementById('syncDetailsList');

            const details = status.details || [];
            const total   = details.length || 1;
            const done    = details.filter(d => d.ok !== undefined).length;

            if (barMsg)  barMsg.textContent  = status.message || 'Syncing…';
            if (barFill) barFill.style.width = `${pct}%`;
            if (barPct)  barPct.textContent  = `${pct}%`;

            // ETA calculation
            if (barETA && done > 0 && status.running) {
                const elapsed = (Date.now() - _syncStart) / 1000;
                const secPerSub = elapsed / done;
                const remaining = Math.max(0, (total - done) * secPerSub);
                if (remaining > 60) {
                    barETA.textContent = `~${Math.ceil(remaining/60)} min remaining`;
                } else if (remaining > 0) {
                    barETA.textContent = `~${Math.ceil(remaining)} sec remaining`;
                } else {
                    barETA.textContent = '';
                }
            } else if (barETA) {
                barETA.textContent = '';
            }

            // Per-subscription status list
            if (barList && details.length) {
                barList.style.display = 'block';
                barList.innerHTML = details.map(d => {
                    const isDone    = d.ok !== undefined;
                    const isCurrent = !isDone && d === details.find(x => x.ok === undefined);
                    let icon, color, info;
                    if (d.ok === true) {
                        icon  = '✅'; color = 'var(--green,#27ae60)';
                        info  = `${(d.records||0).toLocaleString()} records`;
                    } else if (d.ok === false) {
                        icon  = '❌'; color = 'var(--red,#e74c3c)';
                        info  = d.error ? d.error.slice(0,40) + '…' : 'failed';
                    } else if (isCurrent) {
                        icon  = '⏳'; color = 'var(--accent)';
                        info  = 'syncing…';
                    } else {
                        icon  = '○'; color = 'var(--text-secondary)';
                        info  = 'waiting';
                    }
                    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 8px;font-size:11px;${isCurrent?'background:rgba(79,110,247,.07);border-radius:4px':''}">
                        <span style="display:flex;align-items:center;gap:5px">
                            <span>${icon}</span>
                            <span style="color:${color};font-weight:${isCurrent?'600':'400'}">${_esc(d.name)}</span>
                        </span>
                        <span style="color:var(--text-secondary)">${info}</span>
                    </div>`;
                }).join('');
            } else if (barList && !status.running) {
                barList.style.display = 'none';
            }

            // Sync Center per-sub panel
            const scDetails = document.getElementById('scSyncDetails');
            if (scDetails && details.length) {
                scDetails.innerHTML = details.map(d => `
                    <div class="sc-sync-detail-row">
                        <span class="sc-sync-detail-dot" style="color:${d.ok ? 'var(--green)' : 'var(--red)'}">
                            ${d.ok ? '✓' : '✗'}
                        </span>
                        <span class="sc-sync-detail-name">${_esc(d.name)}</span>
                        <span class="sc-sync-detail-count">
                            ${d.ok ? d.records.toLocaleString() + ' records' : (d.error || 'failed')}
                        </span>
                    </div>`).join('');
                scDetails.style.display = 'block';
            } else if (scDetails && !status.running) {
                scDetails.style.display = 'none';
            }

            if (!status.running) {
                clearInterval(syncInterval);
                syncInterval = null;
                if (barPct) barPct.textContent = '100%';
                if (barETA) barETA.textContent = '';
                if (wrap) setTimeout(() => { wrap.style.display = 'none'; if (fill) fill.style.width = '0%'; }, 2000);
                if (status.progress === 100) {
                    showToast(status.message, 'success');
                    setTimeout(() => {
                        const sb = document.querySelector('.sync-bar');
                        if (sb) sb.classList.remove('active');
                        if (barList) barList.style.display = 'none';
                        if (barPct) barPct.textContent = '';
                        loadSyncCenter();
                        if (currentPage === 'executive') loadExecutiveSummary();
                    }, 2000);
                } else {
                    showToast(status.message, 'error');
                    const sb = document.querySelector('.sync-bar');
                    if (sb) sb.classList.remove('active');
                }
            }
        } catch(e) { clearInterval(syncInterval); }
    }, 1000);
}

async function scSyncProvider(id, name, mode = 'incremental') {
    const btn = document.getElementById(`sc-sync-btn-${id}`);
    const lastSyncEl = document.getElementById(`sc-lastsync-${id}`);
    const prevText = lastSyncEl ? lastSyncEl.innerHTML : '';

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cp-sync-spinner"></span> Syncing…'; }
    if (lastSyncEl) lastSyncEl.innerHTML = '<span style="color:var(--accent)">⟳ Syncing…</span>';

    // Capture current last_sync so we can detect when it changes
    let prevLastSync = null;
    try {
        const cur = await fetch('/api/cloud-providers').then(r => r.json());
        const curP = cur.find(x => x.id === id);
        prevLastSync = curP?.last_sync || null;
    } catch(e) {}

    try {
        const resp = await fetch(`/api/cloud-providers/${id}/sync`, { method: 'POST' });
        const d = await resp.json();
        if (d.error) {
            if (btn) { btn.disabled = false; btn.innerHTML = 'Quick Sync'; }
            if (lastSyncEl) lastSyncEl.innerHTML = `<span style="color:var(--red)">✗ Failed</span>`;
            showToast('Sync failed: ' + d.error, 'error');
            return;
        }
        // Poll until last_sync changes from its pre-sync value
        let attempts = 0;
        const poll = setInterval(async () => {
            attempts++;
            try {
                const providers = await fetch('/api/cloud-providers').then(r => r.json());
                const p = providers.find(x => x.id === id);
                const changed = p?.last_sync && p.last_sync !== prevLastSync;
                if (changed || attempts >= 60) {
                    clearInterval(poll);
                    if (btn) { btn.disabled = false; btn.innerHTML = 'Quick Sync'; }
                    const newSync = p?.last_sync ? p.last_sync.slice(0,16).replace('T',' ') : null;
                    if (syncErrIsPending(p?.sync_error)) {
                        if (lastSyncEl) lastSyncEl.innerHTML = `<span style="color:#f59e0b" title="${_esc(syncErrText(p.sync_error))}">⏳ Pending</span>`;
                        showToast(`${name}: ${syncErrText(p.sync_error).slice(0,80)}`, 'info');
                    } else if (p?.sync_error) {
                        if (lastSyncEl) lastSyncEl.innerHTML = `<span style="color:var(--red)" title="${_esc(p.sync_error)}">✗ Failed</span>`;
                        showToast(`${name} sync failed`, 'error');
                    } else {
                        if (lastSyncEl) lastSyncEl.innerHTML = `<span style="color:var(--green)">✓</span> ${newSync || ''}`;
                        showToast(`${name} synced`, 'success');
                        _scLoadHistory();
                        _scLoadStatus();
                    }
                }
            } catch(e) {}
        }, 3000);
    } catch(e) {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Quick Sync'; }
        if (lastSyncEl) lastSyncEl.innerHTML = prevText;
        showToast('Sync error: ' + e.message, 'error');
    }
}

// ─── Auto-Sync (legacy — keep for backwards compat) ──────────────────────────

function toggleAutoSyncPanel() {
    // Now opens the Sync Center drawer instead
    openSyncCenter();
}

async function loadAutoSyncStatus() {
    try {
        const data = await fetch('/api/auto-sync').then(r => r.json());
        const badge = document.getElementById('autoSyncBadge');
        const toggle = document.getElementById('autoSyncToggle');
        const interval = document.getElementById('autoSyncInterval');
        const info = document.getElementById('autoSyncInfo');

        toggle.checked = data.enabled;
        interval.value = data.interval_hours;

        if (data.enabled) {
            badge.className = 'auto-sync-badge enabled';
            badge.innerHTML = `<span class="auto-sync-dot on"></span> Auto-sync: every ${data.interval_hours}h`;
            if (data.next_auto_sync) {
                const next = new Date(data.next_auto_sync + 'Z');
                info.textContent = `Next: ${next.toLocaleTimeString()}`;
            }
            if (data.last_auto_sync) {
                const last = new Date(data.last_auto_sync + 'Z');
                info.textContent += ` | Last: ${last.toLocaleTimeString()}`;
            }
        } else {
            badge.className = 'auto-sync-badge disabled';
            badge.innerHTML = '<span class="auto-sync-dot off"></span> Auto-sync: off';
            info.textContent = 'Auto-sync is disabled';
        }
    } catch (err) {
        console.error('Auto-sync status error:', err);
    }
}

async function saveAutoSyncSettings() {
    const enabled = document.getElementById('autoSyncToggle').checked;
    const interval = parseInt(document.getElementById('autoSyncInterval').value);
    try {
        await Promise.all([
            fetch('/api/sync/schedule', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ interval_hours: interval }) }),
            fetch('/api/auto-sync',    { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) })
        ]);
        loadAutoSyncStatus();
        showToast(`Auto-sync ${enabled ? 'enabled' : 'disabled'} (every ${interval}h)`, 'success');
    } catch (err) {
        showToast('Failed to update auto-sync', 'error');
    }
}

async function triggerAutoSyncNow() {
    try {
        const resp = await fetch('/api/auto-sync/run-now', { method: 'POST' });
        const data = await resp.json();
        if (resp.ok) {
            showToast('Auto-sync triggered! Check progress above.', 'success');
            document.querySelector('.sync-bar').classList.add('active');
            monitorSync();
        } else {
            showToast(data.error || 'Cannot start sync', 'error');
        }
    } catch (err) {
        showToast('Failed to trigger auto-sync', 'error');
    }
}

// ─── UI color themes (Night mode) + Sun/Light appearance ────────────────
const THEME_TRIAL_KEY = 'uiThemeTrial';
/** Dark theme ids (must match themes-trial.css and theme select options) */
const UI_THEME_IDS = ['forest', 'ocean', 'ember', 'violet', 'rose', 'slate', 'aurora'];

// ─── Night / Sun appearance (sidebar) ───────────────────────────────────
const UI_APPEARANCE_KEY = 'uiAppearance';

function syncAppearanceToggleActive() {
    const isLight = document.documentElement.getAttribute('data-appearance') === 'light';
    // legacy floating buttons (removed from DOM but guard anyway)
    const night = document.getElementById('appearanceNightBtn');
    const sun   = document.getElementById('appearanceSunBtn');
    if (night) { night.style.opacity = isLight ? '0.45' : '1'; night.style.boxShadow = isLight ? '' : '0 0 0 2px var(--accent)'; }
    if (sun)   { sun.style.opacity   = isLight ? '1'    : '0.45'; sun.style.boxShadow   = isLight ? '0 0 0 2px var(--accent)' : ''; }
}

function refreshAllCharts() {
    Object.values(chartInstances || {}).forEach(c => {
        if (c && typeof c.update === 'function') c.update();
    });
}

function applyAppearance(mode) {
    const light = mode === 'light';
    const sel = document.getElementById('themeTrialSelect');
    if (light) {
        document.documentElement.setAttribute('data-appearance', 'light');
        document.documentElement.removeAttribute('data-ui-theme');
        if (sel) sel.disabled = true;
    } else {
        document.documentElement.removeAttribute('data-appearance');
        if (sel) sel.disabled = false;
        let t = null;
        try {
            t = localStorage.getItem(THEME_TRIAL_KEY);
        } catch (e) { /* ignore */ }
        if (t === null) {
            try {
                localStorage.setItem(THEME_TRIAL_KEY, 'ocean');
            } catch (e) { /* ignore */ }
            document.documentElement.setAttribute('data-ui-theme', 'ocean');
            if (sel) sel.value = 'ocean';
        } else if (UI_THEME_IDS.includes(t)) {
            document.documentElement.setAttribute('data-ui-theme', t);
            if (sel) sel.value = t;
        } else {
            document.documentElement.removeAttribute('data-ui-theme');
            if (sel) sel.value = '';
        }
    }
    try {
        localStorage.setItem(UI_APPEARANCE_KEY, light ? 'light' : 'dark');
        localStorage.setItem('theme', light ? 'light' : 'dark');
    } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    syncAppearanceToggleActive();
    refreshAllCharts();
}

function setAppearance(mode) { applyAppearance(mode === 'night' ? 'dark' : mode); }

function initAppearanceToggle() {
    try {
        const saved = localStorage.getItem('theme');
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.setAttribute('data-theme', saved);
            applyAppearance(saved);
        }
    } catch (e) { /* ignore */ }
    syncAppearanceToggleActive();

    // Wire in-header theme toggle button
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const isLight = document.documentElement.getAttribute('data-appearance') === 'light';
            applyAppearance(isLight ? 'dark' : 'light');
        });
    }
}

function applyUiTheme(theme) {
    if (document.documentElement.getAttribute('data-appearance') === 'light') return;
    const t = (theme || '').trim();
    if (t && UI_THEME_IDS.includes(t)) {
        document.documentElement.setAttribute('data-ui-theme', t);
    } else {
        document.documentElement.removeAttribute('data-ui-theme');
    }
    try {
        localStorage.setItem(THEME_TRIAL_KEY, t || '');
    } catch (e) { /* ignore */ }
    const sel = document.getElementById('themeTrialSelect');
    if (sel) sel.value = t || '';
}

function initUiThemeTrial() {
    const sel = document.getElementById('themeTrialSelect');
    if (!sel) return;
    if (document.documentElement.getAttribute('data-appearance') === 'light') {
        sel.disabled = true;
        sel.addEventListener('change', () => applyUiTheme(sel.value));
        return;
    }
    sel.disabled = false;
    let raw = null;
    try {
        raw = localStorage.getItem(THEME_TRIAL_KEY);
    } catch (e) { /* ignore */ }
    // First visit (key missing): default to Ocean so the trial palette is obvious
    if (raw === null) {
        try {
            localStorage.setItem(THEME_TRIAL_KEY, 'ocean');
        } catch (e) { /* ignore */ }
        applyUiTheme('ocean');
        sel.addEventListener('change', () => applyUiTheme(sel.value));
        return;
    }
    if (raw === '') {
        applyUiTheme('');
    } else if (UI_THEME_IDS.includes(raw)) {
        applyUiTheme(raw);
    } else {
        applyUiTheme('');
    }
    sel.addEventListener('change', () => applyUiTheme(sel.value));
}

// ─── Event Listeners ─────────────────────────────────────────────────────
// ─── Nav right-click context menu ────────────────────────────────────────────

function _initNavContextMenu() {
    const menu = document.createElement('div');
    menu.id = 'navCtxMenu';
    menu.className = 'nav-ctx-menu';
    menu.innerHTML = `
        <button class="nav-ctx-item" id="navCtxNewTab">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open in new tab
        </button>`;
    document.body.appendChild(menu);

    let _targetPage = null;

    // Attach contextmenu to every nav-item
    function _attach() {
        document.querySelectorAll('.nav-item[data-page]').forEach(el => {
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                _targetPage = el.dataset.page;
                const x = Math.min(e.clientX, window.innerWidth  - 180);
                const y = Math.min(e.clientY, window.innerHeight - 60);
                menu.style.left = x + 'px';
                menu.style.top  = y + 'px';
                menu.style.display = 'block';
            });
        });
    }

    document.getElementById('navCtxNewTab')?.addEventListener('click', () => {
        if (_targetPage) window.open(`${location.origin}/?page=${_targetPage}`, '_blank');
        menu.style.display = 'none';
    });

    // Close on any click outside
    document.addEventListener('click', () => { menu.style.display = 'none'; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.style.display = 'none'; });

    // Run after nav items are in DOM
    _attach();
}

document.addEventListener('DOMContentLoaded', async () => {
    initAppearanceToggle();
    initUiThemeTrial();
    _scLoadAutoSync();   // load auto-sync state into drawer + badge on startup
    _scLoadStatus();     // update sidebar global status
    await initCloudFilter();   // hide cloud UI for unconnected clouds (before first page render)
    await loadTenantCurrency(); // load tenant reporting currency before first render
    populateClientDropdowns();
    _initNavContextMenu();
    // Restore page from URL hash (refresh) or ?page= query param, else default to executive
    const hashPage = location.hash ? location.hash.slice(1) : '';
    let urlPage = hashPage || new URLSearchParams(location.search).get('page');
    if (urlPage === 'dashboard' || !document.getElementById(`page-${urlPage}`)) urlPage = 'executive';
    navigateTo(urlPage || 'executive');
    onCompareModeChange();

    // Chat enter key
    document.getElementById('chatInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    // Search debounce for costs page
    let searchTimeout;
    document.getElementById('costSearch')?.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(loadCostsTable, 250);
    });

    // Search debounce for activity page
    let actSearchTimeout;
    document.getElementById('actSearch')?.addEventListener('input', () => {
        clearTimeout(actSearchTimeout);
        actSearchTimeout = setTimeout(loadActivityTable, 300);
    });
});

function _esc(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// A provider with sync_error prefixed "[PENDING]" is connected but waiting on
// something external (e.g. GCP BigQuery export data) — show it as pending, not failed.
function syncErrIsPending(err) { return !!err && String(err).indexOf('[PENDING]') === 0; }
function syncErrText(err) { return String(err || '').replace('[PENDING]', '').trim(); }
// Stored sync timestamps are naive UTC (no timezone). Append 'Z' so the
// browser parses them as UTC and renders in the viewer's local timezone —
// consistent with the Recent Sync History display.
function _fmtSyncTime(ts) {
    if (!ts) return 'Never';
    const d = new Date(ts + 'Z');
    if (isNaN(d.getTime())) return ts.slice(0,16).replace('T',' ');
    return d.toLocaleString();
}

function syncStatusBadge(p) {
    if (syncErrIsPending(p.sync_error))
        return `<span style="color:#f59e0b" title="${_esc(syncErrText(p.sync_error))}">⏳ Pending</span>`;
    if (p.sync_error)
        return `<span style="color:var(--red)" title="${_esc(p.sync_error)}">✗ Failed</span>`;
    if (p.last_sync)
        return `<span style="color:var(--green)">✓</span> ${_fmtSyncTime(p.last_sync)}`;
    return 'Never';
}

const RESOURCE_TYPE_LABELS = {
    'microsoft.compute/virtualmachines':            'Virtual Machines',
    'microsoft.compute/disks':                      'Managed Disks',
    'microsoft.sql/servers/databases':              'SQL Databases',
    'microsoft.dbforpostgresql/servers':            'PostgreSQL Servers',
    'microsoft.dbforpostgresql/flexibleservers':    'PostgreSQL Flexible Servers',
    'microsoft.dbformysql/servers':                 'MySQL Servers',
    'microsoft.dbformysql/flexibleservers':         'MySQL Flexible Servers',
    'microsoft.dbformariadb/servers':               'MariaDB Servers',
    'microsoft.web/sites':                          'App Services',
    'microsoft.web/serverfarms':                    'App Service Plans',
    'microsoft.storage/storageaccounts':            'Storage Accounts',
    'microsoft.cache/redis':                        'Redis Cache',
    'microsoft.containerservice/managedclusters':   'AKS Clusters',
    'microsoft.network/loadbalancers':              'Load Balancers',
    'microsoft.network/applicationgateways':        'Application Gateways',
    'microsoft.keyvault/vaults':                    'Key Vaults',
    'microsoft.servicebus/namespaces':              'Service Bus',
    'microsoft.eventhub/namespaces':                'Event Hubs',
    'microsoft.cognitiveservices/accounts':         'Cognitive Services',
    'microsoft.search/searchservices':              'Azure Search',
};

function _friendlyResType(t) {
    if (!t) return '—';
    return RESOURCE_TYPE_LABELS[(t || '').toLowerCase()] || t.replace(/^microsoft\./i, '');
}

function _shortResType(t) {
    return (t || '').replace(/^microsoft\./i, '');
}

async function loadConfigsPage() {
    await loadConfigsTable();
}

// ─── Multi-select dropdown helpers ───────────────────────────────────────────

function toggleMultiDrop(dropId, btnId) {
    const drop = document.getElementById(dropId);
    const btn  = document.getElementById(btnId);
    if (!drop) return;
    const isOpen = drop.classList.contains('open');
    // close all others first
    document.querySelectorAll('.multi-select-drop.open').forEach(d => {
        d.classList.remove('open');
        const b = document.getElementById(d.id.replace('Drop', 'Btn'));
        if (b) b.classList.remove('open');
    });
    if (!isOpen) {
        drop.classList.add('open');
        if (btn) btn.classList.add('open');
    }
}

function clearMultiDrop(prefix) {
    if (prefix === 'cfgSub') {
        _cfgSelectedSubs.clear();
        _syncMultiDropChecks('cfgSubItems', _cfgSelectedSubs);
        _updateMultiDropLabel('cfgSubLabel', _cfgSelectedSubs, 'All subscriptions');
    } else if (prefix === 'cfgRg') {
        _cfgSelectedRGs.clear();
        _syncMultiDropChecks('cfgRgItems', _cfgSelectedRGs);
        _updateMultiDropLabel('cfgRgLabel', _cfgSelectedRGs, 'All resource groups');
    }
    applyConfigFilters();
}

function _syncMultiDropChecks(containerId, selectedSet) {
    document.querySelectorAll(`#${containerId} input[type="checkbox"]`).forEach(cb => {
        cb.checked = selectedSet.has(cb.value);
    });
}

function _updateMultiDropLabel(labelId, selectedSet, allLabel) {
    const el = document.getElementById(labelId);
    if (!el) return;
    if (selectedSet.size === 0) {
        el.textContent = allLabel;
    } else if (selectedSet.size === 1) {
        el.textContent = [...selectedSet][0];
    } else {
        el.textContent = `${selectedSet.size} selected`;
    }
}

function _buildMultiDropItems(containerId, items, selectedSet, labelFn, onChangeFn) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach((item) => {
        const val   = typeof item === 'object' ? item.id   : item;
        const label = typeof item === 'object' ? item.name : (labelFn ? labelFn(item) : item);
        const id = `${containerId}_${val.replace(/[^a-z0-9]/gi, '_')}`;
        const div = document.createElement('div');
        div.className = 'multi-select-item';
        div.innerHTML = `
            <input type="checkbox" id="${id}" value="${_escAttr(val)}" ${selectedSet.has(val) ? 'checked' : ''}>
            <label for="${id}" title="${_escAttr(label)}">${_esc(label)}</label>`;
        div.querySelector('input').addEventListener('change', function() {
            if (this.checked) selectedSet.add(this.value);
            else selectedSet.delete(this.value);
            onChangeFn();
        });
        container.appendChild(div);
    });
}

async function loadResourceConfigFilters() {
    const svcSel = document.getElementById('configSvcFilter');
    const curSvc = svcSel ? svcSel.value : '';
    try {
        const data = await fetch('/api/resource_configs/filters').then(r => r.json());

        // Subscriptions multi-drop
        _buildMultiDropItems('cfgSubItems', data.subscriptions || [], _cfgSelectedSubs,
            s => s, () => {
                _updateMultiDropLabel('cfgSubLabel', _cfgSelectedSubs, 'All subscriptions');
                applyConfigFilters();
            });
        const subCount = document.getElementById('cfgSubCount');
        if (subCount) subCount.textContent = `${(data.subscriptions || []).length} subscriptions`;

        // Resource Groups multi-drop
        _buildMultiDropItems('cfgRgItems', data.resource_groups || [], _cfgSelectedRGs,
            null, () => {
                _updateMultiDropLabel('cfgRgLabel', _cfgSelectedRGs, 'All resource groups');
                applyConfigFilters();
            });
        const rgCount = document.getElementById('cfgRgCount');
        if (rgCount) rgCount.textContent = `${(data.resource_groups || []).length} groups`;

        // Type single-select
        if (svcSel) {
            svcSel.innerHTML = '<option value="">All types</option>';
            (data.resource_types || []).forEach(x => {
                const o = document.createElement('option');
                o.value = x;
                o.textContent = _friendlyResType(x);
                svcSel.appendChild(o);
            });
            if ([...svcSel.options].some(o => o.value === curSvc)) svcSel.value = curSvc;
        }
    } catch (e) {
        console.error('Config filters error:', e);
    }
}

function applyConfigFilters() {
    const svc    = (document.getElementById('configSvcFilter')?.value || '').toLowerCase();
    const search = (document.getElementById('configSearch')?.value || '').toLowerCase();
    let filtered = _configsData;

    if (_cfgSelectedSubs.size > 0) {
        filtered = filtered.filter(r => _cfgSelectedSubs.has(r.subscription_id || ''));
    }
    if (_cfgSelectedRGs.size > 0) {
        filtered = filtered.filter(r => _cfgSelectedRGs.has(r.resource_group || ''));
    }
    if (svc) {
        filtered = filtered.filter(r => (r.resource_type || '').toLowerCase() === svc);
    }
    if (search) {
        filtered = filtered.filter(r =>
            (r.resource_name || '').toLowerCase().includes(search) ||
            (r.resource_group || '').toLowerCase().includes(search) ||
            (r.subscription_name || '').toLowerCase().includes(search) ||
            (r.sku_name || '').toLowerCase().includes(search) ||
            (r.spec_summary || '').toLowerCase().includes(search)
        );
    }
    renderConfigsTable(filtered);
}

function clearConfigFilters() {
    _cfgSelectedSubs.clear();
    _cfgSelectedRGs.clear();
    _syncMultiDropChecks('cfgSubItems', _cfgSelectedSubs);
    _syncMultiDropChecks('cfgRgItems', _cfgSelectedRGs);
    _updateMultiDropLabel('cfgSubLabel', _cfgSelectedSubs, 'All subscriptions');
    _updateMultiDropLabel('cfgRgLabel', _cfgSelectedRGs, 'All resource groups');
    const sv = document.getElementById('configSvcFilter');
    const se = document.getElementById('configSearch');
    if (sv) sv.value = '';
    if (se) se.value = '';
    renderConfigsTable(_configsData);
}

async function triggerResourceConfigSync() {
    try {
        const resp = await fetch('/api/resource_configs/sync', { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            showToast(data.error || 'Failed to start configuration sync', 'error');
            return;
        }
        showToast(data.message || 'Sync started — wait a moment, then refresh the list.', 'success');
    } catch (e) {
        showToast('Failed to start configuration sync', 'error');
    }
}

function renderConfigDisplayPanel(display) {
    if (!display || !display.summary) return '';
    const s = display.summary;
    let html = `<div style="background:var(--bg-body); border:1px solid var(--border); border-radius:8px; padding:14px; margin:12px 0">`;
    html += `<div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:10px">${_esc(s.title || 'Summary')}</div>`;
    (s.rows || []).forEach((r) => {
        html += `<div style="display:flex;gap:12px;margin:8px 0;font-size:13px;align-items:flex-start"><span style="color:var(--text-secondary);min-width:150px;flex-shrink:0">${_esc(r.label)}</span><span style="color:var(--text-primary);font-weight:500;flex:1;word-break:break-word">${_esc(r.value)}</span></div>`;
    });
    if (s.one_liner) {
        html += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary)"><strong style="color:var(--text-primary)">Quick read:</strong> ${_esc(s.one_liner)}</div>`;
    }
    html += `</div>`;
    return html;
}

async function showResourceConfig(sub_id, rg, name) {
    if (!name) return;
    try {
        const res = await fetch(`/api/resource_config?subscription_id=${encodeURIComponent(sub_id)}&resource_group=${encodeURIComponent(rg)}&resource_name=${encodeURIComponent(name)}`);
        if (res.status === 404) {
            alert(`No configuration details found for ${name}. Click "Sync from Azure" on Configurations, or wait for the background sync.`);
            return;
        }
        const data = await res.json();
        const raw = data.config_json;
        const confStr =
            raw && typeof raw === 'object' && Object.keys(raw).length
                ? JSON.stringify(raw, null, 2)
                : '(No property payload — resource row exists; try re-sync if you expect details.)';

        const specBlock = renderConfigDisplayPanel(data.display);

        const modal = document.createElement('div');
        modal.setAttribute('data-cfg-modal', '1');
        modal.style.position = 'fixed';
        modal.style.top = '0'; modal.style.left = '0'; modal.style.right = '0'; modal.style.bottom = '0';
        modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
        modal.style.display = 'flex';
        modal.style.justifyContent = 'center'; modal.style.alignItems = 'center';
        modal.style.zIndex = '9999';

        modal.innerHTML = `
            <div style="background:var(--bg-card, #fff); padding:20px; border-radius:8px; width:min(720px,92vw); max-height:90vh; overflow-y:auto; box-shadow:0 10px 25px rgba(0,0,0,0.2); border:1px solid var(--border, #ccc)">
                <h3 style="margin-top:0; color:var(--text-primary, #333)">Configuration: ${_esc(name)}</h3>
                <p style="margin:5px 0; font-size:13px; color:var(--text-secondary, #555)"><strong>Type:</strong> ${_esc(_shortResType(data.resource_type))}</p>
                <p style="margin:5px 0; font-size:13px; color:var(--text-secondary, #555)"><strong>Location:</strong> ${_esc(data.location || '-')}</p>
                ${specBlock || '<p style="color:var(--text-secondary);font-size:13px">No structured summary for this resource type.</p>'}
                <details style="margin-top:12px">
                    <summary style="cursor:pointer;font-size:13px;color:var(--accent);font-weight:500">Raw Azure properties (JSON)</summary>
                    <textarea id="cfgModalJson" readonly style="width:100%; height:220px; margin-top:8px; background:var(--bg-body, #f4f4f4); color:var(--text-primary, #333); border:1px solid var(--border, #ccc); padding:10px; font-family:monospace; font-size:11px; border-radius:4px; box-sizing:border-box"></textarea>
                </details>
                <div style="text-align:right; margin-top:15px">
                    <button type="button" class="btn btn-secondary" onclick="this.closest('[data-cfg-modal]')?.remove()" style="padding:8px 16px; border:none; border-radius:4px; cursor:pointer; background:#6c757d; color:#fff">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        const ta = modal.querySelector('#cfgModalJson');
        if (ta) ta.value = confStr;
    } catch (err) {
        console.error('Config fetch error:', err);
        alert('Failed to fetch resource configuration.');
    }
}

function _escAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function sortConfigsBy(field) {
    if (configSortBy === field) {
        configSortDir = configSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        configSortBy = field;
        configSortDir = 'asc';
    }
    applyConfigFilters();
}

function sortConfigRows(rows) {
    const out = [...rows];
    out.sort((a, b) => {
        let av = (a[configSortBy] || '').toString().toLowerCase();
        let bv = (b[configSortBy] || '').toString().toLowerCase();
        if (av < bv) return configSortDir === 'asc' ? -1 : 1;
        if (av > bv) return configSortDir === 'asc' ? 1 : -1;
        return 0;
    });
    return out;
}

function updateConfigSortIndicators() {
    const fields = ['resource_name', 'subscription_name', 'resource_type', 'power_state', 'spec_summary', 'resource_group'];
    fields.forEach(f => {
        const el = document.getElementById(`cfg-sort-${f}`);
        if (!el) return;
        if (f === configSortBy) {
            el.textContent = configSortDir === 'asc' ? '↑' : '↓';
            el.classList.add('active');
        } else {
            el.textContent = '↕';
            el.classList.remove('active');
        }
    });
}

function renderConfigsTable(data) {
    const tbody = document.getElementById('configsTableBody');
    const cnt = document.getElementById('configsCount');
    if (cnt) cnt.textContent = `${data.length} configuration(s) shown`;

    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-secondary)">No rows match your filters. Choose <strong>Sync from Azure</strong> to load configs, or widen filters / subscription scope.</td></tr>`;
        updateConfigSortIndicators();
        return;
    }

    const sorted = sortConfigRows(data);
    tbody.innerHTML = sorted.map((r) => {
        const subId = r.subscription_id || '';
        const rgName = r.resource_group || '';
        const resName = r.resource_name || '';
        const statusBadge = _resourceStatusBadge(r.power_state, r.resource_type);
        return `<tr>
            <td style="font-weight:500;color:var(--text-primary)">${_esc(resName || '-')}</td>
            <td style="font-size:12px">${_esc(r.subscription_name || subId || '-')}</td>
            <td style="font-size:12px">${_esc(_friendlyResType(r.resource_type) || '-')}</td>
            <td>${statusBadge}</td>
            <td style="font-size:12px;max-width:280px;line-height:1.4">${_esc(r.spec_summary || '—')}</td>
            <td>${_esc(rgName || '-')}</td>
            <td>
                <button type="button" class="btn-mini" data-sub="${_escAttr(subId)}" data-rg="${_escAttr(rgName)}" data-name="${_escAttr(resName)}" onclick="showResourceConfig(this.getAttribute('data-sub'), this.getAttribute('data-rg'), this.getAttribute('data-name'))">View details</button>
            </td>
        </tr>`;
    }).join('');
    updateConfigSortIndicators();
}

function _resourceStatusBadge(powerState, resourceType) {
    const state = (powerState || '').trim();
    if (!state) {
        return '<span style="font-size:11px;color:var(--text-secondary)">—</span>';
    }
    const lower = state.toLowerCase();
    const isVm = (resourceType || '').toLowerCase().includes('virtualmachines');

    let color, bg, label;
    if (lower === 'vm running' || lower === 'running') {
        color = '#166534'; bg = '#dcfce7'; label = 'Running';
    } else if (lower === 'vm deallocated' || lower === 'deallocated') {
        color = '#374151'; bg = '#f3f4f6'; label = 'Deallocated';
    } else if (lower === 'vm stopped' || lower === 'stopped') {
        color = '#92400e'; bg = '#fef3c7'; label = 'Stopped';
    } else if (lower === 'attached') {
        color = '#166534'; bg = '#dcfce7'; label = 'Attached';
    } else if (lower === 'unattached') {
        color = '#374151'; bg = '#f3f4f6'; label = 'Unattached';
    } else if (lower === 'reserved') {
        color = '#1e40af'; bg = '#dbeafe'; label = 'Reserved';
    } else {
        color = '#374151'; bg = '#f3f4f6'; label = state;
    }
    return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${bg};color:${color}">${_esc(label)}</span>`;
}

async function loadConfigsTable() {
    document.getElementById('configsTableBody').innerHTML =
        `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading…</td></tr>`;
    try {
        const data = await fetch('/api/resource_configs_list').then(r => r.json());
        _configsData = data;
        await loadResourceConfigFilters();
        applyConfigFilters();
    } catch (err) {
        console.error('Error loading configs:', err);
        document.getElementById('configsTableBody').innerHTML =
            `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--red)">Failed to load configurations.</td></tr>`;
    }
}

// ─── AWS CloudFormation One-Click Connect ────────────────────────────────────

let _awsCFData = null;
let _awsPollingTimer = null;

function switchAwsTab(tab) {
    const isCF = tab === 'cf';
    document.getElementById('awsTabCF').style.cssText    = `flex:1;padding:8px 12px;border:none;cursor:pointer;font-weight:500;background:${isCF ? 'var(--accent)' : 'var(--bg)'};color:${isCF ? '#fff' : 'var(--text-secondary)'}`;
    document.getElementById('awsTabKeys').style.cssText  = `flex:1;padding:8px 12px;border:none;cursor:pointer;background:${!isCF ? 'var(--accent)' : 'var(--bg)'};color:${!isCF ? '#fff' : 'var(--text-secondary)'}`;
    document.getElementById('awsPanelCF').style.display   = isCF  ? 'flex' : 'none';
    document.getElementById('awsPanelKeys').style.display = !isCF ? 'flex' : 'none';
}

async function loadAWSConnectCommand() {
    const loading = document.getElementById('awsCFLoading');
    const buttons = document.getElementById('awsCFButtons');
    if (!loading) return;
    loading.style.display = 'block';
    if (buttons) buttons.style.display = 'none';
    try {
        _awsCFData = await fetch('/api/aws/connect-command').then(r => r.json());
        if (document.getElementById('awsCLICommand'))
            document.getElementById('awsCLICommand').textContent = _awsCFData.cli_command;
        if (document.getElementById('awsTerraformCode'))
            document.getElementById('awsTerraformCode').textContent = _awsCFData.terraform_code;
        if (loading) loading.style.display = 'none';
        if (buttons) buttons.style.display = 'flex';
        checkAWSConnectionStatus();
    } catch(e) {
        if (loading) loading.textContent = 'Failed to load connect command.';
    }
}

function openAWSConsole() {
    if (_awsCFData?.console_url) window.open(_awsCFData.console_url, '_blank');
}

function toggleAwsMoreMenu() {
    const m = document.getElementById('awsMoreMenu');
    if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}

function showAWSCLIModal() {
    document.getElementById('awsMoreMenu')?.style.setProperty('display','none');
    const modal = document.getElementById('awsCLIModal');
    if (modal) modal.style.display = 'flex';
}

function showAWSTerraformModal() {
    document.getElementById('awsMoreMenu')?.style.setProperty('display','none');
    const modal = document.getElementById('awsTerraformModal');
    if (modal) modal.style.display = 'flex';
}

function copyAWSCLICommand() {
    const text = document.getElementById('awsCLICommand')?.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('awsCopyCLIBtn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
    });
}

function copyTerraformCode() {
    const text = document.getElementById('awsTerraformCode')?.textContent || '';
    navigator.clipboard.writeText(text).then(() => showToast('Terraform code copied', 'success'));
}

async function verifyAWSRole() {
    const roleArn  = document.getElementById('awsCFRoleArn')?.value.trim();
    const bucket   = document.getElementById('awsCFBucket')?.value.trim();
    const statusEl = document.getElementById('awsVerifyStatus');
    if (!roleArn) { showToast('Enter a Role ARN first', 'error'); return; }
    if (statusEl) { statusEl.textContent = 'Verifying…'; statusEl.style.color = 'var(--text-secondary)'; }

    // Auto-extract account ID from ARN: arn:aws:iam::ACCOUNT_ID:role/...
    const arnParts = roleArn.split(':');
    const accountId = arnParts.length >= 5 ? arnParts[4] : '';

    // Auto-fill the Name + ID fields so "Save Provider" also works
    const nameEl = document.getElementById('providerName');
    const idEl   = document.getElementById('providerId');
    if (nameEl && !nameEl.value) nameEl.value = `AWS ${accountId}`;
    if (idEl   && !idEl.value)   idEl.value   = accountId;

    try {
        const resp = await fetch('/api/aws/handshake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role_arn: roleArn,
                cur_bucket: bucket || `prism-cur-1-${_awsCFData?.external_id || ''}`,
                cur_report_name: `PrismReport-1-${_awsCFData?.external_id || ''}`,
                provider_id: accountId,
            })
        });
        const data = await resp.json();
        if (statusEl) {
            statusEl.textContent = data.verified ? '✅ ' + data.message : '⚠️ ' + data.message;
            statusEl.style.color = data.verified ? 'var(--green,#27ae60)' : 'var(--yellow,#e67e22)';
        }
        if (data.success) {
            showAWSConnectionStatus('connected', roleArn);
            showToast(`AWS account ${accountId} connected!`, 'success');
        }
    } catch(e) {
        if (statusEl) statusEl.textContent = 'Error: ' + e.message;
    }
}

async function checkAWSConnectionStatus() {
    try {
        const data = await fetch('/api/aws/connection-status').then(r => r.json());
        if (data.status === 'connected' && data.role_arn) {
            showAWSConnectionStatus('connected', data.role_arn);
        } else if (data.status === 'pending') {
            showAWSConnectionStatus('pending', '');
            startAWSPolling();
        }
    } catch(e) { /* non-fatal */ }
}

function showAWSConnectionStatus(status, roleArn) {
    const el = document.getElementById('awsConnectionStatus');
    if (!el) return;
    if (status === 'connected') {
        el.style.display = 'block';
        el.style.background = 'rgba(39,174,96,.1)';
        el.style.border = '1px solid rgba(39,174,96,.3)';
        el.style.color = '#27ae60';
        el.innerHTML = `✅ <strong>Connected</strong> &nbsp;·&nbsp; ${roleArn || 'Role active'}`;
        stopAWSPolling();
    } else if (status === 'pending') {
        el.style.display = 'block';
        el.style.background = 'rgba(243,156,18,.1)';
        el.style.border = '1px solid rgba(243,156,18,.3)';
        el.style.color = '#e67e22';
        el.innerHTML = '⏳ <strong>Waiting for CloudFormation stack to complete…</strong> Checking every 5 seconds.';
    }
}

function startAWSPolling() {
    if (_awsPollingTimer) return;
    let elapsed = 0;
    _awsPollingTimer = setInterval(async () => {
        elapsed += 5;
        try {
            const data = await fetch('/api/aws/connection-status').then(r => r.json());
            if (data.status === 'connected') {
                showAWSConnectionStatus('connected', data.role_arn);
                stopAWSPolling();
            } else if (elapsed >= 300) {
                stopAWSPolling();
                const el = document.getElementById('awsConnectionStatus');
                if (el) { el.innerHTML = '⚠️ Stack may still be deploying. Check CloudFormation console, then paste the Role ARN manually above.'; el.style.color = 'var(--text-secondary)'; }
            }
        } catch(e) { /* ignore */ }
    }, 5000);
}

function stopAWSPolling() {
    if (_awsPollingTimer) { clearInterval(_awsPollingTimer); _awsPollingTimer = null; }
}

// Close "More Options" menu when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('#awsMoreMenu') && !e.target.textContent?.includes('More Options'))
        document.getElementById('awsMoreMenu')?.style.setProperty('display','none');
});

// ─── Client Tagging & Cost Allocation ────────────────────────────────────────

let _clientsData = [];
let _selectedClientId = null;
let _clientDateFrom = '';
let _clientDateTo = '';

function _clientDateRange() {
    if (_clientDateFrom && _clientDateTo) {
        return { firstDay: _clientDateFrom, todayStr: _clientDateTo };
    }
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth()+1).padStart(2,'0');
    const d = String(today.getDate()).padStart(2,'0');
    return { firstDay: `${y}-${m}-01`, todayStr: `${y}-${m}-${d}` };
}

function _clientPeriodLabel() {
    const preset = document.getElementById('clientDatePreset')?.value || 'this_month';
    const labels = { this_month: 'This Month', last_month: 'Last Month', last_30: 'Last 30 Days', last_90: 'Last 90 Days' };
    if (preset === 'custom') return `${_clientDateFrom} to ${_clientDateTo}`;
    return labels[preset] || 'This Month';
}

function onClientDatePreset() {
    const preset = document.getElementById('clientDatePreset')?.value;
    const customWrap = document.getElementById('clientCustomDateWrap');
    const today = new Date();
    // Format in LOCAL time — toISOString() converts to UTC and shifts local
    // midnight (e.g. 1st of month) back a day in UTC+ timezones (off-by-one).
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    if (preset === 'custom') {
        if (customWrap) customWrap.style.display = 'flex';
        return;
    }
    if (customWrap) customWrap.style.display = 'none';

    if (preset === 'this_month') {
        _clientDateFrom = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
        _clientDateTo   = fmt(today);
    } else if (preset === 'last_month') {
        const end = new Date(today.getFullYear(), today.getMonth(), 0);
        _clientDateFrom = fmt(new Date(end.getFullYear(), end.getMonth(), 1));
        _clientDateTo   = fmt(end);
    } else if (preset === 'last_30') {
        _clientDateFrom = fmt(new Date(today - 30*864e5));
        _clientDateTo   = fmt(today);
    } else if (preset === 'last_90') {
        _clientDateFrom = fmt(new Date(today - 90*864e5));
        _clientDateTo   = fmt(today);
    }
    if (_selectedClientId) selectClient(_selectedClientId);
}

function applyClientDateFilter() {
    _clientDateFrom = document.getElementById('clientDateFrom')?.value || '';
    _clientDateTo   = document.getElementById('clientDateTo')?.value   || '';
    if (_selectedClientId && _clientDateFrom && _clientDateTo) selectClient(_selectedClientId);
}

function _fmt$(n) {
    return curSym() + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


async function loadClientsPage() {
    // Initialise date range from preset if not already set
    if (!_clientDateFrom) onClientDatePreset();
    const panel = document.getElementById('clientListPanel');
    const countEl = document.getElementById('clientCount');
    if (panel) panel.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-secondary);font-size:13px">Loading…</div>`;
    try {
        _clientsData = await fetch('/api/clients').then(r => r.json());
        if (countEl) countEl.textContent = `${_clientsData.length} client${_clientsData.length !== 1 ? 's' : ''}`;
        if (!panel) return;
        if (!_clientsData.length) {
            panel.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--text-secondary);font-size:13px">No clients yet.<br>Click <strong>+ New Client</strong> to get started.</div>`;
            return;
        }

        // Fetch this-month totals for all clients
        const { firstDay, todayStr } = _clientDateRange();
        const costResults = await Promise.all(_clientsData.map(c =>
            fetch(`/api/clients/${c.id}/costs?date_from=${firstDay}&date_to=${todayStr}`)
                .then(r => r.json()).catch(() => ({ total: 0 }))
        ));

        panel.innerHTML = _clientsData.map((c, i) => {
            const cost = costResults[i]?.total ?? 0;
            const clouds = [...new Set((c.mappings || []).map(m => m.cloud.toUpperCase()))].join(' · ');
            const isActive = c.id === _selectedClientId;
            return `<div class="client-list-item${isActive ? ' active' : ''}" onclick="selectClient(${c.id})"
                        style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;${isActive?'background:var(--accent-subtle,rgba(79,110,247,.08));':''}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <span style="font-size:13px;font-weight:500;color:var(--text-primary)">${_esc(c.name)}</span>
                    <span style="font-size:13px;font-weight:600;color:var(--accent)">${_fmt$(cost)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="font-size:11px;color:var(--text-secondary)">${clouds || 'No mappings'}</span>
                    <div style="display:flex;gap:4px">
                        <button class="btn-mini" onclick="event.stopPropagation();openClientForm(${c.id})" title="Edit">
                            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn-mini" onclick="event.stopPropagation();deleteClientById(${c.id},'${_esc(c.name)}')" title="Delete" style="color:var(--red)">
                            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');

        // Re-select active client if any
        if (_selectedClientId) selectClient(_selectedClientId);
        else if (_clientsData.length) selectClient(_clientsData[0].id);

    } catch(e) {
        if (panel) panel.innerHTML = `<div style="text-align:center;padding:32px;color:var(--red);font-size:13px">Failed to load clients.</div>`;
    }
}

function openClientReportModal() {
    const client = _clientsData.find(c => c.id === _selectedClientId);
    if (!client) return;
    const modal = document.getElementById('clientReportModal');
    const subtitle = document.getElementById('clientReportModalSubtitle');
    const periodEl = document.getElementById('clientReportPeriodLabel');
    if (subtitle) subtitle.innerHTML = `Sending cost report for <strong>${_esc(client.name)}</strong>`;
    if (periodEl) periodEl.textContent = _clientPeriodLabel();

    const recipientsEl = document.getElementById('clientReportRecipients');
    if (recipientsEl && !recipientsEl.value) recipientsEl.value = client.recipients || '';
    document.getElementById('clientReportSchedule').value = client.schedule || 'none';
    document.getElementById('clientReportScheduleDay').value = client.schedule_day ?? 1;
    setScheduleTime('clientReportScheduleTime', client.schedule_hour ?? 8, client.schedule_minute ?? 0);
    document.getElementById('clientReportScheduleTz').value = client.schedule_tz || 'UTC';
    onClientScheduleChange();

    const lastSentEl = document.getElementById('clientScheduleLastSent');
    if (lastSentEl) lastSentEl.textContent = client.last_sent ? `Last sent: ${new Date(client.last_sent).toLocaleString()}` : '';

    if (modal) modal.style.display = 'flex';
}

function closeClientReportModal() {
    const modal = document.getElementById('clientReportModal');
    if (modal) modal.style.display = 'none';
}

function onClientScheduleChange() {
    const sched = document.getElementById('clientReportSchedule').value;
    document.getElementById('clientScheduleDayGroup').style.display = sched === 'weekly' ? '' : 'none';
    document.getElementById('clientScheduleHourGroup').style.display = sched !== 'none' ? '' : 'none';
}

async function saveClientReportSchedule() {
    if (!_selectedClientId) return;
    const recipients = (document.getElementById('clientReportRecipients')?.value || '').trim();
    const schedule = document.getElementById('clientReportSchedule').value;
    if (schedule !== 'none' && !recipients) { showToast('Enter at least one recipient to enable a schedule', 'error'); return; }

    const btn = document.getElementById('clientReportScheduleSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const resp = await fetch(`/api/clients/${_selectedClientId}/schedule`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipients,
                schedule,
                schedule_day: parseInt(document.getElementById('clientReportScheduleDay').value),
                schedule_hour: _timeToHM(document.getElementById('clientReportScheduleTime').value).hour,
                schedule_minute: _timeToHM(document.getElementById('clientReportScheduleTime').value).minute,
                schedule_tz: document.getElementById('clientReportScheduleTz').value
            })
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message || 'Schedule saved', 'success');
            const client = _clientsData.find(c => c.id === _selectedClientId);
            if (client) { const _t = _timeToHM(document.getElementById('clientReportScheduleTime').value); client.recipients = recipients; client.schedule = schedule; client.schedule_day = parseInt(document.getElementById('clientReportScheduleDay').value); client.schedule_hour = _t.hour; client.schedule_minute = _t.minute; }
        } else {
            showToast(data.error || 'Save failed', 'error');
        }
    } catch(e) {
        showToast('Save failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Schedule'; }
    }
}

async function sendClientReport() {
    const client = _clientsData.find(c => c.id === _selectedClientId);
    if (!client) return;
    const recipients = (document.getElementById('clientReportRecipients')?.value || '').trim();
    if (!recipients) { showToast('Enter at least one recipient', 'error'); return; }

    const btn = document.getElementById('clientReportSendBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    const { firstDay, todayStr } = _clientDateRange();
    try {
        const resp = await fetch(`/api/clients/${_selectedClientId}/send-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipients, date_from: firstDay, date_to: todayStr })
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast(data.message || 'Report sent!', 'success');
            closeClientReportModal();
        } else {
            showToast(data.error || 'Send failed', 'error');
        }
    } catch(e) {
        showToast('Send failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin-right:4px"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></svg>Send'; }
    }
}

function previewClientReport() {
    const { firstDay, todayStr } = _clientDateRange();
    window.open(`/api/clients/${_selectedClientId}/report-preview?date_from=${firstDay}&date_to=${todayStr}`, '_blank');
}

async function selectClient(clientId) {
    _selectedClientId = clientId;
    // Show action buttons
    document.getElementById('clientSendReportBtn')?.style.setProperty('display', '');
    document.getElementById('clientPreviewBtn')?.style.setProperty('display', '');
    // Highlight active item
    document.querySelectorAll('.client-list-item').forEach(el => {
        const isActive = el.getAttribute('onclick') === `selectClient(${clientId})`;
        el.style.background = isActive ? 'var(--accent-subtle,rgba(79,110,247,.08))' : '';
    });

    const panel = document.getElementById('clientDetailPanel');
    if (!panel) return;
    panel.innerHTML = `<div class="db-card" style="text-align:center;padding:40px;color:var(--text-secondary)">Loading cost data…</div>`;

    const client = _clientsData.find(c => c.id === clientId);
    if (!client) return;

    const { firstDay, todayStr } = _clientDateRange();

    // Fetch current month + last month in parallel
    const today = new Date();
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
    // Local-time formatting — toISOString() shifts the boundary day in UTC+ TZs.
    const _fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const lmFrom = _fmtLocal(lastMonthStart);
    const lmTo   = _fmtLocal(lastMonthEnd);

    const [cur, prev] = await Promise.all([
        fetch(`/api/clients/${clientId}/costs?date_from=${firstDay}&date_to=${todayStr}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/clients/${clientId}/costs?date_from=${lmFrom}&date_to=${lmTo}`).then(r => r.json()).catch(() => ({})),
    ]);

    const total      = cur.total || 0;
    const lastTotal  = prev.total || 0;
    const momChange  = lastTotal > 0 ? ((total - lastTotal) / lastTotal * 100) : 0;
    const trend      = cur.trend || [];
    const avgDaily   = trend.length ? total / trend.length : 0;
    const byService  = cur.by_service || [];
    const bySub      = cur.by_subscription || [];
    const maxSvc     = byService[0]?.cost || 1;
    const maxSub     = bySub[0]?.cost || 1;
    const momColor   = momChange > 0 ? 'var(--red,#c0392b)' : 'var(--green,#27ae60)';
    const momArrow   = momChange > 0 ? '▲' : '▼';
    const monthLabel = today.toLocaleString('default', { month: 'long', year: 'numeric' });
    const CLOUD_COLORS = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4' };

    // Build cloud breakdown from mappings + costs
    const cloudTotals = {};
    (client.mappings || []).forEach(m => {
        const c = m.cloud.toLowerCase();
        if (!cloudTotals[c]) cloudTotals[c] = 0;
    });
    // approximate per-cloud from by_subscription if available
    bySub.forEach(s => {
        const m = (client.mappings || []).find(mp => mp.value === s.subscription_id);
        if (m) {
            const c = m.cloud.toLowerCase();
            cloudTotals[c] = (cloudTotals[c] || 0) + s.cost;
        }
    });

    // Sparkline for trend
    const maxT = Math.max(...trend.map(t => t.cost), 1);
    const sparkPts = trend.map((t, i) => {
        const x = trend.length > 1 ? (i / (trend.length - 1)) * 120 : 60;
        const y = 22 - (t.cost / maxT) * 18;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    // Service bars
    const svcRows = byService.slice(0, 8).map((s, i) => {
        const barW = Math.max(3, Math.round((s.cost / maxSvc) * 100));
        const colors = ['#185FA5','#3A77B2','#5E8FC0','#80A7CE','#A3BFDB','#BACFE5'];
        const col = colors[Math.min(i, colors.length-1)];
        return `<div style="display:grid;grid-template-columns:1fr 90px 70px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-subtle,rgba(0,0,0,.04))">
            <span style="font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(s.name)}">${_esc(s.name)}</span>
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${barW}%;background:${col};border-radius:3px"></div>
            </div>
            <span style="font-size:12px;font-weight:500;text-align:right;color:var(--text-primary)">${_fmt$(s.cost)}</span>
        </div>`;
    }).join('');

    // Per-user / per-resource breakdown — only when explicitly mapped by resource/user
    // (e.g. Cursor by User); otherwise subscription-mapped clients dump raw resource IDs.
    const _hasResMap = (client.mappings || []).some(m => m.filter_type === 'resource_name');
    const byResource = _hasResMap
        ? (cur.by_resource || []).slice().sort((a,b) => (b.ondemand ?? b.cost) - (a.ondemand ?? a.cost))
        : [];
    const maxRes = (byResource[0]?.ondemand ?? byResource[0]?.cost) || 1;
    const resRows = byResource.slice(0, 50).map((s) => {
        const _v = s.ondemand ?? s.cost;
        const _free = s.free_usage || 0;
        const _freeDisp = _free > 20 ? '$20+' : _fmt$(_free);
        const barW = Math.max(3, Math.round((_v / maxRes) * 100));
        return `<div style="display:grid;grid-template-columns:1fr 90px 70px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-subtle,rgba(0,0,0,.04))">
            <span style="font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(s.name)}">${_esc(s.name)}</span>
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${barW}%;background:#10a37f;border-radius:3px"></div>
            </div>
            <span style="font-size:12px;font-weight:500;text-align:right;color:var(--text-primary)" title="${s.included!=null?('Included '+_fmt$(s.included_usage||0)+' · Free '+_freeDisp+' · On-Demand '+_fmt$(s.ondemand||0)):''}">${_fmt$(_v)}</span>
        </div>`;
    }).join('');

    // Group by the real cloud_provider from the data (cur.by_cloud), not inferred
    // from subscription mappings (which mislabels User/Service-mapped clouds as azure).
    const cloudGrouped = {};
    const CLOUD_FULL = { azure: 'Microsoft Azure', aws: 'Amazon AWS', gcp: 'Google Cloud', openai: 'OpenAI', atlassian: 'Atlassian', cursor: 'Cursor' };
    (cur.by_cloud || []).forEach(c => { cloudGrouped[c.cloud] = (cloudGrouped[c.cloud] || 0) + c.cost; });
    if (!Object.keys(cloudGrouped).length) {
        bySub.forEach(s => {
            const m = (client.mappings || []).find(mp => mp.filter_type === 'subscription_id' && mp.value === s.subscription_id);
            const cloud = (m?.cloud || 'azure').toLowerCase();
            cloudGrouped[cloud] = (cloudGrouped[cloud] || 0) + s.cost;
        });
    }
    const cloudGroupedArr = Object.entries(cloudGrouped).sort((a,b) => b[1]-a[1]);
    const maxSubCloud = cloudGroupedArr[0]?.[1] || 1;
    const subRows = cloudGroupedArr.map(([cloud, cost], i) => {
        const barW = Math.max(3, Math.round((cost / maxSubCloud) * 100));
        const col   = CLOUD_COLORS[cloud] || '#888';
        const label = CLOUD_FULL[cloud] || cloud.toUpperCase();
        return `<div style="display:grid;grid-template-columns:1fr 90px 70px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-subtle,rgba(0,0,0,.04))">
            <div style="display:flex;align-items:center;gap:6px;overflow:hidden">
                <span style="font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;background:${col}22;color:${col};flex-shrink:0">${cloud.toUpperCase().slice(0,3)}</span>
                <span style="font-size:12px;color:var(--text-primary)">${_esc(label)}</span>
            </div>
            <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${barW}%;background:${col};border-radius:3px"></div>
            </div>
            <span style="font-size:12px;font-weight:500;text-align:right;color:var(--text-primary)">${_fmt$(cost)}</span>
        </div>`;
    }).join('');

    // Trend bars (last 14 days)
    const recent14 = trend.slice(-14);
    const maxBar = Math.max(...recent14.map(t => t.cost), 1);
    const trendBars = recent14.map(t => {
        const h = Math.max(4, Math.round((t.cost / maxBar) * 52));
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
            <span style="font-size:9px;color:var(--text-secondary);white-space:nowrap">${_fmt$(t.cost).replace('$','')}</span>
            <div style="width:100%;background:var(--accent);border-radius:2px 2px 0 0;height:${h}px;min-height:4px;opacity:.8"></div>
            <span style="font-size:9px;color:var(--text-secondary);white-space:nowrap">${t.date?.slice(5) || ''}</span>
        </div>`;
    }).join('');

    const mappingTags = (client.mappings || []).map(m => {
        const ftLabel = m.filter_type === 'subscription_id' ? 'Sub' : m.filter_type === 'service_name' ? 'Svc' : 'RG';
        return `<span style="font-size:11px;padding:2px 7px;border-radius:4px;background:var(--accent-subtle,rgba(79,110,247,.1));color:var(--accent)">${m.cloud.toUpperCase()} · ${ftLabel}: ${_esc(m.value)}</span>`;
    }).join('');

    panel.innerHTML = `
    <!-- Client header -->
    <div class="db-card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
            <div>
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Client Report · ${_esc(monthLabel)}</div>
                <div style="font-size:22px;font-weight:600;color:var(--text-primary);letter-spacing:-.02em">${_esc(client.name)}</div>
            </div>
            <div style="display:flex;gap:8px">
                <button class="cp-btn-secondary" onclick="openClientForm(${client.id})" style="font-size:12px">
                    <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin-right:4px"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit
                </button>
            </div>
        </div>
    </div>

    <!-- KPI strip -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px">
        <div class="db-kpi-tile">
            <div class="db-kpi-label">This Month</div>
            <div class="db-kpi-value-row">
                <span class="db-kpi-value">${_fmt$(total)}</span>
            </div>
            <svg class="db-sparkline" viewBox="0 0 120 24" preserveAspectRatio="none">
                ${sparkPts ? `<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${sparkPts}"/>` : ''}
            </svg>
            <div class="db-kpi-sub" style="color:${momColor}">${momArrow} ${Math.abs(momChange).toFixed(1)}% vs last month</div>
        </div>
        <div class="db-kpi-tile">
            <div class="db-kpi-label">Last Month</div>
            <div class="db-kpi-value-row"><span class="db-kpi-value">${_fmt$(lastTotal)}</span></div>
            <div class="db-kpi-sub">Reference period</div>
        </div>
        <div class="db-kpi-tile">
            <div class="db-kpi-label">Avg / Day</div>
            <div class="db-kpi-value-row"><span class="db-kpi-value">${_fmt$(avgDaily)}</span></div>
            <div class="db-kpi-sub">Based on ${trend.length} day${trend.length!==1?'s':''} with data</div>
        </div>

    <!-- Top Services full width -->
    <div class="db-card" style="margin-bottom:14px">
        <div class="db-card-hdr"><span class="db-card-title">Top Services</span><span class="db-card-period">This month</span></div>
        ${byService.length ? svcRows : '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">No service data</div>'}
    </div>

    <!-- By Cloud full width -->
    <div class="db-card" style="margin-bottom:14px">
        <div class="db-card-hdr"><span class="db-card-title">By Cloud Provider</span><span class="db-card-period">This month</span></div>
        ${cloudGroupedArr.length ? subRows : '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:12px">No data</div>'}
    </div>

    ${byResource.length ? `
    <!-- By User / Resource -->
    <div class="db-card" style="margin-bottom:14px">
        <div class="db-card-hdr"><span class="db-card-title">By User / Resource</span><span class="db-card-period">This month</span></div>
        ${resRows}
    </div>` : ''}

    `;
}

function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openClientForm(clientId) {
    const wrap = document.getElementById('clientFormWrap');
    const titleEl = document.getElementById('clientFormTitle');
    const nameEl = document.getElementById('clientName');
    const editIdEl = document.getElementById('clientEditId');
    if (!wrap) return;

    if (clientId) {
        const client = _clientsData.find(c => c.id === clientId);
        if (!client) return;
        titleEl.textContent = 'Edit Client';
        nameEl.value = client.name;
        editIdEl.value = clientId;
        _renderMappingRows(client.mappings || []);
    } else {
        titleEl.textContent = 'New Client';
        nameEl.value = '';
        editIdEl.value = '';
        _renderMappingRows([]);
    }
    wrap.style.display = '';
    nameEl.focus();
}

function closeClientForm() {
    const wrap = document.getElementById('clientFormWrap');
    if (wrap) wrap.style.display = 'none';
}

function _renderMappingRows(mappings) {
    const container = document.getElementById('clientMappingRows');
    if (!container) return;
    container.innerHTML = '';
    if (!mappings.length) {
        addClientMappingRow();
        return;
    }
    // Group by cloud + filter_type so multiple values show as one multi-select row
    const grouped = {};
    mappings.forEach(m => {
        const key = `${m.cloud}||${m.filter_type}`;
        if (!grouped[key]) grouped[key] = { cloud: m.cloud, filter_type: m.filter_type, _values: [] };
        grouped[key]._values.push(m.value);
    });
    Object.values(grouped).forEach(g => addClientMappingRow(g));
}

// Labels per cloud + filter_type
const CLIENT_FILTER_LABELS = {
    azure: {
        subscription_id: 'Subscription',
        resource_group:  'Resource Group',
        service_name:    'Service',
    },
    aws: {
        subscription_id: 'AWS Account',
        resource_group:  'Region / Group',
        service_name:    'Service (EC2, RDS…)',
    },
    gcp: {
        subscription_id: 'Project',
        resource_group:  'Region / Group',
        service_name:    'Service',
    },
};

let _cmDlCounter = 0; // unique datalist IDs

function addClientMappingRow(data) {
    const container = document.getElementById('clientMappingRows');
    if (!container) return;

    // Support array of saved values (for grouping same cloud+filter_type rows)
    const cloud     = data?.cloud || 'azure';
    const ft        = data?.filter_type || 'resource_group';
    const savedVals = Array.isArray(data?._values) ? data._values : (data?.value ? [data.value] : []);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;flex-wrap:nowrap';

    // Cloud options come from the tenant's actual clouds (activeClouds), so any
    // connected provider (incl. OpenAI/Atlassian/Cursor) is mappable to a client.
    const _cloudOpts = activeClouds().map(c =>
        `<option value="${c}" ${cloud===c?'selected':''}>${CLOUD_META[c].label}</option>`).join('');
    // Filter-type labels follow each provider's real cost dimensions (e.g. Cursor's
    // "resource group" is Role; OpenAI's "subscription" is the API key).
    const _ftLabels = (cl) => {
        const g = (CLOUD_META[cl] && CLOUD_META[cl].groupLabel) || {};
        return { subscription_id: g.sub || 'Subscription / Account',
                 resource_group:  g.rg  || 'Resource Group / Region',
                 service_name:    g.service || 'Service',
                 resource_name:   g.resource || 'Resource / User' };
    };
    const _ftL = _ftLabels(cloud);
    row.innerHTML = `
        <select class="filter-input cm-cloud" style="width:110px;font-size:12px;height:32px;flex-shrink:0">
            ${_cloudOpts}
        </select>
        <select class="filter-input cm-filter-type" style="width:160px;font-size:12px;height:32px;flex-shrink:0">
            <option value="subscription_id" ${ft==='subscription_id'?'selected':''}>${_ftL.subscription_id}</option>
            <option value="resource_group"  ${ft==='resource_group' ?'selected':''}>${_ftL.resource_group}</option>
            <option value="service_name"    ${ft==='service_name'   ?'selected':''}>${_ftL.service_name}</option>
            <option value="resource_name"   ${ft==='resource_name'  ?'selected':''}>${_ftL.resource_name}</option>
        </select>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0">
            <div class="cm-multiselect-wrap" style="position:relative">
                <div class="cm-trigger filter-input" style="font-size:12px;min-height:32px;padding:4px 28px 4px 8px;cursor:pointer;display:flex;flex-wrap:wrap;gap:3px;align-items:center"
                     onclick="toggleCmDropdown(this)">
                    <span class="cm-placeholder" style="color:var(--text-secondary);font-size:12px">— Loading… —</span>
                </div>
                <svg style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6,9 12,15 18,9"/></svg>
                <div class="cm-dropdown" style="display:none;position:fixed;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;z-index:99999;max-height:280px;overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.25)">
                    <div style="padding:6px 8px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg-card);z-index:1">
                        <input type="text" class="cm-search" placeholder="Search…" style="width:100%;font-size:11px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;background:var(--bg)" oninput="filterCmOptions(this)">
                    </div>
                    <div class="cm-options" style="padding:4px"></div>
                    <div style="padding:6px 8px;border-top:1px solid var(--border)">
                        <input type="text" class="cm-custom-input filter-input" placeholder="+ Type custom value…" style="width:100%;font-size:11px"
                               onkeydown="if(event.key==='Enter'){addCmCustomValue(this);event.preventDefault()}">
                    </div>
                </div>
            </div>
        </div>
        <button class="btn-mini" style="color:var(--red);flex-shrink:0;margin-top:8px" onclick="this.closest('div[style]').remove()" title="Remove">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;

    container.appendChild(row);

    const cloudSel = row.querySelector('.cm-cloud');
    const ftSel    = row.querySelector('.cm-filter-type');

    async function loadOptions() {
        const c = cloudSel.value;
        const f = ftSel.value;
        const optionsEl = row.querySelector('.cm-options');
        const trigger   = row.querySelector('.cm-trigger');
        optionsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-secondary)">Loading…</div>';
        updateCmTrigger(trigger, []);
        try {
            const items = await fetch(`/api/clients/filter-values?cloud=${c}&filter_type=${f}`).then(r => r.json());
            renderCmOptions(row, items, savedVals);
        } catch(e) {
            optionsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--red)">Failed to load</div>';
        }
    }

    cloudSel.addEventListener('change', () => {
        const L = _ftLabels(cloudSel.value);
        if (ftSel.options.length >= 4) {
            ftSel.options[0].text = L.subscription_id;
            ftSel.options[1].text = L.resource_group;
            ftSel.options[2].text = L.service_name;
            ftSel.options[3].text = L.resource_name;
        }
        loadOptions();
    });
    ftSel.addEventListener('change', loadOptions);
    loadOptions();
}

function renderCmOptions(row, items, selectedVals) {
    const optionsEl = row.querySelector('.cm-options');
    const trigger   = row.querySelector('.cm-trigger');
    if (!items.length) {
        optionsEl.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-secondary)">No data yet</div>';
    } else {
        optionsEl.innerHTML = items.map(i => {
            const display = i.label && i.label !== i.value ? `${i.label} (${i.value})` : i.value;
            const checked = selectedVals.includes(i.value);
            return `<label style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;cursor:pointer;border-radius:4px;color:var(--text-primary)" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background=''">
                <input type="checkbox" value="${_esc(i.value)}" ${checked ? 'checked' : ''} onchange="updateCmTrigger(this.closest('.cm-multiselect-wrap').querySelector('.cm-trigger'))">
                <span title="${_esc(i.value)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(display)}</span>
            </label>`;
        }).join('');
    }
    updateCmTrigger(trigger, selectedVals);
}

function updateCmTrigger(trigger, preselected) {
    if (!trigger) return;
    const boxes = trigger.closest('.cm-multiselect-wrap')?.querySelectorAll('.cm-options input[type=checkbox]:checked') || [];
    const selected = preselected && boxes.length === 0 ? preselected
        : [...boxes].map(b => b.value);
    const ph = trigger.querySelector('.cm-placeholder');
    if (selected.length === 0) {
        trigger.innerHTML = `<span class="cm-placeholder" style="color:var(--text-secondary);font-size:12px">— Select —</span>`;
    } else {
        trigger.innerHTML = selected.map(v =>
            `<span style="background:var(--accent);color:#fff;border-radius:3px;padding:1px 6px;font-size:11px;white-space:nowrap">${_esc(v)}</span>`
        ).join('') + '<span class="cm-placeholder" style="display:none"></span>';
    }
}

function toggleCmDropdown(trigger) {
    const wrap = trigger.closest('.cm-multiselect-wrap');
    const dd   = wrap.querySelector('.cm-dropdown');
    const isOpen = dd.style.display !== 'none';
    // Close all other dropdowns
    document.querySelectorAll('.cm-dropdown').forEach(d => d.style.display = 'none');
    dd.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        // position:fixed so the dropdown escapes any card/overflow clipping; place it
        // under the trigger, flipping above if there isn't room below.
        const r = trigger.getBoundingClientRect();
        const vh = window.innerHeight;
        const spaceBelow = vh - r.bottom;
        dd.style.width = r.width + 'px';
        dd.style.left  = r.left + 'px';
        if (spaceBelow < 200 && r.top > spaceBelow) {
            dd.style.top = '';
            dd.style.bottom = (vh - r.top + 2) + 'px';
            dd.style.maxHeight = Math.min(280, r.top - 12) + 'px';
        } else {
            dd.style.bottom = '';
            dd.style.top = (r.bottom + 2) + 'px';
            dd.style.maxHeight = Math.min(280, spaceBelow - 12) + 'px';
        }
        dd.scrollTop = 0;  // always open at the top of the list
        wrap.querySelector('.cm-search')?.focus({ preventScroll: true });
    }
}

function filterCmOptions(input) {
    const q = input.value.toLowerCase();
    input.closest('.cm-dropdown').querySelectorAll('.cm-options label').forEach(l => {
        l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

function addCmCustomValue(input) {
    const val = input.value.trim();
    if (!val) return;
    const wrap   = input.closest('.cm-multiselect-wrap');
    const opts   = wrap.querySelector('.cm-options');
    const trigger = wrap.querySelector('.cm-trigger');
    // Add checkbox option
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;cursor:pointer;border-radius:4px;color:var(--text-primary)';
    label.innerHTML = `<input type="checkbox" value="${_esc(val)}" checked onchange="updateCmTrigger(this.closest('.cm-multiselect-wrap').querySelector('.cm-trigger'))">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(val)}</span>`;
    opts.appendChild(label);
    input.value = '';
    updateCmTrigger(trigger);
}

// Close dropdowns when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('.cm-multiselect-wrap')) {
        document.querySelectorAll('.cm-dropdown').forEach(d => {
            d.style.display = 'none';
            // Update trigger when closing
            const wrap    = d.closest('.cm-multiselect-wrap');
            const trigger = wrap?.querySelector('.cm-trigger');
            if (trigger) updateCmTrigger(trigger);
        });
    }
});

async function saveClient() {
    const nameEl = document.getElementById('clientName');
    const editIdEl = document.getElementById('clientEditId');
    const name = (nameEl?.value || '').trim();
    if (!name) { showToast('Client name is required', 'error'); return; }

    const mappings = [];
    document.querySelectorAll('#clientMappingRows > div[style]').forEach(row => {
        const cloud      = row.querySelector('.cm-cloud')?.value || 'azure';
        const filterType = row.querySelector('.cm-filter-type')?.value || '';
        if (!filterType) return;
        // Collect all checked values from multi-select
        const checked = [...row.querySelectorAll('.cm-options input[type=checkbox]:checked')]
            .map(cb => cb.value.trim()).filter(Boolean);
        // Also check custom input
        const custom = (row.querySelector('.cm-custom-input')?.value || '').trim();
        const allVals = checked.length ? checked : (custom ? [custom] : []);
        allVals.forEach(value => {
            if (value) mappings.push({ cloud, filter_type: filterType, value });
        });
    });

    const editId = editIdEl?.value;
    const url = editId ? `/api/clients/${editId}` : '/api/clients';
    const method = editId ? 'PUT' : 'POST';

    try {
        const resp = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mappings })
        });
        if (!resp.ok) { const e = await resp.json(); showToast(e.error || 'Save failed', 'error'); return; }
        showToast(`Client "${name}" ${editId ? 'updated' : 'created'}`, 'success');
        closeClientForm();
        loadClientsPage();
        populateClientDropdowns();
    } catch(e) {
        showToast('Save failed: ' + e.message, 'error');
    }
}

async function deleteClientById(id, name) {
    if (!confirm(`Delete client "${name}"? This cannot be undone.`)) return;
    try {
        const resp = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
        if (!resp.ok) { showToast('Delete failed', 'error'); return; }
        showToast(`Client "${name}" deleted`, 'success');
        loadClientsPage();
        populateClientDropdowns();
    } catch(e) {
        showToast('Delete failed: ' + e.message, 'error');
    }
}

// ─── Other Costs (manually-added tools/subscriptions) ───────────────────────

const MC_CUR_SYMBOLS = { USD:'$', INR:'₹', EUR:'€', GBP:'£', AUD:'A$', CAD:'C$', SGD:'S$', AED:'AED ', JPY:'¥' };
function _mcSymbol(code) { return MC_CUR_SYMBOLS[(code || 'USD').toUpperCase()] || ((code || '') + ' '); }
function _mcMoney(v, sym) { return sym + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

let _mcData = null;
let _mcCategories = null;

async function _populateMcClientFilter() {
    try {
        const clients = await fetch('/api/clients').then(r => r.json());
        const filterEl = document.getElementById('mcClientFilter');
        const formEl = document.getElementById('mcClient');
        const opts = clients.map(c => `<option value="${c.id}">${_esc(c.name)}</option>`).join('');
        if (filterEl) {
            const cur = filterEl.value;
            filterEl.innerHTML = `<option value="">All Clients</option><option value="none">General / Unassigned</option>` + opts;
            filterEl.value = cur;
        }
        if (formEl) formEl.innerHTML = `<option value="">General / Unassigned</option>` + opts;
    } catch (e) { /* keep existing options */ }
}

async function _populateMcCategories() {
    if (_mcCategories) return _mcCategories;
    try {
        _mcCategories = await fetch('/api/manual-costs/categories').then(r => r.json());
    } catch (e) {
        _mcCategories = ['Other'];
    }
    const sel = document.getElementById('mcCategory');
    if (sel) sel.innerHTML = _mcCategories.map(c => `<option value="${_esc(c)}">${_esc(c)}</option>`).join('');
    return _mcCategories;
}

async function loadOtherCostsPage() {
    const monthEl = document.getElementById('mcMonth');
    if (monthEl && !monthEl.value) {
        const now = new Date();
        monthEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    await _populateMcClientFilter();
    await _populateMcCategories();

    const month = monthEl ? monthEl.value : '';
    const clientId = document.getElementById('mcClientFilter')?.value || '';
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (clientId) params.set('client_id', clientId);

    const tbody = document.getElementById('mcTableBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-secondary)">Loading…</td></tr>`;
    try {
        _mcData = await fetch(`/api/manual-costs?${params}`).then(r => r.json());
        _renderOtherCosts(_mcData);
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--red)">Failed to load.</td></tr>`;
    }
}

function _renderOtherCosts(data) {
    const sym = data.symbol || curSym();
    const totalEl = document.getElementById('mcTotal');
    const countEl = document.getElementById('mcCount');
    const catEl = document.getElementById('mcByCategory');
    if (totalEl) totalEl.textContent = _mcMoney(data.total, sym);
    if (countEl) countEl.textContent = data.items.length;

    if (catEl) {
        if (!data.by_category.length) {
            catEl.innerHTML = `<div style="font-size:12px;color:var(--text-secondary)">No data yet</div>`;
        } else {
            const max = data.by_category[0].cost || 1;
            catEl.innerHTML = data.by_category.map(c => `
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:12px;color:var(--text-primary);min-width:200px">${_esc(c.category)}</span>
                    <div style="flex:1;background:var(--bg-input,#eee);border-radius:4px;height:8px;overflow:hidden">
                        <div style="height:100%;width:${Math.max(3, c.cost / max * 100)}%;background:var(--accent)"></div>
                    </div>
                    <span style="font-size:12px;font-weight:500;color:var(--text-primary);min-width:90px;text-align:right">${_mcMoney(c.cost, sym)}</span>
                </div>`).join('');
        }
    }

    const tbody = document.getElementById('mcTableBody');
    if (!tbody) return;
    if (!data.items.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-secondary)">No other costs for this month. Click <strong>+ Add Cost</strong> to add one.</td></tr>`;
        return;
    }
    tbody.innerHTML = data.items.map(it => `
        <tr>
            <td>${_esc(it.client_name || 'General')}</td>
            <td>${_esc(it.item_name)}</td>
            <td>${_esc(it.category)}</td>
            <td style="text-align:right;white-space:nowrap">${_mcMoney(it.amount, _mcSymbol(it.currency))} <span style="color:var(--text-secondary);font-size:11px">${it.currency}</span></td>
            <td style="text-align:right;white-space:nowrap">${_mcMoney(it.amount_converted, sym)}</td>
            <td>${it.recurring ? '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--accent-subtle,rgba(79,110,247,.12));color:var(--accent)">Monthly</span>' : ''}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${_esc(it.notes || '')}</td>
            <td>
                <div style="display:flex;gap:4px">
                    <button class="btn-mini" onclick="openManualCostForm(${it.id})" title="Edit">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn-mini" onclick="deleteManualCost(${it.id})" title="Delete" style="color:var(--red)">
                        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                    </button>
                </div>
            </td>
        </tr>`).join('');
}

async function openManualCostForm(id) {
    await _populateMcClientFilter();
    await _populateMcCategories();

    document.getElementById('mcEditId').value = id || '';
    document.getElementById('mcFormTitle').textContent = id ? 'Edit Other Cost' : 'Add Other Cost';

    if (id) {
        const item = (_mcData?.items || []).find(i => i.id === id);
        if (item) {
            document.getElementById('mcClient').value = item.client_id || '';
            document.getElementById('mcCategory').value = item.category;
            document.getElementById('mcItemName').value = item.item_name;
            document.getElementById('mcAmount').value = item.amount;
            document.getElementById('mcCurrency').value = item.currency;
            document.getElementById('mcFormMonth').value = (item.cost_month || '').slice(0, 7);
            document.getElementById('mcRecurring').checked = !!item.recurring;
            document.getElementById('mcNotes').value = item.notes || '';
        }
    } else {
        const filterClient = document.getElementById('mcClientFilter')?.value || '';
        document.getElementById('mcClient').value = (filterClient && filterClient !== 'none') ? filterClient : '';
        document.getElementById('mcItemName').value = '';
        document.getElementById('mcAmount').value = '';
        document.getElementById('mcCurrency').value = (window.TENANT_CUR && window.TENANT_CUR.code) || 'USD';
        document.getElementById('mcFormMonth').value = document.getElementById('mcMonth')?.value || '';
        document.getElementById('mcRecurring').checked = false;
        document.getElementById('mcNotes').value = '';
        if (_mcCategories && _mcCategories.length) document.getElementById('mcCategory').value = _mcCategories[0];
    }

    document.getElementById('mcFormModal').style.display = 'flex';
}

function closeManualCostForm() {
    document.getElementById('mcFormModal').style.display = 'none';
}

async function saveManualCost() {
    const id = document.getElementById('mcEditId').value;
    const body = {
        client_id: document.getElementById('mcClient').value || null,
        item_name: document.getElementById('mcItemName').value.trim(),
        category: document.getElementById('mcCategory').value,
        amount: parseFloat(document.getElementById('mcAmount').value) || 0,
        currency: document.getElementById('mcCurrency').value,
        cost_month: document.getElementById('mcFormMonth').value,
        recurring: document.getElementById('mcRecurring').checked,
        notes: document.getElementById('mcNotes').value.trim(),
    };
    if (!body.item_name || !body.cost_month) {
        showToast('Item name and month are required', 'error');
        return;
    }
    try {
        const resp = await fetch(id ? `/api/manual-costs/${id}` : '/api/manual-costs', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) { showToast(data.error || 'Save failed', 'error'); return; }
        showToast('Saved', 'success');
        closeManualCostForm();
        loadOtherCostsPage();
    } catch (e) {
        showToast('Save failed: ' + e.message, 'error');
    }
}

async function deleteManualCost(id) {
    if (!confirm('Delete this cost item?')) return;
    try {
        const resp = await fetch(`/api/manual-costs/${id}`, { method: 'DELETE' });
        if (!resp.ok) { showToast('Delete failed', 'error'); return; }
        showToast('Deleted', 'success');
        loadOtherCostsPage();
    } catch (e) {
        showToast('Delete failed: ' + e.message, 'error');
    }
}

