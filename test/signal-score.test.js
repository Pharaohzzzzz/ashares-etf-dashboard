'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SIGNAL_PARAMETERS,
  levelForScore,
  calculateSignalScore,
  buildSignalScores
} = require('../server/signal-score');

function createDate(index) {
  return new Date(Date.UTC(2025, 0, 2 + index)).toISOString().slice(0, 10);
}

function createDataset({ count = 90, futureMultiplier = 1 } = {}) {
  const etfs = [
    { code: '159516', name: '半导体设备ETF国泰', category: '半导体', tone: 'tech' },
    { code: '588170', name: '科创半导体ETF华夏', category: '半导体', tone: 'tech' }
  ];
  return etfs.map((etf, etfIndex) => ({
    etf,
    bars: Array.from({ length: count }, (_, index) => {
      const spike = index === 55;
      const closeBase = 10 + index * 0.02;
      const close = index > 55
        ? closeBase * futureMultiplier
        : closeBase;
      return {
        date: createDate(index),
        open: close - 0.1,
        close,
        high: close + 0.2,
        low: close - 0.2,
        volume: 100,
        amount: spike ? 300 + etfIndex * 10 : 100,
        amplitude: 1,
        changePercent: 0,
        change: 0,
        turnoverRate: 1
      };
    }),
    shares: Array.from({ length: count }, (_, index) => ({
      tradeDate: createDate(index),
      shares: 100000 + index * 100,
      source: '深交所'
    }))
  }));
}

test('signal score exposes all weighted components and fixed levels', () => {
  const result = calculateSignalScore({
    volumeRatio: 3,
    shareDelta: 100,
    sharePercentile: 1,
    shareSamples: 30,
    streak: { direction: 'subscription', label: '连续净申购', days: 5 },
    resonanceCount: 2,
    resonanceSource: '同分类',
    categorySize: 2
  });
  assert.equal(result.score, 100);
  assert.equal(result.level.label, '高强度异动');
  assert.deepEqual(result.components.map((component) => component.weight), [35, 30, 15, 20]);
  assert.equal(result.components.reduce((sum, component) => sum + component.contribution, 0), 100);
  assert.equal(levelForScore(40).label, '观察');
  assert.equal(levelForScore(60).label, '活跃异动');
  assert.equal(levelForScore(80).label, '高强度异动');
  assert.equal(levelForScore(39.9).label, '未达阈值');
});

test('signal score returns data missing instead of fabricating a score', () => {
  assert.equal(calculateSignalScore({
    volumeRatio: 2,
    shareDelta: null,
    sharePercentile: null,
    shareSamples: 0,
    streak: { direction: null, label: '持平', days: 0 },
    resonanceCount: 2,
    resonanceSource: '同分类',
    categorySize: 2
  }), null);
});

test('future bars and future shares cannot alter an earlier day score', () => {
  const original = createDataset();
  const withChangedFuture = createDataset({ futureMultiplier: 1.8 });
  for (const etf of withChangedFuture) {
    for (const share of etf.shares) {
      if (share.tradeDate > createDate(55)) share.shares *= 20;
    }
  }
  const first = buildSignalScores(original);
  const second = buildSignalScores(withChangedFuture);
  const signalDate = createDate(55);
  for (const item of first.filter((row) => row.date <= signalDate)) {
    const counterpart = second.find(
      (row) => row.code === item.code && row.date === item.date
    );
    assert.ok(counterpart);
    assert.equal(counterpart.score, item.score);
    assert.deepEqual(counterpart.components, item.components);
  }
});
