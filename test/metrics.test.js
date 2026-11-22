'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scale,
  average,
  volumeRatio,
  percentile,
  periodReturn,
  annualizedVolatility,
  calculateShareStreak,
  calculateShareWindow,
  calculateSignals
} = require('../server/metrics');

test('scale handles null and decimal scaling', () => {
  assert.equal(scale(null, 3), null);
  assert.equal(scale('-', 3), null);
  assert.equal(scale(4060, 3), 4.06);
});

test('average ignores invalid values', () => {
  assert.equal(average([1, 2, null, 3]), 2);
  assert.equal(average([]), null);
});

test('volume ratio compares current amount with prior average', () => {
  assert.equal(volumeRatio(300, Array(20).fill(100)), 3);
  assert.equal(volumeRatio(300, [100, 100, 100]), null);
  assert.equal(volumeRatio(300, [...Array(19).fill(100), null]), null);
  assert.equal(volumeRatio(300, []), null);
});

test('percentile returns an inclusive rank', () => {
  assert.equal(percentile(3, [1, 2, 3, 4]), 0.75);
  assert.equal(percentile(null, [1, 2]), null);
});

test('period return uses the last prior close', () => {
  assert.ok(Math.abs(periodReturn(110, [100]) - 0.1) < 1e-12);
  assert.equal(periodReturn(110, []), null);
});

test('period return can use a multi-day lookback', () => {
  assert.ok(Math.abs(periodReturn(120, [80, 90, 100], 3) - 0.5) < 1e-12);
  assert.equal(periodReturn(120, [80, 90], 3), null);
});

test('annualized volatility requires a complete return window', () => {
  const closes = [100, 101, 100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107, 109, 108, 110, 109];
  assert.ok(annualizedVolatility(closes, 20) > 0);
  assert.equal(annualizedVolatility(closes.slice(-20), 20), null);
  assert.equal(annualizedVolatility(closes, 0), null);
});

test('share streak counts consecutive subscriptions and redemptions', () => {
  const dates = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const subscriptions = [
    { tradeDate: dates[0], shares: 90 },
    { tradeDate: dates[1], shares: 100 },
    { tradeDate: dates[2], shares: 110 },
    { tradeDate: dates[3], shares: 120 }
  ];
  assert.deepEqual(calculateShareStreak(subscriptions, dates), {
    direction: 'subscription', label: '连续净申购', days: 3
  });
  const redemptions = [
    { tradeDate: dates[0], shares: 120 },
    { tradeDate: dates[1], shares: 130 },
    { tradeDate: dates[2], shares: 120 },
    { tradeDate: dates[3], shares: 110 }
  ];
  assert.deepEqual(calculateShareStreak(redemptions, dates), {
    direction: 'redemption', label: '连续净赎回', days: 2
  });
  const flat = [
    { tradeDate: dates[0], shares: 100 },
    { tradeDate: dates[1], shares: 110 },
    { tradeDate: dates[2], shares: 110 }
  ];
  assert.deepEqual(calculateShareStreak(flat, dates.slice(1)), {
    direction: null, label: '持平', days: 0
  });
});

test('share streak stops when an official trading date is missing', () => {
  const dates = ['2026-11-17', '2026-11-18', '2026-11-19'];
  const history = [
    { tradeDate: '2026-11-17', shares: 100 },
    { tradeDate: '2026-11-19', shares: 120 }
  ];
  assert.deepEqual(calculateShareStreak(history, dates), {
    direction: null, label: '持平', days: 0
  });
});

test('share window calculates cumulative net subscription and percentile', () => {
  const history = [
    { tradeDate: '2026-11-17', shares: 100, source: '上交所' },
    { tradeDate: '2026-11-18', shares: 110, source: '上交所' },
    { tradeDate: '2026-11-19', shares: 130, source: '上交所' }
  ];
  const bars = [
    { date: '2026-11-17', close: 3, rawClose: 4 },
    { date: '2026-11-18', close: 3, rawClose: 4 },
    { date: '2026-11-19', close: 3, rawClose: 4 }
  ];
  const result = calculateShareWindow(history, bars, 2);
  assert.equal(result.periodShareDelta, 30);
  assert.equal(result.periodEstimatedSubscription, 120);
  assert.equal(result.sharePercentile, 1);
  assert.equal(result.points.at(-1).cumulativeEstimatedSubscription, 120);
  assert.equal(result.startDate, '2026-11-18');
  assert.equal(result.endDate, '2026-11-19');

  const withGap = calculateShareWindow([history[0], history[2]], bars, 2);
  assert.deepEqual(withGap.points.map((point) => point.tradeDate), ['2026-11-18', '2026-11-19']);
  assert.deepEqual(withGap.points.map((point) => point.shareDelta), [null, null]);
  assert.equal(withGap.periodEstimatedSubscription, null);
});

test('signals flag broad resonance and composite candidate', () => {
  const result = calculateSignals({
    isBroad: true,
    volumeRatio: 2.2,
    previousVolumeRatio: 1.6,
    shareDelta: 100,
    broadResonance: true,
    tailVolumeShare: 0.25
  });
  assert.equal(result.composite, true);
  assert.deepEqual(
    result.signals.map((signal) => signal.key),
    ['volume', 'sustained-volume', 'tail-volume', 'share-up', 'broad-resonance', 'candidate']
  );
  assert.equal(
    result.signals.find((signal) => signal.key === 'candidate').label,
    '异常放量+份额变化候选'
  );
});

test('a single share increase is not a composite signal', () => {
  const result = calculateSignals({
    isBroad: false,
    volumeRatio: 1.1,
    previousVolumeRatio: 1,
    shareDelta: 100,
    broadResonance: false,
    tailVolumeShare: 0.1
  });
  assert.equal(result.composite, false);
  assert.equal(result.signals.length, 1);
});

test('broad resonance does not tag a low-volume broad ETF as a candidate', () => {
  const result = calculateSignals({
    isBroad: true,
    volumeRatio: 0.8,
    previousVolumeRatio: 0.9,
    shareDelta: null,
    broadResonance: true,
    tailVolumeShare: null
  });
  assert.equal(result.composite, false);
  assert.equal(result.signals.length, 0);
});
