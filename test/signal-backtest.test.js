'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SIGNAL_PARAMETERS,
  levelForScore,
  calculateSignalScore,
  buildSignalObservations,
  buildBacktest
} = require('../server/signal-backtest');

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
  const first = buildSignalObservations(original);
  const second = buildSignalObservations(withChangedFuture);
  const signalDate = createDate(55);
  for (const item of first.observations.filter((row) => row.date <= signalDate)) {
    const counterpart = second.observations.find(
      (row) => row.code === item.code && row.date === item.date
    );
    assert.ok(counterpart);
    assert.equal(counterpart.score, item.score);
    assert.deepEqual(counterpart.components, item.components);
  }
});

test('backtest outcomes use subsequent dates while scores use the signal date', () => {
  const original = buildBacktest(createDataset());
  const changedFuture = buildBacktest(createDataset({ futureMultiplier: 1.8 }));
  const event = original.events.find((item) => item.date === createDate(55));
  assert.ok(event);
  const changedEvent = changedFuture.events.find(
    (item) => item.code === event.code && item.date === event.date
  );
  assert.equal(changedEvent.score, event.score);
  assert.notEqual(changedEvent.outcomes[5].futureReturn, event.outcomes[5].futureReturn);
  assert.ok(changedEvent.outcomes[5].drawdown <= 0);
  assert.ok(changedEvent.outcomes[5].maxFavorable > 0);
  assert.ok(changedEvent.futurePath[5].every((point) => point.date > event.date));
  assert.equal(event.signalDate, createDate(55));
  assert.equal(event.signalAvailableAt, `${createDate(55)}T15:00:00+08:00`);
  assert.equal(event.earliestEntryDate, createDate(56));
  assert.equal(event.entryPriceMode, 'next_trading_day_open');
  assert.equal(event.outcomes[5].entryDate, createDate(56));
  assert.equal(event.outcomes[5].entryPrice, event.futurePath[5][0].open);
  assert.equal(event.outcomes[5].maxDrawdownMethod, 'entry_to_future_intraday_low');
  assert.ok(event.outcomes[5].zeroCostReturn > event.outcomes[5].futureReturn);
  assert.ok(event.outcomes[5].costDrag > 0);
});

test('signal-day close cannot be used as the same-day entry price', () => {
  const dataset = createDataset();
  const signalIndex = 55;
  for (const etf of dataset) {
    etf.bars[signalIndex].close = etf.bars[signalIndex].open * 100;
    etf.bars[signalIndex].high = etf.bars[signalIndex].close;
    etf.bars[signalIndex].low = etf.bars[signalIndex].open;
  }
  const result = buildBacktest(dataset);
  const event = result.events.find((item) => item.date === createDate(signalIndex));
  assert.ok(event);
  assert.equal(event.outcomes[5].entryDate, createDate(signalIndex + 1));
  assert.notEqual(
    event.outcomes[5].entryPrice,
    dataset[0].bars[signalIndex].close
  );
  assert.ok(event.futurePath[5].every((point) => point.date > event.signalDate));
});

test('backtest uses a chronological 70/30 split and reports samples', () => {
  const result = buildBacktest(createDataset());
  assert.ok(result.window.trainEnd < result.window.validationStart);
  assert.ok(result.window.trainShare <= SIGNAL_PARAMETERS.trainFraction);
  assert.ok(result.window.trainShare >= 0.69);
  for (const split of ['train', 'validation']) {
    for (const horizon of SIGNAL_PARAMETERS.horizons) {
      const row = result.splits[split].byHorizon[horizon];
      assert.ok(Number.isInteger(row.samples));
      assert.ok(row.samples > 0);
    }
  }
  assert.equal(result.etfStatus.length, 2);
  assert.ok(result.etfStatus.every((etf) => etf.status === 'ready'));
});

test('robustness report is deterministic and accounts for overlapping holdings', () => {
  const first = buildBacktest(createDataset());
  const second = buildBacktest(createDataset());
  assert.deepEqual(second.robustness, first.robustness);
  assert.equal(first.robustness.deterministic, true);

  for (const split of ['train', 'validation']) {
    for (const horizon of SIGNAL_PARAMETERS.horizons) {
      const independent = first.robustness.nonOverlapping[split][horizon];
      const raw = first.splits[split].byHorizon[horizon];
      assert.ok(independent.independentSamples <= raw.samples);
      assert.equal(
        independent.independentSamples + independent.overlappingSignalsExcluded,
        raw.samples
      );
      const uncertainty = first.robustness.bootstrap[split][horizon];
      assert.equal(uncertainty.method, 'date_block_bootstrap');
      if (uncertainty.averageReturnConfidenceInterval) {
        assert.ok(
          uncertainty.averageReturnConfidenceInterval.low <=
          uncertainty.averageReturnConfidenceInterval.high
        );
      }
    }
  }

  const rolling = first.robustness.rollingValidation[5];
  assert.ok(rolling.length >= 1);
  assert.ok(rolling.every((window) => (
    window.startDate <= window.endDate &&
    Number.isInteger(window.samples) &&
    window.samples >= 0
  )));
  assert.ok(first.methodology.overlap.includes('重叠'));
  assert.ok(first.methodology.uncertainty.includes('bootstrap'));
});
