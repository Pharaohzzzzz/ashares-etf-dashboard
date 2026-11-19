'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCalendarMonth,
  calendarStatusFor,
  isTradingSession
} = require('../server/trading-calendar');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');

function calendarRows(overrides = []) {
  const rows = [
    { jyrq: '2026-09-30', jybz: '1', jjrmc: '' },
    { jyrq: '2026-10-01', jybz: '0', jjrmc: '国庆节' },
    { jyrq: '2026-10-02', jybz: '0', jjrmc: '国庆节' },
    { jyrq: '2026-10-09', jybz: '1', jjrmc: '' },
    { jyrq: '2026-10-10', jybz: '0', jjrmc: '周末' }
  ].map((row) => {
    const override = overrides.find((item) => item.jyrq === row.jyrq);
    return override || row;
  });
  return { data: rows, nowdate: '2026-10-09' };
}

test('official calendar parses holidays and adjusted workday status', () => {
  const rows = parseCalendarMonth(calendarRows([
    { jyrq: '2026-10-10', jybz: '1', jjrmc: '调休工作日' }
  ]));
  const byDate = new Map(rows.map((row) => [row.date, row]));
  assert.equal(byDate.get('2026-10-01').isTrading, false);
  assert.equal(byDate.get('2026-10-01').name, '国庆节');
  assert.equal(byDate.get('2026-10-10').isTrading, true);
});

test('lunch break and closed holidays never run intraday updates', () => {
  const tradingDay = { known: true, isTradingDay: true };
  assert.equal(isTradingSession(new Date('2026-10-09T03:59:00.000Z'), tradingDay), false);
  assert.equal(isTradingSession(new Date('2026-10-09T04:59:00.000Z'), tradingDay), false);
  assert.equal(isTradingSession(new Date('2026-10-09T05:01:00.000Z'), tradingDay), true);
  assert.equal(isTradingSession(new Date('2026-10-01T02:00:00.000Z'), {
    known: true,
    isTradingDay: false
  }), false);
});

test('calendar cache remains authoritative and is marked stale after refresh failure', async () => {
  const db = createDatabase(':memory:');
  let fail = false;
  const service = new MarketService({
    db,
    calendarProvider: async () => {
      if (fail) throw new Error('mock calendar failure');
      return {
        month: '2026-10',
        source: '深交所',
        sourceUrl: 'https://www.szse.cn/aboutus/calendar/',
        rows: parseCalendarMonth(calendarRows())
      };
    },
    now: () => new Date('2026-10-01T02:00:00.000Z')
  });
  const first = await service.ensureTradingCalendar({ force: true });
  assert.equal(first.known, true);
  assert.equal(first.isTradingDay, false);
  assert.equal(first.stale, false);

  fail = true;
  const fallback = await service.ensureTradingCalendar({ force: true });
  assert.equal(fallback.known, true);
  assert.equal(fallback.isTradingDay, false);
  assert.equal(fallback.stale, true);
  assert.match(fallback.message, /可能过期|缓存/);
  assert.equal(service.isTradingSession(new Date('2026-10-01T02:00:00.000Z')), false);
  db.close();
});

test('missing calendar is not silently treated as a normal weekday', () => {
  const status = calendarStatusFor(null, {
    now: new Date('2026-11-20T02:00:00.000Z')
  });
  assert.equal(status.known, false);
  assert.equal(status.isTradingDay, false);
  assert.equal(status.stale, true);
  assert.equal(isTradingSession(new Date('2026-11-20T02:00:00.000Z'), status), false);
});
