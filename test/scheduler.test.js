'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

test('scheduler invokes official share recovery after the daily refresh', async () => {
  const calls = [];
  const service = {
    ensureTradingCalendar: async () => {},
    getTradingCalendarStatus: () => ({
      known: true,
      isTradingDay: true
    }),
    refreshQuotes: async () => calls.push('quotes'),
    syncHistory: async () => calls.push('history'),
    retryPendingOfficialShares: async () => {
      calls.push('shares');
      return { completedDates: ['2026-11-20'] };
    }
  };
  const scheduler = createScheduler(service, {
    now: () => new Date('2026-11-20T10:30:00.000Z'),
    intervalMs: 60 * 60 * 1000,
    log: () => {}
  });
  await scheduler.runCheck();
  scheduler.stop();
  assert.equal(calls.at(-1), 'shares');
});
