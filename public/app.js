'use strict';

const EXPECTED_API_VERSION = 3;
const DATA_TASK_LABELS = { quotes: '行情', history: '日线', shares: '官方份额', iopv: 'IOPV' };
const TASK_STATUS_LABELS = {
  running: '同步中', success: '已完成', partial: '部分完成', pending: '待数据', error: '同步失败',
  ready: '已完整', waiting: '待发布', failed: '同步失败', incomplete: '历史不完整', unavailable: '暂无目标日'
};
const COLUMN_STORAGE_KEY = 'etf-dashboard-columns-v1';
const DENSITY_STORAGE_KEY = 'etf-dashboard-density-v1';
const COLUMN_DEFAULTS = {
  estimatedSubscription5d: false,
  estimatedSubscription20d: false,
  shareStreakDays: false,
  officialShareDate: false,
  amountPercentile: false,
  turnoverRate: false,
  sharePercentile: false,
  marketValue: false,
  volatility20d: false
};

function loadColumnVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || '{}');
    return Object.fromEntries(Object.entries(COLUMN_DEFAULTS).map(([key, value]) => [
      key,
      typeof saved[key] === 'boolean' ? saved[key] : value
    ]));
  } catch {
    return { ...COLUMN_DEFAULTS };
  }
}

function loadDensity() {
  try {
    return localStorage.getItem(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

const state = {
  summary: null,
  rows: [],
  category: '全部',
  search: '',
  sortKey: null,
  sortDirection: 'desc',
  loading: false,
  detailRequest: null,
  detailData: null,
  shareRange: 250,
  shareChart: null,
  charts: [],
  drawerTrigger: null,
  columnVisibility: loadColumnVisibility(),
  density: loadDensity(),
  catalog: null,
  dragCode: null,
  savingOrder: false,
  manageOpen: false,
  lookupPromise: null,
  lookupCandidate: null
};

const elements = {
  heroTitle: document.querySelector('#heroTitle'),
  heroCopy: document.querySelector('#heroCopy'),
  monitorEyebrow: document.querySelector('#monitorEyebrow'),
  monitorCountFoot: document.querySelector('#monitorCountFoot'),
  marketStatus: document.querySelector('#marketStatus'),
  marketStatusText: document.querySelector('#marketStatusText'),
  refreshButton: document.querySelector('#refreshButton'),
  dataTime: document.querySelector('#dataTime'),
  generatedTime: document.querySelector('#generatedTime'),
  errorBanner: document.querySelector('#errorBanner'),
  totalAmount: document.querySelector('#totalAmount'),
  volumeUpCount: document.querySelector('#volumeUpCount'),
  volumeUpFoot: document.querySelector('#volumeUpFoot'),
  shareUpCount: document.querySelector('#shareUpCount'),
  shareUpFoot: document.querySelector('#shareUpFoot'),
  compositeCount: document.querySelector('#compositeCount'),
  resonanceHint: document.querySelector('#resonanceHint'),
  signalBoard: document.querySelector('#signalBoard'),
  closingSummary: document.querySelector('#closingSummary'),
  scoreBoardAsOf: document.querySelector('#scoreBoardAsOf'),
  categoryTabs: document.querySelector('#categoryTabs'),
  resultCount: document.querySelector('#resultCount'),
  searchInput: document.querySelector('#searchInput'),
  etfRows: document.querySelector('#etfRows'),
  updateLogs: document.querySelector('#updateLogs'),
  dataStatusPanel: document.querySelector('#dataStatusPanel'),
  drawer: document.querySelector('#detailDrawer'),
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  drawerBody: document.querySelector('#drawerBody'),
  drawerTitle: document.querySelector('#drawerTitle'),
  drawerCategory: document.querySelector('#drawerCategory'),
  drawerClose: document.querySelector('#drawerClose'),
  tableLoadingText: document.querySelector('#tableLoadingText'),
  tablePanel: document.querySelector('#tablePanel'),
  etfCards: document.querySelector('#etfCards'),
  densityToggle: document.querySelector('#densityToggle'),
  clearSortButton: document.querySelector('#clearSortButton'),
  manageEtfButton: document.querySelector('#manageEtfButton'),
  manageDialog: document.querySelector('#manageDialog'),
  manageBackdrop: document.querySelector('#manageBackdrop'),
  manageClose: document.querySelector('#manageClose'),
  manageCapacity: document.querySelector('#manageCapacity'),
  manageEtfList: document.querySelector('#manageEtfList'),
  removedEtfList: document.querySelector('#removedEtfList'),
  addEtfForm: document.querySelector('#addEtfForm'),
  addEtfButton: document.querySelector('#addEtfButton'),
  newEtfCode: document.querySelector('#newEtfCode'),
  newEtfName: document.querySelector('#newEtfName'),
  newEtfCategory: document.querySelector('#newEtfCategory'),
  newEtfTone: document.querySelector('#newEtfTone'),
  newEtfPinned: document.querySelector('#newEtfPinned'),
  newEtfHighlighted: document.querySelector('#newEtfHighlighted'),
  etfLookupStatus: document.querySelector('#etfLookupStatus'),
  restoreDefaultOrder: document.querySelector('#restoreDefaultOrder'),
  columnSettingsReset: document.querySelector('#columnSettingsReset'),
  showNarrowColumns: document.querySelector('#showNarrowColumns'),
  toast: document.querySelector('#toast')
};

const pageMain = document.querySelector('main');
const pageHeader = document.querySelector('.site-header');

const toneColors = {
  broad: '#5c8ee6',
  growth: '#7b89ad',
  tech: '#628f9d',
  finance: '#9d8965',
  health: '#947a94',
  hk: '#987466'
};

const CHART_COLORS = {
  primary: '#6f9cec',
  reference: '#aeb7c2',
  secondary: '#7896a4',
  axisLine: '#313842',
  axisLabel: '#7f8b98',
  gridLine: 'rgba(173,185,199,0.09)',
  zeroLine: 'rgba(173,185,199,0.3)',
  tooltipBg: '#15191f',
  tooltipBorder: '#3a4350',
  tooltipText: '#d9e0e8'
};

const formatter = {
  amount(value) {
    if (!Number.isFinite(value)) return '--';
    if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
    if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
    return value.toFixed(0);
  },
  shares(value) {
    if (!Number.isFinite(value)) return '--';
    if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿份`;
    if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万份`;
    return `${value.toFixed(0)} 份`;
  },
  signedAmount(value) {
    if (!Number.isFinite(value)) return '--';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${formatter.amount(value)}`;
  },
  signedShares(value) {
    if (!Number.isFinite(value)) return '--';
    const prefix = value > 0 ? '+' : '';
    return `${prefix}${formatter.shares(value)}`;
  },
  percent(value, digits = 2) {
    if (!Number.isFinite(value)) return '--';
    return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
  },
  percentDirect(value, digits = 2) {
    if (!Number.isFinite(value)) return '--';
    return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
  },
  plainPercent(value, digits = 2) {
    return Number.isFinite(value) ? `${value.toFixed(digits)}%` : '--';
  },
  ratio(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}×` : '--';
  },
  volume(value) {
    if (!Number.isFinite(value)) return '--';
    if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿手`;
    if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)} 万手`;
    return `${value.toFixed(0)} 手`;
  },
  price(value) {
    return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : '--';
  },
  time(value) {
    if (!value) return '等待数据';
    const date = new Date(value);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  },
  fullTime(value) {
    if (!value) return '尚未刷新';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value));
  }
};

function directionClass(value) {
  if (!Number.isFinite(value)) return 'neutral';
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function hasApiVersionMismatch(summary = state.summary) {
  return Boolean(summary && summary.apiVersion !== EXPECTED_API_VERSION);
}

function shareMetricStatusLabel(status) {
  if (hasApiVersionMismatch()) return '后台版本过旧';
  if (status === 'ready') return '官方日终';
  if (status === 'pending') return '待官方发布';
  if (status === 'insufficient') return '历史不完整';
  if (status === 'accumulating') return '历史积累中';
  return '同步状态缺失';
}

function latestOfficialMetricNote(row) {
  if (hasApiVersionMismatch()) {
    return '旧后台未返回最近官方日状态，请安全重启后台';
  }
  if (row.latestOfficialMetricStatus !== 'ready' || !row.latestOfficialShareDeltaDate) {
    if (row.latestOfficialMetricStatus === 'insufficient') {
      return '最近官方日缺少前一交易日记录，历史不完整';
    }
    return row.officialShareDate
      ? `${row.officialShareDate} 最近官方日指标尚未就绪`
      : '最近官方日等待交易所发布';
  }
  return `最近官方日，截至 ${row.latestOfficialShareDeltaDate} · 官方日终 ${formatter.signedShares(row.latestOfficialShareDelta)}`;
}

function latestOfficialSubscriptionNote(row) {
  if (hasApiVersionMismatch()) {
    return '旧后台未返回最近官方日状态，请安全重启后台';
  }
  if (row.latestOfficialMetricStatus !== 'ready' || !row.latestOfficialShareDeltaDate) {
    if (row.latestOfficialMetricStatus === 'insufficient') {
      return '最近官方日缺少前一交易日记录，历史不完整';
    }
    return row.officialShareDate
      ? `${row.officialShareDate} 最近官方日指标尚未就绪`
      : '最近官方日等待交易所发布';
  }
  if (!Number.isFinite(row.latestOfficialEstimatedSubscription)) {
    return `最近官方日，截至 ${row.latestOfficialShareDeltaDate} · 缺少同日价格`;
  }
  return `最近官方日，截至 ${row.latestOfficialShareDeltaDate} · ${formatter.signedAmount(row.latestOfficialEstimatedSubscription)}`;
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyColumnSettings({ persist = false } = {}) {
  document.querySelectorAll('[data-column-key]').forEach((header) => {
    header.hidden = !state.columnVisibility[header.dataset.columnKey];
  });
  document.querySelectorAll('[data-column-toggle]').forEach((input) => {
    input.checked = state.columnVisibility[input.dataset.columnToggle] === true;
  });
  if (persist) {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(state.columnVisibility));
    } catch {
      showToast('列设置无法写入本地浏览器');
    }
  }
}

function visibleColumnCount() {
  return 11 + Object.values(state.columnVisibility).filter(Boolean).length;
}

function createColumnCell(column) {
  const td = document.createElement('td');
  td.dataset.column = column;
  td.hidden = !state.columnVisibility[column];
  return td;
}

function applyDensity() {
  const compact = state.density === 'compact';
  elements.tablePanel?.classList.toggle('density-compact', compact);
  if (elements.densityToggle) {
    elements.densityToggle.textContent = compact ? '紧凑' : '舒适';
    elements.densityToggle.setAttribute('aria-pressed', String(compact));
    elements.densityToggle.title = compact ? '切换为舒适行高' : '切换为紧凑行高';
  }
}

function afterRender(callback) {
  if (document.visibilityState === 'hidden') {
    setTimeout(callback, 0);
  } else {
    requestAnimationFrame(callback);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || `HTTP ${response.status}`);
  return body;
}

async function loadSummary({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!silent) setRefreshLoading(true);
  try {
    const summary = await fetchJson('/api/summary');
    state.summary = summary;
    state.rows = summary.etfs || [];
    applyColumnSettings();
    renderSummary();
    renderTable();
    updateBackendVersionNotice();
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = `读取数据失败：${error.message}`;
    setStatus('error', '数据连接异常');
  } finally {
    state.loading = false;
    setRefreshLoading(false);
  }
}

async function refreshData(kind = 'all') {
  if (state.loading) return;
  state.loading = true;
  setRefreshLoading(true);
  try {
    const path = kind === 'all' ? '/api/refresh' : `/api/refresh?kind=${kind}`;
    const summary = await fetchJson(path, { method: 'POST' });
    state.summary = summary;
    state.rows = summary.etfs || [];
    applyColumnSettings();
    renderSummary();
    renderTable();
    updateBackendVersionNotice();
    showToast(refreshResultText(summary, kind));
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = `刷新失败：${error.message}`;
    showToast('刷新失败，请稍后重试');
  } finally {
    state.loading = false;
    setRefreshLoading(false);
  }
}

function refreshResultText(summary, kind) {
  const taskKeys = kind === 'all' ? ['quotes', 'iopv', 'shares'] : [kind];
  return taskKeys.map((key) => {
    const state = key === 'shares' ? summary.shareSyncStatus?.state : summary.dataStatus?.tasks?.[key]?.status;
    return `${DATA_TASK_LABELS[key]} ${TASK_STATUS_LABELS[state] || '状态待确认'}`;
  }).join(' · ');
}

function setRefreshLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle('is-loading', loading);
  document.querySelectorAll('[data-refresh-kind]').forEach((button) => {
    button.disabled = loading;
  });
}

function setStatus(type, text) {
  elements.marketStatus.className = `status-pill status-${type}`;
  elements.marketStatusText.textContent = text;
}

function updateBackendVersionNotice() {
  if (hasApiVersionMismatch()) {
    const received = state.summary?.apiVersion
      ? `API v${state.summary.apiVersion}`
      : '旧版接口';
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent =
      `后台版本过旧：当前接收到 ${received}，缺少官方份额状态契约（需要 API v${EXPECTED_API_VERSION}）。` +
      ' 请运行 scripts/start-dashboard.ps1 检测并安全重启后台。';
    return;
  }
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = '';
}

function updateMarketStatus() {
  if (!state.summary || !state.summary.etfs.length) {
    setStatus('loading', '等待首次数据');
    return;
  }
  if (hasApiVersionMismatch()) {
    setStatus('warning', '后台版本落后');
    return;
  }
  const status = state.summary.quoteStatus;
  if (status === 'error') setStatus('error', '行情数据异常');
  else if (status === 'partial') setStatus('warning', '部分数据异常');
  else if (state.summary.marketPhase === 'closed') setStatus('quiet', '休市 · 最近交易日');
  else if (state.summary.marketPhase === 'break') setStatus('quiet', '午间休市');
  else if (state.summary.marketPhase === 'unknown') setStatus('warning', '交易日历待确认');
  else setStatus('live', state.summary.dataTime ? '行情已连接' : '等待盘后数据');
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  const monitorCount = summary.monitorCount ?? state.rows.length;
  const quoteDate = summary.quoteAsOfDate || summary.dataStatus?.dates?.quoteDate;
  const amountCount = summary.amountCoverage?.available ?? 0;
  elements.monitorEyebrow.textContent = `${monitorCount} 只监控 ETF · 公开行情监测`;
  elements.monitorCountFoot.textContent = quoteDate
    ? `${quoteDate} · ${amountCount}/${monitorCount} 只有效`
    : '等待行情覆盖数据';
  elements.volumeUpFoot.textContent = [quoteDate, '成交额达到均值 2 倍'].filter(Boolean).join(' · ');
  if (elements.tableLoadingText) {
    elements.tableLoadingText.textContent =
      `正在读取 ${monitorCount} 只 ETF 的行情、IOPV 与历史数据...`;
  }
  elements.totalAmount.textContent = formatter.amount(summary.totalAmount);
  elements.volumeUpCount.textContent = summary.volumeUpCount ?? 0;
  elements.compositeCount.textContent = summary.scoreSignalCount ?? 0;
  const shareCounts = summary.shareMetricStatusCounts || {};
  const readyShareCount = shareCounts.ready || 0;
  const pendingShareCount = shareCounts.pending || 0;
  elements.shareUpCount.classList.toggle('is-status', readyShareCount === 0);
  const shareSyncState = summary.shareSyncStatus?.state;
  if (hasApiVersionMismatch()) {
    elements.shareUpCount.textContent = '后台版本过旧';
    elements.shareUpFoot.textContent = '旧后台未返回官方份额状态，请安全重启';
  } else if (readyShareCount > 0) {
    elements.shareUpCount.textContent = summary.shareUpCount ?? 0;
    const pendingNote = pendingShareCount > 0 ? ` · ${pendingShareCount} 只待发布` : '';
    elements.shareUpFoot.textContent = `${summary.shareUpAsOfDate || '--'} 官方日终 · ${readyShareCount}/${state.rows.length} 只已发布${pendingNote}`;
  } else if (shareSyncState === 'failed') {
    elements.shareUpCount.textContent = '同步失败';
    elements.shareUpFoot.textContent = summary.shareSyncStatus.message;
  } else if (shareSyncState === 'incomplete') {
    elements.shareUpCount.textContent = '历史不完整';
    elements.shareUpFoot.textContent = summary.shareSyncStatus.message;
  } else if (pendingShareCount > 0) {
    elements.shareUpCount.textContent = '待官方发布';
    elements.shareUpFoot.textContent = summary.latestOfficialShareUpAsOfDate
      ? `最近官方日，截至 ${summary.latestOfficialShareUpAsOfDate} · ${summary.latestOfficialShareUpCount || 0} 只净申购`
      : '交易所官方份额尚未发布';
  } else {
    elements.shareUpCount.textContent = '同步状态缺失';
    elements.shareUpFoot.textContent = summary.shareSyncStatus?.message || '后台未返回官方份额同步状态';
  }
  const latestScoreDate = summary.scoreAsOfDate ?? state.rows.map((row) => row.scoreDate).filter(Boolean).sort().at(-1);
  const scoredRows = state.rows.filter((row) => latestScoreDate && row.scoreDate === latestScoreDate);
  elements.scoreBoardAsOf.textContent = latestScoreDate
    ? `评分基于 ${latestScoreDate} · 非实时`
    : '评分暂不可用';
  const highCount = scoredRows.filter((row) => row.scoreLevel?.key === 'high').length;
  const activeCount = scoredRows.filter((row) => row.scoreLevel?.key === 'active').length;
  elements.resonanceHint.textContent = latestScoreDate
    ? `评分日 ${latestScoreDate} · ${activeCount} 只活跃 · ${highCount} 只高强度`
    : '等待最近完整评分日';
  elements.dataTime.textContent = formatter.time(summary.dataTime);
  elements.generatedTime.textContent = summary.capturedAt
    ? `抓取于 ${formatter.fullTime(summary.capturedAt)}`
    : `页面更新 ${formatter.fullTime(summary.generatedAt)}`;
  updateMarketStatus();
  renderSignalBoard(scoredRows);
  renderClosingSummary(quoteDate);
  renderCategoryTabs();
  renderLogs();
  renderDataStatus();
}

function renderSignalBoard(scoredRows) {
  const focusedCode = elements.signalBoard.contains(document.activeElement)
    ? document.activeElement.dataset.etfCode
    : null;
  elements.signalBoard.replaceChildren();
  const candidates = scoredRows.filter((row) => row.scoreSignal)
    .sort((left, right) => right.score - left.score || left.code.localeCompare(right.code))
    .slice(0, 4);
  if (!candidates.length) {
    elements.signalBoard.append(createElement('div', 'signal-empty', '最近完整评分日没有达到 40 分的异动信号'));
    return;
  }
  for (const row of candidates) {
    const card = createElement('article', 'signal-card');
    card.tabIndex = 0;
    card.dataset.etfCode = row.code;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `查看 ${row.name} 详情`);
    const top = createElement('div', 'signal-card-top');
    const titles = createElement('div');
    titles.append(
      createElement('span', 'signal-code', row.code),
      createElement('h4', '', row.name)
    );
    const scoredChange = row.scoreChangePercent ?? (row.tradeDate === row.scoreDate ? row.changePercent : null);
    const scoredRatio = row.scoreVolumeRatio ?? (row.tradeDate === row.scoreDate ? row.volumeRatio : null);
    const change = createElement(
      'span',
      directionClass(scoredChange),
      formatter.percentDirect(scoredChange)
    );
    top.append(titles, change);
    const value = createElement('div', 'score-card-line');
    const score = createScorePill(row);
    value.append(score, createElement(
      'span',
      'score-reason',
      row.scoreReasons?.slice(0, 2).join(' · ') || '查看评分贡献'
    ));
    const tags = createElement('div', 'tag-row');
    tags.style.justifyContent = 'flex-start';
    tags.style.margin = '9px 0 0';
    tags.append(createElement(
      'span',
      'tag',
      `量比 ${formatter.ratio(scoredRatio)} · ${row.scoreDate}`
    ));
    card.append(top, value, tags);
    card.addEventListener('click', () => openDetail(row.code));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(row.code);
      }
    });
    elements.signalBoard.append(card);
  }
  if (focusedCode) elements.signalBoard.querySelector(`[data-etf-code="${focusedCode}"]`)?.focus({ preventScroll: true });
}

function renderClosingSummary(quoteDate) {
  const summary = state.summary;
  elements.closingSummary.hidden = summary.marketPhase !== 'closed' || !quoteDate;
  if (elements.closingSummary.hidden) return;
  const rows = state.rows.filter((row) => row.tradeDate === quoteDate && !row.isStale);
  const topVolume = rows.filter((row) => Number.isFinite(row.volumeRatio))
    .sort((left, right) => right.volumeRatio - left.volumeRatio)[0];
  const topFlow = rows.filter((row) => Number.isFinite(row.estimatedSubscription))
    .sort((left, right) => Math.abs(right.estimatedSubscription) - Math.abs(left.estimatedSubscription))[0];
  elements.closingSummary.textContent = [
    `${quoteDate} 盘后摘要`,
    `有效行情 ${rows.length}/${state.rows.length}`,
    topVolume ? `最高量比 ${topVolume.name} ${formatter.ratio(topVolume.volumeRatio)}` : '量比待积累',
    topFlow
      ? `申赎变动最大 ${topFlow.name} ${formatter.signedAmount(topFlow.estimatedSubscription)}（官方份额估算）`
      : '官方申赎估算待齐',
    summary.scoreAsOfDate === quoteDate ? `评分 ≥ 40 有 ${summary.scoreSignalCount} 只` : '当日评分待齐'
  ].join(' · ');
}

function renderDataStatus() {
  const status = state.summary?.dataStatus;
  elements.dataStatusPanel.replaceChildren();
  if (!status) {
    elements.dataStatusPanel.append(createElement('div', 'log-line', '尚未取得更新状态'));
    return;
  }
  const rows = [
    ['quotes', 'quoteDate', '东方财富', (row) => !row.quoteDate || row.quoteDate < state.summary.quoteAsOfDate],
    ['history', 'barDate', '东方财富', (row) => row.quoteBarLag],
    ['shares', 'officialShareDate', '沪深交易所', (row) => row.quoteShareLag],
    ['iopv', 'iopvDate', '沪深交易所 / 东方财富补充', (row) => row.barIopvLag]
  ];
  for (const [key, field, source, isBehind] of rows) {
    const item = createElement('div', 'data-status-item');
    const task = status.tasks?.[key];
    const gaps = (status.etfs || []).filter(isBehind)
      .map((row) => `${row.code} ${row[field] || '无数据'}`);
    const failedDates = (task?.failedDates || []).slice(-5);
    item.append(
      createElement('span', '', `${DATA_TASK_LABELS[key]} · ${source}`),
      createElement('strong', '', status.dates?.[field] || '尚未更新')
    );
    if (task) item.append(createElement('small', '', [
      TASK_STATUS_LABELS[task.status], task.message, failedDates.length ? `待补 ${failedDates.join('、')}` : null
    ].filter(Boolean).join(' · ')));
    if (gaps.length) item.append(createElement('small', 'status-note', `缺口 ${gaps.join('、')}`));
    elements.dataStatusPanel.append(item);
  }
  for (const [key, label] of [['closeQuotes', '15:30 盘后快照'], ['closeHistory', '18:00 盘后同步']]) {
    const task = status.tasks?.[key];
    if (!task) continue;
    elements.dataStatusPanel.append(createElement('div', 'data-status-note', [
      label, task.targetDates?.at(-1) || task.lastSuccessDate, TASK_STATUS_LABELS[task.status]
    ].filter(Boolean).join(' · ')));
  }
  const shareSync = state.summary?.shareSyncStatus;
  if (hasApiVersionMismatch()) {
    elements.dataStatusPanel.append(createElement(
      'div',
      'data-calendar-note warning',
      `后台版本过旧：需要 API v${EXPECTED_API_VERSION}，请安全重启后台后再判断官方份额状态。`
    ));
  } else if (shareSync) {
    const stateLabel = {
      ready: '已完整',
      waiting: '待交易所发布 / 等待自动重试',
      failed: '同步失败 / 等待自动重试',
      incomplete: '历史不完整',
      unavailable: '暂无行情交易日'
    }[shareSync.state] || shareSync.state;
    elements.dataStatusPanel.append(createElement(
      'div',
      `data-sync-note ${shareSync.state === 'ready' ? '' : 'warning'}`,
      `官方份额同步状态：${stateLabel} · ${shareSync.message || ''}`
    ));
    elements.dataStatusPanel.append(createElement(
      'div',
      'data-status-note',
      `目标日 ${shareSync.targetDate || '--'} · 最近尝试 ${formatter.fullTime(shareSync.lastAttemptAt)} · ` +
      `下次 ${shareSync.nextRetryAt ? formatter.fullTime(shareSync.nextRetryAt) : '暂无计划'}`
    ));
    const missingDates = shareSync.history?.missingRecentDates || [];
    if (missingDates.length) elements.dataStatusPanel.append(createElement(
      'div', 'data-status-note', `官方份额历史缺口 ${missingDates.join('、')}`
    ));
  }
  const calendar = status.calendar;
  if (calendar) {
    elements.dataStatusPanel.append(createElement(
      'div',
      `data-calendar-note ${calendar.stale ? 'warning' : ''}`,
      calendar.message
    ));
  }
}

function renderCategoryTabs() {
  const categories = ['全部', ...new Set(state.rows.map((row) => row.category))];
  elements.categoryTabs.replaceChildren();
  for (const category of categories) {
    const button = createElement(
      'button',
      `category-tab ${state.category === category ? 'active' : ''}`,
      category
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      state.category = category;
      renderCategoryTabs();
      renderTable();
    });
    elements.categoryTabs.append(button);
  }
}

function visibleRows() {
  const query = state.search.trim().toLowerCase();
  const rows = state.rows.filter((row) => {
    const categoryMatch = state.category === '全部' || row.category === state.category;
    const searchMatch = !query || row.code.includes(query) || row.name.toLowerCase().includes(query);
    return categoryMatch && searchMatch;
  });
  const compareForSort = (left, right) => {
    if (!state.sortKey) return 0;
    const a = left[state.sortKey];
    const b = right[state.sortKey];
    const aMissing = a === null || a === undefined || a === '';
    const bMissing = b === null || b === undefined || b === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    const comparison = typeof a === 'string' ? a.localeCompare(b, 'zh-CN') : a - b;
    return state.sortDirection === 'asc' ? comparison : -comparison;
  };
  const compareCustom = (left, right) => (
    left.sortOrder - right.sortOrder || left.code.localeCompare(right.code)
  );
  const compare = state.sortKey ? compareForSort : compareCustom;
  const pinned = rows.filter((row) => row.isPinned).sort(compare);
  const normal = rows.filter((row) => !row.isPinned).sort(compare);
  return [...pinned, ...normal];
}

function customSortedRows() {
  return [...state.rows].sort((left, right) => (
    Number(right.isPinned) - Number(left.isPinned) ||
    left.sortOrder - right.sortOrder ||
    left.code.localeCompare(right.code)
  ));
}

function filteredRowsWithoutMetricSort() {
  const query = state.search.trim().toLowerCase();
  return state.rows.filter((row) => {
    const categoryMatch = state.category === '全部' || row.category === state.category;
    const searchMatch = !query || row.code.includes(query) || row.name.toLowerCase().includes(query);
    return categoryMatch && searchMatch;
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code));
}

function moveRowBy(code, direction) {
  if (state.savingOrder) return;
  state.sortKey = null;
  const row = state.rows.find((item) => item.code === code);
  if (!row) return;
  const groupRows = filteredRowsWithoutMetricSort()
    .filter((item) => item.isPinned === row.isPinned);
  const index = groupRows.findIndex((item) => item.code === code);
  const neighbor = groupRows[index + direction];
  if (!neighbor) {
    showToast(direction < 0 ? '已经是当前区域第一位' : '已经是当前区域最后一位');
    renderTable();
    return;
  }
  reorderRows(code, neighbor.code, neighbor.isPinned, direction > 0 ? 'after' : 'before');
}

function reorderRows(draggedCode, targetCode, targetPinned, position = 'before') {
  if (state.savingOrder || draggedCode === targetCode) return;
  const previousRows = state.rows.map((row) => ({ ...row }));
  const previousSummary = state.summary;
  const dragged = state.rows.find((row) => row.code === draggedCode);
  if (!dragged) return;
  const pinned = state.rows
    .filter((row) => row.isPinned && row.code !== draggedCode)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const normal = state.rows
    .filter((row) => !row.isPinned && row.code !== draggedCode)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const targetList = targetPinned ? pinned : normal;
  const targetIndex = targetList.findIndex((row) => row.code === targetCode);
  if (targetIndex < 0) return;
  targetList.splice(
    targetIndex + (position === 'after' ? 1 : 0),
    0,
    { ...dragged, isPinned: targetPinned }
  );
  const nextRows = [
    ...pinned.map((row, index) => ({ ...row, isPinned: true, sortOrder: (index + 1) * 10 })),
    ...normal.map((row, index) => ({ ...row, isPinned: false, sortOrder: 1000 + index * 10 }))
  ];
  state.sortKey = null;
  state.rows = nextRows;
  state.summary = { ...state.summary, etfs: nextRows };
  state.savingOrder = true;
  renderTable();
  persistCatalogOrder(previousRows, previousSummary);
}

async function persistCatalogOrder(previousRows, previousSummary) {
  const pinnedCodes = state.rows.filter((row) => row.isPinned).map((row) => row.code);
  const normalCodes = state.rows.filter((row) => !row.isPinned).map((row) => row.code);
  try {
    const result = await fetchJson('/api/etfs/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinnedCodes, normalCodes })
    });
    state.summary = {
      ...result.summary,
      apiVersion: result.apiVersion,
      buildId: result.buildId
    };
    state.rows = state.summary.etfs || [];
    state.catalog = result.catalog || state.catalog;
    state.savingOrder = false;
    renderTable();
    showToast('自定义顺序已保存');
  } catch (error) {
    state.rows = previousRows;
    state.summary = previousSummary;
    state.savingOrder = false;
    renderTable();
    showToast(`排序保存失败，已恢复原顺序：${error.message}`);
  }
}

function renderTable() {
  const rows = visibleRows();
  const focused = document.activeElement;
  const focusedPool = [elements.etfRows, elements.etfCards].find((pool) => pool?.contains(focused));
  const focusedCode = focusedPool ? focused.closest('[data-etf-code]')?.dataset.etfCode : null;
  const focusedMove = focusedCode ? focused.dataset.move : null;
  document.querySelectorAll('th[data-sort]').forEach((header) => {
    const active = header.dataset.sort === state.sortKey;
    header.setAttribute(
      'aria-sort',
      active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
    );
  });
  const pinnedCount = rows.filter((row) => row.isPinned).length;
  elements.resultCount.textContent =
    `${rows.length} / ${state.rows.length} 只 ETF · 置顶 ${pinnedCount}`;
  elements.etfRows.replaceChildren();
  renderEtfCards(rows);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const emptyState = createElement('div', 'table-empty-state');
    emptyState.append(
      createElement('strong', '', state.rows.length ? '没有匹配的 ETF' : '正在读取行情数据'),
      createElement(
        'span',
        '',
        state.rows.length ? '调整搜索词或分类后再试' : '行情、官方份额与历史指标正在同步'
      )
    );
    const td = document.createElement('td');
    td.className = 'table-loading';
    td.append(emptyState);
    td.colSpan = visibleColumnCount();
    tr.append(td);
    elements.etfRows.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.etfCode = row.code;
    tr.setAttribute('role', 'button');
    tr.classList.toggle('is-candidate', row.scoreSignal);
    tr.classList.toggle('is-stale', row.isStale);
    tr.classList.toggle('is-pinned', row.isPinned);
    tr.classList.toggle('is-highlighted', row.isHighlighted);
    tr.draggable = !state.savingOrder;
    tr.classList.toggle('is-saving', state.savingOrder);
    if (row.isStale) tr.title = row.staleness || '行情数据已过期';
    tr.setAttribute('aria-label', `查看 ${row.name} 详情`);
    tr.append(createEtfCell(row));
    tr.append(createElement('td', '', formatter.price(row.price)));
    tr.append(createPremiumCell(row));
    tr.append(createElement('td', directionClass(row.changePercent), formatter.percentDirect(row.changePercent)));
    tr.append(createElement('td', '', formatter.amount(row.amount)));
    const ratioCell = document.createElement('td');
    ratioCell.append(createElement(
      'span',
      `ratio-pill ${row.volumeRatio >= 2 ? 'high' : ''}`,
      formatter.ratio(row.volumeRatio)
    ));
    tr.append(ratioCell);
    tr.append(createElement('td', directionClass(row.return5d), formatter.percent(row.return5d)));
    tr.append(createElement('td', directionClass(row.return20d), formatter.percent(row.return20d)));
    tr.append(createShareMetricCell(row, 'shareDelta'));
    tr.append(createShareMetricCell(row, 'estimatedSubscription'));
    tr.append(createSignalCell(row));
    tr.append(createWindowMetricCell(row, 5));
    tr.append(createWindowMetricCell(row, 20));
    tr.append(createStreakCell(row));
    tr.append(createOfficialShareStatusCell(row));
    tr.append(createQuantityMetricCell(
      'amountPercentile',
      formatter.plainPercent(
        Number.isFinite(row.amountPercentile) ? row.amountPercentile * 100 : null,
        1
      ),
      '历史交易日分位'
    ));
    tr.append(createQuantityMetricCell(
      'turnoverRate',
      formatter.plainPercent(row.turnoverRate, 2),
      row.tradeDate || '等待行情'
    ));
    tr.append(createQuantityMetricCell(
      'sharePercentile',
      formatter.plainPercent(
        Number.isFinite(row.sharePercentile) ? row.sharePercentile * 100 : null,
        1
      ),
      '250日官方份额'
    ));
    tr.append(createQuantityMetricCell(
      'marketValue',
      formatter.amount(row.estimatedFundSize ?? row.marketValue),
      '行情字段估算'
    ));
    tr.append(createQuantityMetricCell(
      'volatility20d',
      formatter.plainPercent(
        Number.isFinite(row.volatility20d) ? row.volatility20d * 100 : null,
        2
      ),
      row.volatility20d === null ? '历史积累中' : '20日年化'
    ));
    bindRowInteractions(tr, row);
    elements.etfRows.append(tr);
  }
  if (focusedCode) {
    const entry = focusedPool.querySelector(`[data-etf-code="${focusedCode}"]`);
    const target = focusedMove ? entry?.querySelector(`[data-move="${focusedMove}"]`) : entry;
    target?.focus({ preventScroll: true });
  }
}

function createEtfCard(row) {
  const card = createElement('article', 'etf-card');
  card.tabIndex = 0;
  card.dataset.etfCode = row.code;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `查看 ${row.name} 详情`);
  card.classList.toggle('is-pinned', row.isPinned);
  card.classList.toggle('is-highlighted', row.isHighlighted);
  card.classList.toggle('is-stale', row.isStale);

  const header = createElement('div', 'etf-card-head');
  const identity = createElement('div', 'etf-card-identity');
  const title = createElement('div', 'etf-card-title');
  title.append(
    createElement('strong', '', row.name),
    createElement('span', '', `${row.code} · ${row.category}`)
  );
  const tags = createElement('div', 'etf-card-tags');
  if (row.isPinned) tags.append(createElement('span', 'pin-tag', '置顶'));
  if (row.isHighlighted) tags.append(createElement('span', 'focus-tag', '重点'));
  if (row.isStale) {
    tags.append(createElement('span', 'freshness-tag', row.quoteStatus === 'missing' ? '无行情' : '数据过期'));
  }
  identity.append(title, tags);
  const quote = createElement('div', 'etf-card-quote');
  quote.append(
    createElement('strong', directionClass(row.changePercent), formatter.price(row.price)),
    createElement('span', directionClass(row.changePercent), formatter.percentDirect(row.changePercent))
  );
  header.append(identity, quote);

  const subscriptionReady = row.shareMetricStatus === 'ready' && !hasApiVersionMismatch();
  const subscriptionValue = hasApiVersionMismatch()
    ? '后台版本过旧'
    : subscriptionReady
      ? Number.isFinite(row.estimatedSubscription) ? formatter.signedAmount(row.estimatedSubscription) : '缺少同日收盘'
      : shareMetricStatusLabel(row.shareMetricStatus);
  const metricGrid = createElement('div', 'etf-card-metrics');
  const metrics = [
    ['成交额', formatter.amount(row.amount), ''],
    ['行情日估算净申赎', subscriptionValue, subscriptionReady ? directionClass(row.estimatedSubscription) : 'status-warning'],
    ['20日量比', formatter.ratio(row.volumeRatio), row.volumeRatio >= 2 ? 'metric-alert' : ''],
    ['行情日', row.tradeDate || '待行情', 'neutral']
  ];
  for (const [label, value, className] of metrics) {
    const item = createElement('div', 'etf-card-metric');
    item.append(createElement('span', '', label), createElement('strong', className, value));
    metricGrid.append(item);
  }

  const footer = createElement('div', 'etf-card-foot');
  const officialStatus = row.latestOfficialMetricStatus === 'ready'
    ? `${row.officialShareDate || '--'} 官方日终`
    : row.latestOfficialMetricStatus === 'insufficient'
      ? '官方份额历史不完整'
      : '待官方份额发布';
  const status = createElement(
    'span',
    `etf-card-status ${row.latestOfficialMetricStatus === 'ready' ? 'is-ready' : 'is-pending'}`,
    officialStatus
  );
  const score = createScorePill(row);
  score.classList.add('mobile-score');
  footer.append(status, score);

  card.append(header, metricGrid, footer);
  card.addEventListener('click', () => {
    card.focus({ preventScroll: true });
    openDetail(row.code);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(row.code);
    }
  });
  return card;
}

function renderEtfCards(rows) {
  if (!elements.etfCards) return;
  elements.etfCards.replaceChildren();
  if (!rows.length) {
    const stateNode = createElement('div', 'etf-card-state');
    stateNode.append(
      createElement('strong', '', state.rows.length ? '没有匹配的 ETF' : '正在读取 ETF 数据'),
      createElement(
        'span',
        '',
        state.rows.length ? '调整搜索词或分类后再试' : '行情、官方份额与评分正在同步'
      )
    );
    elements.etfCards.append(stateNode);
    return;
  }
  for (const row of rows) elements.etfCards.append(createEtfCard(row));
}

function createShareMetricCell(row, field) {
  const td = document.createElement('td');
  const wrapper = createElement('div', 'share-metric-cell');
  const versionMismatch = hasApiVersionMismatch();
  const ready = !versionMismatch && row.shareMetricStatus === 'ready';
  const value = row[field];
  const primary = versionMismatch
    ? '后台版本过旧'
    : ready
    ? field === 'shareDelta'
      ? formatter.signedShares(value)
      : Number.isFinite(value) ? formatter.signedAmount(value) : '缺少同日收盘'
    : shareMetricStatusLabel(row.shareMetricStatus);
  const note = ready && row.latestOfficialShareDeltaDate === row.tradeDate
    ? `官方日终 ${row.tradeDate}`
    : field === 'shareDelta' ? latestOfficialMetricNote(row) : latestOfficialSubscriptionNote(row);
  wrapper.append(
    createElement('strong', ready ? directionClass(value) : 'status-note', primary),
    createElement('small', '', note)
  );
  td.append(wrapper);
  td.title = versionMismatch
    ? '旧后台缺少官方份额状态字段，请安全重启后台'
    : ready
    ? `当前行情日 ${row.tradeDate || '--'} 官方日终指标`
    : `${primary}；${note}`;
  return td;
}

function createPremiumCell(row) {
  const td = document.createElement('td');
  const pill = createElement('span', 'premium-pill');
  if (Number.isFinite(row.premiumRate) && row.premiumStatus === 'valid') {
    pill.classList.add(directionClass(row.premiumRate));
    if (row.premiumAbnormal) pill.classList.add('abnormal');
    pill.append(
      createElement('strong', '', formatter.percent(row.premiumRate)),
      createElement('small', '', row.premiumAbnormal ? '异常偏离' : 'IOPV')
    );
    pill.title = `${row.iopvSource || 'IOPV'} · ${row.iopvDataTime || '时间未知'} · ${formatter.percent(row.premiumRate)}`;
  } else {
    pill.classList.add(`status-${row.premiumStatus || 'missing'}`);
    pill.append(createElement('small', '', row.premiumStatusLabel || '暂无'));
    pill.title = row.premiumMessage || 'IOPV 数据暂不可用';
  }
  td.append(pill);
  return td;
}

function createEtfCell(row) {
  const td = document.createElement('td');
  td.className = 'sticky-col';
  const wrapper = createElement('div', 'etf-cell');
  const controls = createElement('div');
  const dragHandle = createElement('span', 'drag-handle', '⠿');
  dragHandle.title = '拖动排序';
  dragHandle.setAttribute('aria-hidden', 'true');
  const actions = createElement('div', 'row-actions');
  const up = createElement('button', 'row-action', '↑');
  up.type = 'button';
  up.dataset.move = 'up';
  up.setAttribute('aria-label', `上移 ${row.name}`);
  const down = createElement('button', 'row-action', '↓');
  down.type = 'button';
  down.dataset.move = 'down';
  down.setAttribute('aria-label', `下移 ${row.name}`);
  actions.append(up, down);
  controls.append(dragHandle, actions);
  const mark = createElement('span', 'tone-mark');
  mark.style.setProperty('--tone-color', toneColors[row.tone] || toneColors.broad);
  const content = createElement('div');
  content.append(
    createElement('span', 'etf-name', row.name),
    createElement('span', 'etf-meta', `${row.code} · ${row.category}`)
  );
  if (row.isStale) {
    const warning = createElement(
      'span',
      `freshness-tag ${row.quoteStatus || 'stale'}`,
      row.quoteStatus === 'missing' ? '无行情' : '数据过期'
    );
    warning.title = row.staleness || '行情数据已过期';
    content.append(warning);
  }
  if (row.isPinned) content.append(createElement('span', 'pin-tag', '置顶'));
  if (row.isHighlighted) content.append(createElement('span', 'focus-tag', '重点关注'));
  if (row.historyStatus === 'accumulating') {
    content.append(createElement('span', 'freshness-tag', '历史积累中'));
  }
  wrapper.append(controls, mark, content);
  td.append(wrapper);
  return td;
}

function createWindowMetricCell(row, days) {
  const td = createColumnCell(`estimatedSubscription${days}d`);
  const value = row[`estimatedSubscription${days}d`];
  const status = row[`estimatedSubscription${days}dStatus`];
  const coverage = row[`estimatedSubscription${days}dCoverage`] ?? 0;
  const wrapper = createElement('div', `metric-value ${status === 'ready' ? '' : 'status-note'}`);
  wrapper.append(
    createElement(
      'strong',
      status === 'ready' ? directionClass(value) : '',
      status === 'ready' ? formatter.signedAmount(value) : '历史积累中'
    ),
    createElement(
      'small',
      '',
      status === 'ready'
        ? `${days} 个官方交易日累计`
        : `已配对 ${coverage}/${days} 日 · 待数据`
    )
  );
  td.title = status === 'ready'
    ? `近 ${days} 日官方份额变化 × 同日收盘价，仅使用连续可用记录`
    : `官方份额或同日价格不足 ${days} 日，不补零`;
  td.append(wrapper);
  return td;
}

function createStreakCell(row) {
  const td = createColumnCell('shareStreakDays');
  const days = row.shareStreakDays ?? row.shareStreak?.days ?? 0;
  const direction = row.shareStreakDirection ?? row.shareStreak?.direction;
  const wrapper = createElement('div', `metric-value ${days ? '' : 'status-note'}`);
  wrapper.append(
    createElement(
      'strong',
      directionClass(direction === 'subscription' ? 1 : direction === 'redemption' ? -1 : 0),
      days ? row.shareStreak?.label || (direction === 'subscription' ? '连续净申购' : '连续净赎回') : '无连续序列'
    ),
    createElement('small', '', days ? `${days} 个交易日 · 截至 ${row.shareStreakDate || '--'}` : '待连续官方份额记录')
  );
  td.title = '连续净申赎只统计连续官方日终记录，缺失日期即中断';
  td.append(wrapper);
  return td;
}

function createOfficialShareStatusCell(row) {
  const td = createColumnCell('officialShareDate');
  const ready = row.latestOfficialMetricStatus === 'ready';
  const wrapper = createElement('div', `metric-value ${ready ? '' : 'status-note'}`);
  const status = ready
    ? '官方日终已就绪'
    : row.latestOfficialMetricStatus === 'insufficient'
      ? '历史不完整'
      : '待官方发布';
  wrapper.append(
    createElement('strong', '', row.officialShareDate || '待数据'),
    createElement(
      'small',
      '',
      `${status}${row.officialShareSource ? ` · ${row.officialShareSource}` : ''}`
    )
  );
  td.title = row.latestOfficialMetricStatus === 'insufficient'
    ? '最近官方日缺少前一交易日记录，不使用行情快照代替'
    : '官方份额来自交易所日终数据';
  td.append(wrapper);
  return td;
}

function createQuantityMetricCell(column, primary, note) {
  const td = createColumnCell(column);
  const wrapper = createElement('div', `metric-value ${primary === '--' ? 'status-note' : ''}`);
  wrapper.append(
    createElement('strong', '', primary),
    createElement('small', '', note)
  );
  td.append(wrapper);
  return td;
}

function bindRowInteractions(tr, row) {
  tr.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openDetail(row.code);
  });
  tr.addEventListener('keydown', (event) => {
    if (event.target.closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(row.code);
    }
  });
  tr.querySelectorAll('[data-move]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      moveRowBy(row.code, button.dataset.move === 'up' ? -1 : 1);
    });
  });
  tr.addEventListener('dragstart', (event) => {
    if (state.sortKey) {
      event.preventDefault();
      showToast('请先清除指标排序，再拖动自定义顺序');
      return;
    }
    if (state.savingOrder) {
      event.preventDefault();
      return;
    }
    state.dragCode = row.code;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.code);
  });
  tr.addEventListener('dragend', () => {
    state.dragCode = null;
    document.querySelectorAll('tr.is-drag-over').forEach((item) => {
      item.classList.remove('is-drag-over');
    });
  });
  tr.addEventListener('dragover', (event) => {
    if (!state.dragCode || state.dragCode === row.code || state.sortKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('tr.is-drag-over').forEach((item) => {
      item.classList.remove('is-drag-over');
    });
    tr.classList.add('is-drag-over');
  });
  tr.addEventListener('dragleave', () => tr.classList.remove('is-drag-over'));
  tr.addEventListener('drop', (event) => {
    event.preventDefault();
    tr.classList.remove('is-drag-over');
    const draggedCode = state.dragCode || event.dataTransfer.getData('text/plain');
    state.dragCode = null;
    if (draggedCode && draggedCode !== row.code) {
      reorderRows(draggedCode, row.code, row.isPinned);
    }
  });
}

function createSignalCell(row) {
  const td = document.createElement('td');
  const wrapper = createElement('div', 'score-card-line');
  wrapper.style.justifyContent = 'flex-end';
  wrapper.append(createScorePill(row));
  td.append(wrapper);
  return td;
}

function createScorePill(row) {
  const score = Number.isFinite(row.score) ? row.score : null;
  const levelKey = row.scoreLevel?.key || 'empty';
  const pill = createElement(
    'span',
    `score-pill ${levelKey}`
  );
  if (score === null) {
    pill.append(createElement('span', '', '数据不足'));
    return pill;
  }
  pill.append(
    createElement('strong', '', score.toFixed(1)),
    createElement('span', '', row.scoreLevel?.label || '评分')
  );
  return pill;
}

function renderLogs() {
  elements.updateLogs.replaceChildren();
  const logs = state.summary?.logs || [];
  if (!logs.length) {
    elements.updateLogs.append(createElement('div', 'log-line', '等待首次更新'));
    return;
  }
  for (const log of logs.slice(0, 5)) {
    const line = createElement(
      'div',
      `log-line ${log.status === 'error' ? 'log-error' : ''}`,
      `${formatter.fullTime(log.createdAt)} · ${log.message || log.status}`
    );
    elements.updateLogs.append(line);
  }
}

async function openManagement() {
  state.manageOpen = true;
  elements.manageBackdrop.hidden = false;
  elements.manageDialog.classList.add('is-open');
  elements.manageDialog.setAttribute('aria-hidden', 'false');
  pageMain?.toggleAttribute('inert', true);
  pageHeader?.toggleAttribute('inert', true);
  document.body.style.overflow = 'hidden';
  elements.manageClose.focus();
  elements.manageEtfList.replaceChildren(createElement('div', 'table-loading', '正在加载目录...'));
  try {
    const payload = await fetchJson('/api/etfs/manage?includeSummary=false');
    applyCatalogPayload(payload);
  } catch (error) {
    elements.manageEtfList.replaceChildren(
      createElement('div', 'error-banner', `ETF 管理目录加载失败：${error.message}`)
    );
  }
}

function closeManagement() {
  state.manageOpen = false;
  elements.manageBackdrop.hidden = true;
  elements.manageDialog.classList.remove('is-open');
  elements.manageDialog.setAttribute('aria-hidden', 'true');
  if (!elements.drawer.classList.contains('is-open')) {
    pageMain?.toggleAttribute('inert', false);
    pageHeader?.toggleAttribute('inert', false);
    document.body.style.overflow = '';
  }
  elements.manageEtfButton.focus();
}

function applyCatalogPayload(payload) {
  const catalog = payload.catalog || payload;
  state.catalog = catalog;
  if (payload.summary) {
    state.summary = {
      ...payload.summary,
      apiVersion: payload.apiVersion || state.summary?.apiVersion,
      buildId: payload.buildId || state.summary?.buildId
    };
    state.rows = state.summary.etfs || [];
    renderSummary();
    renderTable();
  }
  renderManageCatalog(catalog);
}

function renderManageCatalog(catalog) {
  const enabled = catalog.enabled || [];
  const removed = catalog.removed || [];
  elements.manageCapacity.textContent =
    `${catalog.enabledCount ?? enabled.length} / ${catalog.capacity ?? 30} 只 · 移出后保留历史数据库`;
  elements.manageEtfList.replaceChildren();
  if (!enabled.length) {
    elements.manageEtfList.append(createElement('div', 'manage-empty', '当前没有监控中的 ETF'));
  }
  for (const etf of enabled) {
    elements.manageEtfList.append(createManageEtfRow(etf, catalog.tones || {}));
  }
  elements.removedEtfList.replaceChildren();
  if (!removed.length) {
    elements.removedEtfList.append(createElement('div', 'manage-empty', '暂无已移出的 ETF'));
  }
  for (const etf of removed) {
    const row = createElement('div', 'manage-etf-row');
    const identity = createElement('div', 'manage-etf-identity');
    identity.append(
      createElement('strong', '', etf.name),
      createElement('span', '', `${etf.code} · ${etf.category} · 历史保留`)
    );
    const restored = createElement('button', 'button button-quiet', '恢复监控');
    restored.type = 'button';
    restored.addEventListener('click', () => restoreManagedEtf(etf.code));
    const actions = createElement('div', 'manage-row-actions');
    actions.append(restored);
    row.append(identity, actions);
    elements.removedEtfList.append(row);
  }
}

function createManageEtfRow(etf, tones) {
  const row = createElement('div', 'manage-etf-row');
  const identity = createElement('div', 'manage-etf-identity');
  identity.append(
    createElement('strong', '', etf.name),
    createElement('span', '', `${etf.code} · ${etf.isPinned ? '置顶区' : '普通区'}`)
  );
  const category = document.createElement('input');
  category.value = etf.category;
  category.maxLength = 24;
  category.setAttribute('aria-label', `${etf.code} 分类`);
  const tone = document.createElement('select');
  tone.setAttribute('aria-label', `${etf.code} 颜色`);
  for (const [key, label] of Object.entries(tones)) {
    const option = createElement('option', '', label);
    option.value = key;
    option.selected = etf.tone === key;
    tone.append(option);
  }
  const pinnedLabel = createElement('label', 'check-label');
  const pinned = document.createElement('input');
  pinned.type = 'checkbox';
  pinned.checked = etf.isPinned;
  pinnedLabel.append(pinned, document.createTextNode('置顶'));
  const highlightLabel = createElement('label', 'check-label');
  const highlighted = document.createElement('input');
  highlighted.type = 'checkbox';
  highlighted.checked = etf.isHighlighted;
  highlightLabel.append(highlighted, document.createTextNode('重点'));
  const actions = createElement('div', 'manage-row-actions');
  const save = createElement('button', 'button button-quiet', '保存');
  save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const payload = await fetchJson(`/api/etfs/${etf.code}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: category.value,
          tone: tone.value,
          isPinned: pinned.checked,
          isHighlighted: highlighted.checked
        })
      });
      applyCatalogPayload(payload);
      showToast(`${etf.code} 设置已保存`);
    } catch (error) {
      showToast(`设置保存失败：${error.message}`);
    } finally {
      save.disabled = false;
    }
  });
  const remove = createElement('button', 'button button-quiet', '移出');
  remove.type = 'button';
  remove.addEventListener('click', () => removeManagedEtf(etf));
  actions.append(save, remove);
  row.append(identity, category, tone, pinnedLabel, highlightLabel, actions);
  return row;
}

async function removeManagedEtf(etf) {
  const confirmed = window.confirm(
    `确认将 ${etf.code} ${etf.name} 移出监控？\n` +
    '它会从表格、汇总、评分、导出和后续抓取中排除；历史数据库会保留。'
  );
  if (!confirmed) return;
  try {
    const payload = await fetchJson(`/api/etfs/${etf.code}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    });
    applyCatalogPayload(payload);
    showToast(`${etf.code} 已移出监控，历史数据已保留`);
  } catch (error) {
    showToast(`移出失败：${error.message}`);
  }
}

async function restoreManagedEtf(code) {
  try {
    const payload = await fetchJson(`/api/etfs/${code}/restore`, { method: 'POST' });
    applyCatalogPayload(payload);
    showToast(`${code} 已恢复监控`);
  } catch (error) {
    showToast(`恢复失败：${error.message}`);
  }
}

let lookupTimer;
function scheduleEtfLookup() {
  clearTimeout(lookupTimer);
  const code = elements.newEtfCode.value.trim();
  state.lookupCandidate = null;
  elements.addEtfButton.disabled = true;
  elements.newEtfName.value = '';
  if (code.length !== 6) {
    elements.etfLookupStatus.className = 'catalog-status';
    elements.etfLookupStatus.textContent = '输入 6 位 ETF 代码后自动校验。';
    return;
  }
  lookupTimer = setTimeout(() => lookupNewEtf(code), 300);
}

async function lookupNewEtf(code = elements.newEtfCode.value.trim()) {
  elements.etfLookupStatus.className = 'catalog-status';
  elements.etfLookupStatus.textContent = '正在查询名称、市场与 ETF 类型...';
  try {
    const payload = await fetchJson(`/api/etfs/lookup?code=${encodeURIComponent(code)}`);
    if (elements.newEtfCode.value.trim() !== code) return;
    state.lookupCandidate = payload.candidate;
    elements.newEtfName.value = payload.candidate.name;
    elements.etfLookupStatus.className = 'catalog-status success';
    elements.etfLookupStatus.textContent =
      `${payload.candidate.exchange} · ${payload.candidate.securityType} · 校验通过`;
    elements.addEtfButton.disabled = false;
  } catch (error) {
    state.lookupCandidate = null;
    elements.addEtfButton.disabled = true;
    elements.etfLookupStatus.className = 'catalog-status error';
    elements.etfLookupStatus.textContent = error.message;
  }
}

async function addManagedEtf(event) {
  event.preventDefault();
  const code = elements.newEtfCode.value.trim();
  if (!state.lookupCandidate || state.lookupCandidate.code !== code) {
    await lookupNewEtf(code);
  }
  if (!state.lookupCandidate) return;
  elements.addEtfButton.disabled = true;
  try {
    const payload = await fetchJson('/api/etfs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        category: elements.newEtfCategory.value,
        tone: elements.newEtfTone.value,
        isPinned: elements.newEtfPinned.checked,
        isHighlighted: elements.newEtfHighlighted.checked
      })
    });
    applyCatalogPayload(payload);
    elements.addEtfForm.reset();
    state.lookupCandidate = null;
    elements.etfLookupStatus.className = 'catalog-status success';
    elements.etfLookupStatus.textContent =
      `${code} 已加入监控，行情、IOPV 与官方份额正在后台补齐。`;
    showToast('ETF 已加入，后台历史正在积累');
  } catch (error) {
    elements.etfLookupStatus.className = 'catalog-status error';
    elements.etfLookupStatus.textContent = error.message;
    elements.addEtfButton.disabled = false;
  }
}

async function restoreDefaultOrder() {
  if (state.savingOrder) return;
  state.savingOrder = true;
  elements.restoreDefaultOrder.disabled = true;
  try {
    const payload = await fetchJson('/api/etfs/order/restore', { method: 'POST' });
    applyCatalogPayload(payload);
    showToast('已恢复默认排序：159915 第一、159516 第二');
  } catch (error) {
    showToast(`恢复默认排序失败：${error.message}`);
  } finally {
    state.savingOrder = false;
    elements.restoreDefaultOrder.disabled = false;
  }
}

async function openDetail(code) {
  rememberDrawerTrigger(`[data-etf-code="${code}"]`);
  state.detailRequest?.abort();
  const request = new AbortController();
  state.detailRequest = request;
  state.detailData = null;
  state.shareRange = 250;
  const row = state.rows.find((item) => item.code === code);
  elements.drawerCategory.textContent = `${code} · ${row?.category || 'ETF'}`;
  elements.drawerTitle.textContent = row?.name || code;
  elements.drawerBody.replaceChildren(createElement('div', 'table-loading', '正在加载详情...'));
  elements.drawerBackdrop.hidden = false;
  elements.drawer.classList.add('is-open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  pageMain?.toggleAttribute('inert', true);
  pageHeader?.toggleAttribute('inert', true);
  elements.drawerClose.focus();
  const options = { signal: request.signal };
  const intradayResult = fetchJson(`/api/etfs/${code}/intraday`, options).then(
    (data) => ({ data }), (error) => ({ error })
  );
  try {
    const detail = await fetchJson(`/api/etfs/${code}?compact=1`, options);
    if (state.detailRequest === request) renderDetail(detail, intradayResult);
  } catch (error) {
    if (state.detailRequest === request) {
      request.abort();
      elements.drawerBody.replaceChildren(createElement('div', 'error-banner', `详情加载失败：${error.message}`));
    }
  }
}

function renderDetail(detail, intradayResult) {
  const row = detail.quote;
  state.detailData = detail;
  elements.drawerBody.replaceChildren();
  const iopv = detail.iopvHistory;
  const currentIopv = iopv?.current || {};
  const currentShareMetric = row.currentDayShareMetrics || {};
  const currentShareStatus = shareMetricStatusLabel(row.shareMetricStatus);
  const latestOfficialStatus = shareMetricStatusLabel(row.latestOfficialMetricStatus);
  const premiumUnavailableLabel = currentIopv.label || (row.premiumStatus === 'valid' ? '暂无' : '数据异常');
  const items = [
    ['最新价', formatter.price(row.price), ''],
    ['当前 IOPV', Number.isFinite(currentIopv.iopv) ? formatter.price(currentIopv.iopv) : '暂无', currentIopv.status === 'valid' ? '' : 'status-warning'],
    ['IOPV 对应市场价', Number.isFinite(currentIopv.marketPrice) ? formatter.price(currentIopv.marketPrice) : '暂无', ''],
    ['当前折溢价', Number.isFinite(row.premiumRate) ? formatter.percent(row.premiumRate) : premiumUnavailableLabel, row.premiumAbnormal ? 'premium-warning' : directionClass(row.premiumRate)],
    ['IOPV 来源', currentIopv.source || '暂无', currentIopv.sourceKind === 'official' ? '' : 'status-warning'],
    ['IOPV 数据时间', currentIopv.dataTime || '暂无', currentIopv.status === 'valid' ? 'neutral' : 'status-warning'],
    ['涨跌幅', formatter.percentDirect(row.changePercent), directionClass(row.changePercent)],
    ['开盘', formatter.price(row.open), ''],
    ['最高', formatter.price(row.high), ''],
    ['最低', formatter.price(row.low), ''],
    ['前收', formatter.price(row.previousClose), ''],
    ['成交量', formatter.volume(row.volume), ''],
    ['成交额', formatter.amount(row.amount), ''],
    ['换手率', formatter.plainPercent(row.turnoverRate), ''],
    ['20日量比', formatter.ratio(row.volumeRatio), row.volumeRatio >= 2 ? 'positive' : ''],
    ['近5日', formatter.percent(row.return5d), directionClass(row.return5d)],
    ['近20日', formatter.percent(row.return20d), directionClass(row.return20d)],
    ['行情快照份额', formatter.shares(row.quoteShares), 'neutral'],
    ['行情快照日期', row.quoteShareDate ? `${row.quoteShareDate} · 行情快照` : '--', 'neutral'],
    ['当前官方份额', Number.isFinite(row.shares) ? formatter.shares(row.shares) : '待官方发布', row.shareMetricStatus === 'ready' ? '' : 'status-warning'],
    ['当前官方份额日期', currentShareMetric.officialShareDate || '待官方发布', 'neutral'],
    ['当前日指标状态', currentShareStatus, row.shareMetricStatus === 'ready' ? '' : 'status-warning'],
    ['当前日上一官方份额', row.previousOfficialShareDate
      ? `${row.previousOfficialShareDate} · ${formatter.shares(row.previousOfficialShares)} · ${row.previousOfficialShareSource}`
      : '暂无', 'neutral'],
    ['当前日官方份额变化', row.shareMetricStatus === 'ready'
      ? formatter.signedShares(row.shareDelta)
      : currentShareStatus, directionClass(row.shareDelta)],
    ['当前日估算净申赎', row.shareMetricStatus === 'ready'
      ? formatter.signedAmount(row.estimatedSubscription)
      : currentShareStatus, directionClass(row.estimatedSubscription)],
    ['最近官方总份额', row.officialShareDate
      ? `${row.officialShareDate} · ${formatter.shares(row.officialShares)}`
      : '暂无', 'neutral'],
    ['最近官方日份额变化', row.latestOfficialMetricStatus === 'ready'
      ? `${row.latestOfficialShareDeltaDate} 官方日终 · ${formatter.signedShares(row.latestOfficialShareDelta)}`
      : latestOfficialStatus, directionClass(row.latestOfficialShareDelta)],
    ['最近官方日上一份额', row.latestOfficialPreviousDate
      ? `${row.latestOfficialPreviousDate} · ${formatter.shares(row.latestOfficialPreviousShares)}`
      : '暂无', 'neutral'],
    ['最近官方日估算净申赎', row.latestOfficialMetricStatus === 'ready'
      ? `${row.latestOfficialShareDeltaDate} · ${formatter.signedAmount(row.latestOfficialEstimatedSubscription)}`
      : latestOfficialStatus, directionClass(row.latestOfficialEstimatedSubscription)],
    ['近5日累计估算净申赎', row.estimatedSubscription5dStatus === 'ready'
      ? formatter.signedAmount(row.estimatedSubscription5d)
      : `历史积累中 ${row.estimatedSubscription5dCoverage || 0}/5日`,
    directionClass(row.estimatedSubscription5d)],
    ['近20日累计估算净申赎', row.estimatedSubscription20dStatus === 'ready'
      ? formatter.signedAmount(row.estimatedSubscription20d)
      : `历史积累中 ${row.estimatedSubscription20dCoverage || 0}/20日`,
    directionClass(row.estimatedSubscription20d)],
    ['官方份额日期与状态', row.officialShareDate
      ? `${row.officialShareDate} · ${row.latestOfficialMetricStatus === 'ready' ? '官方日终' : latestOfficialStatus}`
      : '待数据', row.latestOfficialMetricStatus === 'ready' ? '' : 'status-warning'],
    ['估算基金规模', formatter.amount(row.estimatedFundSize ?? row.marketValue), 'neutral'],
    ['20日波动率', formatter.plainPercent(
      Number.isFinite(row.volatility20d) ? row.volatility20d * 100 : null,
      2
    ), ''],
    ['成交额分位', formatter.plainPercent(row.amountPercentile === null ? null : row.amountPercentile * 100, 1), ''],
    ['连续净申赎', row.shareStreak?.days
      ? `${row.shareStreak.label} ${row.shareStreak.days}日 · 截至 ${row.shareStreakDate}`
      : '无连续序列', directionClass(row.shareStreak?.direction === 'subscription' ? 1 : row.shareStreak?.direction === 'redemption' ? -1 : 0)],
    ['250日份额分位', formatter.plainPercent(row.sharePercentile === null ? null : row.sharePercentile * 100, 1), ''],
    ['最新官方来源', row.officialShareDate ? `${row.officialShareDate} · ${row.officialShareSource}` : '暂无官方记录', 'neutral']
  ];
  const metricGroups = [
    {
      title: '关键结论',
      hint: '行情、成交与最近官方日',
      labels: [
        '最新价', '涨跌幅', '成交额', '当前折溢价', '当前官方份额',
        '最近官方日估算净申赎', '近5日累计估算净申赎', '近20日累计估算净申赎'
      ]
    },
    {
      title: '行情与估值',
      hint: '当前快照与短周期表现',
      labels: [
        '当前 IOPV', 'IOPV 对应市场价', 'IOPV 来源', 'IOPV 数据时间', '开盘',
        '最高', '最低', '前收', '成交量', '换手率', '20日量比', '近5日',
        '近20日', '行情快照份额', '行情快照日期'
      ]
    },
    {
      title: '官方份额与净申赎',
      hint: '交易所日终数据，不使用行情快照替代',
      labels: [
        '当前官方份额日期', '当前日指标状态', '当前日上一官方份额', '当前日官方份额变化',
        '当前日估算净申赎', '最近官方总份额', '最近官方日份额变化', '最近官方日上一份额',
        '官方份额日期与状态', '连续净申赎', '250日份额分位', '最新官方来源'
      ]
    },
    {
      title: '风险与历史分位',
      hint: '规模、波动与成交结构',
      labels: ['估算基金规模', '20日波动率', '成交额分位']
    }
  ].map((group) => ({ ...group, metrics: createElement('div', 'detail-metrics') }));
  for (const [label, value, className] of items) {
    const card = createElement('div', 'detail-metric');
    card.append(createElement('span', '', label), createElement('strong', className, value));
    const group = metricGroups.find((item) => item.labels.includes(label)) || metricGroups[0];
    group.metrics.append(card);
  }
  for (const group of metricGroups) {
    if (!group.metrics.childElementCount) continue;
    const section = createElement('section', 'detail-section');
    const heading = createElement('div', 'detail-section-head');
    heading.append(
      createElement('h3', '', group.title),
      createElement('span', '', group.hint)
    );
    section.append(heading, group.metrics);
    elements.drawerBody.append(section);
  }

  const scoreNote = createElement('section', 'signal-note');
  const scoreHeading = createElement('div', 'chart-card-heading');
  scoreHeading.append(createElement('h3', '', '异常资金评分贡献'));
  const scoreActions = createElement('div', 'score-card-line');
  scoreActions.append(createScorePill(row));
  scoreHeading.append(scoreActions);
  scoreNote.append(scoreHeading);
  if (row.scoreComponents?.length) {
    const componentGrid = createElement('div', 'score-component-grid');
    for (const component of row.scoreComponents) {
      componentGrid.append(createScoreComponent(component));
    }
    scoreNote.append(componentGrid);
    const scoreMethod = createElement(
      'p',
      'data-note',
      `评分基于最近完整评分日 ${row.scoreDate}，只使用该日及以前数据。40–59 观察，60–79 活跃异动，80–100 高强度异动；这不是账户身份判断。`
    );
    scoreNote.append(scoreMethod);
  } else {
    scoreNote.append(createElement(
      'p',
      'data-note',
      '数据不足：需要至少 20 个连续可配对的官方份额变化，以及完整的 20 日成交额基准。缺失日期不使用 0 或模拟值补齐。'
    ));
  }
  elements.drawerBody.append(scoreNote);

  const signalNote = createElement('section', 'signal-note');
  signalNote.append(createElement('h3', '', '旧版规则对照'));
  const signalList = createElement('div', 'signal-explain-list');
  const detailSignals = row.signals || [];
  const emptySignals = createElement('p', '', '旧版规则当前没有触发标签');
  if (!detailSignals.length) {
    signalList.append(emptySignals);
  } else {
    for (const signal of detailSignals) {
      signalList.append(createElement(
        'p',
        '',
        `${signal.label}：${signalCondition(signal.key, row)}`
      ));
    }
  }
  signalNote.append(signalList);
  elements.drawerBody.append(signalNote);

  const sourceLinks = createElement('div', 'source-links');
  const methodologyLink = createElement('a', 'source-link', '指标口径');
  methodologyLink.href = '#methodology';
  methodologyLink.addEventListener('click', (event) => {
    event.preventDefault();
    closeDrawer();
    document.querySelector('#methodology').focus();
  });
  sourceLinks.append(methodologyLink);
  const sourceLink = createElement('a', 'source-link', '东方财富原始行情 ↗');
  sourceLink.href = `https://quote.eastmoney.com/${row.code}.html`;
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  sourceLinks.append(sourceLink);
  if (iopv?.sourceUrl) {
    const iopvLink = createElement(
      'a',
      'source-link',
      `${iopv.source || 'IOPV'} 原始数据 ↗`
    );
    iopvLink.href = iopv.sourceUrl;
    iopvLink.target = '_blank';
    iopvLink.rel = 'noopener noreferrer';
    sourceLinks.append(iopvLink);
  }
  if (detail.shareHistory?.sourceUrl) {
    const officialLink = createElement(
      'a',
      'source-link',
      `${detail.shareHistory.sourceName}官方份额 ↗`
    );
    officialLink.href = detail.shareHistory.sourceUrl;
    officialLink.target = '_blank';
    officialLink.rel = 'noopener noreferrer';
    sourceLinks.append(officialLink);
  }
  elements.drawerBody.append(sourceLinks);

  const iopvCard = createElement('section', 'chart-card iopv-chart-card');
  const iopvHeading = createElement('div', 'chart-card-heading');
  iopvHeading.append(
    createElement('h3', '', '当日市场价与 IOPV'),
    createElement('span', 'muted-note', iopv?.updateFrequency || '交易所实时数据')
  );
  const iopvStats = createElement('div', 'share-range-summary iopv-intraday-stats');
  iopvStats.id = 'iopvIntradayStats';
  const iopvChart = createElement('div', 'chart chart-tall');
  iopvChart.id = 'iopvIntradayChart';
  const iopvNote = createElement('div', 'share-coverage-note');
  iopvNote.id = 'iopvCoverageNote';
  const iopvExport = createElement('a', 'button button-quiet share-export', '导出折溢价历史 CSV');
  iopvExport.href = `/api/export.csv?code=${row.code}&type=iopv`;
  iopvCard.append(iopvHeading, iopvStats, iopvChart, iopvNote, iopvExport);
  elements.drawerBody.append(iopvCard);

  const shareCard = createElement('section', 'chart-card share-chart-card');
  const shareHeading = createElement('div', 'chart-card-heading');
  shareHeading.append(createElement('h3', '', '官方份额与累计净申赎'));
  const rangeTabs = createElement('div', 'range-tabs');
  rangeTabs.setAttribute('role', 'tablist');
  rangeTabs.setAttribute('aria-label', '份额历史视角');
  for (const days of [20, 60, 250]) {
    const button = createElement(
      'button',
      `range-tab ${state.shareRange === days ? 'active' : ''}`,
      `${days}日`
    );
    button.type = 'button';
    button.dataset.range = String(days);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.shareRange === days));
    button.addEventListener('click', () => selectShareRange(days));
    rangeTabs.append(button);
  }
  shareHeading.append(rangeTabs);
  const rangeSummary = createElement('div', 'share-range-summary');
  rangeSummary.id = 'shareRangeSummary';
  const shareChart = createElement('div', 'chart chart-tall');
  shareChart.id = 'shareHistoryChart';
  const coverageNote = createElement('div', 'share-coverage-note');
  coverageNote.id = 'shareCoverageNote';
  const shareExport = createElement('a', 'button button-quiet share-export', '导出官方份额 CSV');
  shareExport.href = `/api/export.csv?code=${row.code}&type=shares`;
  shareCard.append(shareHeading, rangeSummary, shareChart, coverageNote, shareExport);
  elements.drawerBody.append(shareCard);

  const intradayCard = createElement('section', 'chart-card');
  intradayCard.append(createElement('h3', '', '当日分时'));
  const intradayNote = createElement('div', 'share-coverage-note', '正在加载东方财富分时');
  intradayNote.setAttribute('role', 'status');
  const intradayChart = createElement('div', 'chart');
  intradayChart.id = 'intradayChart';
  intradayCard.append(intradayNote, intradayChart);
  elements.drawerBody.append(intradayCard);

  const dailyCard = createElement('section', 'chart-card');
  dailyCard.append(createElement('h3', '', '近两年日 K 与成交额'));
  const dailyChart = createElement('div', 'chart chart-tall');
  dailyChart.id = 'dailyChart';
  dailyCard.append(dailyChart);
  elements.drawerBody.append(dailyCard);

  afterRender(() => {
    if (state.detailData !== detail || !window.echarts) return;
    state.charts.forEach((instance) => instance.dispose());
    const shareInstance = echarts.init(shareChart);
    const intradayInstance = echarts.init(intradayChart);
    const dailyInstance = echarts.init(dailyChart);
    const iopvIntradayInstance = echarts.init(iopvChart);
    state.shareChart = shareInstance;
    renderShareRange();
    renderIopvCharts(iopv, iopvIntradayInstance);
    dailyInstance.setOption(buildDailyOption(detail.bars || []));
    state.charts = [
      shareInstance,
      intradayInstance,
      dailyInstance,
      iopvIntradayInstance
    ];
    intradayResult.then(({ data, error }) => {
      if (state.detailData !== detail) return;
      if (!data?.points?.length) {
        const message = error ? `分时加载失败：${error.message}` : '东方财富暂无分时记录';
        intradayNote.textContent = message;
        intradayInstance.setOption(emptyChartOption('分时暂不可用'), true);
        return;
      }
      intradayNote.textContent = [
        `东方财富 · ${data.points.at(-1).time.slice(0, 10)}`,
        Number.isFinite(data.tailVolumeShare) ? `尾盘成交占比 ${formatter.plainPercent(data.tailVolumeShare * 100)}` : null
      ].filter(Boolean).join(' · ');
      intradayInstance.setOption(buildIntradayOption(data), true);
      if (data.tailVolumeShare >= 0.2 && !detailSignals.some((signal) => signal.key === 'tail-volume')) {
        emptySignals.remove();
        signalList.append(createElement('p', '', `尾盘异动：${signalCondition('tail-volume', row)}`));
      }
    });
  });
}

function selectShareRange(days) {
  state.shareRange = days;
  document.querySelectorAll('.range-tab').forEach((button) => {
    const active = Number(button.dataset.range) === days;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  renderShareRange();
}

function renderShareRange() {
  const history = state.detailData?.shareHistory;
  const summary = document.querySelector('#shareRangeSummary');
  const note = document.querySelector('#shareCoverageNote');
  if (!summary || !note) return;
  summary.replaceChildren();
  if (!history) {
    summary.append(createElement('div', 'share-empty', '官方份额历史暂不可用'));
    note.textContent = '尚未取得官方份额记录，不以模拟数据补齐。';
    state.shareChart?.clear();
    return;
  }
  const range = history.ranges?.[state.shareRange] || history.range;
  if (!range) {
    summary.append(createElement('div', 'share-empty', '该视角暂无可用数据'));
    note.textContent = '官方接口暂未返回该区间记录。';
    state.shareChart?.clear();
    return;
  }
  const items = [
    ['区间累计净申赎', range.periodEstimatedSubscription === null
      ? '--'
      : formatter.signedAmount(range.periodEstimatedSubscription),
    directionClass(range.periodEstimatedSubscription)],
    ['区间份额变化', range.periodShareDelta === null
      ? '--'
      : formatter.signedShares(range.periodShareDelta),
    directionClass(range.periodShareDelta)],
    ['期末份额分位', formatter.plainPercent(
      range.sharePercentile === null ? null : range.sharePercentile * 100,
      1
    ), ''],
    ['官方可取得', `${range.coverage?.availableDays ?? 0} / ${state.shareRange} 日`, 'neutral']
  ];
  for (const [label, value, className] of items) {
    const card = createElement('div', 'share-range-stat');
    card.append(createElement('span', '', label), createElement('strong', className, value));
    summary.append(card);
  }
  const coverage = range.coverage;
  const statusText = coverage?.status === 'complete'
    ? '窗口完整'
    : coverage?.status === 'partial'
      ? `缺少 ${coverage.missingDays} 个交易日`
      : '暂无官方记录';
  const missingText = coverage?.missingRecentDates?.length
    ? `；近期缺口 ${coverage.missingRecentDates.join('、')}`
    : '';
  const estimateText = Number.isInteger(coverage?.estimatedDays)
    ? `；连续份额 ${coverage.shareDeltaDays}/${state.shareRange} 日，有效估算 ${coverage.estimatedDays}/${state.shareRange} 日`
    : '';
  note.textContent = `${statusText}${missingText}${estimateText}。数据来源：${history.sourceName || '交易所'}官方接口；${history.note}`;
  state.shareChart?.setOption(buildShareOption(range, history), true);
}

function buildShareOption(range, history) {
  const points = range.points || [];
  const dates = points.map((point) => point.tradeDate);
  const shares = points.map((point) => (
    Number.isFinite(point.shares) ? point.shares / 1e8 : null
  ));
  const cumulative = points.map((point) => (
    Number.isFinite(point.cumulativeEstimatedSubscription)
      ? point.cumulativeEstimatedSubscription / 1e8
      : null
  ));
  return {
    animation: false,
    backgroundColor: 'transparent',
    aria: { enabled: true },
    color: [CHART_COLORS.primary, CHART_COLORS.reference],
    legend: {
      top: 0,
      left: 'center',
      textStyle: { color: CHART_COLORS.axisLabel, fontSize: 11 },
      data: ['官方总份额', '累计估算净申赎']
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.tooltipBg,
      borderColor: CHART_COLORS.tooltipBorder,
      textStyle: { color: CHART_COLORS.tooltipText },
      formatter: (items) => {
        const index = items[0]?.dataIndex ?? 0;
        const point = points[index];
        if (!point) return '';
        return [
          point.tradeDate,
          `官方总份额：${formatter.shares(point.shares)}`,
          `当日份额变化：${point.shareDelta === null ? '--' : formatter.signedShares(point.shareDelta)}`,
          `当日估算净申赎：${point.estimatedSubscription === null ? '--' : formatter.signedAmount(point.estimatedSubscription)}`,
          `累计估算净申赎：${point.cumulativeEstimatedSubscription === null ? '--' : formatter.signedAmount(point.cumulativeEstimatedSubscription)}`,
          `来源：${point.source || history.sourceName}`
        ].join('<br>');
      }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: { left: 56, right: 58, top: 42, bottom: 54 },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
      axisLabel: {
        color: CHART_COLORS.axisLabel,
        hideOverlap: true,
        formatter: (value) => value.slice(5)
      },
      axisTick: { show: false }
    },
    yAxis: [
      {
        type: 'value',
        name: '总份额（亿份）',
        scale: true,
        nameTextStyle: { color: CHART_COLORS.axisLabel, fontSize: 10 },
        splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
        axisLabel: {
          color: CHART_COLORS.axisLabel,
          formatter: (value) => value.toFixed(value >= 10 ? 0 : 1)
        }
      },
      {
        type: 'value',
        name: '累计净申赎（亿元）',
        scale: true,
        nameTextStyle: { color: CHART_COLORS.axisLabel, fontSize: 10 },
        splitLine: { show: false },
        axisLabel: {
          color: CHART_COLORS.axisLabel,
          formatter: (value) => value.toFixed(Math.abs(value) >= 10 ? 0 : 1)
        }
      }
    ],
    dataZoom: [{
      type: 'inside',
      xAxisIndex: [0],
      start: 0,
      end: 100
    }],
    series: [
      {
        name: '官方总份额',
        type: 'line',
        data: shares,
        showSymbol: points.length <= 60,
        symbolSize: 4,
        connectNulls: false,
        lineStyle: { color: CHART_COLORS.primary, width: 2 },
        itemStyle: { color: CHART_COLORS.primary },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(111,156,236,0.16)' },
              { offset: 1, color: 'rgba(111,156,236,0.01)' }
            ]
          }
        }
      },
      {
        name: '累计估算净申赎',
        type: 'line',
        yAxisIndex: 1,
        data: cumulative,
        showSymbol: points.length <= 60,
        symbolSize: 4,
        connectNulls: false,
        lineStyle: { color: CHART_COLORS.reference, width: 2 },
        itemStyle: { color: CHART_COLORS.reference },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: CHART_COLORS.zeroLine, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }]
        }
      }
    ]
  };
}

function renderIopvCharts(history, intradayInstance) {
  const statsNode = document.querySelector('#iopvIntradayStats');
  const coverageNode = document.querySelector('#iopvCoverageNote');
  if (!statsNode || !coverageNode) return;

  const stats = history?.stats || {};
  const statItems = [
    ['首个记录时点', formatter.percent(stats.first ?? stats.open, 3)],
    ['最高', formatter.percent(stats.high, 3)],
    ['最低', formatter.percent(stats.low, 3)],
    ['均值', formatter.percent(stats.mean, 3)],
    ['最新', formatter.percent(stats.latest, 3)]
  ];
  statsNode.replaceChildren();
  for (const [label, value] of statItems) {
    const card = createElement('div', 'share-range-stat');
    card.append(createElement('span', '', label), createElement('strong', '', value));
    statsNode.append(card);
  }
  const current = history?.current || {};
  coverageNode.textContent = [
    current.label || '暂无',
    `${stats.sampleCount || 0} 个已记录时点`,
    stats.firstTime ? `首条：${stats.firstTime}` : null,
    stats.lastTime ? `末条：${stats.lastTime}` : null,
    current.source ? `来源：${current.source}` : null,
    current.dataTime ? `数据时间：${current.dataTime}` : null,
    history?.note || 'IOPV 缺失时不补零或推算。'
  ].filter(Boolean).join(' · ');

  if ((history?.intraday || []).length) {
    intradayInstance.setOption(buildIopvIntradayOption(history.intraday), true);
  } else {
    intradayInstance.clear();
    intradayInstance.setOption(emptyChartOption('当日暂无有效市场价与 IOPV 配对样本'), true);
  }
}

function buildIopvIntradayOption(points) {
  const labels = points.map((point) => point.dataTime?.slice(11, 16) || '--');
  const prices = points.map((point) => point.marketPrice);
  const iopvs = points.map((point) => point.iopv);
  const premiums = points.map((point) => (
    Number.isFinite(point.premiumRate) ? point.premiumRate * 100 : null
  ));
  return {
    animation: false,
    backgroundColor: 'transparent',
    aria: { enabled: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.tooltipBg,
      borderColor: CHART_COLORS.tooltipBorder,
      textStyle: { color: CHART_COLORS.tooltipText },
      formatter: (items) => {
        const index = items[0]?.dataIndex ?? 0;
        const point = points[index];
        return [
          point.dataTime,
          `市场价：${formatter.price(point.marketPrice)}`,
          `IOPV：${formatter.price(point.iopv)}`,
          `折溢价：${formatter.percent(point.premiumRate, 3)}`,
          `来源：${point.source}`
        ].join('<br>');
      }
    },
    legend: {
      top: 0,
      left: 'center',
      data: ['市场价', 'IOPV', '折溢价'],
      textStyle: { color: CHART_COLORS.axisLabel, fontSize: 11 }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 54, right: 24, top: 42, height: 205 },
      { left: 54, right: 24, top: 276, height: 72 }
    ],
    xAxis: [
      {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
        axisLabel: { color: CHART_COLORS.axisLabel, hideOverlap: true },
        axisTick: { show: false }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
        axisLabel: { color: CHART_COLORS.axisLabel, hideOverlap: true },
        axisTick: { show: false }
      }
    ],
    yAxis: [
      {
        type: 'value',
        scale: true,
        splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
        axisLabel: { color: CHART_COLORS.axisLabel }
      },
      {
        type: 'value',
        gridIndex: 1,
        scale: true,
        splitNumber: 2,
        splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
        axisLabel: { color: CHART_COLORS.axisLabel, formatter: (value) => `${value.toFixed(1)}%` }
      }
    ],
    series: [
      {
        name: '市场价',
        type: 'line',
        data: prices,
        symbol: 'none',
        lineStyle: { color: CHART_COLORS.primary, width: 2 },
        itemStyle: { color: CHART_COLORS.primary }
      },
      {
        name: 'IOPV',
        type: 'line',
        data: iopvs,
        symbol: points.length <= 2 ? 'circle' : 'none',
        symbolSize: 5,
        lineStyle: { color: CHART_COLORS.reference, width: 2 },
        itemStyle: { color: CHART_COLORS.reference }
      },
      {
        name: '折溢价',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: premiums,
        symbol: points.length <= 2 ? 'circle' : 'none',
        symbolSize: 5,
        lineStyle: { color: CHART_COLORS.secondary, width: 1.8 },
        itemStyle: { color: CHART_COLORS.secondary },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: CHART_COLORS.zeroLine, type: 'dashed' },
          data: [{ yAxis: 0 }]
        }
      }
    ]
  };
}

function emptyChartOption(message) {
  return {
    animation: false,
    graphic: {
      type: 'text',
      left: 'center',
      top: 'middle',
      style: { text: message, fill: '#75869b', fontSize: 12 }
    },
    xAxis: { show: false },
    yAxis: { show: false },
    series: []
  };
}

function signalCondition(key, row) {
  const dataTime = formatter.time(row.dataTime);
  const conditions = {
    volume: `20日量比 ${formatter.ratio(row.volumeRatio)}，触发阈值 2.00×`,
    'sustained-volume': '当日与上一完整交易日均达到 1.50× 以上',
    'tail-volume': '14:30 后成交额占全天成交额达到 20% 以上',
    'share-up': `份额变化 ${formatter.signedShares(row.shareDelta)}`,
    'broad-resonance': '至少 2 只宽基核心 ETF 当日成交额达到 20 日均值 2 倍',
    candidate: '宽基共振，或显著放量与份额增加同时出现'
  };
  return `${conditions[key] || '已触发规则'}；数据时间 ${dataTime}`;
}

function createScoreComponent(component) {
  const row = createElement('div', 'score-component');
  const actualLabel = component.key === 'shareChange' && Number.isFinite(component.actual)
    ? formatter.signedShares(component.actual)
    : component.actualLabel || '--';
  const identity = createElement('div');
  identity.append(
    createElement('strong', '', component.label),
    createElement('span', '', actualLabel)
  );
  const factor = createElement('div');
  factor.append(
    createElement('strong', '', `归一化 ${formatter.plainPercent((component.normalized || 0) * 100, 0)}`),
    createElement(
      'span',
      '',
      component.percentile === undefined
        ? component.note || ''
        : `历史分位 ${formatter.plainPercent(component.percentile * 100, 1)} · ${component.samples || 0} 个样本`
    )
  );
  row.append(
    identity,
    factor,
    createElement('span', '', `权重 ${component.weight}`),
    createElement('div', 'component-contribution', `+${Number(component.contribution || 0).toFixed(1)}`)
  );
  return row;
}

function buildIntradayOption(intraday) {
  const trendPoints = intraday.points || [];
  const labels = trendPoints.map((point) => point.time.slice(11));
  const values = trendPoints.map((point) => point.price);
  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 52, right: 20, top: 28, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.tooltipBg,
      borderColor: CHART_COLORS.tooltipBorder,
      textStyle: { color: CHART_COLORS.tooltipText }
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
      axisLabel: { color: CHART_COLORS.axisLabel, hideOverlap: true },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
      axisLabel: { color: CHART_COLORS.axisLabel }
    },
    series: [{
      name: '分时价格',
      type: 'line',
      data: values,
      symbol: 'none',
      smooth: false,
      lineStyle: { color: CHART_COLORS.primary, width: 2 },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(75, 139, 255, 0.28)' },
            { offset: 1, color: 'rgba(75, 139, 255, 0.01)' }
          ]
        }
      }
    }]
  };
}

function buildDailyOption(bars) {
  const dates = bars.map((bar) => bar.date);
  const candles = bars.map((bar) => [bar.open, bar.close, bar.low, bar.high]);
  const volumes = bars.map((bar) => ({
    value: bar.amount,
    itemStyle: { color: bar.close >= bar.open ? 'rgba(255,91,107,0.42)' : 'rgba(34,196,135,0.42)' }
  }));
  return {
    animation: false,
    backgroundColor: 'transparent',
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.tooltipBg,
      borderColor: CHART_COLORS.tooltipBorder,
      textStyle: { color: CHART_COLORS.tooltipText }
    },
    grid: [
      { left: 52, right: 20, top: 22, height: 205 },
      { left: 52, right: 20, top: 250, height: 62 }
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
        axisLabel: { color: CHART_COLORS.axisLabel, hideOverlap: true },
        axisTick: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
        axisLabel: { show: false },
        axisTick: { show: false }
      }
    ],
    yAxis: [
      {
        scale: true,
        splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
        axisLabel: { color: CHART_COLORS.axisLabel }
      },
      {
        gridIndex: 1,
        scale: true,
        splitNumber: 2,
        splitLine: { show: false },
        axisLabel: {
          color: CHART_COLORS.axisLabel,
          formatter: (value) => `${(value / 1e8).toFixed(0)}亿`
        }
      }
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0, 1],
        start: Math.max(0, 100 - (250 / Math.max(dates.length, 1)) * 100),
        end: 100
      },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        bottom: 4,
        height: 18,
        borderColor: 'rgba(150,170,195,0.12)',
        backgroundColor: 'rgba(8,12,19,0.6)',
        fillerColor: 'rgba(111,156,236,0.12)',
        handleStyle: { color: CHART_COLORS.primary },
        textStyle: { color: CHART_COLORS.axisLabel }
      }
    ],
    series: [
      {
        name: '日K',
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: '#ff5b6b',
          color0: '#22c487',
          borderColor: '#ff5b6b',
          borderColor0: '#22c487'
        }
      },
      {
        name: '成交额',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
        barMaxWidth: 7
      }
    ]
  };
}

function closeDrawer() {
  state.detailRequest?.abort();
  state.detailRequest = null;
  state.detailData = null;
  state.shareChart = null;
  state.charts.forEach((instance) => instance.dispose());
  state.charts = [];
  elements.drawer.classList.remove('is-open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.hidden = true;
  document.body.style.overflow = '';
  pageMain?.toggleAttribute('inert', false);
  pageHeader?.toggleAttribute('inert', false);
  const trigger = state.drawerTrigger;
  state.drawerTrigger = null;
  const target = trigger?.element?.isConnected
    ? trigger.element
    : trigger?.selector
      ? document.querySelector(trigger.selector)
      : null;
  target?.focus();
}

function rememberDrawerTrigger(selector) {
  state.drawerTrigger = {
    element: document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
    selector
  };
}

function trapDrawerFocus(event) {
  if (event.key !== 'Tab' || !elements.drawer.classList.contains('is-open')) return;
  const focusable = [...elements.drawer.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    elements.drawer.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function trapManageFocus(event) {
  if (event.key !== 'Tab' || !state.manageOpen) return;
  const focusable = [...elements.manageDialog.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    elements.manageDialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

window.addEventListener('resize', () => {
  state.charts.forEach((instance) => instance.resize());
}, { passive: true });

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', () => refreshData());
  document.querySelectorAll('[data-refresh-kind]').forEach((button) => {
    button.addEventListener('click', () => refreshData(button.dataset.refreshKind));
  });
  elements.densityToggle.addEventListener('click', () => {
    state.density = state.density === 'compact' ? 'comfortable' : 'compact';
    applyDensity();
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, state.density);
    } catch {
      showToast('密度设置无法写入本地浏览器');
    }
  });
  elements.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderTable();
  });
  elements.drawerClose.addEventListener('click', closeDrawer);
  elements.drawerBackdrop.addEventListener('click', closeDrawer);
  elements.manageEtfButton.addEventListener('click', openManagement);
  elements.manageClose.addEventListener('click', closeManagement);
  elements.manageBackdrop.addEventListener('click', closeManagement);
  elements.restoreDefaultOrder.addEventListener('click', restoreDefaultOrder);
  elements.newEtfCode.addEventListener('input', scheduleEtfLookup);
  elements.addEtfForm.addEventListener('submit', addManagedEtf);
  elements.clearSortButton.addEventListener('click', () => {
    state.sortKey = null;
    renderTable();
    showToast('指标排序已清除，恢复自定义顺序');
  });
  document.querySelectorAll('[data-column-toggle]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.columnToggle;
      state.columnVisibility[key] = input.checked;
      if (!input.checked && state.sortKey === key) state.sortKey = null;
      applyColumnSettings({ persist: true });
      renderTable();
    });
  });
  elements.columnSettingsReset.addEventListener('click', () => {
    state.columnVisibility = { ...COLUMN_DEFAULTS };
    if (
      state.sortKey &&
      Object.hasOwn(COLUMN_DEFAULTS, state.sortKey) &&
      !state.columnVisibility[state.sortKey]
    ) {
      state.sortKey = null;
    }
    applyColumnSettings({ persist: true });
    renderTable();
    showToast('已恢复默认列显示');
  });
  elements.showNarrowColumns.addEventListener('click', () => {
    const expanded = elements.showNarrowColumns.getAttribute('aria-pressed') !== 'true';
    elements.tablePanel.classList.toggle('show-narrow-secondary', expanded);
    elements.showNarrowColumns.setAttribute('aria-pressed', String(expanded));
    elements.showNarrowColumns.textContent = expanded ? '收起' : '展开';
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.drawer.classList.contains('is-open')) {
      event.preventDefault();
      closeDrawer();
    } else if (event.key === 'Escape' && state.manageOpen) {
      event.preventDefault();
      closeManagement();
    } else {
      trapDrawerFocus(event);
      trapManageFocus(event);
    }
  });
  document.querySelectorAll('th[data-sort]').forEach((header) => {
    const button = header.querySelector('.sort-button');
    button.addEventListener('click', () => {
      const key = header.dataset.sort;
      if (state.sortKey === key) {
        if (state.sortDirection === 'desc') {
          state.sortDirection = 'asc';
        } else {
          state.sortKey = null;
        }
      } else {
        state.sortKey = key;
        state.sortDirection = 'desc';
      }
      renderTable();
    });
  });
}

async function initializePage() {
  applyColumnSettings();
  applyDensity();
  bindEvents();
  loadSummary();
}

initializePage();
setInterval(() => {
  if (document.visibilityState === 'visible') loadSummary({ silent: true });
}, 30000);
