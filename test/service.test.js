'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');
const { ETFS } = require('../config/etfs');

function createBars(count = 25) {
  return Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return {
      date: `2026-10-${day}`,
      open: 4,
      close: 4 + index * 0.01,
      high: 4.1,
      low: 3.9,
      volume: 100,
      amount: 100,
      amplitude: 1,
      changePercent: 1,
      change: 0.01,
      turnoverRate: 1
    };
  });
}

function createConsecutiveBars(count) {
  const start = Date.UTC(2025, 0, 2);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(start + index * 86400000).toISOString().slice(0, 10),
    open: 4,
    close: 4 + index * 0.001,
    high: 4.1,
    low: 3.9,
    volume: 100,
    amount: 100,
    amplitude: 1,
    changePercent: 1,
    change: 0.01,
    turnoverRate: 1
  }));
}

async function mockOfficialIopv(etf) {
  return {
    code: etf.code,
    name: etf.name,
    marketPrice: 4,
    iopv: 4,
    tradeDate: '2026-10-26',
    dataTime: '2026-10-26 15:00:00',
    observedAt: '2026-10-26T07:00:00.000Z',
    source: '上交所',
    sourceKind: 'official',
    sourceUrl: 'https://www.sse.com.cn/',
    series: []
  };
}

async function mockSupplementaryIopv(etfs) {
  return new Map(etfs.map((etf) => [etf.code, {
    code: etf.code,
    marketPrice: 4,
    iopv: 4,
    tradeDate: '2026-10-26',
    dataTime: '2026-10-26 15:00:00',
    observedAt: '2026-10-26T07:00:00.000Z',
    source: '东方财富（补充）',
    sourceKind: 'supplementary',
    sourceUrl: 'https://quote.eastmoney.com/'
  }]));
}

test('summary calculates ratio, returns, shares and a broad resonance candidate', () => {
  const db = createDatabase(':memory:');
  db.upsertBars('510300', createBars());
  db.saveSnapshot({
    code: '510300', price: 4.4, previousClose: 4.3, change: 0.1,
    changePercent: 2, open: 4.3, high: 4.4, low: 4.2, volume: 300,
    amount: 300, turnoverRate: 3, shares: 1200, marketValue: 5000,
    timestamp: 1795114800
  }, '2026-10-26', '2026-10-26T07:00:00.000Z');
  db.saveSnapshot({
    code: '510300', price: 4.2, previousClose: 4.1, change: 0.1,
    changePercent: 2, open: 4.1, high: 4.2, low: 4.0, volume: 100,
    amount: 100, turnoverRate: 1, shares: 1000, marketValue: 4000,
    timestamp: 1795028400
  }, '2026-10-25', '2026-10-25T07:00:00.000Z');
  const service = new MarketService({
    db,
    now: () => new Date('2026-10-26T08:00:00.000Z')
  });
  const summary = service.getSummary();
  const row = summary.etfs.find((etf) => etf.code === '510300');
  assert.equal(row.volumeRatio, 3);
  assert.equal(row.shareDelta, 200);
  assert.equal(row.signals.some((signal) => signal.key === 'volume'), true);
  assert.equal(summary.totalAmount, 300);
  assert.deepEqual(summary.amountCoverage, { available: 1, total: 1 });
  db.close();
});

test('summary excludes missing amounts from totals while preserving valid zero', () => {
  const db = createDatabase(':memory:');
  const quote = {
    code: '510300', price: 4, previousClose: 4, change: 0,
    changePercent: 0, open: 4, high: 4, low: 4, volume: 0,
    amount: 0, turnoverRate: 0, shares: 1000, marketValue: 4000,
    timestamp: 1795114800
  };
  db.saveSnapshot(quote, '2026-11-19', '2026-11-19T07:00:00.000Z');
  db.saveSnapshot({
    ...quote,
    code: '159919',
    amount: null,
    timestamp: 1795114801
  }, '2026-11-19', '2026-11-19T07:00:01.000Z');
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  const summary = service.getSummary();
  assert.equal(summary.totalAmount, 0);
  assert.deepEqual(summary.amountCoverage, { available: 1, total: 2 });
  db.close();
});

test('refreshQuotes records provider failures without discarding successes', async () => {
  const db = createDatabase(':memory:');
  let call = 0;
  const service = new MarketService({
    db,
    quoteProvider: async (etf) => {
      call += 1;
      if (call > 2) throw new Error('mock failure');
      return {
        code: etf.code, price: 1, previousClose: 1, change: 0,
        changePercent: 0, open: 1, high: 1, low: 1, volume: 1,
        amount: 1, turnoverRate: 0, shares: 1, marketValue: 1,
        timestamp: 1795114800
      };
    },
    officialIopvProvider: mockOfficialIopv,
    supplementaryIopvProvider: mockSupplementaryIopv,
    calendarProvider: async (date) => ({
      month: '2026-10',
      source: '深交所',
      sourceUrl: 'https://www.szse.cn/aboutus/calendar/',
      rows: [{
        date: '2026-10-26',
        isTrading: true,
        exchangeStatus: '1',
        name: null
      }]
    }),
    now: () => new Date('2026-10-26T08:00:00.000Z')
  });
  const summary = await service.refreshQuotes();
  assert.equal(summary.etfs.length, 2);
  assert.equal(
    summary.logs.find((log) => log.scope === 'quotes')?.status,
    'partial'
  );
  db.close();
});

test('invalid code returns no detail', () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({ db });
  assert.equal(service.getDetail('000000'), null);
  db.close();
});

test('initialization continues when one ETF history request fails', async () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({
    db,
    klineProvider: async (etf) => {
      if (etf.code === '510050') throw new Error('mock history failure');
      return createBars(1);
    },
    quoteProvider: async (etf) => ({
      code: etf.code, price: 1, previousClose: 1, change: 0,
      changePercent: 0, open: 1, high: 1, low: 1, volume: 1,
      amount: 1, turnoverRate: 0, shares: 1, marketValue: 1,
      timestamp: 1795114800
    }),
    sseShareProvider: async () => new Map(),
    szseShareProvider: async () => new Map(),
    officialIopvProvider: mockOfficialIopv,
    supplementaryIopvProvider: mockSupplementaryIopv,
    calendarProvider: async () => ({
      month: '2026-10',
      source: '深交所',
      sourceUrl: 'https://www.szse.cn/aboutus/calendar/',
      rows: [{
        date: '2026-10-26',
        isTrading: true,
        exchangeStatus: '1',
        name: null
      }]
    }),
    now: () => new Date('2026-10-26T08:00:00.000Z')
  });
  await service.initialize({ force: true });
  assert.equal(db.getLatestSnapshots().length, 14);
  assert.equal(service.getSummary().etfs.length, 14);
  db.close();
});

test('official previous-day shares populate ETF share delta immediately', async () => {
  const db = createDatabase(':memory:');
  db.upsertBars('510300', [
    {
      date: '2026-11-17', open: 4, close: 4.05, high: 4.1, low: 3.9,
      volume: 100, amount: 100, amplitude: 1, changePercent: 1,
      change: 0.01, turnoverRate: 1
    },
    {
      date: '2026-11-18', open: 4, close: 4.1, high: 4.2, low: 3.9,
      volume: 100, amount: 100, amplitude: 1, changePercent: 1,
      change: 0.01, turnoverRate: 1
    }
  ]);
  db.saveSnapshot({
    code: '510300', price: 4.2, previousClose: 4.1, change: 0.1,
    changePercent: 2, open: 4.1, high: 4.2, low: 4.0, volume: 100,
    amount: 100, turnoverRate: 1, shares: 1200, marketValue: 4000,
    timestamp: 1795114800
  }, '2026-11-19', '2026-11-19T07:00:00.000Z');
  const service = new MarketService({
    db,
    sseShareProvider: async (date) => new Map([['510300', date === '2026-11-19' ? 1200 : 1000]]),
    szseShareProvider: async () => new Map(),
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  const result = await service.syncOfficialShareHistory('2026-11-19');
  const row = result.summary.etfs.find((etf) => etf.code === '510300');
  assert.equal(result.tradeDate, '2026-11-18');
  assert.equal(row.shares, 1200);
  assert.equal(row.sharesSource, '上交所');
  assert.equal(row.previousShares, 1000);
  assert.equal(row.previousShareSource, '上交所');
  assert.equal(row.shareDelta, 200);
  assert.equal(row.estimatedSubscription, 840);
  db.close();
});

test('official history backfill covers the 250-day analytics window and stays idempotent', async () => {
  const db = createDatabase(':memory:');
  const bars = createConsecutiveBars(251);
  db.upsertBars('510300', bars);
  const lastDate = bars.at(-1).date;
  db.saveSnapshot({
    code: '510300', price: 4.4, previousClose: 4.3, change: 0.1,
    changePercent: 2, open: 4.3, high: 4.4, low: 4.2, volume: 100,
    amount: 100, turnoverRate: 1, shares: 2000, marketValue: 4000,
    timestamp: 1795114800
  }, lastDate, `${lastDate}T07:00:00.000Z`);
  const sseAttempts = [];
  let rangeCalls = 0;
  const service = new MarketService({
    db,
    sseShareProvider: async (date) => {
      sseAttempts.push(date);
      return new Map([['510300', 1000 + sseAttempts.length]]);
    },
    szseRangeProvider: async () => {
      rangeCalls += 1;
      return [];
    },
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });

  const first = await service.syncOfficialShareHistory(lastDate);
  assert.equal(first.requestedDates.length, 251);
  assert.equal(sseAttempts.length, 251);
  assert.equal(rangeCalls, 1);
  assert.equal(db.countOfficialShareHistory('510300'), 251);
  assert.equal(db.recentLogs(1)[0].status, 'success');

  const second = await service.syncOfficialShareHistory(lastDate);
  assert.equal(second.requestedDates.length, 251);
  assert.equal(sseAttempts.length, 251);
  assert.equal(rangeCalls, 1);
  assert.equal(db.countOfficialShareHistory('510300'), 251);
  db.close();
});

test('one failed exchange does not discard the other exchange share history', async () => {
  const db = createDatabase(':memory:');
  const bars = createConsecutiveBars(5);
  db.upsertBars('159919', bars);
  const lastDate = bars.at(-1).date;
  db.saveSnapshot({
    code: '159919', price: 4.4, previousClose: 4.3, change: 0.1,
    changePercent: 2, open: 4.3, high: 4.4, low: 4.2, volume: 100,
    amount: 100, turnoverRate: 1, shares: 1200, marketValue: 4000,
    timestamp: 1795114800
  }, lastDate, `${lastDate}T07:00:00.000Z`);
  const service = new MarketService({
    db,
    sseShareProvider: async () => {
      throw new Error('mock SSE failure');
    },
    szseRangeProvider: async (codes, startDate, endDate) => [{
      code: '159919',
      tradeDate: endDate,
      shares: 1200,
      source: '深交所'
    }],
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });

  const result = await service.syncOfficialShareHistory(lastDate, { historyDays: 5 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.failures.length, 5);
  assert.equal(db.countOfficialShareHistory('159919'), 1);
  assert.equal(
    db.getCompletedOfficialShareSyncDates('SZSE', result.requestedDates).size,
    5
  );
  assert.equal(db.recentLogs(1)[0].status, 'partial');
  db.close();
});

test('share history API model exposes 20/60/250 windows and real coverage', () => {
  const db = createDatabase(':memory:');
  const bars = createConsecutiveBars(30);
  db.upsertBars('510300', bars);
  db.saveShareHistory(bars.map((bar, index) => ({
    code: '510300',
    tradeDate: bar.date,
    shares: 1000 + index * 10,
    source: '上交所'
  })));
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T00:00:00.000Z')
  });
  const history = service.getShareHistory('510300', 20);
  assert.equal(history.range.days, 20);
  assert.equal(history.range.points.length, 20);
  assert.equal(history.range.coverage.availableDays, 20);
  assert.equal(history.range.coverage.status, 'complete');
  assert.equal(history.ranges[60].coverage.availableDays, 30);
  assert.equal(history.ranges[60].coverage.status, 'partial');
  assert.equal(history.streak.days, 29);
  assert.ok(Number.isFinite(history.range.periodEstimatedSubscription));
  assert.ok(Number.isFinite(history.range.sharePercentile));
  db.close();
});

test('signal backtest is deterministic and does not duplicate a matching dataset run', async () => {
  const db = createDatabase(':memory:');
  const bars = createConsecutiveBars(90);
  for (const etf of ETFS) {
    db.upsertBars(etf.code, bars);
    db.saveShareHistory(bars.map((bar, index) => ({
      code: etf.code,
      tradeDate: bar.date,
      shares: 100000 + index * 100,
      source: etf.code.startsWith('1') ? '深交所' : '上交所'
    })));
  }
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });

  const first = await service.runSignalBacktest();
  const firstEventCount = db.countSignalEvents(first.id);
  const second = await service.runSignalBacktest();
  assert.equal(second.id, first.id);
  assert.equal(db.countSignalEvents(second.id), firstEventCount);
  assert.ok(firstEventCount > 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM backtest_runs').get().count, 1);
  assert.equal(
    db.raw.prepare('SELECT COUNT(*) AS count FROM signal_events').get().count,
    firstEventCount
  );
  db.close();
});

test('signal backtest reports insufficient official share history per ETF', async () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });
  const run = await service.runSignalBacktest();
  const summary = await service.getBacktestSummary();
  assert.equal(run.id, summary.run.id);
  assert.equal(summary.etfStatus.length, ETFS.length);
  assert.ok(summary.etfStatus.every((etf) => etf.status === 'insufficient'));
  assert.ok(summary.etfStatus.every((etf) => etf.reason));
  db.close();
});
