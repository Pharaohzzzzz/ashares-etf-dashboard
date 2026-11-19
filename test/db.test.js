'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDatabase } = require('../server/db');

test('database seeds all configured ETFs and stores bars idempotently', () => {
  const db = createDatabase(':memory:');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM etfs').get().count, 14);
  const bar = {
    date: '2026-11-19', open: 4, close: 4.06, high: 4.07, low: 3.99,
    volume: 100, amount: 400, amplitude: 2, changePercent: 0.5,
    change: 0.02, turnoverRate: 1.2
  };
  db.upsertBars('510300', [bar]);
  db.upsertBars('510300', [{ ...bar, close: 4.08 }]);
  const bars = db.getBars('510300');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 4.08);
  assert.equal(db.getLatestBarDateBefore('2026-11-19'), null);
  db.close();
});

test('latest snapshots and previous shares use trade-date boundaries', () => {
  const db = createDatabase(':memory:');
  const quote = {
    code: '510300', price: 4.06, previousClose: 4.05, change: 0.01,
    changePercent: 0.25, open: 4.05, high: 4.07, low: 4.04,
    volume: 100, amount: 400, turnoverRate: 1.2, shares: 1000,
    marketValue: 4000, timestamp: 1795075898
  };
  db.saveSnapshot(quote, '2026-11-18', '2026-11-18T07:00:00.000Z');
  db.saveSnapshot({ ...quote, shares: 1200 }, '2026-11-19', '2026-11-19T07:00:00.000Z');
  const latest = db.getLatestSnapshots();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].shares, 1200);
  assert.equal(db.getPreviousShares('510300', '2026-11-19'), 1000);
  db.close();
});

test('official share history takes precedence over quote snapshots', () => {
  const db = createDatabase(':memory:');
  db.saveShareHistory([
    { code: '510300', tradeDate: '2026-11-17', shares: 900, source: 'SSE' },
    { code: '510300', tradeDate: '2026-11-18', shares: 980, source: 'SSE' }
  ], '2026-11-20T00:00:00.000Z');
  const record = db.getPreviousShareRecord('510300', '2026-11-19');
  assert.equal(record.shares, 980);
  assert.equal(record.tradeDate, '2026-11-18');
  assert.equal(record.source, 'SSE');
  db.saveShareHistory([
    { code: '510300', tradeDate: '2026-11-18', shares: 777, source: '行情快照' }
  ], '2026-11-20T02:00:00.000Z');
  const protectedRecord = db.getShareRecord('510300', '2026-11-18');
  assert.equal(protectedRecord.shares, 980);
  assert.equal(protectedRecord.source, 'SSE');
  assert.equal(protectedRecord.fetchedAt, '2026-11-20T00:00:00.000Z');
  assert.equal(protectedRecord.officialFetchedAt, '2026-11-20T00:00:00.000Z');
  assert.equal(protectedRecord.snapshotFetchedAt, '2026-11-20T02:00:00.000Z');
  db.close();
});

test('share provenance migration backfills old official and snapshot timestamps', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-provenance-'));
  const filePath = path.join(directory, 'dashboard.db');
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    CREATE TABLE share_history (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      shares REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (code, trade_date)
    )
  `);
  legacy.prepare(`
    INSERT INTO share_history(code, trade_date, shares, source, fetched_at)
    VALUES ('510300', '2026-11-18', 1000, '上交所', '2026-11-19T00:00:00.000Z')
  `).run();
  legacy.close();

  const migrated = createDatabase(filePath);
  const row = migrated.raw.prepare(`
    SELECT official_fetched_at, snapshot_fetched_at
    FROM share_history
    WHERE code = '510300' AND trade_date = '2026-11-18'
  `).get();
  assert.equal(row.official_fetched_at, '2026-11-19T00:00:00.000Z');
  assert.equal(row.snapshot_fetched_at, null);
  migrated.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('official share history and completed sync dates are idempotent', () => {
  const db = createDatabase(':memory:');
  const entries = [
    { code: '510300', tradeDate: '2026-11-18', shares: 980, source: '上交所' },
    { code: '510300', tradeDate: '2026-11-19', shares: 1000, source: '上交所' }
  ];
  db.saveShareHistory(entries, '2026-11-20T00:00:00.000Z');
  db.saveShareHistory(entries, '2026-11-20T01:00:00.000Z');
  db.markOfficialShareSyncDates('SSE', ['2026-11-18', '2026-11-19']);
  db.markOfficialShareSyncDates('SSE', ['2026-11-18', '2026-11-19']);
  assert.equal(db.countOfficialShareHistory('510300'), 2);
  assert.deepEqual(
    db.getOfficialShareHistory('510300').map((row) => row.tradeDate),
    ['2026-11-18', '2026-11-19']
  );
  assert.equal(
    db.raw.prepare('SELECT COUNT(*) AS count FROM official_share_sync_dates').get().count,
    2
  );
  assert.deepEqual(
    [...db.getCompletedOfficialShareSyncDates(
      'SSE',
      ['2026-11-17', '2026-11-18', '2026-11-19']
    )],
    ['2026-11-18', '2026-11-19']
  );
  db.close();
});

test('recent trade dates return the requested window in ascending order', () => {
  const db = createDatabase(':memory:');
  db.upsertBars('510300', ['2026-11-17', '2026-11-18', '2026-11-19'].map((date) => ({
    date, open: 4, close: 4, high: 4, low: 4, volume: 1, amount: 1,
    amplitude: 0, changePercent: 0, change: 0, turnoverRate: 0
  })));
  assert.deepEqual(
    db.getRecentTradeDates(2),
    ['2026-11-18', '2026-11-19']
  );
  assert.deepEqual(
    db.getRecentTradeDates(3, '2026-11-18'),
    ['2026-11-17', '2026-11-18']
  );
  db.close();
});

test('sync task state persists failed dates and retry counts', () => {
  const db = createDatabase(':memory:');
  db.startSyncTask('history', {
    targetDates: ['2026-11-19'],
    attemptedAt: '2026-11-20T01:00:00.000Z'
  });
  db.finishSyncTask('history', {
    status: 'partial',
    lastSuccessDate: '2026-11-19',
    failedDates: ['2026-11-18', '2026-11-18', '2026-11-19'],
    message: '1 只失败',
    attemptedAt: '2026-11-20T01:01:00.000Z'
  });
  db.startSyncTask('history', {
    targetDates: ['2026-11-20'],
    attemptedAt: '2026-11-20T02:00:00.000Z'
  });
  const task = db.getSyncTask('history');
  assert.equal(task.status, 'running');
  assert.equal(task.retryCount, 1);
  assert.deepEqual(task.targetDates, ['2026-11-20']);
  assert.equal(task.lastSuccessDate, '2026-11-19');
  assert.deepEqual(task.failedDates, ['2026-11-18', '2026-11-19']);
  db.close();
});
