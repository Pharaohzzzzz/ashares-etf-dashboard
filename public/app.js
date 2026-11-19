'use strict';

const state = {
  view: 'overview',
  summary: null,
  rows: [],
  category: '全部',
  search: '',
  sortKey: null,
  sortDirection: 'desc',
  loading: false,
  detailCode: null,
  detailData: null,
  shareRange: 250,
  shareChart: null,
  charts: [],
  backtestSummary: null,
  backtestEvents: [],
  backtestLoading: false,
  backtestPromise: null,
  backtestFilters: {
    split: 'validation',
    horizon: 5,
    code: '',
    category: '',
    level: '',
    from: '',
    to: ''
  },
  backtestHeatmap: null,
  signalDetailChart: null,
  signalDetailHorizon: 5
};

const elements = {
  heroTitle: document.querySelector('#heroTitle'),
  heroCopy: document.querySelector('#heroCopy'),
  viewTabs: document.querySelectorAll('.view-tab'),
  overviewView: document.querySelector('#overviewView'),
  evaluationView: document.querySelector('#evaluationView'),
  marketStatus: document.querySelector('#marketStatus'),
  marketStatusText: document.querySelector('#marketStatusText'),
  refreshButton: document.querySelector('#refreshButton'),
  dataTime: document.querySelector('#dataTime'),
  generatedTime: document.querySelector('#generatedTime'),
  errorBanner: document.querySelector('#errorBanner'),
  totalAmount: document.querySelector('#totalAmount'),
  volumeUpCount: document.querySelector('#volumeUpCount'),
  shareUpCount: document.querySelector('#shareUpCount'),
  compositeCount: document.querySelector('#compositeCount'),
  resonanceHint: document.querySelector('#resonanceHint'),
  signalBoard: document.querySelector('#signalBoard'),
  categoryTabs: document.querySelector('#categoryTabs'),
  resultCount: document.querySelector('#resultCount'),
  searchInput: document.querySelector('#searchInput'),
  etfRows: document.querySelector('#etfRows'),
  updateLogs: document.querySelector('#updateLogs'),
  drawer: document.querySelector('#detailDrawer'),
  drawerBackdrop: document.querySelector('#drawerBackdrop'),
  drawerBody: document.querySelector('#drawerBody'),
  drawerTitle: document.querySelector('#drawerTitle'),
  drawerCategory: document.querySelector('#drawerCategory'),
  drawerClose: document.querySelector('#drawerClose'),
  toast: document.querySelector('#toast'),
  backtestRunMeta: document.querySelector('#backtestRunMeta'),
  evalSignalCount: document.querySelector('#evalSignalCount'),
  evalSignalFoot: document.querySelector('#evalSignalFoot'),
  evalBaselineHit: document.querySelector('#evalBaselineHit'),
  evalSignalHit: document.querySelector('#evalSignalHit'),
  evalHitSamples: document.querySelector('#evalHitSamples'),
  evalLift: document.querySelector('#evalLift'),
  evalMedianReturn: document.querySelector('#evalMedianReturn'),
  evalHorizonFoot: document.querySelector('#evalHorizonFoot'),
  evalWorstDrawdown: document.querySelector('#evalWorstDrawdown'),
  backtestFilters: document.querySelector('#backtestFilters'),
  backtestSplit: document.querySelector('#backtestSplit'),
  backtestHorizon: document.querySelector('#backtestHorizon'),
  backtestCode: document.querySelector('#backtestCode'),
  backtestCategory: document.querySelector('#backtestCategory'),
  backtestLevel: document.querySelector('#backtestLevel'),
  backtestFrom: document.querySelector('#backtestFrom'),
  backtestTo: document.querySelector('#backtestTo'),
  backtestReset: document.querySelector('#backtestReset'),
  backtestExport: document.querySelector('#backtestExport'),
  backtestDataNote: document.querySelector('#backtestDataNote'),
  splitComparisonRows: document.querySelector('#splitComparisonTable tbody'),
  backtestHeatmap: document.querySelector('#backtestHeatmap'),
  heatmapNote: document.querySelector('#heatmapNote'),
  backtestEtfRows: document.querySelector('#backtestEtfRows'),
  signalTimeline: document.querySelector('#signalTimeline'),
  eventCount: document.querySelector('#eventCount'),
  parameterVersion: document.querySelector('#parameterVersion'),
  backtestMethodology: document.querySelector('#backtestMethodology'),
  backtestEtfStatus: document.querySelector('#backtestEtfStatus')
};

const toneColors = {
  broad: '#4d8dff',
  growth: '#7f86ff',
  tech: '#42d6ca',
  finance: '#f0b857',
  health: '#e68cd4',
  hk: '#d8904c'
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

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
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
    renderSummary();
    renderTable();
    elements.errorBanner.hidden = true;
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = `读取数据失败：${error.message}`;
    setStatus('error', '数据连接异常');
  } finally {
    state.loading = false;
    setRefreshLoading(false);
  }
}

async function refreshData() {
  if (state.loading) return;
  state.loading = true;
  setRefreshLoading(true);
  try {
    const summary = await fetchJson('/api/refresh', { method: 'POST' });
    state.summary = summary;
    state.rows = summary.etfs || [];
    renderSummary();
    renderTable();
    elements.errorBanner.hidden = true;
    showToast('行情与份额已刷新');
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = `刷新失败：${error.message}`;
    showToast('刷新失败，请稍后重试');
  } finally {
    state.loading = false;
    setRefreshLoading(false);
  }
}

function setRefreshLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle('is-loading', loading);
}

function setStatus(type, text) {
  elements.marketStatus.className = `status-pill status-${type}`;
  elements.marketStatusText.textContent = text;
}

function updateMarketStatus() {
  if (!state.summary || !state.summary.etfs.length) {
    setStatus('loading', '等待首次数据');
    return;
  }
  const latestLog = state.summary.logs?.[0];
  if (latestLog?.status === 'error') {
    setStatus('error', '数据源异常');
    return;
  }
  setStatus('live', state.summary.dataTime ? '行情已连接' : '等待盘后数据');
}

function renderSummary() {
  const summary = state.summary;
  if (!summary) return;
  elements.totalAmount.textContent = formatter.amount(summary.totalAmount);
  elements.volumeUpCount.textContent = summary.volumeUpCount ?? 0;
  elements.shareUpCount.textContent = summary.shareUpCount ?? 0;
  elements.compositeCount.textContent = summary.scoreSignalCount ?? 0;
  const highCount = state.rows.filter((row) => row.scoreLevel?.key === 'high').length;
  const activeCount = state.rows.filter((row) => row.scoreLevel?.key === 'active').length;
  elements.resonanceHint.textContent = `${activeCount} 只活跃 · ${highCount} 只高强度`;
  elements.dataTime.textContent = formatter.time(summary.dataTime);
  elements.generatedTime.textContent = `抓取于 ${formatter.fullTime(summary.generatedAt)}`;
  updateMarketStatus();
  renderSignalBoard();
  renderCategoryTabs();
  renderLogs();
}

function renderSignalBoard() {
  elements.signalBoard.replaceChildren();
  const candidates = state.rows.filter((row) => row.scoreSignal).slice(0, 4);
  if (!candidates.length) {
    elements.signalBoard.append(createElement('div', 'signal-empty', '最近完整评分日没有达到 40 分的异动信号'));
    return;
  }
  for (const row of candidates) {
    const card = createElement('article', 'signal-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `查看 ${row.name} 详情`);
    const top = createElement('div', 'signal-card-top');
    const titles = createElement('div');
    titles.append(
      createElement('span', 'signal-code', row.code),
      createElement('h4', '', row.name)
    );
    const change = createElement(
      'span',
      directionClass(row.changePercent),
      formatter.percentDirect(row.changePercent)
    );
    top.append(titles, change);
    const value = createElement('div', 'score-card-line');
    const score = createScorePill(row, { clickable: true });
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
      `量比 ${formatter.ratio(row.volumeRatio)} · ${row.scoreDate || '--'}`
    ));
    card.append(top, value, tags);
    card.addEventListener('click', () => openDetail(row.code));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openDetail(row.code);
    });
    elements.signalBoard.append(card);
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
  if (!state.sortKey) return rows;
  rows.sort((left, right) => {
    const a = left[state.sortKey];
    const b = right[state.sortKey];
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    const comparison = typeof a === 'string' ? a.localeCompare(b, 'zh-CN') : a - b;
    return state.sortDirection === 'asc' ? comparison : -comparison;
  });
  return rows;
}

function renderTable() {
  const rows = visibleRows();
  elements.resultCount.textContent = `${rows.length} / ${state.rows.length} 只 ETF`;
  elements.etfRows.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = createElement('td', 'table-loading', state.rows.length ? '没有匹配的 ETF' : '正在读取行情数据...');
    td.colSpan = 10;
    tr.append(td);
    elements.etfRows.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.classList.toggle('is-candidate', row.scoreSignal);
    tr.setAttribute('aria-label', `查看 ${row.name} 详情`);
    tr.append(createEtfCell(row));
    tr.append(createElement('td', '', formatter.price(row.price)));
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
    tr.append(createElement(
      'td',
      directionClass(row.shareDelta),
      row.shareDelta === null ? '待积累' : formatter.signedShares(row.shareDelta)
    ));
    tr.append(createElement(
      'td',
      directionClass(row.estimatedSubscription),
      row.estimatedSubscription === null ? '--' : formatter.signedAmount(row.estimatedSubscription)
    ));
    tr.append(createSignalCell(row));
    tr.addEventListener('click', () => openDetail(row.code));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openDetail(row.code);
    });
    elements.etfRows.append(tr);
  }
}

function createEtfCell(row) {
  const td = document.createElement('td');
  td.className = 'sticky-col';
  const wrapper = createElement('div', 'etf-cell');
  const mark = createElement('span', 'tone-mark');
  mark.style.setProperty('--tone-color', toneColors[row.tone] || toneColors.broad);
  const content = createElement('div');
  content.append(
    createElement('span', 'etf-name', row.name),
    createElement('span', 'etf-meta', `${row.code} · ${row.category}`)
  );
  wrapper.append(mark, content);
  td.append(wrapper);
  return td;
}

function createSignalCell(row) {
  const td = document.createElement('td');
  const wrapper = createElement('div', 'score-card-line');
  wrapper.style.justifyContent = 'flex-end';
  wrapper.append(createScorePill(row, { clickable: true }));
  td.append(wrapper);
  return td;
}

function createScorePill(row, { clickable = false } = {}) {
  const score = Number.isFinite(row.score) ? row.score : null;
  const levelKey = row.scoreLevel?.key || 'empty';
  const pill = createElement(
    'button',
    `score-pill ${levelKey}`,
  );
  pill.type = 'button';
  if (score === null) {
    pill.disabled = true;
    pill.append(createElement('span', '', '数据不足'));
    return pill;
  }
  pill.append(
    createElement('strong', '', score.toFixed(1)),
    createElement('span', '', row.scoreLevel?.label || '评分')
  );
  if (clickable) {
    pill.title = `查看 ${row.scoreDate} 评分与回测解释`;
    pill.addEventListener('click', (event) => {
      event.stopPropagation();
      openSignalEvaluation({ code: row.code, date: row.scoreDate });
    });
  } else {
    pill.disabled = true;
  }
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

async function openDetail(code) {
  state.detailCode = code;
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
  try {
    const [detail, intraday] = await Promise.all([
      fetchJson(`/api/etfs/${code}`),
      fetchJson(`/api/etfs/${code}/intraday`).catch(() => ({ points: [], tailVolumeShare: null }))
    ]);
    if (state.detailCode === code) renderDetail(detail, intraday);
  } catch (error) {
    elements.drawerBody.replaceChildren(createElement('div', 'error-banner', `详情加载失败：${error.message}`));
  }
}

function renderDetail(detail, intraday) {
  const row = detail.quote;
  state.detailData = detail;
  elements.drawerBody.replaceChildren();
  const metrics = createElement('div', 'detail-metrics');
  const items = [
    ['最新价', formatter.price(row.price), ''],
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
    ['当前份额', formatter.shares(row.shares), ''],
    ['上一期份额', formatter.shares(row.previousShares), ''],
    ['份额基准', row.previousShareDate ? `${row.previousShareDate} · ${row.previousShareSource}` : '--', 'neutral'],
    ['份额变化', row.shareDelta === null ? '待积累' : formatter.signedShares(row.shareDelta), directionClass(row.shareDelta)],
    ['估算净申赎', row.estimatedSubscription === null ? '--' : formatter.signedAmount(row.estimatedSubscription), directionClass(row.estimatedSubscription)],
    ['成交额分位', formatter.plainPercent(row.amountPercentile === null ? null : row.amountPercentile * 100, 1), ''],
    ['连续净申赎', row.shareStreak?.days ? `${row.shareStreak.label} ${row.shareStreak.days}日` : '无连续序列', directionClass(row.shareStreak?.direction === 'subscription' ? 1 : row.shareStreak?.direction === 'redemption' ? -1 : 0)],
    ['250日份额分位', formatter.plainPercent(row.sharePercentile === null ? null : row.sharePercentile * 100, 1), ''],
    ['官方份额截至', row.officialShareDate ? `${row.officialShareDate} · ${row.officialShareSource}` : '暂无官方记录', 'neutral'],
    ['折溢价', '暂无', 'neutral'],
    ['尾盘成交占比', formatter.plainPercent(intraday.tailVolumeShare === null ? null : intraday.tailVolumeShare * 100), '']
  ];
  for (const [label, value, className] of items) {
    const card = createElement('div', 'detail-metric');
    card.append(createElement('span', '', label), createElement('strong', className, value));
    metrics.append(card);
  }
  elements.drawerBody.append(metrics);

  const scoreNote = createElement('section', 'signal-note');
  const scoreHeading = createElement('div', 'chart-card-heading');
  scoreHeading.append(createElement('h3', '', '异常资金评分贡献'));
  const scoreActions = createElement('div', 'score-card-line');
  scoreActions.append(createScorePill(row));
  if (row.scoreSignal) {
    const backtestButton = createElement('button', 'button button-quiet', '查看历史回测解释');
    backtestButton.type = 'button';
    backtestButton.addEventListener('click', () => {
      closeDrawer();
      openSignalEvaluation({ code: row.code, date: row.scoreDate });
    });
    scoreActions.append(backtestButton);
  }
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

  const disclaimer = createElement('div', 'detail-note');
  disclaimer.textContent = '历史曲线只使用上交所、深交所官方份额，不使用模拟值补齐缺失日期。当前份额仍优先使用官方记录，交易所尚未返回当日数据时才显示行情快照。二级市场买入不增加总份额，候选信号不代表已确认的国家队成交；公开行情接口未提供可靠 IOPV，因此折溢价显示“暂无”。';
  elements.drawerBody.append(disclaimer);

  const signalNote = createElement('section', 'signal-note');
  signalNote.append(createElement('h3', '', '旧版规则对照'));
  const signalList = createElement('div', 'signal-explain-list');
  const detailSignals = [...row.signals];
  if (
    Number.isFinite(intraday.tailVolumeShare) &&
    intraday.tailVolumeShare >= 0.2 &&
    !detailSignals.some((signal) => signal.key === 'tail-volume')
  ) {
    detailSignals.push({ key: 'tail-volume', label: '尾盘异动', level: 'medium' });
  }
  if (!detailSignals.length) {
    signalList.append(createElement('p', '', '旧版规则当前没有触发标签；历史记录仍保留用于回测对照。'));
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
  const sourceLink = createElement('a', 'source-link', '东方财富原始行情 ↗');
  sourceLink.href = `https://quote.eastmoney.com/${row.code}.html`;
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  sourceLinks.append(sourceLink);
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
  const intradayChart = createElement('div', 'chart');
  intradayChart.id = 'intradayChart';
  intradayCard.append(intradayChart);
  elements.drawerBody.append(intradayCard);

  const dailyCard = createElement('section', 'chart-card');
  dailyCard.append(createElement('h3', '', '近两年日 K 与成交额'));
  const dailyChart = createElement('div', 'chart chart-tall');
  dailyChart.id = 'dailyChart';
  dailyCard.append(dailyChart);
  elements.drawerBody.append(dailyCard);

  requestAnimationFrame(() => {
    if (!window.echarts) return;
    state.charts.forEach((instance) => instance.dispose());
    const shareInstance = echarts.init(shareChart);
    const intradayInstance = echarts.init(intradayChart);
    const dailyInstance = echarts.init(dailyChart);
    state.shareChart = shareInstance;
    renderShareRange();
    intradayInstance.setOption(buildIntradayOption(intraday));
    dailyInstance.setOption(buildDailyOption(detail.bars || []));
    state.charts = [shareInstance, intradayInstance, dailyInstance];
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
  note.textContent = `${statusText}${missingText}。数据来源：${history.sourceName || '交易所'}官方接口；${history.note}`;
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
    color: ['#4d8dff', '#f0b857'],
    legend: {
      top: 0,
      left: 'center',
      textStyle: { color: '#8493a7', fontSize: 11 },
      data: ['官方总份额', '累计估算净申赎']
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#111824',
      borderColor: '#29364c',
      textStyle: { color: '#dce8f8' },
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
      axisLine: { lineStyle: { color: '#263246' } },
      axisLabel: {
        color: '#66768a',
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
        nameTextStyle: { color: '#66768a', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(150,170,195,0.08)' } },
        axisLabel: {
          color: '#66768a',
          formatter: (value) => value.toFixed(value >= 10 ? 0 : 1)
        }
      },
      {
        type: 'value',
        name: '累计净申赎（亿元）',
        scale: true,
        nameTextStyle: { color: '#66768a', fontSize: 10 },
        splitLine: { show: false },
        axisLabel: {
          color: '#66768a',
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
        lineStyle: { color: '#4d8dff', width: 2 },
        itemStyle: { color: '#4d8dff' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(77,141,255,0.20)' },
              { offset: 1, color: 'rgba(77,141,255,0.01)' }
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
        lineStyle: { color: '#f0b857', width: 2 },
        itemStyle: { color: '#f0b857' },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: 'rgba(240,184,87,0.22)', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }]
        }
      }
    ]
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

function averageClient(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function medianClient(values) {
  const valid = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
}

function aggregateEventOutcomes(events, horizon) {
  const outcomes = events
    .map((event) => event.outcomes?.[horizon])
    .filter((outcome) => outcome && Number.isFinite(outcome.futureReturn));
  if (!outcomes.length) {
    return {
      samples: 0,
      hitRate: null,
      baselineHitRate: null,
      hitRateLift: null,
      averageReturn: null,
      medianReturn: null,
      worstDrawdown: null,
      averageMaxFavorable: null
    };
  }
  const hitRate = outcomes.filter((outcome) => outcome.outperformedBenchmark).length / outcomes.length;
  const baselineHitRate = averageClient(outcomes.map((outcome) => outcome.baselineHitRate));
  return {
    samples: outcomes.length,
    hitRate,
    baselineHitRate,
    hitRateLift: hitRate - baselineHitRate,
    averageReturn: averageClient(outcomes.map((outcome) => outcome.futureReturn)),
    medianReturn: medianClient(outcomes.map((outcome) => outcome.futureReturn)),
    worstDrawdown: Math.min(...outcomes.map((outcome) => outcome.drawdown)),
    averageMaxFavorable: averageClient(outcomes.map((outcome) => outcome.maxFavorable))
  };
}

function switchView(view, { updateUrl = true } = {}) {
  state.view = view === 'evaluation' ? 'evaluation' : 'overview';
  const evaluation = state.view === 'evaluation';
  elements.overviewView.hidden = evaluation;
  elements.evaluationView.hidden = !evaluation;
  elements.heroTitle.textContent = evaluation
    ? '检验信号区分度，不用收益倒推身份'
    : '观察资金痕迹，不猜测账户身份';
  elements.heroCopy.textContent = evaluation
    ? '评分只读取信号日及以前数据，评价只读取未来路径。结果同时展示样本数、无条件基准和历史表现，不把“历史收益为正”当作身份确认。'
    : '把成交放量、份额变化与宽基共振放在同一张图里。信号用于发现异常，不代表已确认的“国家队”成交。';
  elements.viewTabs.forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (evaluation) {
      url.searchParams.set('view', 'evaluation');
    } else {
      url.searchParams.delete('view');
      url.searchParams.delete('code');
      url.searchParams.delete('date');
    }
    window.history.replaceState({}, '', url);
  }
  if (evaluation && !state.backtestSummary) loadBacktest();
}

function setSelectOptions(select, options, allLabel) {
  select.replaceChildren();
  if (allLabel) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = allLabel;
    select.append(option);
  }
  for (const optionData of options) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    select.append(option);
  }
}

function setBacktestDateDefaults() {
  const run = state.backtestSummary?.run;
  if (!run) return;
  if (state.backtestFilters.split === 'train') {
    elements.backtestFrom.value = run.trainStart || '';
    elements.backtestTo.value = run.trainEnd || '';
  } else {
    elements.backtestFrom.value = run.validationStart || '';
    elements.backtestTo.value = run.validationEnd || '';
  }
  state.backtestFilters.from = elements.backtestFrom.value;
  state.backtestFilters.to = elements.backtestTo.value;
}

function readBacktestFilters() {
  state.backtestFilters = {
    split: elements.backtestSplit.value,
    horizon: Number(elements.backtestHorizon.value),
    code: elements.backtestCode.value,
    category: elements.backtestCategory.value,
    level: elements.backtestLevel.value,
    from: elements.backtestFrom.value,
    to: elements.backtestTo.value
  };
  return state.backtestFilters;
}

function backtestQuery() {
  const params = new URLSearchParams();
  const filters = state.backtestFilters;
  for (const key of ['split', 'code', 'category', 'level', 'from', 'to']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  params.set('horizon', String(filters.horizon));
  return params;
}

function updateBacktestExport() {
  const params = backtestQuery();
  params.set('type', 'backtest');
  elements.backtestExport.href = `/api/export.csv?${params}`;
}

async function loadBacktest() {
  if (state.backtestPromise) return state.backtestPromise;
  state.backtestPromise = performBacktestLoad();
  try {
    return await state.backtestPromise;
  } finally {
    state.backtestPromise = null;
  }
}

async function performBacktestLoad() {
  state.backtestLoading = true;
  try {
    if (!state.backtestSummary) {
      await fetchJson('/api/backtests/summary').then((summary) => {
        state.backtestSummary = summary;
        const etfs = summary.etfStatus || [];
        setSelectOptions(
          elements.backtestCode,
          etfs.map((etf) => ({ value: etf.code, label: `${etf.code} · ${etf.name}` })),
          '全部 ETF'
        );
        setSelectOptions(
          elements.backtestCategory,
          [...new Set(etfs.map((etf) => etf.category))]
            .map((category) => ({ value: category, label: category })),
          '全部分类'
        );
        elements.backtestSplit.value = state.backtestFilters.split;
        elements.backtestHorizon.value = String(state.backtestFilters.horizon);
        setBacktestDateDefaults();
      });
      renderBacktestSummary();
    }
    readBacktestFilters();
    updateBacktestExport();
    const params = new URLSearchParams();
    for (const key of ['split', 'code', 'category', 'level', 'from', 'to']) {
      if (state.backtestFilters[key]) params.set(key, state.backtestFilters[key]);
    }
    const eventsResult = await fetchJson(`/api/backtests/events?${params}`);
    state.backtestEvents = eventsResult.events || [];
    renderBacktestData();
  } catch (error) {
    state.backtestSummary = null;
    elements.backtestDataNote.textContent = `回测读取失败：${error.message}`;
    elements.signalTimeline.replaceChildren(
      createElement('div', 'event-empty', `信号事件读取失败：${error.message}`)
    );
  } finally {
    state.backtestLoading = false;
  }
}

function renderBacktestSummary() {
  const summary = state.backtestSummary;
  if (!summary) return;
  const run = summary.run;
  elements.backtestRunMeta.replaceChildren(
    createElement('strong', '', summary.parameterVersion),
    document.createElement('br'),
    document.createTextNode(`运行 #${run.id} · ${formatter.fullTime(run.generatedAt)}`),
    document.createElement('br'),
    document.createTextNode(`训练 ${run.trainStart} 至 ${run.trainEnd}`),
    document.createElement('br'),
    document.createTextNode(`验证 ${run.validationStart} 至 ${run.validationEnd}`)
  );
  elements.parameterVersion.textContent = summary.parameterVersion;
  elements.splitComparisonRows.replaceChildren();
  for (const horizon of [1, 3, 5, 10]) {
    const train = summary.splits?.train?.byHorizon?.[horizon];
    const validation = summary.splits?.validation?.byHorizon?.[horizon];
    const legacyTrain = summary.splits?.train?.legacyByHorizon?.[horizon];
    const legacyValidation = summary.splits?.validation?.legacyByHorizon?.[horizon];
    const tr = document.createElement('tr');
    tr.append(createElement('td', '', `未来 ${horizon} 日`));
    for (const row of [train, validation]) {
      tr.append(
        createElement('td', '', row?.samples ? String(row.samples) : '数据不足'),
        createElement('td', '', formatNullablePercent(row?.hitRate)),
        createElement('td', directionClass(row?.hitRateLift), formatNullableSignedPercent(row?.hitRateLift))
      );
    }
    for (const row of [legacyTrain, legacyValidation]) {
      tr.append(
        createElement('td', '', row?.samples ? String(row.samples) : '数据不足'),
        createElement('td', '', formatNullablePercent(row?.hitRate))
      );
    }
    elements.splitComparisonRows.append(tr);
  }

  const weights = summary.parameters?.weights || {};
  const chips = createElement('div', 'parameter-chips');
  for (const [key, label] of [
    ['volume', '量比'],
    ['shareChange', '份额分位'],
    ['streak', '连续净申赎'],
    ['resonance', '共振']
  ]) {
    chips.append(createElement('span', 'parameter-chip', `${label} ${weights[key]}%`));
  }
  chips.append(
    createElement('span', 'parameter-chip', '阈值 40 / 60 / 80'),
    createElement('span', 'parameter-chip', '训练 70% · 验证 30%')
  );
  elements.backtestMethodology.replaceChildren(chips);
  for (const text of Object.values(summary.methodology || {})) {
    elements.backtestMethodology.append(createElement('p', '', text));
  }

  elements.backtestEtfStatus.replaceChildren();
  for (const etf of summary.etfStatus || []) {
    const card = createElement(
      'div',
      `etf-status-card ${etf.status === 'insufficient' ? 'warning' : ''}`
    );
    card.append(
      createElement('strong', '', `${etf.code} · ${etf.name}`),
      createElement(
        'span',
        '',
        etf.status === 'ready'
          ? `可评分 ${etf.eligibleScoringDays} 日 · 信号 ${etf.signalCount} 个 · 日线 ${etf.barCount} 根`
          : `数据不足：${etf.reason}`
      )
    );
    elements.backtestEtfStatus.append(card);
  }
}

function formatNullablePercent(value, digits = 1) {
  return Number.isFinite(value) ? formatter.plainPercent(value * 100, digits) : '数据不足';
}

function formatNullableSignedPercent(value, digits = 1) {
  return Number.isFinite(value) ? formatter.percent(value, digits) : '数据不足';
}

function renderBacktestData() {
  const summary = state.backtestSummary;
  if (!summary) return;
  const horizon = state.backtestFilters.horizon;
  const split = state.backtestFilters.split;
  const splitLabel = split === 'train' ? '训练期' : '留出验证期';
  const events = state.backtestEvents;
  const aggregate = aggregateEventOutcomes(events, horizon);
  elements.evalSignalCount.textContent = String(aggregate.samples);
  elements.evalSignalFoot.textContent = `${splitLabel} · 原始事件 ${events.length} 个`;
  elements.evalBaselineHit.textContent = formatNullablePercent(aggregate.baselineHitRate);
  elements.evalSignalHit.textContent = formatNullablePercent(aggregate.hitRate);
  elements.evalHitSamples.textContent = `样本数 ${aggregate.samples}`;
  elements.evalLift.textContent = formatNullableSignedPercent(aggregate.hitRateLift);
  elements.evalLift.className = directionClass(aggregate.hitRateLift);
  elements.evalMedianReturn.textContent = formatNullableSignedPercent(aggregate.medianReturn);
  elements.evalHorizonFoot.textContent = `未来 ${horizon} 日`;
  elements.evalWorstDrawdown.textContent = formatNullableSignedPercent(aggregate.worstDrawdown);

  const insufficient = (summary.etfStatus || []).filter((etf) => etf.status === 'insufficient');
  const dates = state.backtestFilters.from || state.backtestFilters.to
    ? `${state.backtestFilters.from || '起点'} 至 ${state.backtestFilters.to || '终点'}`
    : `${summary.run.trainStart || '--'} 至 ${summary.run.validationEnd || '--'}`;
  elements.backtestDataNote.textContent = aggregate.samples
    ? `${splitLabel} ${dates}；当前筛选有 ${aggregate.samples} 个具备未来 ${horizon} 日结果的信号样本。相对提升为百分点差，不是收益率。ETF 当前价与历史结果不用于生成当日评分。`
    : `数据不足：当前筛选没有具备未来 ${horizon} 日结果的信号样本。请扩大日期范围或调整 ETF、分类和评分等级；不把缺失结果记为 0。`;
  if (insufficient.length) {
    elements.backtestDataNote.textContent += ` 另有 ${insufficient.length} 只 ETF 因历史数据不足被排除：${insufficient.map((etf) => `${etf.code}（${etf.reason}）`).join('；')}。`;
  }

  renderBacktestHeatmap(events);
  renderBacktestEtfTable(events, horizon);
  renderSignalTimeline(events, horizon);
}

function renderBacktestHeatmap(events) {
  if (!window.echarts) return;
  if (!state.backtestHeatmap) {
    state.backtestHeatmap = echarts.init(elements.backtestHeatmap);
  }
  const categories = [...new Set((state.backtestSummary.etfStatus || []).map((etf) => etf.category))];
  const horizons = [1, 3, 5, 10];
  const data = [];
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    const categoryEvents = events.filter((event) => event.category === categories[categoryIndex]);
    for (let horizonIndex = 0; horizonIndex < horizons.length; horizonIndex += 1) {
      const aggregate = aggregateEventOutcomes(categoryEvents, horizons[horizonIndex]);
      data.push([
        horizonIndex,
        categoryIndex,
        Number.isFinite(aggregate.hitRateLift) ? aggregate.hitRateLift * 100 : null,
        aggregate.samples
      ]);
    }
  }
  state.backtestHeatmap.setOption({
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: '#111824',
      borderColor: '#29364c',
      textStyle: { color: '#dce8f8' },
      formatter: (item) => {
        const [horizonIndex, categoryIndex, value, samples] = item.value;
        return [
          categories[categoryIndex],
          `未来 ${horizons[horizonIndex]} 日`,
          Number.isFinite(value) ? `相对提升 ${value >= 0 ? '+' : ''}${value.toFixed(1)} 个百分点` : '数据不足',
          `样本 ${samples}`
        ].join('<br>');
      }
    },
    grid: { left: 82, right: 18, top: 20, bottom: 72 },
    xAxis: {
      type: 'category',
      data: horizons.map((value) => `未来 ${value} 日`),
      splitArea: { show: true },
      axisLabel: { color: '#7f90a5' },
      axisLine: { lineStyle: { color: '#263246' } }
    },
    yAxis: {
      type: 'category',
      data: categories,
      splitArea: { show: true },
      axisLabel: { color: '#a8b8ca' },
      axisLine: { lineStyle: { color: '#263246' } }
    },
    visualMap: {
      min: -20,
      max: 20,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 4,
      text: ['提升', '落后'],
      textStyle: { color: '#6f8094', fontSize: 10 },
      inRange: { color: ['#184756', '#173347', '#27354b', '#6a5937', '#7f3d49'] }
    },
    series: [{
      type: 'heatmap',
      data,
      label: {
        show: true,
        color: '#eef4fb',
        formatter: (item) => Number.isFinite(item.value[2])
          ? `${item.value[2] >= 0 ? '+' : ''}${item.value[2].toFixed(1)}pp`
          : '不足'
      },
      itemStyle: { borderColor: '#0c121c', borderWidth: 2 }
    }]
  }, true);
  elements.heatmapNote.textContent = `${state.backtestFilters.split === 'train' ? '训练期' : '验证期'} · 横轴覆盖全部周期，悬停可查看相对提升与样本数`;
}

function renderBacktestEtfTable(events, horizon) {
  elements.backtestEtfRows.replaceChildren();
  const statuses = state.backtestSummary?.etfStatus || [];
  for (const etf of statuses) {
    const aggregate = aggregateEventOutcomes(
      events.filter((event) => event.code === etf.code),
      horizon
    );
    const tr = document.createElement('tr');
    tr.append(createElement('td', '', ''));
    tr.firstChild.append(
      createElement('strong', '', etf.name),
      createElement('span', 'etf-meta', `${etf.code} · ${etf.category}`)
    );
    tr.append(
      createElement('td', aggregate.samples ? '' : 'data-missing', String(aggregate.samples)),
      createElement('td', '', formatNullablePercent(aggregate.hitRate)),
      createElement('td', '', formatNullablePercent(aggregate.baselineHitRate)),
      createElement('td', directionClass(aggregate.hitRateLift), formatNullableSignedPercent(aggregate.hitRateLift)),
      createElement('td', directionClass(aggregate.averageReturn), formatNullableSignedPercent(aggregate.averageReturn)),
      createElement('td', directionClass(aggregate.medianReturn), formatNullableSignedPercent(aggregate.medianReturn)),
      createElement('td', directionClass(aggregate.worstDrawdown), formatNullableSignedPercent(aggregate.worstDrawdown)),
      createElement('td', '', formatNullableSignedPercent(aggregate.averageMaxFavorable)),
      createElement(
        'td',
        etf.status === 'ready' ? '' : 'data-missing',
        etf.status === 'ready'
          ? (aggregate.samples ? '有有效样本' : '当前筛选不足')
          : etf.reason
      )
    );
    elements.backtestEtfRows.append(tr);
  }
}

function renderSignalTimeline(events, horizon) {
  elements.signalTimeline.replaceChildren();
  elements.eventCount.textContent = `${events.length} 个事件 · 展示未来 ${horizon} 日结果`;
  if (!events.length) {
    elements.signalTimeline.append(createElement(
      'div',
      'event-empty',
      '当前筛选没有评分达到 40 分的信号事件。'
    ));
    return;
  }
  for (const event of events) {
    const outcome = event.outcomes?.[horizon];
    const row = createElement('div', 'event-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `查看 ${event.name} ${event.date} 信号解释`);
    const etf = createElement('div', 'event-etf');
    etf.append(
      createElement('strong', '', event.name),
      createElement('span', '', `${event.code} · ${event.category}`)
    );
    const reasons = createElement(
      'div',
      'event-reasons',
      event.reasons?.join(' · ') || '查看完整贡献'
    );
    const outcomeNode = createElement('div', 'event-outcome');
    outcomeNode.append(
      createElement(
        'strong',
        directionClass(outcome?.futureReturn),
        outcome ? formatter.percent(outcome.futureReturn) : '未来数据不足'
      ),
      createElement(
        'span',
        '',
        outcome ? `基准 ${formatter.percent(outcome.benchmarkReturn)} · 样本 ${outcome.baselineSampleCount}` : '尚不足所选周期'
      )
    );
    const score = createElement('div', 'score-card-line');
    score.append(
      createScorePill({
        score: event.score,
        scoreLevel: event.level,
        scoreDate: event.date
      }),
      createElement('span', 'event-date', event.split === 'train' ? '训练期' : '验证期')
    );
    row.append(score, etf, reasons, outcomeNode);
    row.addEventListener('click', () => openSignalEvent(event.id));
    row.addEventListener('keydown', (eventObject) => {
      if (eventObject.key === 'Enter' || eventObject.key === ' ') {
        eventObject.preventDefault();
        openSignalEvent(event.id);
      }
    });
    elements.signalTimeline.append(row);
  }
}

async function openSignalEvaluation({ code, date }) {
  switchView('evaluation');
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'evaluation');
  url.searchParams.set('code', code);
  url.searchParams.set('date', date);
  window.history.replaceState({}, '', url);
  if (!state.backtestSummary) await loadBacktest();
  const run = state.backtestSummary?.run;
  if (!run) return;
  state.backtestFilters.split = date <= run.trainEnd ? 'train' : 'validation';
  elements.backtestSplit.value = state.backtestFilters.split;
  elements.backtestCode.value = code || '';
  elements.backtestCategory.value = '';
  elements.backtestLevel.value = '';
  elements.backtestFrom.value = date || '';
  elements.backtestTo.value = date || '';
  await loadBacktest();
  const event = state.backtestEvents.find(
    (item) => item.code === code && item.date === date
  );
  if (event) {
    openSignalEvent(event.id);
  } else {
    showToast('该日没有达到 40 分的信号事件，已保留筛选条件');
  }
}

async function openSignalEvent(id) {
  elements.drawerCategory.textContent = 'SIGNAL EVENT';
  elements.drawerTitle.textContent = '加载信号解释';
  elements.drawerBody.replaceChildren(createElement('div', 'table-loading', '正在加载信号贡献与未来路径...'));
  elements.drawerBackdrop.hidden = false;
  elements.drawer.classList.add('is-open');
  elements.drawer.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  try {
    const detail = await fetchJson(`/api/backtests/events/${id}`);
    renderSignalEventDetail(detail);
  } catch (error) {
    elements.drawerBody.replaceChildren(
      createElement('div', 'error-banner', `信号详情读取失败：${error.message}`)
    );
  }
}

function renderSignalEventDetail(detail) {
  state.charts.forEach((instance) => instance.dispose());
  state.charts = [];
  state.signalDetailHorizon = 5;
  elements.drawerCategory.textContent = `${detail.category} · ${detail.split === 'train' ? '训练期' : '验证期'}`;
  elements.drawerTitle.textContent = `${detail.name} · ${detail.date}`;
  elements.drawerBody.replaceChildren();

  const head = createElement('section', 'signal-detail-head');
  head.append(
    createScorePill({
      score: detail.score,
      scoreLevel: detail.level,
      scoreDate: detail.date
    }),
    createElement('p', '', detail.reasons?.join(' · ') || '评分贡献见下')
  );
  elements.drawerBody.append(head);

  const components = createElement('section', 'signal-note');
  components.append(createElement('h3', '', '当日评分贡献'));
  const grid = createElement('div', 'score-component-grid');
  for (const component of detail.components || []) {
    grid.append(createScoreComponent(component));
  }
  components.append(grid);
  elements.drawerBody.append(components);

  const outcomes = createElement('section', 'signal-note');
  outcomes.append(createElement('h3', '', '后续表现与同期基准'));
  const outcomeGrid = createElement('div', 'outcome-grid');
  for (const horizon of [1, 3, 5, 10]) {
    const outcome = detail.outcomes?.[horizon];
    const card = createElement('div', 'outcome-card');
    card.append(
      createElement('strong', directionClass(outcome?.futureReturn), outcome
        ? formatter.percent(outcome.futureReturn)
        : '数据不足'),
      createElement(
        'span',
        '',
        outcome
          ? `未来 ${horizon} 日 · 基准 ${formatter.percent(outcome.benchmarkReturn)} · 回撤 ${formatter.percent(outcome.drawdown)}`
          : `未来 ${horizon} 日结果尚未形成`
      )
    );
    outcomeGrid.append(card);
  }
  outcomes.append(
    outcomeGrid,
    createElement(
      'p',
      'data-note',
      '命中指未来收益高于监测池同期等权基准；无条件样本按同 ETF、同数据切分计算。未来路径只用于评价，不回流到信号日评分。'
    )
  );
  elements.drawerBody.append(outcomes);

  const pathCard = createElement('section', 'chart-card');
  const pathHeading = createElement('div', 'chart-card-heading');
  pathHeading.append(createElement('h3', '', '信号后价格路径'));
  const horizonTabs = createElement('div', 'range-tabs');
  for (const horizon of [1, 3, 5, 10]) {
    const button = createElement('button', `range-tab ${horizon === 5 ? 'active' : ''}`, `${horizon}日`);
    button.type = 'button';
    button.dataset.signalHorizon = String(horizon);
    button.addEventListener('click', () => {
      state.signalDetailHorizon = horizon;
      document.querySelectorAll('[data-signal-horizon]').forEach((item) => {
        item.classList.toggle('active', Number(item.dataset.signalHorizon) === horizon);
      });
      renderSignalPath(detail);
    });
    horizonTabs.append(button);
  }
  pathHeading.append(horizonTabs);
  const pathChart = createElement('div', 'chart');
  pathChart.id = 'signalPathChart';
  pathCard.append(pathHeading, pathChart);
  elements.drawerBody.append(pathCard);

  const legacy = createElement('section', 'signal-note');
  legacy.append(
    createElement('h3', '', '旧版规则对照'),
    createElement(
      'p',
      '',
      detail.legacyComposite
        ? `旧版规则同日为“护盘候选”：${(detail.legacySignals || []).map((signal) => signal.label).join('、')}`
        : '旧版规则同日未标记“护盘候选”；历史信号记录保留。'
    )
  );
  elements.drawerBody.append(legacy);

  requestAnimationFrame(() => {
    if (!window.echarts) return;
    state.signalDetailChart = echarts.init(pathChart);
    state.charts = [state.signalDetailChart];
    renderSignalPath(detail);
  });
}

function renderSignalPath(detail) {
  if (!state.signalDetailChart) return;
  const horizon = state.signalDetailHorizon;
  const points = detail.futurePath?.[horizon] || [];
  state.signalDetailChart.setOption(buildSignalPathOption(points, horizon), true);
}

function buildSignalPathOption(points, horizon) {
  const values = points.map((point) => Number.isFinite(point.relative) ? point.relative * 100 : null);
  return {
    animation: false,
    backgroundColor: 'transparent',
    title: points.length ? null : {
      text: `未来 ${horizon} 日路径数据不足`,
      left: 'center',
      top: 'middle',
      textStyle: { color: '#718196', fontSize: 12, fontWeight: 400 }
    },
    grid: { left: 52, right: 20, top: 24, bottom: 34 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#111824',
      borderColor: '#29364c',
      textStyle: { color: '#dce8f8' },
      formatter: (items) => {
        const item = items[0];
        return item ? `${item.axisValue}<br>相对信号日：${formatter.percentDirect(item.value)}` : '';
      }
    },
    xAxis: {
      type: 'category',
      data: points.map((point) => point.date),
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#263246' } },
      axisLabel: { color: '#66768a', hideOverlap: true },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      name: '相对涨跌（%）',
      splitLine: { lineStyle: { color: 'rgba(150,170,195,0.08)' } },
      axisLabel: { color: '#66768a' },
      nameTextStyle: { color: '#66768a', fontSize: 10 }
    },
    series: [{
      type: 'line',
      data: values,
      symbol: 'circle',
      symbolSize: 5,
      lineStyle: { color: '#4d8dff', width: 2 },
      itemStyle: { color: '#7fb0ff' },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(77,141,255,0.24)' },
            { offset: 1, color: 'rgba(77,141,255,0.01)' }
          ]
        }
      },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: 'rgba(240,184,87,0.35)', type: 'dashed' },
        data: [{ yAxis: 0 }]
      }
    }]
  };
}

function buildIntradayOption(intraday) {
  const trendPoints = intraday.points || [];
  const labels = trendPoints.map((point) => point.time.slice(11));
  const values = trendPoints.map((point) => point.price);
  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 52, right: 20, top: 28, bottom: 32 },
    tooltip: { trigger: 'axis', backgroundColor: '#111824', borderColor: '#29364c', textStyle: { color: '#dce8f8' } },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#263246' } },
      axisLabel: { color: '#66768a', hideOverlap: true },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: 'rgba(150,170,195,0.08)' } },
      axisLabel: { color: '#66768a' }
    },
    series: [{
      name: '分时价格',
      type: 'line',
      data: values,
      symbol: 'none',
      smooth: false,
      lineStyle: { color: '#5b98ff', width: 2 },
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
      backgroundColor: '#111824',
      borderColor: '#29364c',
      textStyle: { color: '#dce8f8' }
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
        axisLine: { lineStyle: { color: '#263246' } },
        axisLabel: { color: '#66768a', hideOverlap: true },
        axisTick: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#263246' } },
        axisLabel: { show: false },
        axisTick: { show: false }
      }
    ],
    yAxis: [
      {
        scale: true,
        splitLine: { lineStyle: { color: 'rgba(150,170,195,0.08)' } },
        axisLabel: { color: '#66768a' }
      },
      {
        gridIndex: 1,
        scale: true,
        splitNumber: 2,
        splitLine: { show: false },
        axisLabel: {
          color: '#66768a',
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
        fillerColor: 'rgba(77,141,255,0.12)',
        handleStyle: { color: '#4d8dff' },
        textStyle: { color: '#66768a' }
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
  state.detailCode = null;
  state.detailData = null;
  state.shareChart = null;
  state.signalDetailChart = null;
  state.charts.forEach((instance) => instance.dispose());
  state.charts = [];
  elements.drawer.classList.remove('is-open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.hidden = true;
  document.body.style.overflow = '';
}

window.addEventListener('resize', () => {
  state.charts.forEach((instance) => instance.resize());
  state.backtestHeatmap?.resize();
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
  elements.refreshButton.addEventListener('click', refreshData);
  elements.viewTabs.forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
  elements.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderTable();
  });
  elements.drawerClose.addEventListener('click', closeDrawer);
  elements.drawerBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
  document.querySelectorAll('th[data-sort]').forEach((header) => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      if (state.sortKey === key) {
        state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortKey = key;
        state.sortDirection = 'desc';
      }
      renderTable();
    });
  });
  elements.backtestSplit.addEventListener('change', async () => {
    state.backtestFilters.split = elements.backtestSplit.value;
    setBacktestDateDefaults();
    await loadBacktest();
  });
  elements.backtestHorizon.addEventListener('change', () => {
    readBacktestFilters();
    updateBacktestExport();
    renderBacktestData();
  });
  for (const select of [
    elements.backtestCode,
    elements.backtestCategory,
    elements.backtestLevel
  ]) {
    select.addEventListener('change', () => loadBacktest());
  }
  for (const input of [elements.backtestFrom, elements.backtestTo]) {
    input.addEventListener('change', () => loadBacktest());
  }
  elements.backtestReset.addEventListener('click', async () => {
    elements.backtestSplit.value = 'validation';
    elements.backtestHorizon.value = '5';
    elements.backtestCode.value = '';
    elements.backtestCategory.value = '';
    elements.backtestLevel.value = '';
    state.backtestFilters = {
      split: 'validation',
      horizon: 5,
      code: '',
      category: '',
      level: '',
      from: '',
      to: ''
    };
    setBacktestDateDefaults();
    await loadBacktest();
  });
}

async function initializePage() {
  bindEvents();
  const url = new URL(window.location.href);
  if (url.searchParams.get('view') === 'evaluation') {
    loadSummary();
    switchView('evaluation', { updateUrl: false });
    await loadBacktest();
    const code = url.searchParams.get('code');
    const date = url.searchParams.get('date');
    if (code && date) {
      await openSignalEvaluation({ code, date });
    }
  } else {
    loadSummary();
  }
}

initializePage();
setInterval(() => {
  if (document.visibilityState === 'visible') loadSummary({ silent: true });
}, 30000);
