'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');

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
    now: () => new Date('2026-10-26T08:00:00.000Z')
  });
  const summary = await service.refreshQuotes();
  assert.equal(summary.etfs.length, 2);
  assert.equal(summary.logs[0].status, 'partial');
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
    now: () => new Date('2026-10-26T08:00:00.000Z')
  });
  await service.initialize({ force: true });
  assert.equal(db.getLatestSnapshots().length, 14);
  assert.equal(service.getSummary().etfs.length, 14);
  db.close();
});
