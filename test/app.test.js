'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');

const summary = {
  generatedAt: '2026-11-20T08:00:00.000Z',
  dataTime: '2026-11-19T07:00:00.000Z',
  oldestDataTime: '2026-11-19T07:00:00.000Z',
  latestDataTime: '2026-11-19T07:00:00.000Z',
  quoteStatus: 'ok',
  quoteStatusLabel: '行情已连接',
  staleCount: 0,
  totalAmount: 100,
  volumeUpCount: 1,
  shareUpCount: 0,
  compositeCount: 0,
  broadResonance: false,
  etfs: [{
    code: '510300', name: '沪深300ETF华泰柏瑞', category: '宽基核心',
    price: 4.06, changePercent: 0.05, amount: 100, turnoverRate: 5.62,
    capturedAt: '2026-11-19T07:00:05.000Z',
    dataTime: '2026-11-19T07:00:00.000Z',
    quoteStatus: 'fresh',
    quoteStatusLabel: '行情已连接',
    isStale: false,
    officialShareDate: '2026-11-19',
    officialShareSource: '上交所',
    officialShares: 1000,
    quoteShares: 1001,
    previousOfficialShares: 990,
    previousOfficialShareDate: '2026-11-18',
    officialShareFetchedAt: '2026-11-20T00:00:00.000Z',
    volumeRatio: 2.1, shares: 1000, shareDelta: null,
    estimatedSubscription: null, tradeDate: '2026-11-19',
    shareMetricStatus: 'pending',
    latestOfficialShareDelta: 10,
    latestOfficialShareDeltaDate: '2026-11-19',
    latestOfficialPreviousShares: 990,
    latestOfficialPreviousDate: '2026-11-18',
    latestOfficialEstimatedSubscription: 40,
    latestOfficialMetricStatus: 'ready',
    scoreDate: '2026-11-19',
    shareStreak: { direction: 'subscription', label: '连续净申购', days: 3 },
    sharePercentile: 0.82,
    signals: [{ key: 'volume', label: '显著放量', level: 'high' }]
  }],
  logs: []
};

let refreshAllCalls = 0;
let historySyncCalls = 0;

const service = {
  initializedAt: '2026-11-20T07:00:00.000Z',
  initializing: false,
  getSummary: () => summary,
  getDetail: (code) => code === '510300'
    ? { quote: summary.etfs[0], bars: [{ date: '2026-11-19', open: 4, close: 4.06 }] }
    : null,
  refreshQuotes: async () => summary,
  syncHistoricalBars: async () => { historySyncCalls += 1; },
  refreshAllData: async () => {
    refreshAllCalls += 1;
    return summary;
  },
  getIntraday: async (code) => code === '510300' ? { code, points: [], tailVolumeShare: 0.1 } : null,
  getShareHistory: (code, days) => code === '510300'
    ? {
      code,
      selectedDays: days,
      range: {
        days,
        points: [{
          tradeDate: '2026-11-19', shares: 1000, shareDelta: 10,
          estimatedSubscription: 40, cumulativeEstimatedSubscription: 40,
          source: '上交所', fetchedAt: '2026-11-20T00:00:00.000Z',
          officialFetchedAt: '2026-11-20T00:00:00.000Z'
        }]
      },
      ranges: {}
    }
    : null,
  getIopvHistory: (code, days) => code === '510300'
    ? {
      code,
      selectedDays: days,
      current: {
        iopv: 4,
        marketPrice: 4.04,
        premiumRate: 0.01,
        source: '上交所',
        sourceKind: 'official',
        dataTime: '2026-11-19 15:00:00',
        status: 'valid',
        label: '正常'
      },
      stats: {
        open: 0,
        high: 0.01,
        low: 0,
        mean: 0.005,
        latest: 0.01,
        sampleCount: 2
      },
      closeHistory: [{
        tradeDate: '2026-11-19',
        dataTime: '2026-11-19 15:00:00',
        marketPrice: 4.04,
        iopv: 4,
        premiumRate: 0.01,
        source: '上交所',
        sourceKind: 'official'
      }],
      closePercentile: null,
      closeSampleCount: 1,
      coverage: { requestedDays: days, availableDays: 1, status: 'partial' }
    }
    : null
};

test('summary, health, detail and CSV APIs respond', async (context) => {
  const server = createApp({
    service,
    runtimeVersion: { apiVersion: 3, buildId: 'test-build' }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.apiVersion, 3);
  assert.equal(health.buildId, 'test-build');
  const list = await fetch(`${base}/api/summary`).then((response) => response.json());
  assert.equal(list.etfs[0].code, '510300');
  assert.equal(list.apiVersion, 3);
  assert.equal(list.buildId, 'test-build');
  const refresh = await fetch(`${base}/api/refresh`, { method: 'POST' })
    .then((response) => response.json());
  assert.equal(refresh.apiVersion, 3);
  assert.equal(refreshAllCalls, 1);
  const historyRefresh = await fetch(`${base}/api/refresh?kind=history`, { method: 'POST' });
  assert.equal(historyRefresh.status, 200);
  assert.equal(historySyncCalls, 1);
  assert.equal(refreshAllCalls, 1);
  const detail = await fetch(`${base}/api/etfs/510300`).then((response) => response.json());
  assert.equal(detail.bars.length, 1);
  const shareHistory = await fetch(`${base}/api/etfs/510300/share-history?days=20`)
    .then((response) => response.json());
  assert.equal(shareHistory.selectedDays, 20);
  const invalidShareHistory = await fetch(`${base}/api/etfs/510300/share-history?days=30`);
  assert.equal(invalidShareHistory.status, 400);
  const iopvHistory = await fetch(`${base}/api/etfs/510300/iopv-history?days=20`)
    .then((response) => response.json());
  assert.equal(iopvHistory.current.iopv, 4);
  const invalidIopvHistory = await fetch(`${base}/api/etfs/510300/iopv-history?days=0`);
  assert.equal(invalidIopvHistory.status, 400);
  const missing = await fetch(`${base}/api/etfs/000000`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'INVALID_CODE');
  const csv = await fetch(`${base}/api/export.csv`).then((response) => response.text());
  assert.match(csv, /代码/);
  assert.match(csv, /510300/);
  assert.match(csv, /连续净申赎/);
  assert.match(csv, /行情状态/);
  assert.match(csv, /官方份额抓取时间/);
  assert.match(csv, /行情快照份额/);
  assert.match(csv, /当前官方份额/);
  assert.match(csv, /当前日份额状态/);
  assert.match(csv, /最近官方日份额变化日期/);
  assert.match(csv, /pending/);
  assert.match(csv, /数据不足/);
  assert.match(csv, /2026-11-19/);
  const shareCsv = await fetch(`${base}/api/export.csv?code=510300&type=shares`)
    .then((response) => response.text());
  assert.match(shareCsv, /官方总份额/);
  assert.match(shareCsv, /2026-11-19/);
  assert.match(shareCsv, /最新报价时间/);
  assert.match(shareCsv, /不复权收盘价/);
  assert.match(shareCsv, /官方份额来源/);
  assert.match(shareCsv, /官方份额抓取时间/);
  const iopvCsv = await fetch(`${base}/api/export.csv?code=510300&type=iopv`)
    .then((response) => response.text());
  assert.match(iopvCsv, /折溢价率/);
  assert.match(iopvCsv, /交易所官方/);

  for (const path of [
    '/api/backtests/summary',
    '/api/backtests/events?horizon=5',
    '/api/backtests/events/11'
  ]) {
    const removed = await fetch(`${base}${path}`);
    assert.equal(removed.status, 404);
    assert.equal((await removed.json()).error.code, 'NOT_FOUND');
  }
  const removedBacktestCsv = await fetch(`${base}/api/export.csv?type=backtest&horizon=5`);
  assert.equal(removedBacktestCsv.status, 400);
  assert.equal((await removedBacktestCsv.json()).error.code, 'INVALID_CSV_TYPE');
  const invalidCsvType = await fetch(`${base}/api/export.csv?type=unknown`);
  assert.equal(invalidCsvType.status, 400);
  assert.equal((await invalidCsvType.json()).error.code, 'INVALID_CSV_TYPE');
});

test('overview copy distinguishes pending current shares from the latest official day', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  assert.match(html, /行情日官方净申购/);
  assert.match(html, /最近完整评分日异动线索/);
  assert.match(html, /评分基于/);
  assert.match(html, /异常资金评分/);
  assert.match(html, /交易所官方份额通常不是盘中逐秒数据/);
  assert.doesNotMatch(html, /信号评估/);
  assert.doesNotMatch(html, /evaluationView/);
  assert.doesNotMatch(html, /backtest/);
  assert.match(client, /待官方发布/);
  assert.match(client, /评分基于/);
  assert.match(client, /行情快照份额/);
  assert.match(client, /当前官方份额/);
  assert.match(client, /最近官方日/);
  assert.doesNotMatch(client, /信号评估/);
  assert.doesNotMatch(client, /backtest/);
  assert.doesNotMatch(client, /evaluationView/);
});

test('frontend treats a missing or mismatched API contract as an outdated backend', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /EXPECTED_API_VERSION/);
  assert.match(client, /后台版本过旧/);
  assert.match(client, /官方份额同步状态/);
});

test('detail keeps current IOPV premium while removing the historical premium chart', () => {
  const root = path.join(__dirname, '..');
  const client = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

  assert.match(client, /const iopv = detail\.iopvHistory/);
  assert.match(client, /当日市场价与 IOPV/);
  assert.match(client, /iopvIntradayChart/);
  assert.match(client, /导出折溢价历史 CSV/);
  assert.match(client, /当日暂无有效市场价与 IOPV 配对样本/);

  assert.doesNotMatch(client, /收盘折溢价历史分位与近期趋势/);
  assert.doesNotMatch(client, /收盘折溢价分位/);
  assert.doesNotMatch(client, /最近收盘折溢价/);
  assert.doesNotMatch(client, /历史有效样本/);
  assert.doesNotMatch(client, /近期趋势/);
  assert.doesNotMatch(client, /iopvHistory(?:Stats|Chart|Note)/);
  assert.doesNotMatch(client, /buildIopvCloseOption/);
  assert.doesNotMatch(styles, /\.iopv-history-stats/);
});

test('local application assets are served without stale caching', async (context) => {
  const server = createApp({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-cache/);
  }
});

test('internal errors are logged without exposing stack or messages', async (context) => {
  const logged = [];
  const failingService = {
    ...service,
    getSummary: () => {
      throw new Error('secret internal path C:\\private');
    }
  };
  const server = createApp({
    service: failingService,
    logger: { error: (message) => logged.push(message) }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/summary`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, '服务内部错误');
  assert.doesNotMatch(JSON.stringify(body), /secret internal path/);
  assert.match(logged[0], /secret internal path/);
});

test('catalog management APIs drive summary, detail and CSV visibility', async (context) => {
  const db = createDatabase(':memory:');
  context.after(() => db.close());
  db.removeEtf('510050');
  db.startSyncTask('backtest', { targetDates: ['2026-11-20'] });
  const marketService = new MarketService({
    db,
    etfLookupProvider: async (code) => ({
      code,
      name: `测试ETF${code}`,
      market: code.startsWith('5') ? 1 : 0,
      exchange: code.startsWith('5') ? '上交所' : '深交所',
      securityType: '基金'
    }),
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });
  let backfillCode = null;
  marketService.backfillEtf = async (code) => {
    backfillCode = code;
    return marketService.getSummary();
  };
  const server = createApp({
    service: marketService,
    runtimeVersion: { apiVersion: 3, buildId: 'catalog-test' }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const state = await fetch(`${base}/api/etfs/manage`).then((response) => response.json());
  assert.equal(state.capacity, 30);
  assert.equal(state.enabledCount, 13);
  assert.equal(state.removed.some((etf) => etf.code === '510050'), true);
  assert.equal(Object.hasOwn(state.summary.dataStatus.tasks, 'backtest'), false);
  const catalogOnly = await fetch(`${base}/api/etfs/manage?includeSummary=false`).then((response) => response.json());
  assert.equal(catalogOnly.enabledCount, 13);
  assert.equal(Object.hasOwn(catalogOnly, 'summary'), false);

  const invalid = await fetch(`${base}/api/etfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '51050', category: '测试', tone: 'broad' })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_CODE');

  const addedResponse = await fetch(`${base}/api/etfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '159999', category: '测试分类', tone: 'tech' })
  });
  assert.equal(addedResponse.status, 201);
  const added = await addedResponse.json();
  assert.equal(added.etf.code, '159999');
  assert.equal(added.etf.isPinned, false);
  assert.equal(added.summary.etfs.some((etf) => etf.code === '159999'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backfillCode, '159999');

  const editedResponse = await fetch(`${base}/api/etfs/159999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: '科技测试',
      tone: 'finance',
      isPinned: true,
      isHighlighted: true
    })
  });
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json();
  assert.equal(edited.etf.isPinned, true);
  assert.equal(edited.etf.isHighlighted, true);

  const beforeOrder = marketService.getSummary().etfs;
  const pinned = beforeOrder.filter((etf) => etf.isPinned).map((etf) => etf.code).reverse();
  const normal = beforeOrder.filter((etf) => !etf.isPinned).map((etf) => etf.code).reverse();
  const orderResponse = await fetch(`${base}/api/etfs/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinnedCodes: pinned, normalCodes: normal })
  });
  assert.equal(orderResponse.status, 200);
  assert.equal((await orderResponse.clone().json()).apiVersion, 3);
  assert.deepEqual(
    marketService.getSummary().etfs.filter((etf) => etf.isPinned).map((etf) => etf.code),
    pinned
  );

  const missingConfirmation = await fetch(`${base}/api/etfs/510300`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(missingConfirmation.status, 400);
  assert.equal((await missingConfirmation.json()).error.code, 'CONFIRMATION_REQUIRED');
  const removedResponse = await fetch(`${base}/api/etfs/510300`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  });
  assert.equal(removedResponse.status, 200);
  assert.equal((await removedResponse.json()).summary.etfs.some((etf) => etf.code === '510300'), false);

  const removedDetail = await fetch(`${base}/api/etfs/510300`);
  assert.equal(removedDetail.status, 400);
  const removedCsv = await fetch(`${base}/api/export.csv?code=510300&type=daily`);
  assert.equal(removedCsv.status, 400);

  const restoredResponse = await fetch(`${base}/api/etfs/510300/restore`, {
    method: 'POST'
  });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.etf.enabled, true);
  assert.equal(restored.etf.isPinned, false);

  const csv = await fetch(`${base}/api/export.csv`).then((response) => response.text());
  assert.match(csv, /510300/);
  assert.doesNotMatch(csv, /510050/);
  assert.match(csv, /近5日累计估算净申赎/);
  assert.match(csv, /近20日累计估算净申赎/);
  assert.match(csv, /20日波动率/);
  assert.match(csv, /估算基金规模/);

  const restoredOrder = await fetch(`${base}/api/etfs/order/restore`, { method: 'POST' });
  assert.equal(restoredOrder.status, 200);
  assert.deepEqual(
    marketService.getSummary().etfs.slice(0, 2).map((etf) => etf.code),
    ['159915', '159516']
  );
});
