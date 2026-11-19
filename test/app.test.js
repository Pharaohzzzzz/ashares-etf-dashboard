'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');

const summary = {
  generatedAt: '2026-11-20T08:00:00.000Z',
  dataTime: '2026-11-19T07:00:00.000Z',
  totalAmount: 100,
  volumeUpCount: 1,
  shareUpCount: 0,
  compositeCount: 0,
  broadResonance: false,
  etfs: [{
    code: '510300', name: '沪深300ETF华泰柏瑞', category: '宽基核心',
    price: 4.06, changePercent: 0.05, amount: 100, turnoverRate: 5.62,
    volumeRatio: 2.1, shares: 1000, shareDelta: null,
    estimatedSubscription: null, tradeDate: '2026-11-19',
    shareStreak: { direction: 'subscription', label: '连续净申购', days: 3 },
    sharePercentile: 0.82,
    signals: [{ key: 'volume', label: '显著放量', level: 'high' }]
  }],
  logs: []
};

const service = {
  initializedAt: '2026-11-20T07:00:00.000Z',
  initializing: false,
  getSummary: () => summary,
  getDetail: (code) => code === '510300'
    ? { quote: summary.etfs[0], bars: [{ date: '2026-11-19', open: 4, close: 4.06 }] }
    : null,
  refreshQuotes: async () => summary,
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
          source: '上交所'
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
    : null,
  getBacktestSummary: async () => ({
    parameterVersion: 'signal-score-v1.0.1',
    run: { id: 7, generatedAt: '2026-11-20T08:00:00.000Z' },
    parameters: { weights: { volume: 35 }, horizons: [1, 3, 5, 10] },
    splits: {
      train: {},
      validation: {}
    }
  }),
  getBacktestEvents: async (filters) => ({
    runId: 7,
    parameterVersion: 'signal-score-v1.0.1',
    events: filters.code === '000000'
      ? []
      : filters.code === '588170'
        ? [{
          id: 12,
          code: '588170',
          name: '科创半导体ETF华夏',
          category: '半导体',
          date: '2026-11-19',
          split: 'validation',
          score: 63.8,
          level: { key: 'active', label: '活跃异动' },
          legacyComposite: false,
          outcomes: { 5: {} }
        }]
        : [{
          id: 11,
          code: '510300',
          name: '沪深300ETF华泰柏瑞',
          category: '宽基核心',
          date: '2026-10-15',
          signalAvailableAt: '2026-10-15T15:00:00+08:00',
          earliestEntryDate: '2026-10-16',
          entryPriceMode: 'next_trading_day_open',
          split: 'validation',
          score: 72.5,
          level: { key: 'active', label: '活跃异动' },
          legacyComposite: true,
          outcomes: {
            5: {
              futureReturn: 0.03,
              zeroCostReturn: 0.032,
              costDrag: 0.002,
              drawdown: -0.02,
              maxDrawdownMethod: 'entry_to_future_intraday_low',
              entryPrice: 4.1,
              exitDate: '2026-10-22',
              maxFavorable: 0.04,
              benchmarkReturn: 0.01,
              outperformedBenchmark: true,
              baselineHitRate: 0.48,
              returnVsUnconditional: 0.012
            }
          }
        }]
  }),
  getBacktestEvent: async (id) => Number(id) === 11
    ? {
      id: 11,
      code: '510300',
      date: '2026-10-15',
      components: [{ key: 'volume', contribution: 20 }],
      outcomes: { 5: { futureReturn: 0.03 } },
      futurePath: { 5: [{ date: '2026-10-16', close: 4.2, relative: 0.01 }] }
    }
    : null
};

test('summary, health, detail and CSV APIs respond', async (context) => {
  const server = createApp({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  const list = await fetch(`${base}/api/summary`).then((response) => response.json());
  assert.equal(list.etfs[0].code, '510300');
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
  assert.equal(missing.status, 404);
  const csv = await fetch(`${base}/api/export.csv`).then((response) => response.text());
  assert.match(csv, /代码/);
  assert.match(csv, /510300/);
  assert.match(csv, /连续净申赎/);
  const shareCsv = await fetch(`${base}/api/export.csv?code=510300&type=shares`)
    .then((response) => response.text());
  assert.match(shareCsv, /官方总份额/);
  assert.match(shareCsv, /2026-11-19/);
  const iopvCsv = await fetch(`${base}/api/export.csv?code=510300&type=iopv`)
    .then((response) => response.text());
  assert.match(iopvCsv, /折溢价率/);
  assert.match(iopvCsv, /交易所官方/);

  const backtestSummary = await fetch(`${base}/api/backtests/summary`)
    .then((response) => response.json());
  assert.equal(backtestSummary.run.id, 7);
  const backtestEvents = await fetch(`${base}/api/backtests/events?horizon=5&code=510300`)
    .then((response) => response.json());
  assert.equal(backtestEvents.events[0].score, 72.5);
  const invalidHorizon = await fetch(`${base}/api/backtests/events?horizon=2`);
  assert.equal(invalidHorizon.status, 400);
  const signalEvent = await fetch(`${base}/api/backtests/events/11`)
    .then((response) => response.json());
  assert.equal(signalEvent.components[0].contribution, 20);
  const missingSignalEvent = await fetch(`${base}/api/backtests/events/12`);
  assert.equal(missingSignalEvent.status, 404);
  const backtestCsv = await fetch(`${base}/api/export.csv?type=backtest&horizon=5&code=510300`)
    .then((response) => response.text());
  assert.match(backtestCsv, /信号日期/);
  assert.match(backtestCsv, /最早入场日/);
  assert.match(backtestCsv, /零成本未来收益/);
  assert.match(backtestCsv, /2026-10-16/);
  assert.match(backtestCsv, /72.5/);
  const missingOutcomeCsv = await fetch(`${base}/api/export.csv?type=backtest&horizon=5&code=588170`)
    .then((response) => response.text());
  assert.match(missingOutcomeCsv, /数据不足/);
  assert.doesNotMatch(missingOutcomeCsv, /2026-11-19,验证期,63.8,活跃异动,5日,,,,,否/);
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
