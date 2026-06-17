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
};
const CLOUD_META = {
    azure:  { icon: '⊞', logo: CLOUD_LOGOS.azure,  label: 'Azure',  color: '#0078d4', groupLabel: { sub: 'Subscription', rg: 'Resource Group', service: 'Service' } },
    aws:    { icon: '⚙', logo: CLOUD_LOGOS.aws,    label: 'AWS',    color: '#ff9900', groupLabel: { sub: 'Account',      rg: 'Region',         service: 'Service' } },
    gcp:    { icon: '◉', logo: CLOUD_LOGOS.gcp,    label: 'GCP',    color: '#4285f4', groupLabel: { sub: 'Project',      rg: 'Project',        service: 'Service' } },
    openai: { icon: '◈', logo: CLOUD_LOGOS.openai, label: 'OpenAI', color: '#10a37f', groupLabel: { sub: 'Org',          rg: 'Model',          service: 'AI API'   } },
};
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
    if (page === 'rgroups') loadResourceGroups();
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
        // Pre-select the cloud if arriving from a cloud card (setCloudFilter sets selectedCloud)
        if (selectedCloud) {
            costsSelectedCloud = selectedCloud;
            document.querySelectorAll('[data-costs-cloud]').forEach(b =>
                b.classList.toggle('active', b.dataset.costsCloud === selectedCloud));
            _updateCostsCloudFilters(selectedCloud);
        } else {
            // Reset to All when navigating directly
            costsSelectedCloud = '';
            document.querySelectorAll('[data-costs-cloud]').forEach(b =>
                b.classList.toggle('active', b.dataset.costsCloud === ''));
            _updateCostsCloudFilters('');
        }
        loadCostsTable();
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
                        y: { grid: { color: gridColor }, ticks: { color: txtColor, font: { size: 11 }, callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0)+'k' : v) } }
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

        // Cloud Donut
        const cVals   = [kpi.azure||0, kpi.aws||0, kpi.gcp||0];
        const cLabels = ['Azure','AWS','GCP'];
        const cColors = ['#0089D6','#FF9900','#34A853'];
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

    // 2. Load per-provider dashboard data in parallel
    const results = await Promise.all(
        ['azure', 'aws', 'gcp'].map(async (cloud) => {
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
    const cloudColor   = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4' };
    const sparkStroke  = { azure: 'var(--chart-1,#185FA5)', aws: 'var(--chart-3,#BA7517)', gcp: 'var(--chart-2,#1D9E75)' };
    const cloudFull    = { azure: 'Microsoft Azure', aws: 'Amazon Web Services', gcp: 'Google Cloud' };
    const logoH        = { azure: '16', aws: '13', gcp: '16' };

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

    ['aws', 'azure', 'gcp'].forEach(cloud => {
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
        const topSubs = subs.slice(0, 3);
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
                        <div class="co-rank-bar"><div class="co-rank-bar__fill" style="width:${Math.round(s.cost/maxSub*100)}%;background:${clr};opacity:${1-i*0.25}"></div></div>
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

    // Fetch monthly data per provider
    const colors6 = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4' };
    const datasets = [];

    await Promise.all(['azure','aws','gcp'].map(async (cloud) => {
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
                datasets.push({ label: PROVIDER_META[cloud].label, data: vals, borderColor: colors6[cloud], backgroundColor: colors6[cloud]+'33', fill: true, tension: 0.3, pointRadius: 4 });
            }
        } catch(e) { /* skip */ }
    }));

    if (!datasets.length) return;
    renderChart('coTrendChart', 'line', {
        labels: months.map(m => m.label),
        datasets
    }, 'Monthly Spend', { scales: { y: { ticks: { callback: v => '$'+v.toLocaleString() } } } });
}

// ─── Costs Table ─────────────────────────────────────────────────────────
let costsSelectedCloud = '';
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
let cdAccOptions = [];   // {id, label}[]
let cdRgSelected  = new Set();
let cdSvcSelected = new Set();
let cdAccSelected = new Set(); // stores provider_ids

const CD_MS = {
    rg:  { panel: 'cdRgPanel',  list: 'cdRgList',  search: 'cdRgSearch',  trigger: 'cdRgTriggerText'  },
    svc: { panel: 'cdSvcPanel', list: 'cdSvcList', search: 'cdSvcSearch', trigger: 'cdSvcTriggerText' },
    acc: { panel: 'cdAccPanel', list: 'cdAccList', search: 'cdAccSearch', trigger: 'cdAccTriggerText' },
};

function cdOpts(key) { return key === 'rg' ? cdRgOptions : key === 'svc' ? cdSvcOptions : cdAccOptions; }
function cdSel(key)  { return key === 'rg' ? cdRgSelected : key === 'svc' ? cdSvcSelected : cdAccSelected; }

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
    const items = key === 'acc' ? opts : opts.map(o => ({ id: o, label: o === '__BLANK__' ? '(Blank)' : o }));
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
        el.textContent = opt ? opt.label : (v === '__BLANK__' ? '(Blank)' : v);
        el.className = 'multiselect__summary';
    } else {
        el.textContent = `${sel.size} selected`; el.className = 'multiselect__summary';
    }
}

function populateCdMultiselect(key, options) {
    const newOpts = ['__BLANK__', ...options];
    if (key === 'rg') cdRgOptions = newOpts;
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
    document.querySelectorAll('[data-costs-cloud]').forEach(b => b.classList.toggle('active', b.dataset.costsCloud === ''));
    costsSelectedCloud = '';
    cdRgSelected.clear();  cdUpdateTrigger('rg');
    cdSvcSelected.clear(); cdUpdateTrigger('svc');
    cdAccSelected.clear(); cdUpdateTrigger('acc');
    _updateCostsCloudFilters('');
    const costsClient = document.getElementById('costsClientFilter');
    if (costsClient) costsClient.value = '';
    costPageOffset = 0;
    loadCostsTable();
}

// Close CD panels when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('#cdRgMultiselect'))  document.getElementById('cdRgPanel')?.setAttribute('hidden', '');
    if (!e.target.closest('#cdSvcMultiselect')) document.getElementById('cdSvcPanel')?.setAttribute('hidden', '');
    if (!e.target.closest('#cdAccMultiselect')) document.getElementById('cdAccPanel')?.setAttribute('hidden', '');
});

function getMultiSelectValues(id) {
    const sel = document.getElementById(id);
    if (!sel) return [];
    return Array.from(sel.selectedOptions || []).map(o => o.value).filter(v => v !== '');
}

function setCostsCloud(btn, cloud) {
    costsSelectedCloud = cloud;
    costPageOffset = 0;
    document.querySelectorAll('[data-costs-cloud]').forEach(b => b.classList.toggle('active', b.dataset.costsCloud === cloud));
    _updateCostsCloudFilters(cloud);
    loadCostsTable();
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

    // AWS: hide Group By only; RG multiselect stays visible (shows regions for AWS)
    if (groupByWrap) groupByWrap.style.display = isAws ? 'none' : '';
    if (rgWrap)      rgWrap.style.display      = '';

    // AWS defaults to line-item view so service/resource filters work; Azure/All uses resource_group
    const groupByEl = document.getElementById('costGroupBy');
    if (groupByEl) groupByEl.value = isAws ? 'resource' : 'resource_group';
    if (resTypeWrap) resTypeWrap.style.display  = isAws ? '' : 'none';

    if (accountLabelEl) accountLabelEl.textContent = cloud ? subLabel(cloud) : 'Account / Subscription';

    const subs = await fetch('/api/subscriptions').then(r => r.json()).catch(() => []);
    const filtered = cloud ? subs.filter(s => (s.cloud || 'azure').toLowerCase() === cloud) : subs;
    populateCdAccounts(filtered);

    if (rgLabelEl)    rgLabelEl.textContent    = lbl;
    if (rgColLabelEl) rgColLabelEl.textContent = lbl || 'RG / Region / Project';
}

async function loadCostsTable() {
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
    const cloudHeader = document.getElementById('costCloudHeader');
    const rgHeader = document.getElementById('costRGHeader');
    const serviceHeader = document.getElementById('costServiceHeader');
    const resourceHeader = document.getElementById('costResourceHeader');
    const subscriptionHeader = document.getElementById('costSubscriptionHeader');
    if (serviceHeader) serviceHeader.style.display = isRgGroup ? 'none' : '';
    if (resourceHeader) resourceHeader.style.display = isRgGroup ? 'none' : '';
    if (subscriptionHeader) {
        subscriptionHeader.style.display = isRgGroup ? '' : 'none';
        const subHdrText = costsSelectedCloud ? (subLabel(costsSelectedCloud) || 'Account') : 'Subscription';
        subscriptionHeader.innerHTML = `${subHdrText} <span id="sort-subscription_id" class="sort-indicator">↕</span>`;
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
    if (costGroupBy && costGroupBy !== 'resource') params.set('group_by', costGroupBy);
    if (rg.length) params.set('resource_groups', rg.join(','));
    if (services.length) params.set('service_names', services.join(','));
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
        const showServiceBreakdown = costsSelectedCloud === 'aws' && accSelected.length > 0;
        const subTableUrl = showServiceBreakdown
            ? `/api/costs/total-by-service?${paramsBySub}`
            : `/api/costs/total-by-subscription?${paramsBySub}`;

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

        const cloudLogoH = { azure: '12', aws: '10', gcp: '12' };
        const cloudNames = { azure: 'Azure', aws: 'AWS', gcp: 'GCP' };
        const subNameMap = {};
        (totalsBySub || []).forEach(s => { subNameMap[s.subscription_id] = s.subscription_name || s.subscription_id; });
        if (!sortedData.length) {
          const hasFilter = (document.getElementById('costSearch')?.value || '') ||
            (document.getElementById('costDateFrom')?.value || '') ||
            costsSelectedCloud;
          tbody.innerHTML = `<tr><td colspan="${isRgGroup ? 5 : 6}" style="padding:0;border:none">` +
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
                const resourceDisplay = vmName
                    ? `<span style="font-weight:500">${vmName}</span><br><span style="font-size:11px;color:var(--text-tertiary)">${prettyResourceName}</span>`
                    : (prettyResourceName || '-');
                const resourceTitle = vmName ? `${vmName} (${prettyResourceName})` : (prettyResourceName || '');
                const rawDate = (r.date || '').toString();
                const dateOnly = granularity === 'monthly' ? rawDate.slice(0, 7) : rawDate.split('T')[0];
                const rgCell = `<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${r.resource_group||''}">${r.resource_group || '-'}</td>`;
                const middleCells = isRgGroup
                    ? `<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${subNameMap[r.subscription_id]||''}">${subNameMap[r.subscription_id] || '-'}</td>${rgCell}`
                    : `${rgCell}<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)" title="${r.service_name||''}">${r.service_name || '-'}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${resourceTitle}" data-sub="${r.subscription_id||''}" data-rg="${r.resource_group||''}" data-name="${r.resource_name||''}" onclick="showResourceConfig(this.getAttribute('data-sub'), this.getAttribute('data-rg'), this.getAttribute('data-name'))"><span class="res-link">${resourceDisplay}</span></td>`;
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
        if (subtitleBar && costPageTotal > 0) {
            subtitleBar.textContent = `Showing ${from}–${to} of ${costPageTotal.toLocaleString()} records · ${curSym()}${(totals.total_cost || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})} filtered total`;
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
    } catch (err) {
        console.error('Costs load error:', err);
    }
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
            const cloudColors = { azure: '#0078d4', aws: '#ff9900', gcp: '#4285f4', openai: '#10a37f' };
            const cloudLabels = { azure: 'Azure', aws: 'AWS', gcp: 'GCP', openai: 'OpenAI' };
            const cloudOrder = ['aws', 'azure', 'gcp', 'openai'];
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
                const cloudGroupOrder = ['azure', 'aws', 'gcp'];
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
        // Auto-run comparison on page load with default fields
        await runComparison();
    } catch (err) {
        console.error('Compare load error:', err);
    }
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
        extraOpts.centerLabel = { text: '$' + total.toLocaleString(undefined, { maximumFractionDigits: 0 }) };
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
        btn.addEventListener('click', () => {
            document.querySelectorAll('#ccCloudsFilter .seg').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            ccCloudFilter = btn.dataset.cloud;
            ccSelectedSubs.clear();
            ccSelectedRgs.clear();
            ccSelectedSvcs.clear();
            ccUpdateCloudLabels(ccCloudFilter);
            ccRenderList('sub');
            ccLoadFilters();
        });
    });
    ccUpdateCloudLabels('all'); // init labels

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
    const fmt = d => d.toISOString().split('T')[0];
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

function ccToggleItem(type, item, checkbox) {
    const selected = type === 'sub' ? ccSelectedSubs : (type === 'rg' ? ccSelectedRgs : ccSelectedSvcs);
    if (checkbox.checked) selected.add(item);
    else selected.delete(item);
    ccUpdateCounts();
    if (type === 'sub') ccLoadFilters();
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
}

function ccDeselectAll(type) {
    const selected = type === 'sub' ? ccSelectedSubs : (type === 'rg' ? ccSelectedRgs : ccSelectedSvcs);
    selected.clear();
    ccRenderList(type);
    ccUpdateCounts();
    if (type === 'sub') ccLoadFilters();
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
    const types = await _getTenantProviderTypes();
    const allValue = opts.allValue !== undefined ? opts.allValue : '';
    const allLabel = opts.allLabel || 'All Clouds';
    const savedValue = sel.value;
    const labels = { azure: 'Azure', aws: 'AWS', gcp: 'GCP', openai: 'OpenAI' };
    sel.innerHTML = `<option value="${allValue}">${allLabel}</option>`;
    types.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = labels[t] || t.toUpperCase();
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

    // Load subscriptions
    try {
        const subs = await fetch('/api/subscriptions').then(r => r.json());
        crSubOptions = subs.filter(s => s.enabled).map(s => s.subscription_id);
        crSubMap = {};
        subs.filter(s => s.enabled).forEach(s => { crSubMap[s.subscription_id] = s.name; });
    } catch (e) {}

    // Load RG/services
    try {
        const filters = await fetch('/api/filters').then(r => r.json());
        crRgOptions = filters.resource_groups || [];
        crSvcOptions = filters.services || [];
    } catch (e) {}

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
    const fmt = d => d.toISOString().slice(0,10);

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

// ─── Resource Groups view (RG / project cost per month, all clouds) ──────────
let _rgData = null;
let _rgCloud = '';

function setRgCloud(btn, cloud) {
    _rgCloud = cloud;
    document.querySelectorAll('#rgCloudSeg .cp-seg').forEach(b => b.classList.toggle('active', b === btn));
    loadResourceGroups();
}

async function loadResourceGroups() {
    const body = document.getElementById('rgTableBody');
    if (body) body.innerHTML = '<tr><td style="padding:20px;text-align:center;color:var(--text-secondary)">Loading…</td></tr>';
    // populate client dropdown once
    const clientSel = document.getElementById('rgClient');
    if (clientSel && !clientSel.dataset.loaded) {
        try {
            const clients = await fetch('/api/clients').then(r => r.json());
            clientSel.innerHTML = '<option value="">All clients</option>' +
                (clients || []).map(c => `<option value="${c.id}">${_esc(c.name)}</option>`).join('');
            clientSel.dataset.loaded = '1';
        } catch (e) { clientSel.innerHTML = '<option value="">All clients</option>'; }
    }
    const months = document.getElementById('rgMonths')?.value || '6';
    const clientId = document.getElementById('rgClient')?.value || '';
    const qs = new URLSearchParams({ months });
    if (_rgCloud) qs.set('cloud_provider', _rgCloud);
    if (clientId) qs.set('client_id', clientId);
    try {
        _rgData = await fetch(`/api/resource-groups?${qs}`).then(r => r.json());
        renderRgroups();
    } catch (e) {
        if (body) body.innerHTML = '<tr><td style="padding:20px;text-align:center;color:var(--red)">Failed to load.</td></tr>';
    }
    loadCommitments(months);
}

async function loadCommitments(months) {
    const el = document.getElementById('rgCommitments');
    if (!el) return;
    try {
        const d = await fetch(`/api/commitments?months=${months || 6}`).then(r => r.json());
        const sym = d.currency_symbol || curSym();
        const fmt = v => sym + Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
        const grand = (d.total_committed || 0) + (d.total_ondemand || 0);
        if (grand <= 0) { el.innerHTML = ''; return; }
        const cloudName = { aws: 'AWS', azure: 'Azure', gcp: 'GCP', other: 'Other' };
        const cloudClr = { aws: '#FF9900', azure: '#0078d4', gcp: '#4285F4', other: '#6366f1' };
        const cards = (d.by_cloud || []).filter(c => c.committed > 0).map(c => `
            <div style="flex:1;min-width:170px;background:var(--card-bg);border:1px solid var(--border);border-top:3px solid ${cloudClr[c.cloud] || '#6366f1'};border-radius:8px;padding:12px 14px">
                <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-secondary);font-weight:600">${cloudName[c.cloud] || c.cloud} commitments</div>
                <div style="font-size:20px;font-weight:700;color:var(--text-primary);margin-top:2px">${fmt(c.committed)}</div>
                <div style="font-size:11px;color:var(--text-secondary)">${c.committed_pct}% of ${cloudName[c.cloud] || c.cloud} spend committed</div>
                <div style="height:5px;background:var(--border);border-radius:3px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${Math.min(c.committed_pct,100)}%;background:${cloudClr[c.cloud] || '#6366f1'}"></div></div>
            </div>`).join('');
        el.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span style="font-size:13px;font-weight:600;color:var(--text-primary)">Reserved Instances / Commitments</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(99,102,241,0.1);color:var(--accent);font-weight:600">${d.committed_pct}% committed · last ${d.months}mo</span>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
                <div style="flex:1;min-width:170px;background:var(--card-bg);border:1px solid var(--border);border-top:3px solid #10b981;border-radius:8px;padding:12px 14px">
                    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-secondary);font-weight:600">Total committed</div>
                    <div style="font-size:20px;font-weight:700;color:#10b981;margin-top:2px">${fmt(d.total_committed)}</div>
                    <div style="font-size:11px;color:var(--text-secondary)">vs ${fmt(d.total_ondemand)} on-demand</div>
                </div>
                ${cards || '<div style="flex:2;min-width:200px;display:flex;align-items:center;color:var(--text-secondary);font-size:12px;padding:0 8px">No RI / Savings Plan / CUD purchases detected for this account.</div>'}
            </div>`;
    } catch (e) { el.innerHTML = ''; }
}

function _rgMonthLabel(ym) {
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString(undefined, { month: 'short', year: '2-digit' });
}

function renderRgroups() {
    if (!_rgData) return;
    const sym = _rgData.currency_symbol || curSym();
    const months = _rgData.months || [];
    const search = (document.getElementById('rgSearch')?.value || '').trim().toLowerCase();
    let rows = _rgData.rows || [];
    if (search) rows = rows.filter(r => (r.resource_group || '').toLowerCase().includes(search));

    const head = document.getElementById('rgTableHead');
    const cloudIcon = { azure: 'Az', aws: 'AW', gcp: 'G' };
    head.innerHTML = `<tr>
        <th style="text-align:left">Resource Group / Project</th>
        <th style="text-align:left">Cloud</th>
        ${months.map(m => `<th style="text-align:right">${_rgMonthLabel(m)}</th>`).join('')}
        <th style="text-align:right">Total</th>
    </tr>`;

    const fmt = v => sym + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const body = document.getElementById('rgTableBody');
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="${months.length + 3}" style="padding:20px;text-align:center;color:var(--text-secondary)">No resource-group data for this selection.</td></tr>`;
    } else {
        body.innerHTML = rows.map(r => `
            <tr>
                <td style="font-weight:500" title="${_esc(r.resource_group)}">${_esc(r.resource_group)}</td>
                <td style="color:var(--text-secondary);font-size:12px">${(cloudIcon[r.cloud] || (r.cloud || '').toUpperCase())}</td>
                ${months.map(m => `<td style="text-align:right">${r.by_month[m] ? fmt(r.by_month[m]) : '<span style="color:var(--text-tertiary)">–</span>'}</td>`).join('')}
                <td style="text-align:right;font-weight:600;color:var(--text-primary)">${fmt(r.total)}</td>
            </tr>`).join('');
    }
    const sum = rows.reduce((s, r) => s + (r.total || 0), 0);
    const el = document.getElementById('rgSummary');
    if (el) el.textContent = `${rows.length} resource group${rows.length !== 1 ? 's' : ''} · ${sym}${sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} over ${months.length} month${months.length !== 1 ? 's' : ''}`;
}

function exportRgroupsCsv() {
    if (!_rgData || !_rgData.rows) return;
    const months = _rgData.months || [];
    const header = ['Resource Group', 'Cloud', ...months, 'Total'];
    const lines = [header.join(',')];
    (_rgData.rows || []).forEach(r => {
        const row = [`"${(r.resource_group || '').replace(/"/g, '""')}"`, r.cloud || '',
            ...months.map(m => r.by_month[m] || 0), r.total || 0];
        lines.push(row.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'resource-groups-monthly.csv';
    a.click();
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
    const lmFrom = lastMonthStart.toISOString().slice(0,10);
    const lmTo   = lastMonthEnd.toISOString().slice(0,10);

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

    // Subscription bars
    // Group bySub by cloud provider
    const cloudGrouped = {};
    const CLOUD_FULL = { azure: 'Microsoft Azure', aws: 'Amazon AWS', gcp: 'Google Cloud' };
    bySub.forEach(s => {
        const m = (client.mappings || []).find(mp => mp.filter_type === 'subscription_id' && mp.value === s.subscription_id);
        const cloud = (m?.cloud || 'azure').toLowerCase();
        cloudGrouped[cloud] = (cloudGrouped[cloud] || 0) + s.cost;
    });
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

    row.innerHTML = `
        <select class="filter-input cm-cloud" style="width:90px;font-size:12px;height:32px;flex-shrink:0">
            <option value="azure" ${cloud==='azure'?'selected':''}>Azure</option>
            <option value="aws"   ${cloud==='aws'  ?'selected':''}>AWS</option>
            <option value="gcp"   ${cloud==='gcp'  ?'selected':''}>GCP</option>
        </select>
        <select class="filter-input cm-filter-type" style="width:160px;font-size:12px;height:32px;flex-shrink:0">
            <option value="subscription_id" ${ft==='subscription_id'?'selected':''}>Subscription / Account</option>
            <option value="resource_group"  ${ft==='resource_group' ?'selected':''}>Resource Group / Region</option>
            <option value="service_name"    ${ft==='service_name'   ?'selected':''}>Service (VM, EC2, DB…)</option>
        </select>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0">
            <div class="cm-multiselect-wrap" style="position:relative">
                <div class="cm-trigger filter-input" style="font-size:12px;min-height:32px;padding:4px 28px 4px 8px;cursor:pointer;display:flex;flex-wrap:wrap;gap:3px;align-items:center"
                     onclick="toggleCmDropdown(this)">
                    <span class="cm-placeholder" style="color:var(--text-secondary);font-size:12px">— Loading… —</span>
                </div>
                <svg style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6,9 12,15 18,9"/></svg>
                <div class="cm-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;z-index:100;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.15);margin-top:2px">
                    <div style="padding:6px 8px;border-bottom:1px solid var(--border)">
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

    cloudSel.addEventListener('change', loadOptions);
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
    if (!isOpen) wrap.querySelector('.cm-search')?.focus();
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

