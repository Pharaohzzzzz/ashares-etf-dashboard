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
