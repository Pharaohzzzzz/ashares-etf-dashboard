'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ETFS,
  INITIAL_FOCUS
} = require('../config/etfs');

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function shareUpsertSql() {
  return `
    INSERT INTO share_history(
      code, trade_date, shares, source, fetched_at,
      official_fetched_at, snapshot_fetched_at
    )
    VALUES (
      ?, ?, ?, ?, ?,
      CASE WHEN ? IN ('上交所', '深交所', 'SSE', 'SZSE') THEN ? ELSE NULL END,
      CASE WHEN ? NOT IN ('上交所', '深交所', 'SSE', 'SZSE') THEN ? ELSE NULL END
    )
    ON CONFLICT(code, trade_date) DO UPDATE SET
      shares = CASE
        WHEN share_history.source IN ('上交所', '深交所', 'SSE', 'SZSE')
             AND excluded.source NOT IN ('上交所', '深交所', 'SSE', 'SZSE')
          THEN share_history.shares
        ELSE excluded.shares
      END,
      source = CASE
        WHEN share_history.source IN ('上交所', '深交所', 'SSE', 'SZSE')
             AND excluded.source NOT IN ('上交所', '深交所', 'SSE', 'SZSE')
          THEN share_history.source
        ELSE excluded.source
      END,
      fetched_at = CASE
        WHEN share_history.source IN ('上交所', '深交所', 'SSE', 'SZSE')
             AND excluded.source NOT IN ('上交所', '深交所', 'SSE', 'SZSE')
          THEN share_history.fetched_at
        ELSE excluded.fetched_at
      END,
      official_fetched_at = CASE
        WHEN excluded.source IN ('上交所', '深交所', 'SSE', 'SZSE')
          THEN excluded.official_fetched_at
        ELSE share_history.official_fetched_at
      END,
      snapshot_fetched_at = CASE
        WHEN excluded.source NOT IN ('上交所', '深交所', 'SSE', 'SZSE')
          THEN excluded.snapshot_fetched_at
        ELSE share_history.snapshot_fetched_at
      END
  `;
}

function runShareUpsert(statement, entry, fetchedAt) {
  statement.run(
    entry.code,
    entry.tradeDate,
    entry.shares,
    entry.source,
    fetchedAt,
    entry.source,
    fetchedAt,
    entry.source,
    fetchedAt
  );
}

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
      enabled INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_highlighted INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 1000
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

    CREATE TABLE IF NOT EXISTS extended_share_values (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      shares REAL NOT NULL,
      source TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (code, trade_date)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS extended_share_closes (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (code, trade_date)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS official_share_sync_dates (
      exchange TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (exchange, trade_date)
    );

    CREATE TABLE IF NOT EXISTS iopv_latest (
      code TEXT PRIMARY KEY,
      trade_date TEXT,
      data_time TEXT,
      observed_at TEXT,
      market_price REAL,
      iopv REAL,
      premium_rate REAL,
      source TEXT,
      source_kind TEXT,
      source_url TEXT,
      cross_check_json TEXT,
      status TEXT NOT NULL,
      message TEXT,
      fetched_at TEXT NOT NULL,
      attempted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS iopv_samples (
      code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      data_time TEXT NOT NULL,
      observed_at TEXT,
      market_price REAL NOT NULL,
      iopv REAL NOT NULL,
      premium_rate REAL NOT NULL,
      source TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_url TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (code, data_time, source)
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

    CREATE TABLE IF NOT EXISTS trading_calendar (
      trade_date TEXT PRIMARY KEY,
      is_trading INTEGER NOT NULL,
      exchange_status TEXT,
      name TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_tasks (
      task_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      target_dates_json TEXT NOT NULL DEFAULT '[]',
      last_success_date TEXT,
      failed_dates_json TEXT NOT NULL DEFAULT '[]',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT NOT NULL,
      last_success_at TEXT,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS fetch_status (
      code TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      last_success_at TEXT,
      last_error TEXT,
      PRIMARY KEY (code, source)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON snapshots(code, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_source_time ON snapshots(code, data_time DESC, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bars_code_date ON daily_bars(code, date);
    CREATE INDEX IF NOT EXISTS idx_share_history_code_date ON share_history(code, trade_date DESC);
    CREATE INDEX IF NOT EXISTS idx_share_sync_exchange_date
      ON official_share_sync_dates(exchange, trade_date DESC);
    CREATE INDEX IF NOT EXISTS idx_iopv_samples_code_time
      ON iopv_samples(code, data_time DESC);
    CREATE INDEX IF NOT EXISTS idx_iopv_samples_code_trade_date
      ON iopv_samples(code, trade_date DESC, data_time DESC);
    CREATE INDEX IF NOT EXISTS idx_trading_calendar_trading
      ON trading_calendar(is_trading, trade_date);
  `);
  ensureColumn(db, 'share_history', 'official_fetched_at', 'TEXT');
  ensureColumn(db, 'share_history', 'snapshot_fetched_at', 'TEXT');
  ensureColumn(db, 'daily_bars', 'raw_close', 'REAL');
  ensureColumn(db, 'etfs', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'etfs', 'is_highlighted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'etfs', 'sort_order', 'INTEGER NOT NULL DEFAULT 1000');
  ensureColumn(db, 'official_share_sync_dates', 'expected_count', 'INTEGER');
  ensureColumn(db, 'official_share_sync_dates', 'actual_count', 'INTEGER');
  ensureColumn(db, 'official_share_sync_dates', 'expected_codes_json', 'TEXT');
  ensureColumn(db, 'official_share_sync_dates', 'written_codes_json', 'TEXT');
  db.exec(`
    UPDATE share_history
    SET official_fetched_at = fetched_at
    WHERE official_fetched_at IS NULL
      AND source IN ('上交所', '深交所', 'SSE', 'SZSE');

    UPDATE share_history
    SET snapshot_fetched_at = fetched_at
    WHERE snapshot_fetched_at IS NULL
      AND source IN ('行情快照', '快照');
  `);

  const insertEtf = db.prepare(`
    INSERT INTO etfs(code, name, category, tone, sort_order)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO NOTHING
  `);
  ETFS.forEach((etf, index) => {
    insertEtf.run(etf.code, etf.name, etf.category, etf.tone, 100 + index * 10);
  });

  const catalogLayoutVersion = '1';
  if (db.prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('etfCatalogLayoutMigrated')?.value !== catalogLayoutVersion) {
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE etfs
        SET is_pinned = 0, is_highlighted = 0
      `).run();
      ETFS.forEach((etf, index) => {
        db.prepare(`
          UPDATE etfs
          SET sort_order = ?
          WHERE code = ?
        `).run(100 + index * 10, etf.code);
      });
      for (const focus of INITIAL_FOCUS) {
        db.prepare(`
          UPDATE etfs
          SET is_pinned = 1, is_highlighted = 1, sort_order = ?
          WHERE code = ?
        `).run(focus.sortOrder, focus.code);
      }
      db.prepare(`
        INSERT INTO app_meta(key, value) VALUES ('etfCatalogLayoutMigrated', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(catalogLayoutVersion);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    raw: db,
    close: () => db.close(),
    getEtfs({ enabled = true } = {}) {
      const rows = db.prepare(`
        SELECT code, name, category, tone, enabled, is_pinned, is_highlighted, sort_order
        FROM etfs
        ${enabled === null ? '' : 'WHERE enabled = ?'}
        ORDER BY is_pinned DESC, sort_order ASC, code ASC
      `).all(...(enabled === null ? [] : [enabled ? 1 : 0]));
      return rows.map(mapEtfConfig);
    },
    getEtfConfig(code) {
      const row = db.prepare(`
        SELECT code, name, category, tone, enabled, is_pinned, is_highlighted, sort_order
        FROM etfs
        WHERE code = ?
      `).get(code);
      return row ? mapEtfConfig(row) : null;
    },
    countEnabledEtfs() {
      return db.prepare('SELECT COUNT(*) AS count FROM etfs WHERE enabled = 1').get().count;
    },
    addEtf({ code, name, category, tone, isPinned = false, isHighlighted = false }) {
      const nextOrder = db.prepare(`
        SELECT COALESCE(MAX(sort_order), 1000) + 10 AS nextOrder
        FROM etfs
        WHERE enabled = 1 AND is_pinned = ?
      `).get(isPinned ? 1 : 0).nextOrder;
      db.prepare(`
        INSERT INTO etfs(
          code, name, category, tone, enabled, is_pinned, is_highlighted, sort_order
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        code,
        name,
        category,
        tone,
        isPinned ? 1 : 0,
        isHighlighted ? 1 : 0,
        nextOrder
      );
      return this.getEtfConfig(code);
    },
    updateEtf(code, updates) {
      const current = this.getEtfConfig(code);
      if (!current) return null;
      const next = {
        name: updates.name ?? current.name,
        category: updates.category ?? current.category,
        tone: updates.tone ?? current.tone,
        isPinned: updates.isPinned ?? current.isPinned,
        isHighlighted: updates.isHighlighted ?? current.isHighlighted,
        sortOrder: current.sortOrder
      };
      if (next.isPinned !== current.isPinned) {
        next.sortOrder = db.prepare(`
          SELECT COALESCE(MAX(sort_order), 1000) + 10 AS nextOrder
          FROM etfs
          WHERE enabled = 1 AND is_pinned = ?
        `).get(next.isPinned ? 1 : 0).nextOrder;
      }
      db.prepare(`
        UPDATE etfs
        SET name = ?, category = ?, tone = ?,
            is_pinned = ?, is_highlighted = ?, sort_order = ?
        WHERE code = ?
      `).run(
        next.name,
        next.category,
        next.tone,
        next.isPinned ? 1 : 0,
        next.isHighlighted ? 1 : 0,
        next.sortOrder,
        code
      );
      return this.getEtfConfig(code);
    },
    removeEtf(code) {
      const result = db.prepare(`
        UPDATE etfs
        SET enabled = 0, is_pinned = 0, is_highlighted = 0
        WHERE code = ?
      `).run(code);
      return result.changes ? this.getEtfConfig(code) : null;
    },
    restoreEtf(code) {
      const current = this.getEtfConfig(code);
      if (!current) return null;
      const nextOrder = db.prepare(`
        SELECT COALESCE(MAX(sort_order), 1000) + 10 AS nextOrder
        FROM etfs
        WHERE enabled = 1 AND is_pinned = 0
      `).get().nextOrder;
      db.prepare(`
        UPDATE etfs
        SET enabled = 1, is_pinned = 0, is_highlighted = 0, sort_order = ?
        WHERE code = ?
      `).run(nextOrder, code);
      return this.getEtfConfig(code);
    },
    saveEtfOrder({ pinnedCodes = [], normalCodes = [] }) {
      const enabledCodes = this.getEtfs().map((etf) => etf.code);
      const orderedCodes = [...pinnedCodes, ...normalCodes];
      const uniqueCodes = new Set(orderedCodes);
      if (
        uniqueCodes.size !== orderedCodes.length ||
        orderedCodes.length !== enabledCodes.length ||
        enabledCodes.some((code) => !uniqueCodes.has(code))
      ) {
        throw new Error('排序必须覆盖当前监控中的全部 ETF，且不能重复');
      }
      const statement = db.prepare(`
        UPDATE etfs
        SET is_pinned = ?, sort_order = ?
        WHERE code = ? AND enabled = 1
      `);
      db.exec('BEGIN');
      try {
        pinnedCodes.forEach((code, index) => statement.run(1, (index + 1) * 10, code));
        normalCodes.forEach((code, index) => statement.run(0, 1000 + index * 10, code));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return this.getEtfs();
    },
    restoreEtfOrder() {
      const enabled = this.getEtfs();
      const custom = enabled
        .filter((etf) => !ETFS.some((item) => item.code === etf.code))
        .sort((left, right) => left.sortOrder - right.sortOrder);
      const ordered = [
        ...ETFS
          .map((etf) => enabled.find((item) => item.code === etf.code))
          .filter(Boolean),
        ...custom
      ];
      const pinnedCodes = INITIAL_FOCUS.map((item) => item.code)
        .filter((code) => ordered.some((etf) => etf.code === code));
      const normalCodes = ordered
        .map((etf) => etf.code)
        .filter((code) => !pinnedCodes.includes(code));
      const statement = db.prepare(`
        UPDATE etfs
        SET is_pinned = ?, is_highlighted = ?, sort_order = ?
        WHERE code = ? AND enabled = 1
      `);
      db.exec('BEGIN');
      try {
        pinnedCodes.forEach((code, index) => {
          statement.run(1, INITIAL_FOCUS.some((item) => item.code === code) ? 1 : 0,
            (index + 1) * 10, code);
        });
        normalCodes.forEach((code, index) => {
          statement.run(0, 0, 1000 + index * 10, code);
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return this.getEtfs();
    },
    upsertBars(code, bars) {
      const statement = db.prepare(`
        INSERT INTO daily_bars(
          code, date, open, close, high, low, volume, amount,
          amplitude, change_percent, change, turnover_rate, raw_close
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, date) DO UPDATE SET
          open = excluded.open, close = excluded.close, high = excluded.high, low = excluded.low,
          volume = excluded.volume, amount = excluded.amount, amplitude = excluded.amplitude,
          change_percent = excluded.change_percent, change = excluded.change,
          turnover_rate = excluded.turnover_rate,
          raw_close = COALESCE(excluded.raw_close, daily_bars.raw_close)
      `);
      db.exec('BEGIN');
      try {
        for (const bar of bars) {
          statement.run(
            code, bar.date, bar.open, bar.close, bar.high, bar.low, bar.volume, bar.amount,
            bar.amplitude, bar.changePercent, bar.change, bar.turnoverRate, bar.rawClose ?? null
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
        SELECT date, open, close, raw_close AS rawClose, high, low, volume, amount, amplitude,
               change_percent AS changePercent, change, turnover_rate AS turnoverRate
        FROM (
          SELECT * FROM daily_bars WHERE code = ? ORDER BY date DESC LIMIT ?
        ) ORDER BY date ASC
      `).all(code, limit);
    },
    countBars(code) {
      return db.prepare('SELECT COUNT(*) AS count FROM daily_bars WHERE code = ?').get(code).count;
    },
    getFirstEtfDate(code) {
      return db.prepare(`
        SELECT MIN(date) AS date FROM (
          SELECT MIN(date) AS date FROM daily_bars WHERE code = ?
          UNION ALL
          SELECT MIN(trade_date) FROM share_history
          WHERE code = ? AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        )
      `).get(code, code).date;
    },
    getLatestBarDateBefore(tradeDate) {
      return db.prepare(
        'SELECT MAX(date) AS date FROM daily_bars WHERE date < ?'
      ).get(tradeDate)?.date || null;
    },
    getRecentTradeDates(limit = 250, endDate = null) {
      if (!Number.isInteger(limit) || limit < 1) return [];
      return db.prepare(`
        SELECT date FROM (
          SELECT date FROM daily_bars
          WHERE (? IS NULL OR date <= ?)
            AND date NOT IN (SELECT trade_date FROM trading_calendar WHERE is_trading = 0)
          UNION
          SELECT trade_date FROM trading_calendar
          WHERE is_trading = 1 AND (? IS NULL OR trade_date <= ?)
          UNION
          SELECT trade_date FROM share_history
          WHERE (? IS NULL OR trade_date <= ?)
            AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        )
        ORDER BY date DESC
        LIMIT ?
      `).all(endDate, endDate, endDate, endDate, endDate, endDate, limit)
        .map((row) => row.date)
        .reverse();
    },
    saveSnapshot(quote, tradeDate, capturedAt) {
      const dataTime = quote.timestamp
        ? new Date(quote.timestamp * 1000).toISOString()
        : null;
      const result = db.prepare(`
        INSERT INTO snapshots(
          code, captured_at, trade_date, data_time, price, previous_close, change,
          change_percent, open, high, low, volume, amount, turnover_rate, shares, market_value
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ? IS NULL OR NOT EXISTS (
            SELECT 1 FROM snapshots WHERE code = ? AND data_time > ?
          )
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
        quote.volume, quote.amount, quote.turnoverRate, quote.shares, quote.marketValue,
        dataTime, quote.code, dataTime
      );
      return result.changes > 0;
    },
    getLatestSnapshots() {
      return db.prepare(`
        SELECT s.*
        FROM etfs e JOIN snapshots s ON s.id = (
          SELECT id FROM snapshots WHERE code = e.code
          ORDER BY data_time DESC, captured_at DESC LIMIT 1
        )
        ORDER BY s.code
      `).all();
    },
    getClosingSnapshotCodes(tradeDate) {
      return db.prepare(`
        SELECT e.code FROM etfs e WHERE e.enabled = 1 AND EXISTS (
          SELECT 1 FROM snapshots s WHERE s.code = e.code AND s.trade_date = ?
            AND s.data_time >= ? AND s.price > 0
        )
      `).all(tradeDate, `${tradeDate}T07:00:00`).map((row) => row.code);
    },
    saveIopvLatest(state) {
      db.prepare(`
        INSERT INTO iopv_latest(
          code, trade_date, data_time, observed_at, market_price, iopv, premium_rate,
          source, source_kind, source_url, cross_check_json, status, message,
          fetched_at, attempted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          trade_date = excluded.trade_date,
          data_time = excluded.data_time,
          observed_at = excluded.observed_at,
          market_price = excluded.market_price,
          iopv = excluded.iopv,
          premium_rate = excluded.premium_rate,
          source = excluded.source,
          source_kind = excluded.source_kind,
          source_url = excluded.source_url,
          cross_check_json = excluded.cross_check_json,
          status = excluded.status,
          message = excluded.message,
          fetched_at = excluded.fetched_at,
          attempted_at = excluded.attempted_at
      `).run(
        state.code,
        state.tradeDate ?? null,
        state.dataTime ?? null,
        state.observedAt ?? null,
        state.marketPrice ?? null,
        state.iopv ?? null,
        state.premiumRate ?? null,
        state.source ?? null,
        state.sourceKind ?? null,
        state.sourceUrl ?? null,
        state.crossCheck ? JSON.stringify(state.crossCheck) : null,
        state.status,
        state.message ?? null,
        state.fetchedAt,
        state.attemptedAt || state.fetchedAt
      );
    },
    markIopvFailure(code, message, attemptedAt = new Date().toISOString()) {
      db.prepare(`
        INSERT INTO iopv_latest(code, status, message, fetched_at, attempted_at)
        VALUES (?, 'stale', ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          status = 'stale',
          message = excluded.message,
          attempted_at = excluded.attempted_at
      `).run(code, message, attemptedAt, attemptedAt);
    },
    getIopvLatest(code) {
      const row = db.prepare('SELECT * FROM iopv_latest WHERE code = ?').get(code);
      return row ? parseIopvLatest(row) : null;
    },
    saveIopvSamples(entries, fetchedAt = new Date().toISOString()) {
      const statement = db.prepare(`
        INSERT INTO iopv_samples(
          code, trade_date, data_time, observed_at, market_price, iopv, premium_rate,
          source, source_kind, source_url, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, data_time, source) DO UPDATE SET
          trade_date = excluded.trade_date,
          observed_at = excluded.observed_at,
          market_price = excluded.market_price,
          iopv = excluded.iopv,
          premium_rate = excluded.premium_rate,
          source_kind = excluded.source_kind,
          source_url = excluded.source_url,
          fetched_at = excluded.fetched_at
      `);
      db.exec('BEGIN');
      try {
        for (const entry of entries) {
          if (
            !Number.isFinite(entry.marketPrice) ||
            !Number.isFinite(entry.iopv) ||
            entry.marketPrice <= 0 ||
            entry.iopv <= 0 ||
            !Number.isFinite(entry.premiumRate)
          ) {
            continue;
          }
          statement.run(
            entry.code,
            entry.tradeDate,
            entry.dataTime,
            entry.observedAt ?? null,
            entry.marketPrice,
            entry.iopv,
            entry.premiumRate,
            entry.source,
            entry.sourceKind,
            entry.sourceUrl ?? null,
            fetchedAt
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getIopvSamplesForDate(code, tradeDate, limit = 500) {
      return db.prepare(`
        SELECT code, trade_date AS tradeDate, data_time AS dataTime,
               observed_at AS observedAt, market_price AS marketPrice,
               iopv, premium_rate AS premiumRate, source,
               source_kind AS sourceKind, source_url AS sourceUrl,
               fetched_at AS fetchedAt
        FROM iopv_samples
        WHERE code = ? AND trade_date = ?
        ORDER BY data_time ASC
        LIMIT ?
      `).all(code, tradeDate, limit);
    },
    getIopvCloseHistory(code, limit = 250, startDate = null, endDate = null) {
      if (!Number.isInteger(limit) || limit < 1) return [];
      return db.prepare(`
        SELECT code, trade_date AS tradeDate, data_time AS dataTime, observed_at AS observedAt,
               market_price AS marketPrice, iopv, premium_rate AS premiumRate, source,
               source_kind AS sourceKind, source_url AS sourceUrl, fetched_at AS fetchedAt
        FROM (
          SELECT s.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY trade_date
                   ORDER BY data_time DESC,
                            CASE source_kind WHEN 'official' THEN 0 ELSE 1 END
                 ) AS position
          FROM iopv_samples s
          WHERE code = ?
            AND (? IS NULL OR trade_date >= ?)
            AND (? IS NULL OR trade_date <= ?)
        )
        WHERE position = 1
        ORDER BY trade_date DESC
        LIMIT ?
      `).all(code, startDate, startDate, endDate, endDate, limit).reverse();
    },
    countIopvSamples(code) {
      return db.prepare(
        'SELECT COUNT(*) AS count FROM iopv_samples WHERE code = ?'
      ).get(code).count;
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
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS fetchedAt,
               official_fetched_at AS officialFetchedAt,
               snapshot_fetched_at AS snapshotFetchedAt
        FROM share_history
        WHERE code = ? AND trade_date < ?
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(code, tradeDate);
      if (official) return official;
      const snapshot = db.prepare(`
        SELECT trade_date AS tradeDate, shares, '快照' AS source,
               captured_at AS fetchedAt,
               NULL AS officialFetchedAt,
               captured_at AS snapshotFetchedAt
        FROM snapshots
        WHERE code = ? AND trade_date < ? AND shares IS NOT NULL
        ORDER BY trade_date DESC, captured_at DESC
        LIMIT 1
      `).get(code, tradeDate);
      return snapshot || null;
    },
    getShareRecord(code, tradeDate) {
      const official = db.prepare(`
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS fetchedAt,
               official_fetched_at AS officialFetchedAt,
               snapshot_fetched_at AS snapshotFetchedAt
        FROM share_history
        WHERE code = ? AND trade_date = ?
        LIMIT 1
      `).get(code, tradeDate);
      return official || null;
    },
    getOfficialShareRecord(code, tradeDate) {
      if (!tradeDate) return null;
      return db.prepare(`
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS fetchedAt,
               official_fetched_at AS officialFetchedAt,
               snapshot_fetched_at AS snapshotFetchedAt
        FROM share_history
        WHERE code = ? AND trade_date = ?
          AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        LIMIT 1
      `).get(code, tradeDate) || null;
    },
    getPreviousOfficialShareRecord(code, tradeDate) {
      if (!tradeDate) return null;
      return db.prepare(`
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS fetchedAt,
               official_fetched_at AS officialFetchedAt,
               snapshot_fetched_at AS snapshotFetchedAt
        FROM share_history
        WHERE code = ? AND trade_date < ?
          AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        ORDER BY trade_date DESC
        LIMIT 1
      `).get(code, tradeDate) || null;
    },
    getPreviousTradingDate(tradeDate) {
      if (!tradeDate) return null;
      return db.prepare(`
        SELECT MAX(date) AS date FROM (
          SELECT MAX(date) AS date FROM daily_bars WHERE date < ?
            AND date NOT IN (SELECT trade_date FROM trading_calendar WHERE is_trading = 0)
          UNION ALL
          SELECT MAX(trade_date) FROM trading_calendar WHERE is_trading = 1 AND trade_date < ?
          UNION ALL
          SELECT MAX(trade_date) FROM share_history WHERE trade_date < ?
            AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        )
      `).get(tradeDate, tradeDate, tradeDate).date || null;
    },
    getOfficialShareHistory(code, limit = 251) {
      if (!Number.isInteger(limit) || limit < 1) return [];
      return db.prepare(`
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS fetchedAt,
               official_fetched_at AS officialFetchedAt,
               snapshot_fetched_at AS snapshotFetchedAt
        FROM (
          SELECT *
          FROM share_history
          WHERE code = ?
            AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
          ORDER BY trade_date DESC
          LIMIT ?
        )
        ORDER BY trade_date ASC
      `).all(code, limit);
    },
    readExtendedShares(code, from, through) {
      const rows = db.prepare(`
        SELECT trade_date AS tradeDate, shares, source, fetched_at AS officialFetchedAt
        FROM extended_share_values WHERE code = ? AND trade_date BETWEEN ? AND ?
        UNION ALL
        SELECT trade_date AS tradeDate, shares, source, COALESCE(official_fetched_at, fetched_at) AS officialFetchedAt
        FROM share_history WHERE code = ? AND trade_date BETWEEN ? AND ?
          AND source IN ('上交所', '深交所', 'SSE', 'SZSE') AND shares > 0
      `).all(code, from, through, code, from, through);
      return [...new Map(rows.map((row) => [row.tradeDate, row])).values()]
        .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
    },
    saveExtendedShares(entries, fetchedAt) {
      const statement = db.prepare(`
        INSERT INTO extended_share_values(code, trade_date, shares, source, fetched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(code, trade_date) DO UPDATE SET
          shares = excluded.shares, source = excluded.source, fetched_at = excluded.fetched_at
      `);
      db.exec('BEGIN');
      try {
        for (const { code, tradeDate, shares, source } of entries) {
          if (Number.isFinite(shares) && shares > 0) statement.run(code, tradeDate, shares, source, fetchedAt);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    saveExtendedCloses(code, rows) {
      const statement = db.prepare(`
        INSERT INTO extended_share_closes(code, trade_date, close) VALUES (?, ?, ?)
        ON CONFLICT(code, trade_date) DO UPDATE SET close = excluded.close
      `);
      db.exec('BEGIN');
      try {
        for (const { date, rawClose } of rows) {
          if (Number.isFinite(rawClose) && rawClose > 0) statement.run(code, date, rawClose);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    readExtendedCloses(code, from, through) {
      const rows = db.prepare(`
        SELECT trade_date AS date, close AS rawClose FROM extended_share_closes
        WHERE code = ? AND trade_date BETWEEN ? AND ?
        UNION ALL
        SELECT date, raw_close AS rawClose FROM daily_bars
        WHERE code = ? AND date BETWEEN ? AND ? AND raw_close > 0
      `).all(code, from, through, code, from, through);
      return [...new Map(rows.map((row) => [row.date, row])).values()];
    },
    countOfficialShareHistory(code) {
      return db.prepare(`
        SELECT COUNT(*) AS count
        FROM share_history
        WHERE code = ?
          AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
      `).get(code).count;
    },
    getCompletedOfficialShareSyncDates(exchange, tradeDates, expectedCodes = null) {
      if (!tradeDates.length) return new Set();
      const placeholders = tradeDates.map(() => '?').join(',');
      if (Array.isArray(expectedCodes) && expectedCodes.length) {
        const codePlaceholders = expectedCodes.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT trade_date AS tradeDate, COUNT(DISTINCT code) AS actualCount
          FROM share_history
          WHERE trade_date IN (${placeholders})
            AND code IN (${codePlaceholders})
            AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
          GROUP BY trade_date
          HAVING COUNT(DISTINCT code) = ?
          ORDER BY trade_date ASC
        `).all(
          ...tradeDates,
          ...expectedCodes,
          expectedCodes.length
        );
        return new Set(rows.map((row) => row.tradeDate));
      }
      const rows = db.prepare(`
        SELECT trade_date AS tradeDate
        FROM official_share_sync_dates
        WHERE exchange = ?
          AND status = 'success'
          AND trade_date IN (${placeholders})
        ORDER BY trade_date ASC
      `).all(exchange, ...tradeDates);
      return new Set(rows.map((row) => row.tradeDate));
    },
    markOfficialShareSyncDates(
      exchange,
      tradeDates,
      status = 'success',
      message = null,
      fetchedAt = new Date().toISOString()
    ) {
      const statement = db.prepare(`
        INSERT INTO official_share_sync_dates(
          exchange, trade_date, status, message, fetched_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(exchange, trade_date) DO UPDATE SET
          status = excluded.status,
          message = excluded.message,
          fetched_at = excluded.fetched_at
      `);
      db.exec('BEGIN');
      try {
        for (const tradeDate of tradeDates) {
          statement.run(exchange, tradeDate, status, message, fetchedAt);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    saveShareHistory(entries, fetchedAt = new Date().toISOString()) {
      const statement = db.prepare(shareUpsertSql());
      db.exec('BEGIN');
      try {
        for (const entry of entries) {
          runShareUpsert(statement, entry, fetchedAt);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    saveOfficialShareDay({
      exchange,
      tradeDate,
      entries,
      expectedCodes,
      message = null,
      fetchedAt = new Date().toISOString()
    }) {
      const expected = [...new Set(expectedCodes)];
      const byCode = new Map(entries
        .filter((entry) => (
          entry.tradeDate === tradeDate &&
          expected.includes(entry.code) &&
          Number.isFinite(entry.shares) &&
          entry.shares > 0
        ))
        .map((entry) => [entry.code, entry]));
      const statement = db.prepare(shareUpsertSql());
      const insertStatus = db.prepare(`
        INSERT INTO official_share_sync_dates(
          exchange, trade_date, status, message, fetched_at,
          expected_count, actual_count, expected_codes_json, written_codes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exchange, trade_date) DO UPDATE SET
          status = excluded.status,
          message = excluded.message,
          fetched_at = excluded.fetched_at,
          expected_count = excluded.expected_count,
          actual_count = excluded.actual_count,
          expected_codes_json = excluded.expected_codes_json,
          written_codes_json = excluded.written_codes_json
      `);
      db.exec('BEGIN');
      try {
        for (const entry of byCode.values()) {
          runShareUpsert(statement, entry, fetchedAt);
        }
        const actualCodes = this.getActualOfficialShareCodes(tradeDate, expected);
        const status = !actualCodes.length
          ? 'pending'
          : actualCodes.length === expected.length
            ? 'success'
            : 'partial';
        insertStatus.run(
          exchange,
          tradeDate,
          status,
          message,
          fetchedAt,
          expected.length,
          actualCodes.length,
          JSON.stringify(expected),
          JSON.stringify(actualCodes)
        );
        db.exec('COMMIT');
        return { status, tradeDate, expectedCodes: expected, writtenCodes: actualCodes };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    recordOfficialShareDayFailure({
      exchange,
      tradeDate,
      expectedCodes,
      message,
      fetchedAt = new Date().toISOString()
    }) {
      const expected = [...new Set(expectedCodes)];
      const actualCodes = this.getActualOfficialShareCodes(tradeDate, expected);
      const status = 'error';
      db.prepare(`
        INSERT INTO official_share_sync_dates(
          exchange, trade_date, status, message, fetched_at,
          expected_count, actual_count, expected_codes_json, written_codes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(exchange, trade_date) DO UPDATE SET
          status = excluded.status,
          message = excluded.message,
          fetched_at = excluded.fetched_at,
          expected_count = excluded.expected_count,
          actual_count = excluded.actual_count,
          expected_codes_json = excluded.expected_codes_json,
          written_codes_json = excluded.written_codes_json
      `).run(
        exchange,
        tradeDate,
        status,
        message,
        fetchedAt,
        expected.length,
        actualCodes.length,
        JSON.stringify(expected),
        JSON.stringify(actualCodes)
      );
      return { status, tradeDate, writtenCodes: actualCodes };
    },
    getActualOfficialShareCodes(tradeDate, expectedCodes) {
      if (!expectedCodes.length) return [];
      const placeholders = expectedCodes.map(() => '?').join(',');
      return db.prepare(`
        SELECT code
        FROM share_history
        WHERE trade_date = ?
          AND code IN (${placeholders})
          AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        ORDER BY code ASC
      `).all(tradeDate, ...expectedCodes).map((row) => row.code);
    },
    getOfficialShareSyncRecord(exchange, tradeDate) {
      return db.prepare(`
        SELECT exchange, trade_date AS tradeDate, status, message,
               fetched_at AS fetchedAt, expected_count AS expectedCount,
               actual_count AS actualCount,
               expected_codes_json AS expectedCodesJson,
               written_codes_json AS writtenCodesJson
        FROM official_share_sync_dates
        WHERE exchange = ? AND trade_date = ?
      `).get(exchange, tradeDate) || null;
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
    },
    saveTradingCalendar(rows, {
      source,
      sourceUrl = null,
      fetchedAt = new Date().toISOString()
    }) {
      const statement = db.prepare(`
        INSERT INTO trading_calendar(
          trade_date, is_trading, exchange_status, name, source, source_url, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trade_date) DO UPDATE SET
          is_trading = excluded.is_trading,
          exchange_status = excluded.exchange_status,
          name = excluded.name,
          source = excluded.source,
          source_url = excluded.source_url,
          fetched_at = excluded.fetched_at
      `);
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          statement.run(
            row.date,
            row.isTrading ? 1 : 0,
            row.exchangeStatus ?? null,
            row.name ?? null,
            source,
            sourceUrl,
            fetchedAt
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getTradingCalendar(date) {
      return db.prepare(`
        SELECT trade_date AS date, is_trading AS isTrading,
               exchange_status AS exchangeStatus, name, source,
               source_url AS sourceUrl, fetched_at AS fetchedAt
        FROM trading_calendar
        WHERE trade_date = ?
      `).get(date) || null;
    },
    getDataDates() {
      return {
        quoteDate: db.prepare('SELECT MAX(trade_date) AS date FROM snapshots').get().date || null,
        barDate: db.prepare('SELECT MAX(date) AS date FROM daily_bars').get().date || null,
        officialShareDate: db.prepare(`
          SELECT MAX(trade_date) AS date
          FROM share_history
          WHERE source IN ('上交所', '深交所', 'SSE', 'SZSE')
        `).get().date || null,
        iopvDate: db.prepare('SELECT MAX(trade_date) AS date FROM iopv_latest').get().date || null
      };
    },
    getEtfDataDates(code) {
      return {
        quoteDate: db.prepare(
          'SELECT MAX(trade_date) AS date FROM snapshots WHERE code = ?'
        ).get(code).date || null,
        barDate: db.prepare(
          'SELECT MAX(date) AS date FROM daily_bars WHERE code = ?'
        ).get(code).date || null,
        officialShareDate: db.prepare(`
          SELECT MAX(trade_date) AS date
          FROM share_history
          WHERE code = ? AND source IN ('上交所', '深交所', 'SSE', 'SZSE')
        `).get(code).date || null,
        iopvDate: db.prepare(
          'SELECT MAX(trade_date) AS date FROM iopv_latest WHERE code = ?'
        ).get(code).date || null
      };
    },
    startSyncTask(taskKey, {
      targetDates = [],
      attemptedAt = new Date().toISOString()
    } = {}) {
      db.prepare(`
        INSERT INTO sync_tasks(
          task_key, status, target_dates_json, retry_count, last_attempt_at
        ) VALUES (?, 'running', ?, 0, ?)
        ON CONFLICT(task_key) DO UPDATE SET
          status = 'running',
          target_dates_json = excluded.target_dates_json,
          retry_count = CASE WHEN sync_tasks.target_dates_json = excluded.target_dates_json
            THEN sync_tasks.retry_count + 1 ELSE 0 END,
          last_attempt_at = excluded.last_attempt_at
      `).run(taskKey, JSON.stringify(targetDates), attemptedAt);
    },
    finishSyncTask(taskKey, {
      status,
      lastSuccessDate = null,
      failedDates = [],
      message = null,
      attemptedAt = new Date().toISOString()
    }) {
      db.prepare(`
        INSERT INTO sync_tasks(
          task_key, status, target_dates_json, last_success_date,
          failed_dates_json, retry_count, last_attempt_at, last_success_at, message
        ) VALUES (?, ?, '[]', ?, ?, 0, ?, ?, ?)
        ON CONFLICT(task_key) DO UPDATE SET
          status = excluded.status,
          last_success_date = COALESCE(excluded.last_success_date, sync_tasks.last_success_date),
          failed_dates_json = excluded.failed_dates_json,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = CASE
            WHEN excluded.status IN ('success', 'partial')
              THEN excluded.last_attempt_at
            ELSE sync_tasks.last_success_at
          END,
          message = excluded.message
      `).run(
        taskKey,
        status,
        lastSuccessDate,
        JSON.stringify([...new Set(failedDates)].sort()),
        attemptedAt,
        attemptedAt,
        message
      );
    },
    getSyncTask(taskKey) {
      const row = db.prepare('SELECT * FROM sync_tasks WHERE task_key = ?').get(taskKey);
      return row ? {
        key: row.task_key,
        status: row.status,
        targetDates: JSON.parse(row.target_dates_json),
        lastSuccessDate: row.last_success_date,
        failedDates: JSON.parse(row.failed_dates_json),
        retryCount: row.retry_count,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessAt: row.last_success_at,
        message: row.message
      } : null;
    },
    getSyncTasks() {
      return db.prepare('SELECT task_key FROM sync_tasks ORDER BY task_key').all()
        .map((row) => this.getSyncTask(row.task_key));
    },
    recordFetchStatus(code, source, {
      status,
      attemptedAt = new Date().toISOString(),
      successAt = null,
      error = null
    }) {
      db.prepare(`
        INSERT INTO fetch_status(
          code, source, status, last_attempt_at, last_success_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code, source) DO UPDATE SET
          status = excluded.status,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = COALESCE(excluded.last_success_at, fetch_status.last_success_at),
          last_error = excluded.last_error
      `).run(code, source, status, attemptedAt, successAt, error);
    },
    getFetchStatuses(source) {
      return Object.fromEntries(
        db.prepare(`
          SELECT code, status, last_attempt_at AS lastAttemptAt,
                 last_success_at AS lastSuccessAt, last_error AS lastError
          FROM fetch_status
          WHERE source = ?
        `).all(source).map((row) => [row.code, row])
      );
    }
  };
}

module.exports = { createDatabase };

function mapEtfConfig(row) {
  return {
    code: row.code,
    name: row.name,
    category: row.category,
    tone: row.tone,
    enabled: row.enabled === 1,
    isPinned: row.is_pinned === 1,
    isHighlighted: row.is_highlighted === 1,
    sortOrder: row.sort_order
  };
}

function parseIopvLatest(row) {
  return {
    code: row.code,
    tradeDate: row.trade_date,
    dataTime: row.data_time,
    observedAt: row.observed_at,
    marketPrice: row.market_price,
    iopv: row.iopv,
    premiumRate: row.premium_rate,
    source: row.source,
    sourceKind: row.source_kind,
    sourceUrl: row.source_url,
    crossCheck: row.cross_check_json ? JSON.parse(row.cross_check_json) : null,
    status: row.status,
    message: row.message,
    fetchedAt: row.fetched_at,
    attemptedAt: row.attempted_at
  };
}

