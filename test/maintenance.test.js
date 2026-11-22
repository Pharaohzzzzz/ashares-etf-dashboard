'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../server/db');
const {
  createBackup,
  cleanupDatabase,
  restoreDatabase,
  verifyDatabase,
  listBackups
} = require('../server/maintenance');
const { rotateFile } = require('../server/rotating-logger');

function createFixture(filePath) {
  const db = createDatabase(filePath);
  db.upsertBars('510300', [{
    date: '2026-11-19',
    open: 4,
    close: 4.1,
    high: 4.2,
    low: 3.9,
    volume: 100,
    amount: 400,
    amplitude: 2,
    changePercent: 1,
    change: 0.04,
    turnoverRate: 1
  }]);
  db.saveShareHistory([{
    code: '510300',
    tradeDate: '2026-11-19',
    shares: 1000,
    source: '上交所'
  }], '2026-11-20T00:00:00.000Z');
  db.saveIopvSamples([{
    code: '510300',
    tradeDate: '2026-11-19',
    dataTime: '2026-11-19 15:00:00',
    observedAt: '2026-11-19T07:00:00.000Z',
    marketPrice: 4.1,
    iopv: 4,
    premiumRate: 0.025,
    source: '上交所',
    sourceKind: 'official'
  }], '2026-11-20T00:00:00.000Z');
  const quote = {
    code: '510300',
    price: 4.1,
    previousClose: 4,
    change: 0.1,
    changePercent: 2,
    open: 4,
    high: 4.2,
    low: 3.9,
    volume: 10,
    amount: 40,
    turnoverRate: 1,
    shares: 1000,
    marketValue: 4100,
    timestamp: 1795114800
  };
  db.saveSnapshot(quote, '2026-01-01', '2026-01-01T00:00:00.000Z');
  db.saveSnapshot(quote, '2026-11-19', '2026-11-19T00:00:00.000Z');
  db.log('test', 'success', 'old log', '2026-01-01T00:00:00.000Z');
  db.log('test', 'success', 'recent log', '2026-11-19T00:00:00.000Z');
  db.saveDailyMetrics({
    code: '510300',
    tradeDate: '2026-11-19',
    volumeRatio: 1,
    return5d: 0,
    return20d: 0,
    amountPercentile: 1,
    previousShares: 900,
    shares: 1000,
    shareDelta: 100,
    estimatedSubscription: 410,
    signals: [],
    updatedAt: '2026-11-20T00:00:00.000Z'
  });
  db.close();
}

test('backup, cleanup, restore and log rotation work on temporary databases', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-maintenance-'));
  const dbPath = path.join(directory, 'dashboard.db');
  const targetPath = path.join(directory, 'restore-target.db');
  const backupDir = path.join(directory, 'backups');
  createFixture(dbPath);
  createFixture(targetPath);

  const backupResult = await createBackup({
    dbPath,
    backupDir,
    now: new Date('2026-11-20T00:00:00.000Z'),
    retention: 3
  });
  assert.equal(backupResult.verification.ok, true);
  assert.equal(verifyDatabase(backupResult.backupPath).ok, true);

  const cleanup = cleanupDatabase({
    dbPath,
    snapshotDays: 90,
    logDays: 30,
    now: new Date('2026-11-20T00:00:00.000Z')
  });
  assert.equal(cleanup.snapshotsRemoved, 1);
  assert.equal(cleanup.logsRemoved, 1);
  const cleaned = createDatabase(dbPath);
  assert.equal(cleaned.raw.prepare('SELECT COUNT(*) AS n FROM daily_bars').get().n, 1);
  assert.equal(cleaned.raw.prepare('SELECT COUNT(*) AS n FROM share_history').get().n, 1);
  assert.equal(cleaned.raw.prepare('SELECT COUNT(*) AS n FROM daily_metrics').get().n, 1);
  assert.equal(cleaned.raw.prepare('SELECT COUNT(*) AS n FROM iopv_samples').get().n, 1);
  cleaned.raw.prepare("UPDATE etfs SET name = 'modified' WHERE code = '510300'").run();
  cleaned.close();

  const restored = await restoreDatabase({
    backupPath: backupResult.backupPath,
    dbPath: targetPath,
    safetyDir: backupDir,
    now: new Date('2026-11-20T01:00:00.000Z')
  });
  assert.equal(restored.restored.ok, true);
  assert.ok(restored.safetyBackup);
  assert.equal(verifyDatabase(restored.safetyBackup).ok, true);
  const target = createDatabase(targetPath);
  assert.equal(target.raw.prepare(
    "SELECT name FROM etfs WHERE code = '510300'"
  ).get().name, '沪深300ETF华泰柏瑞');
  target.raw.prepare("UPDATE etfs SET name = 'before failed restore' WHERE code = '510300'").run();
  target.close();

  const rename = fs.renameSync;
  const renameMock = context.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === targetPath) throw new Error('simulated replace failure');
    return rename(source, destination);
  });
  try {
    await assert.rejects(restoreDatabase({
      backupPath: backupResult.backupPath,
      dbPath: targetPath,
      safetyDir: backupDir,
      now: new Date('2026-11-20T01:05:00.000Z')
    }), /simulated replace failure/);
  } finally {
    renameMock.mock.restore();
  }
  assert.ok(verifyDatabase(targetPath).ok);
  const retained = createDatabase(targetPath);
  assert.equal(retained.getEtfConfig('510300').name, 'before failed restore');
  retained.close();

  const rotated = path.join(directory, 'dashboard.log');
  fs.writeFileSync(rotated, 'x'.repeat(32));
  const files = rotateFile(rotated, { maxBytes: 16, keep: 3 });
  assert.ok(files.includes(`${rotated}.1`));
  assert.equal(fs.existsSync(rotated), false);

  for (let day = 21; day <= 24; day += 1) {
    await createBackup({
      dbPath,
      backupDir,
      now: new Date(`2026-11-${day}T00:00:00.000Z`),
      retention: 3
    });
  }
  assert.equal(listBackups(backupDir).filter((item) => (
    item.name.startsWith('dashboard-')
  )).length, 3);
  fs.rmSync(directory, { recursive: true, force: true });
});
