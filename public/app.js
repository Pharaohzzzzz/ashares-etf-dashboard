'use strict';

const state = {
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
  charts: []
};

const elements = {
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
  toast: document.querySelector('#toast')
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
  elements.compositeCount.textContent = summary.compositeCount ?? 0;
  elements.resonanceHint.textContent = summary.broadResonance ? '已触发宽基共振' : '成交额达均值2倍且份额增加';
  elements.dataTime.textContent = formatter.time(summary.dataTime);
  elements.generatedTime.textContent = `抓取于 ${formatter.fullTime(summary.generatedAt)}`;
  updateMarketStatus();
  renderSignalBoard();
  renderCategoryTabs();
  renderLogs();
}

function renderSignalBoard() {
  elements.signalBoard.replaceChildren();
  const candidates = state.rows.filter((row) => row.signals?.length).slice(0, 4);
  if (!candidates.length) {
    elements.signalBoard.append(createElement('div', 'signal-empty', '当前没有达到阈值的异动信号'));
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
    const value = createElement(
      'div',
      'signal-value',
      `量比 ${formatter.ratio(row.volumeRatio)} · 成交 ${formatter.amount(row.amount)}`
    );
    const tags = createElement('div', 'tag-row');
    tags.style.justifyContent = 'flex-start';
    tags.style.margin = '9px 0 0';
    for (const signal of row.signals.slice(0, 3)) {
      tags.append(createElement('span', `tag ${signal.level === 'high' ? 'tag-high' : ''}`, signal.label));
    }
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
    tr.classList.toggle('is-candidate', row.composite);
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
  const tags = createElement('div', 'tag-row');
  if (!row.signals?.length) {
    tags.append(createElement('span', 'tag tag-empty', '—'));
  } else {
    for (const signal of row.signals.slice(0, 3)) {
      const className = signal.key === 'candidate'
        ? 'tag tag-candidate'
        : `tag ${signal.level === 'high' ? 'tag-high' : ''}`;
      tags.append(createElement('span', className, signal.label));
    }
  }
  td.append(tags);
  return td;
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

  const disclaimer = createElement('div', 'detail-note');
  disclaimer.textContent = '历史曲线只使用上交所、深交所官方份额，不使用模拟值补齐缺失日期。当前份额仍优先使用官方记录，交易所尚未返回当日数据时才显示行情快照。二级市场买入不增加总份额，候选信号不代表已确认的国家队成交；公开行情接口未提供可靠 IOPV，因此折溢价显示“暂无”。';
  elements.drawerBody.append(disclaimer);

  const signalNote = createElement('section', 'signal-note');
  signalNote.append(createElement('h3', '', '信号触发说明'));
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
    signalList.append(createElement('p', '', '当前没有达到阈值的候选信号。'));
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
  state.charts.forEach((instance) => instance.dispose());
  state.charts = [];
  elements.drawer.classList.remove('is-open');
  elements.drawer.setAttribute('aria-hidden', 'true');
  elements.drawerBackdrop.hidden = true;
  document.body.style.overflow = '';
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
  elements.refreshButton.addEventListener('click', refreshData);
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
}

bindEvents();
loadSummary();
setInterval(() => {
  if (document.visibilityState === 'visible') loadSummary({ silent: true });
}, 30000);
