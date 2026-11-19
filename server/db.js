'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ETFS } = require('../config/etfs');

function createDatabase(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS etfs (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      tone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_bars (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      close REAL,
      high REAL,
      low REAL,
      volume REAL,
      amount REAL,
      amplitude REAL,
      change_percent REAL,
      change REAL,
      turnover_rate REAL,
      PRIMARY KEY (code, date)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      data_time TEXT,
      price REAL,
      previous_close REAL,
      change REAL,
      change_percent REAL,
      open REAL,
      high REAL,
      low REAL,
      volume REAL,
      amount REAL,
      turnover_rate REAL,
      shares REAL,
      market_value REAL,
      UNIQUE(code, captured_at)
    );

    CREATE TABLE IF NOT EXISTS daily_metrics (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      volume_ratio REAL,
      return_5d REAL,
      return_20d REAL,
      amount_percentile REAL,
      previous_shares REAL,
      shares REAL,
      share_delta REAL,
      estimated_subscription REAL,
      signals_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (code, trade_date)
    );

    CREATE TABLE IF NOT EXISTS share_history (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      shares REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (code, trade_date)
    );

    CREATE TABLE IF NOT EXISTS update_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON snapshots(code, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bars_code_date ON daily_bars(code, date);
    CREATE INDEX IF NOT EXISTS idx_share_history_code_date ON share_history(code, trade_date DESC);
  `);

  const insertEtf = db.prepare(`
    INSERT INTO etfs(code, name, category, tone)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      tone = excluded.tone,
      enabled = 1
  `);
  for (const etf of ETFS) insertEtf.run(etf.code, etf.name, etf.category, etf.tone);

  return {
    raw: db,
    close: () => db.close(),
    upsertBars(code, bars) {
      const statement = db.prepare(`
        INSERT INTO daily_bars(
          code, date, open, close, high, low, volume, amount,
          amplitude, change_percent, change, turnover_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, date) DO UPDATE SET
          open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low,
          volume = excluded.volume, amount = excluded.amount, amplitude = excluded.amplitude,
          change_percent = excluded.change_percent, change = excluded.change,
          turnover_rate = excluded.turnover_rate
      `);
      db.exec('BEGIN');
      try {
        for (const bar of bars) {
          statement.run(
            code, bar.date, bar.open, bar.close, bar.high, bar.low, bar.volume, bar.amount,
            bar.amplitude, bar.changePercent, bar.change, bar.turnoverRate
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getBars(code, limit = 520) {
      return db.prepare(`
        SELECT date, open, close, high, low, volume, amount, amplitude,
               change_percent AS changePercent, change, turnover_rate AS turnoverRate
        FROM (
          SELECT * FROM daily_bars WHERE code = ? ORDER BY date DESC LIMIT ?
        ) ORDER BY date ASC
      `).all(code, limit);
    },
    countBars(code) {
      return db.prepare('SELECT COUNT(*) AS count FROM daily_bars WHERE code = ?').get(code).count;
    },
    saveSnapshot(quote, tradeDate, capturedAt) {
      const dataTime = quote.timestamp
        ? new Date(quote.timestamp * 1000).toISOString()
        : null;
      db.prepare(`
        INSERT INTO snapshots(
          code, captured_at, trade_date, data_time, price, previous_close, change,
          change_percent, open, high, low, volume, amount, turnover_rate, shares, market_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, captured_at) DO UPDATE SET
          trade_date = excluded.trade_date, data_time = excluded.data_time,
          price = excluded.price, previous_close = excluded.previous_close,
          change = excluded.change, change_percent = excluded.change_percent,
          open = excluded.open, high = excluded.high, low = excluded.low,
          volume = excluded.volume, amount = excluded.amount,
          turnover_rate = excluded.turnover_rate, shares = excluded.shares,
          market_value = excluded.market_value
      `).run(
        quote.code, capturedAt, tradeDate, dataTime, quote.price, quote.previousClose,
        quote.change, quote.changePercent, quote.open, quote.high, quote.low,
        quote.volume, quote.amount, quote.turnoverRate, quote.shares, quote.marketValue
      );
    },
    getLatestSnapshots() {
      return db.prepare(`
        SELECT s.*
        FROM snapshots s
        JOIN (
          SELECT code, MAX(captured_at) AS captured_at
          FROM snapshots
          GROUP BY code
        ) latest ON latest.code = s.code AND latest.captured_at = s.captured_at
        ORDER BY s.code
      `).all();
    },
    getPreviousShares(code, tradeDate) {
      const shareRecord = db.prepare(`
        SELECT shares FROM share_history
        WHERE code = ? AND trade_date < ?
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(code, tradeDate);
      if (shareRecord?.shares !== undefined) return shareRecord.shares;
      const row = db.prepare(`
        SELECT shares FROM snapshots
        WHERE code = ? AND trade_date < ? AND shares IS NOT NULL
        ORDER BY trade_date DESC, captured_at DESC
        LIMIT 1
      `).get(code, tradeDate);
      return row?.shares ?? null;
    },
    getPreviousShareRecord(code, tradeDate) {
      const official = db.prepare(`
        SELECT trade_date AS tradeDate, shares, source
        FROM share_history
        WHERE code = ? AND trade_date < ?
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(code, tradeDate);
      if (official) return official;
      const snapshot = db.prepare(`
        SELECT trade_date AS tradeDate, shares, '快照' AS source
        FROM snapshots
        WHERE code = ? AND trade_date < ? AND shares IS NOT NULL
        ORDER BY trade_date DESC, captured_at DESC
        LIMIT 1
      `).get(code, tradeDate);
      return snapshot || null;
    },
    saveShareHistory(entries, fetchedAt = new Date().toISOString()) {
      const statement = db.prepare(`
        INSERT INTO share_history(code, trade_date, shares, source, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(code, trade_date) DO UPDATE SET
          shares = excluded.shares,
          source = excluded.source,
          fetched_at = excluded.fetched_at
      `);
      db.exec('BEGIN');
      try {
        for (const entry of entries) {
          statement.run(entry.code, entry.tradeDate, entry.shares, entry.source, fetchedAt);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    saveDailyMetrics(metric) {
      db.prepare(`
        INSERT INTO daily_metrics(
          code, trade_date, volume_ratio, return_5d, return_20d, amount_percentile,
          previous_shares, shares, share_delta, estimated_subscription, signals_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, trade_date) DO UPDATE SET
          volume_ratio = excluded.volume_ratio, return_5d = excluded.return_5d,
          return_20d = excluded.return_20d, amount_percentile = excluded.amount_percentile,
          previous_shares = excluded.previous_shares, shares = excluded.shares,
          share_delta = excluded.share_delta,
          estimated_subscription = excluded.estimated_subscription,
          signals_json = excluded.signals_json, updated_at = excluded.updated_at
      `).run(
        metric.code, metric.tradeDate, metric.volumeRatio, metric.return5d,
        metric.return20d, metric.amountPercentile, metric.previousShares,
        metric.shares, metric.shareDelta, metric.estimatedSubscription,
        JSON.stringify(metric.signals), metric.updatedAt
      );
    },
    log(scope, status, message, createdAt = new Date().toISOString()) {
      db.prepare(
        'INSERT INTO update_log(scope, status, message, created_at) VALUES (?, ?, ?, ?)'
      ).run(scope, status, message ?? null, createdAt);
    },
    recentLogs(limit = 8) {
      return db.prepare(
        'SELECT scope, status, message, created_at AS createdAt FROM update_log ORDER BY id DESC LIMIT ?'
      ).all(limit);
    },
    getMeta(key) {
      return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare(`
        INSERT INTO app_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    }
  };
}

module.exports = { createDatabase };

