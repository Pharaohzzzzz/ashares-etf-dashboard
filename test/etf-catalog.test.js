'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');
const { ETFS } = require('../config/etfs');

function temporaryDatabase(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-catalog-'));
  const filePath = path.join(directory, 'dashboard.db');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return filePath;
}

function createRecentBars(count = 25) {
  const end = Date.parse('2026-11-20T00:00:00Z');
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(end - (count - index - 1) * 86400000).toISOString().slice(0, 10),
    open: 4,
    close: 4 + index * 0.001,
    high: 4.1,
    low: 3.9,
    volume: 100,
    amount: 100 + index,
    amplitude: 1,
    changePercent: 1,
    change: 0.001,
    turnoverRate: 1 + index / 100
  }));
}

test('catalog migration pins and highlights the two initial focus ETFs once', (context) => {
  const filePath = temporaryDatabase(context);
  const db = createDatabase(filePath);
  const enabled = db.getEtfs();

  assert.deepEqual(enabled.slice(0, 2).map((etf) => etf.code), ['159915', '159516']);
  assert.deepEqual(
    enabled.slice(0, 2).map((etf) => [etf.isPinned, etf.isHighlighted]),
    [[true, true], [true, true]]
  );
  assert.equal(enabled.filter((etf) => etf.isPinned).length, 2);

  db.updateEtf('159915', { isPinned: false, isHighlighted: false });
  db.close();

  const reopened = createDatabase(filePath);
  const focus = reopened.getEtfConfig('159915');
  assert.equal(focus.isPinned, false);
  assert.equal(focus.isHighlighted, false);
  reopened.close();
});

test('removed defaults stay removed after restart and their history is retained', (context) => {
  const filePath = temporaryDatabase(context);
  const db = createDatabase(filePath);
  db.saveShareHistory([
    { code: '510300', tradeDate: '2026-11-19', shares: 1000, source: '上交所' }
  ], '2026-11-20T00:00:00.000Z');
  db.removeEtf('510300');
  assert.equal(db.getEtfConfig('510300').enabled, false);
  db.close();

  const reopened = createDatabase(filePath);
  assert.equal(reopened.getEtfConfig('510300').enabled, false);
  assert.equal(reopened.countOfficialShareHistory('510300'), 1);
  assert.equal(reopened.restoreEtf('510300').enabled, true);
  assert.equal(reopened.getEtfConfig('510300').isPinned, false);
  reopened.close();
});

test('catalog ordering is stored separately for pinned and normal groups', (context) => {
  const filePath = temporaryDatabase(context);
  const db = createDatabase(filePath);
  const enabled = db.getEtfs();
  const pinnedCodes = enabled.filter((etf) => etf.isPinned).map((etf) => etf.code);
  const normalCodes = enabled.filter((etf) => !etf.isPinned).map((etf) => etf.code);

  db.saveEtfOrder({
    pinnedCodes: pinnedCodes.reverse(),
    normalCodes: [normalCodes.at(-1), ...normalCodes.slice(0, -1)]
  });
  db.close();

  const reopened = createDatabase(filePath);
  const rows = reopened.getEtfs();
  assert.deepEqual(rows.filter((row) => row.isPinned).map((row) => row.code), [
    '159516',
    '159915'
  ]);
  assert.equal(rows.find((row) => !row.isPinned).code, normalCodes.at(-1));

  const restored = reopened.restoreEtfOrder();
  assert.deepEqual(restored.slice(0, 2).map((row) => row.code), ['159915', '159516']);
  assert.ok(reopened.getEtfConfig('510300').isPinned === false);
  reopened.close();
});

test('catalog preserves user metadata when initial defaults are seeded again', (context) => {
  const filePath = temporaryDatabase(context);
  const db = createDatabase(filePath);
  db.updateEtf('510300', {
    name: '用户自定义名称',
    category: '自定义分类',
    tone: 'finance'
  });
  db.close();

  const reopened = createDatabase(filePath);
  const etf = reopened.getEtfConfig('510300');
  assert.equal(etf.name, '用户自定义名称');
  assert.equal(etf.category, '自定义分类');
  assert.equal(etf.tone, 'finance');
  reopened.close();
});

test('legacy catalog migration preserves disabled state and adds catalog fields', (context) => {
  const filePath = temporaryDatabase(context);
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    CREATE TABLE etfs (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      tone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
  legacy.prepare(`
    INSERT INTO etfs(code, name, category, tone, enabled)
    VALUES ('510300', '旧名称', '旧分类', 'broad', 0)
  `).run();
  legacy.close();

  const migrated = createDatabase(filePath);
  const etf = migrated.getEtfConfig('510300');
  assert.equal(etf.name, '旧名称');
  assert.equal(etf.enabled, false);
  assert.equal(etf.isPinned, false);
  assert.equal(etf.isHighlighted, false);
  migrated.close();
});

test('service uses only enabled ETFs for quotes, summary and history', async (context) => {
  const db = createDatabase(':memory:');
  context.after(() => db.close());
  db.saveShareHistory([
    { code: '510300', tradeDate: '2026-11-19', shares: 1000, source: '上交所' }
  ], '2026-11-20T00:00:00.000Z');
  db.removeEtf('510050');
  const quoteCalls = [];
  const historyCalls = [];
  const service = new MarketService({
    db,
    quoteProvider: async (etf) => {
      quoteCalls.push(etf.code);
      return {
        code: etf.code,
        name: etf.name,
        price: 4,
        previousClose: 4,
        change: 0,
        changePercent: 0,
        open: 4,
        high: 4,
        low: 4,
        volume: 100,
        amount: 100,
        turnoverRate: 1,
        shares: 1000,
        marketValue: 4000,
        timestamp: 1795162317
      };
    },
    klineProvider: async (etf) => {
      historyCalls.push(etf.code);
      return createRecentBars();
    },
    officialIopvProvider: async (etf) => ({
      code: etf.code,
      marketPrice: 4,
      iopv: 4,
      tradeDate: '2026-11-20',
      dataTime: '2026-11-20 15:00:00',
      observedAt: '2026-11-20T07:00:00.000Z',
      source: '上交所',
      sourceKind: 'official',
      series: []
    }),
    supplementaryIopvProvider: async () => new Map(),
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });

  await service.refreshQuotes();
  await service.syncHistoricalBars({ force: true });
  const summary = service.getSummary();
  assert.equal(summary.etfs.length, ETFS.length - 1);
  assert.equal(quoteCalls.includes('510050'), false);
  assert.equal(historyCalls.includes('510050'), false);
  assert.equal(summary.etfs.some((row) => row.code === '510050'), false);
  assert.equal(db.countOfficialShareHistory('510300'), 1);
});

test('service validates lookup, capacity, duplicate and non-ETF additions', async () => {
  const db = createDatabase(':memory:');
  const service = new MarketService({
    db,
    etfLookupProvider: async (code) => {
      if (code === '600000') {
        return {
          code,
          name: '浦发银行',
          market: 1,
          exchange: '上交所',
          securityType: '沪A'
        };
      }
      return {
        code,
        name: code === '510500' ? '中证500ETF南方' : `新ETF${code}`,
        market: code.startsWith('5') ? 1 : 0,
        exchange: code.startsWith('5') ? '上交所' : '深交所',
        securityType: '基金'
      };
    },
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });
  await assert.rejects(
    service.addEtf({ code: '60000', category: '测试', tone: 'broad' }),
    /6 位/
  );
  await assert.rejects(
    service.addEtf({ code: '600000', category: '测试', tone: 'broad' }),
    /不是 ETF/
  );
  await assert.rejects(
    service.addEtf({ code: '510500', category: '测试', tone: 'broad' }),
    /已在监控/
  );
  const added = await service.addEtf({
    code: '159999',
    category: '自定义',
    tone: 'tech'
  });
  assert.equal(added.enabled, true);
  assert.equal(added.isPinned, false);
  assert.equal(added.isHighlighted, false);
  assert.equal(service.getSummary().etfs.some((row) => row.code === '159999'), true);
  assert.equal(
    service.getSummary().etfs.find((row) => row.code === '159999').historyStatus,
    'accumulating'
  );

  for (let index = 0; index < 30; index += 1) {
    db.raw.prepare(`
      INSERT INTO etfs(
        code, name, category, tone, enabled, is_pinned, is_highlighted, sort_order
      ) VALUES (?, ?, '容量测试', 'broad', 1, 0, 0, ?)
    `).run(String(300000 + index), `容量ETF${index}`, 2000 + index);
  }
  service.etfLookupProvider = async (code) => ({
    code,
    name: '容量ETF',
    market: 0,
    exchange: '深交所',
    securityType: '基金'
  });
  await assert.rejects(
    service.addEtf({ code: '159998', category: '测试', tone: 'broad' }),
    /最多监控 30 只/
  );
  db.close();
});

test('summary exposes complete 5/20 day share windows and accumulating state', () => {
  const db = createDatabase(':memory:');
  const bars = createRecentBars(25);
  db.upsertBars('510300', bars);
  db.saveSnapshot({
    code: '510300',
    price: 4.2,
    previousClose: 4.1,
    change: 0.1,
    changePercent: 2,
    open: 4.1,
    high: 4.2,
    low: 4,
    volume: 100,
    amount: 100,
    turnoverRate: 1,
    shares: 1001,
    marketValue: 4200,
    timestamp: 1795162317
  }, '2026-11-20', '2026-11-20T07:00:00.000Z');
  db.saveShareHistory(bars.slice(-21).map((bar, index) => ({
    code: '510300',
    tradeDate: bar.date,
    shares: 100000 + index * 100,
    source: '上交所'
  })), '2026-11-20T08:00:00.000Z');
  const service = new MarketService({
    db,
    now: () => new Date('2026-11-20T08:00:00.000Z')
  });

  const row = service.getSummary().etfs.find((etf) => etf.code === '510300');
  assert.equal(row.estimatedSubscription5dStatus, 'ready');
  assert.ok(Number.isFinite(row.estimatedSubscription5d));
  assert.equal(row.estimatedSubscription20dStatus, 'ready');
  assert.ok(Number.isFinite(row.estimatedSubscription20d));
  assert.equal(row.shareStreak.days, 20);
  assert.ok(Number.isFinite(row.volatility20d));

  const shortDb = createDatabase(':memory:');
  const shortBars = createRecentBars(4);
  shortDb.upsertBars('510300', shortBars);
  shortDb.saveSnapshot({
    code: '510300',
    price: 4,
    previousClose: 4,
    change: 0,
    changePercent: 0,
    open: 4,
    high: 4,
    low: 4,
    volume: 100,
    amount: 100,
    turnoverRate: 1,
    shares: 1000,
    marketValue: 4000,
    timestamp: 1795162317
  }, '2026-11-20', '2026-11-20T07:00:00.000Z');
  shortDb.saveShareHistory(shortBars.map((bar, index) => ({
    code: '510300',
    tradeDate: bar.date,
    shares: 100000 + index * 100,
    source: '上交所'
  })), '2026-11-20T08:00:00.000Z');
  const shortRow = new MarketService({
    db: shortDb,
    now: () => new Date('2026-11-20T08:00:00.000Z')
  }).getSummary().etfs.find((etf) => etf.code === '510300');
  assert.equal(shortRow.estimatedSubscription5dStatus, 'accumulating');
  assert.equal(shortRow.estimatedSubscription5d, null);
  assert.equal(shortRow.estimatedSubscription20dStatus, 'accumulating');
  assert.equal(shortRow.estimatedSubscription20d, null);
  assert.equal(shortRow.volatility20d, null);
  shortDb.close();
  db.close();
});
