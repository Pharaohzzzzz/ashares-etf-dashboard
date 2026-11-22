'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');
const {
  shanghaiClock,
  isTradingSession,
  createScheduler
} = require('../server/scheduler');

test('Shanghai clock and trading sessions use China market hours', () => {
  assert.equal(shanghaiClock(new Date('2026-11-20T01:31:00.000Z')).time, '09:31:00');
  const tradingDay = { known: true, isTradingDay: true };
  assert.equal(isTradingSession(new Date('2026-11-20T01:31:00.000Z'), tradingDay), true);
  assert.equal(isTradingSession(new Date('2026-11-20T03:31:00.000Z'), tradingDay), false);
  assert.equal(isTradingSession(new Date('2026-11-20T05:01:00.000Z'), tradingDay), true);
  assert.equal(isTradingSession(new Date('2026-11-20T07:01:00.000Z'), tradingDay), false);
});

test('official closed days and unknown calendars are not trading sessions', () => {
  assert.equal(isTradingSession(new Date('2026-11-21T02:00:00.000Z'), {
    known: true,
    isTradingDay: false
  }), false);
  assert.equal(isTradingSession(new Date('2026-11-22T06:00:00.000Z'), {
    known: false,
    isTradingDay: false
  }), false);
});

test('scheduler catches up after the scheduled minutes and retries only incomplete tasks', async (context) => {
  const db = createDatabase(':memory:');
  context.after(() => db.close());
  const code = '510300';
  const date = '2026-11-20';
  for (const etf of db.getEtfs()) if (etf.code !== code) db.removeEtf(etf.code);
  const bar = {
    date, open: 4, close: 4, rawClose: 4, high: 4, low: 4, volume: 100, amount: 400,
    amplitude: 0, changePercent: 0, change: 0, turnoverRate: 1
  };
  let clock = '07:31:00';
  let barsAvailable = false;
  let historyCalls = 0;
  const providers = {
    db,
    now: () => new Date(`${date}T${clock}Z`),
    quoteProvider: async () => ({
      ...bar, code, timestamp: Date.parse(`${date}T07:00:00Z`) / 1000,
      price: 4, previousClose: 4, shares: 1000, marketValue: 4000
    }),
    klineProvider: async () => { historyCalls += 1; return barsAvailable ? [bar] : []; },
    officialIopvProvider: async () => { throw new Error('fixture: IOPV unavailable'); },
    supplementaryIopvProvider: async () => new Map(),
    sseShareProvider: async () => new Map([[code, 1000]]),
    szseShareProvider: async () => { throw new Error('no targets on this exchange'); },
    calendarProvider: async () => ({
      source: '深交所', sourceUrl: null, month: '2026-11', rows: [{ date, isTrading: true }]
    })
  };
  async function tick() {
    const scheduler = createScheduler(new MarketService(providers), { now: providers.now, log: () => {} });
    await scheduler.runCheck();
    scheduler.stop();
  }
  await tick();
  assert.equal(db.getSyncTask('closeQuotes').lastSuccessDate, date);
  clock = '10:01:00';
  await tick();
  assert.equal(db.getSyncTask('history').status, 'pending');
  assert.deepEqual(db.getSyncTask('closeHistory').failedDates, [date]);
  barsAvailable = true;
  clock = '10:18:00';
  await tick();
  assert.equal(db.getSyncTask('closeHistory').lastSuccessDate, date);
  clock = '10:40:00';
  await tick();
  assert.equal(historyCalls, 2);
});
