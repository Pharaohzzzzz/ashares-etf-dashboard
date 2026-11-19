'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePremiumRate,
  parseSseIopv,
  parseSzseIopv,
  crossCheckIopv,
  resolveIopvState
} = require('../server/iopv');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');
const { ETFS } = require('../config/etfs');

const etf = ETFS.find((item) => item.code === '510300');

function sample(overrides = {}) {
  return {
    code: '510300',
    tradeDate: '2026-11-19',
    dataTime: '2026-11-19 15:00:00',
    observedAt: '2026-11-19T07:00:00.000Z',
    marketPrice: 4.06,
    iopv: 4,
    source: '上交所',
    sourceKind: 'official',
    sourceUrl: 'https://www.sse.com.cn/',
    status: 'valid',
    crossCheck: null,
    ...overrides
  };
}

function almost(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('premium formula uses market price divided by IOPV minus one', () => {
  almost(calculatePremiumRate(4.06, 4), 0.015);
  almost(calculatePremiumRate(3.96, 4), -0.01);
  assert.equal(calculatePremiumRate(0, 4), null);
  assert.equal(calculatePremiumRate(4, 0), null);
  assert.equal(calculatePremiumRate(4, -1), null);
  assert.equal(calculatePremiumRate(null, 4), null);
});

test('official parsers preserve exchange timestamps and positive IOPV only', () => {
  const sse = parseSseIopv(etf, {
    snap: ['510300', '300ETF', 4.06, 4.058, 4.046, 4.072, 4.013, 100, 200, 4.0598, 'E110', 20261119, 162900]
  });
  assert.equal(sse.iopv, 4.0598);
  assert.equal(sse.marketPrice, 4.06);
  assert.equal(sse.tradeDate, '2026-11-19');
  assert.equal(sse.dataTime, '2026-11-19 16:29:00');
  assert.equal(sse.source, '上交所');

  const szse = parseSzseIopv(
    { ...etf, code: '159919' },
    {
      code: '0',
      data: {
        code: '159919',
        name: '沪深300ETF嘉实',
        now: '4.239',
        netValue: '4.240',
        marketTime: '2026-11-19 15:30:00',
        picupdata: [['09:30', '4.226'], ['15:00', '4.239']],
        piciopv: [['09:30', '4.227'], ['15:00', '4.240'], ['15:01', 0]]
      }
    }
  );
  assert.equal(szse.iopv, 4.24);
  assert.equal(szse.series.length, 2);
  assert.equal(szse.series[0].premiumRate, calculatePremiumRate(4.226, 4.227));
  assert.equal(szse.series.some((point) => point.iopv <= 0), false);
});

test('missing, zero and stale values never produce a current premium', () => {
  const now = new Date('2026-11-20T00:00:00.000Z');
  const missing = resolveIopvState(null, { now, latestTradeDate: '2026-11-19' });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.premiumRate, null);

  const zero = resolveIopvState(sample({ iopv: 0 }), {
    now,
    latestTradeDate: '2026-11-19'
  });
  assert.equal(zero.status, 'zero');
  assert.equal(zero.label, '数据异常');
  assert.equal(zero.premiumRate, null);

  const stale = resolveIopvState(sample({
    tradeDate: '2026-11-18',
    dataTime: '2026-11-18 15:00:00',
    observedAt: '2026-11-18T07:00:00.000Z'
  }), {
    now,
    latestTradeDate: '2026-11-19'
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.label, '数据过期');
  assert.equal(stale.iopv, 4);
  assert.equal(stale.premiumRate, null);
});

test('cross-source values merge only when timestamps align and values agree', () => {
  const primary = sample();
  const matched = crossCheckIopv(primary, sample({
    iopv: 4.0002,
    dataTime: '2026-11-19 15:00:30',
    observedAt: '2026-11-19T07:00:30.000Z',
    source: '东方财富（补充）',
    sourceKind: 'supplementary'
  }));
  assert.equal(matched.status, 'matched');

  const conflict = crossCheckIopv(primary, sample({
    iopv: 4.02,
    dataTime: '2026-11-19 15:00:10',
    observedAt: '2026-11-19T07:00:10.000Z',
    source: '东方财富（补充）',
    sourceKind: 'supplementary'
  }));
  assert.equal(conflict.status, 'conflict');

  const unaligned = crossCheckIopv(primary, sample({
    iopv: 4.02,
    dataTime: '2026-11-19 15:05:00',
    observedAt: '2026-11-19T07:05:00.000Z',
    source: '东方财富（补充）',
    sourceKind: 'supplementary'
  }));
  assert.equal(unaligned.status, 'unaligned');
  const resolved = resolveIopvState(sample({ crossCheck: unaligned }), {
    now: new Date('2026-11-20T00:00:00.000Z'),
    latestTradeDate: '2026-11-19'
  });
  assert.equal(resolved.status, 'valid');
  assert.equal(resolved.iopv, 4);
});

test('IOPV sample and latest persistence are idempotent and keep gaps empty', () => {
  const db = createDatabase(':memory:');
  const point = {
    ...sample(),
    premiumRate: calculatePremiumRate(4.06, 4)
  };
  db.saveIopvSamples([point], '2026-11-20T00:00:00.000Z');
  db.saveIopvSamples([{ ...point, premiumRate: 0.02 }], '2026-11-20T00:01:00.000Z');
  assert.equal(db.countIopvSamples('510300'), 1);
  assert.equal(db.getIopvSamplesForDate('510300', '2026-11-19')[0].premiumRate, 0.02);

  db.saveIopvLatest({
    ...point,
    premiumRate: 0.02,
    fetchedAt: '2026-11-20T00:01:00.000Z',
    attemptedAt: '2026-11-20T00:01:00.000Z'
  });
  db.saveIopvLatest({
    ...point,
    premiumRate: 0.03,
    fetchedAt: '2026-11-20T00:02:00.000Z',
    attemptedAt: '2026-11-20T00:02:00.000Z'
  });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM iopv_latest').get().count, 1);
  assert.equal(db.getIopvLatest('510300').premiumRate, 0.03);
  assert.equal(db.getIopvCloseHistory('510300', 250).length, 1);
  assert.equal(db.getIopvCloseHistory('510300', 250)[0].tradeDate, '2026-11-19');
  db.close();
});

test('source degradation preserves last valid value and marks it stale', async () => {
  const db = createDatabase(':memory:');
  let fail = false;
  const service = new MarketService({
    db,
    officialIopvProvider: async (item) => {
      if (fail) throw new Error('official unavailable');
      return sample({
        code: item.code,
        iopv: 4,
        marketPrice: 4.04,
        series: [{
          ...sample(),
          code: item.code,
          dataTime: '2026-11-19 14:59:00',
          observedAt: '2026-11-19T06:59:00.000Z',
          marketPrice: 4.02,
          iopv: 4,
          premiumRate: 0.005
        }]
      });
    },
    supplementaryIopvProvider: async () => new Map(),
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  await service.refreshIopv();
  const valid = db.getIopvLatest('510300');
  assert.equal(valid.status, 'valid');
  almost(valid.premiumRate, 0.01);
  assert.equal(db.getIopvSamplesForDate('510300', '2026-11-19').length, 2);

  fail = true;
  await service.refreshIopv();
  const degraded = db.getIopvLatest('510300');
  assert.equal(degraded.status, 'stale');
  assert.equal(degraded.iopv, 4);
  assert.match(degraded.message, /不可用|降级/);
  assert.equal(service.getCurrentIopv('510300', '2026-11-19').premiumRate, null);
  db.close();
});

test('supplementary source is clearly labeled when official data is unavailable', async () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({
    db,
    officialIopvProvider: async () => {
      throw new Error('official unavailable');
    },
    supplementaryIopvProvider: async (etfs) => new Map(etfs.map((item) => [item.code, sample({
      code: item.code,
      source: '东方财富（补充）',
      sourceKind: 'supplementary',
      sourceUrl: `https://quote.eastmoney.com/${item.code}.html`
    })])),
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  await service.refreshIopv();
  const row = service.getCurrentIopv('510300', '2026-11-19');
  assert.equal(row.status, 'valid');
  assert.equal(row.sourceKind, 'supplementary');
  assert.equal(row.source, '东方财富（补充）');
  almost(row.premiumRate, 0.015);
  db.close();
});

test('same-day statistics and close history use recorded values without interpolation', () => {
  const db = createDatabase(':memory:');
  for (const date of [
    '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13',
    '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'
  ]) {
    db.upsertBars('510300', [{
      date,
      open: 4,
      close: 4,
      high: 4,
      low: 4,
      volume: 1,
      amount: 1,
      amplitude: 0,
      changePercent: 0,
      change: 0,
      turnoverRate: 0
    }]);
  }
  const dailyRates = [-0.01, -0.005, 0, 0.005, 0.01, 0.015];
  const dailyDates = [
    '2026-11-10', '2026-11-11', '2026-11-12',
    '2026-11-13', '2026-11-18', '2026-11-19'
  ];
  db.saveIopvSamples(dailyDates.map((date, index) => ({
    ...sample(),
    tradeDate: date,
    dataTime: `${date} 15:00:00`,
    observedAt: new Date(`${date}T07:00:00.000Z`).toISOString(),
    marketPrice: 4 * (1 + dailyRates[index]),
    iopv: 4,
    premiumRate: dailyRates[index]
  })));
  const intradayRates = [-0.002, 0.001, 0.004, 0.003, 0.005];
  db.saveIopvSamples(intradayRates.map((rate, index) => ({
    ...sample(),
    dataTime: `2026-11-19 14:5${index}:00`,
    observedAt: `2026-11-19T06:5${index}:00.000Z`,
    marketPrice: 4 * (1 + rate),
    iopv: 4,
    premiumRate: rate
  })));
  db.saveIopvLatest({
    ...sample(),
    marketPrice: 4.02,
    iopv: 4,
    premiumRate: 0.005,
    fetchedAt: '2026-11-20T00:00:00.000Z',
    attemptedAt: '2026-11-20T00:00:00.000Z'
  });
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  const history = service.getIopvHistory('510300', 20);
  assert.equal(history.stats.open, -0.002);
  assert.equal(history.stats.first, -0.002);
  assert.equal(history.stats.high, 0.015);
  assert.equal(history.stats.low, -0.002);
  assert.equal(history.stats.latest, 0.015);
  assert.equal(history.stats.sampleCount, 6);
  assert.equal(history.stats.firstRecordLabel, '首个记录时点');
  assert.equal(history.stats.firstTime, '2026-11-19 14:50:00');
  assert.equal(history.stats.lastTime, '2026-11-19 15:00:00');
  assert.equal(history.closeSampleCount, 6);
  assert.ok(Number.isFinite(history.closePercentile));
  assert.equal(history.closeHistory.some((point) => point.premiumRate === 0 && !dailyRates.includes(0)), false);
  assert.equal(history.coverage.status, 'partial');
  db.close();
});

test('IOPV statistics label first samples without claiming an opening record', () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  const insertSamples = (times) => {
    db.raw.exec('DELETE FROM iopv_samples');
    db.saveIopvSamples(times.map((time, index) => ({
      ...sample(),
      dataTime: `2026-11-19 ${time}:00`,
      observedAt: new Date(`2026-11-19T${String(Number(time.slice(0, 2)) - 8).padStart(2, '0')}:${time.slice(3)}:00.000Z`).toISOString(),
      marketPrice: 4,
      iopv: 4,
      premiumRate: (index + 1) / 1000
    })));
    db.saveIopvLatest({
      ...sample(),
      marketPrice: 4,
      iopv: 4,
      premiumRate: 0.003,
      fetchedAt: '2026-11-20T00:00:00.000Z',
      attemptedAt: '2026-11-20T00:00:00.000Z'
    });
    return service.getIopvHistory('510300', 1).stats;
  };

  const single = insertSamples(['10:17']);
  assert.equal(single.sampleCount, 1);
  assert.equal(single.firstRecordLabel, '首个记录时点');
  assert.equal(single.firstTime, '2026-11-19 10:17:00');

  const two = insertSamples(['10:17', '10:18']);
  assert.equal(two.sampleCount, 2);
  assert.equal(two.firstTime, '2026-11-19 10:17:00');
  assert.equal(two.lastTime, '2026-11-19 10:18:00');
  assert.equal(two.firstRecordLabel, '首个记录时点');

  const full = insertSamples(['09:31', '09:32', '09:33']);
  assert.equal(full.sampleCount, 3);
  assert.equal(full.firstTime, '2026-11-19 09:31:00');
  assert.equal(full.firstRecordLabel, '首个记录时点');
  db.close();
});
