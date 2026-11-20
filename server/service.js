'use strict';

const {
  ETF_CAPACITY,
  ETF_TONES,
  getMarket
} = require('../config/etfs');
const {
  volumeRatio,
  percentile,
  periodReturn,
  annualizedVolatility,
  calculateShareStreak,
  calculateShareWindow,
  calculateSignals
} = require('./metrics');
const {
  SIGNAL_PARAMETERS,
  buildSignalScores
} = require('./signal-score');
const {
  fetchQuote,
  fetchKlines,
  fetchTrends,
  lookupEtf
} = require('./provider');
const {
  IOPV_ALERT_THRESHOLD,
  calculatePremiumRate,
  fetchOfficialIopv,
  fetchSupplementaryIopv,
  crossCheckIopv,
  resolveIopvState,
  dedupeIopvSeries
} = require('./iopv');
const {
  fetchSseEtfShares,
  fetchSzseEtfShares,
  fetchSzseEtfShareRange
} = require('./official-shares');
const {
  fetchCalendarMonth,
  calendarStatusFor,
  isTradingSession
} = require('./trading-calendar');
const {
  isOfficialShareRetryDue,
  nextOfficialShareRetryAt
} = require('./official-share-retry');

const OFFICIAL_HISTORY_DAYS = 250;
const OFFICIAL_FETCH_DAYS = OFFICIAL_HISTORY_DAYS + 1;
const OFFICIAL_RECOVERY_DAYS = 2;
const OFFICIAL_STATUS_HISTORY_DAYS = OFFICIAL_HISTORY_DAYS;
const OFFICIAL_RANGES = [20, 60, 250];
const SSE_FETCH_CONCURRENCY = 4;
const OFFICIAL_SHARE_SOURCES = new Set(['上交所', '深交所', 'SSE', 'SZSE']);

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function tradeDateFromTimestamp(timestamp) {
  return shanghaiDateFormatter.format(new Date(timestamp * 1000));
}

function snapshotToQuote(row) {
  return {
    code: row.code,
    name: row.code,
    category: '未分类',
    tone: 'broad',
    price: row.price,
    previousClose: row.previous_close,
    change: row.change,
    changePercent: row.change_percent,
    open: row.open,
    high: row.high,
    low: row.low,
    volume: row.volume,
    amount: row.amount,
    turnoverRate: row.turnover_rate,
    shares: row.shares,
    marketValue: row.market_value,
    dataTime: row.data_time,
    capturedAt: row.captured_at,
    tradeDate: row.trade_date
  };
}

function isOfficialShareSource(source) {
  return OFFICIAL_SHARE_SOURCES.has(source);
}

function calculateOfficialShareMetric({
  current,
  previous,
  expectedPreviousDate,
  price,
  priceSource
}) {
  const base = {
    status: 'pending',
    currentShares: current?.shares ?? null,
    currentDate: current?.tradeDate ?? null,
    previousShares: previous?.shares ?? null,
    previousDate: previous?.tradeDate ?? null,
    shareDelta: null,
    estimatedSubscription: null,
    price: Number.isFinite(price) ? price : null,
    priceSource: Number.isFinite(price) ? priceSource : null
  };
  if (!current) return base;
  if (
    !Number.isFinite(current.shares) ||
    current.shares <= 0 ||
    !isOfficialShareSource(current.source) ||
    !previous ||
    !Number.isFinite(previous.shares) ||
    previous.shares <= 0 ||
    !isOfficialShareSource(previous.source) ||
    !expectedPreviousDate ||
    previous.tradeDate !== expectedPreviousDate
  ) {
    return { ...base, status: 'insufficient' };
  }
  const shareDelta = current.shares - previous.shares;
  return {
    ...base,
    status: 'ready',
    shareDelta,
    estimatedSubscription: Number.isFinite(price) ? shareDelta * price : null
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

class MarketService {
  constructor({
    db,
    quoteProvider = fetchQuote,
    klineProvider = fetchKlines,
    trendProvider = fetchTrends,
    sseShareProvider = fetchSseEtfShares,
    szseShareProvider = fetchSzseEtfShares,
    szseRangeProvider = fetchSzseEtfShareRange,
    officialIopvProvider = fetchOfficialIopv,
    supplementaryIopvProvider = fetchSupplementaryIopv,
    calendarProvider = fetchCalendarMonth,
    etfLookupProvider = lookupEtf,
    calendarMaxAgeMs,
    now = () => new Date()
  }) {
    this.db = db;
    this.quoteProvider = quoteProvider;
    this.klineProvider = klineProvider;
    this.trendProvider = trendProvider;
    this.sseShareProvider = sseShareProvider;
    this.szseShareProvider = szseShareProvider;
    this.szseRangeProvider = szseRangeProvider;
    this.officialIopvProvider = officialIopvProvider;
    this.supplementaryIopvProvider = supplementaryIopvProvider;
    this.calendarProvider = calendarProvider;
    this.etfLookupProvider = etfLookupProvider;
    this.calendarMaxAgeMs = calendarMaxAgeMs;
    this.now = now;
    this.refreshPromise = null;
    this.shareSyncPromise = null;
    this.iopvRefreshPromise = null;
    this.calendarRefreshPromise = null;
    this.calendarLastAttemptAt = 0;
    this.calendarLastError = null;
    this.initializing = false;
    this.initializedAt = db.getMeta('initializedAt');
  }

  getEnabledEtfs() {
    return this.db.getEtfs();
  }

  getEtfConfig(code, { includeDisabled = false } = {}) {
    const etf = this.db.getEtfConfig(code);
    return etf && (includeDisabled || etf.enabled) ? etf : null;
  }

  getCatalogState() {
    const etfs = this.db.getEtfs({ enabled: null });
    return {
      capacity: ETF_CAPACITY,
      enabledCount: etfs.filter((etf) => etf.enabled).length,
      tones: ETF_TONES,
      enabled: etfs.filter((etf) => etf.enabled),
      removed: etfs.filter((etf) => !etf.enabled)
    };
  }

  async lookupEtfCandidate(code) {
    const normalized = String(code || '').trim();
    if (!/^\d{6}$/.test(normalized)) {
      throw catalogError('INVALID_CODE', 'ETF 代码必须为 6 位数字');
    }
    const existing = this.db.getEtfConfig(normalized);
    if (existing) {
      throw catalogError(
        'ETF_ALREADY_EXISTS',
        existing.enabled ? '该 ETF 已在监控中' : '该 ETF 已移出监控，可从已移出列表恢复'
      );
    }
    if (this.db.countEnabledEtfs() >= ETF_CAPACITY) {
      throw catalogError('ETF_CAPACITY_REACHED', `最多监控 ${ETF_CAPACITY} 只 ETF`);
    }
    const result = await this.etfLookupProvider(normalized);
    if (!result || result.code !== normalized || !result.name) {
      throw catalogError('ETF_NOT_FOUND', '未查询到该证券');
    }
    if (!String(result.name).toUpperCase().includes('ETF')) {
      throw catalogError('NOT_ETF', '该代码不是 ETF');
    }
    if (![0, 1].includes(Number(result.market))) {
      throw catalogError('UNSUPPORTED_MARKET', '仅支持沪深交易所 ETF');
    }
    return {
      code: normalized,
      name: result.name,
      market: Number(result.market),
      exchange: result.exchange || (Number(result.market) === 1 ? '上交所' : '深交所'),
      securityType: result.securityType || '基金'
    };
  }

  async addEtf({ code, category, tone = 'broad', isPinned = false, isHighlighted = false }) {
    const candidate = await this.lookupEtfCandidate(code);
    const normalizedCategory = String(category || '').trim();
    if (!normalizedCategory) {
      throw catalogError('INVALID_CATEGORY', '请填写 ETF 分类');
    }
    if (!ETF_TONES[tone]) {
      throw catalogError('INVALID_TONE', 'ETF 颜色不在可选范围内');
    }
    const added = this.db.addEtf({
      ...candidate,
      category: normalizedCategory,
      tone,
      isPinned: false,
      isHighlighted: Boolean(isHighlighted)
    });
    if (isPinned) {
      return this.db.updateEtf(added.code, { isPinned: true });
    }
    this.db.log('catalog', 'success', `新增监控 ETF ${added.code} ${added.name}`, this.now().toISOString());
    return added;
  }

  updateEtf(code, updates) {
    const current = this.db.getEtfConfig(code);
    if (!current) throw catalogError('ETF_NOT_FOUND', 'ETF 不存在');
    const next = {};
    if (updates.name !== undefined) {
      const name = String(updates.name).trim();
      if (!name) throw catalogError('INVALID_NAME', 'ETF 名称不能为空');
      next.name = name;
    }
    if (updates.category !== undefined) {
      const category = String(updates.category).trim();
      if (!category) throw catalogError('INVALID_CATEGORY', 'ETF 分类不能为空');
      next.category = category;
    }
    if (updates.tone !== undefined) {
      if (!ETF_TONES[updates.tone]) {
        throw catalogError('INVALID_TONE', 'ETF 颜色不在可选范围内');
      }
      next.tone = updates.tone;
    }
    if (updates.isPinned !== undefined) next.isPinned = Boolean(updates.isPinned);
    if (updates.isHighlighted !== undefined) {
      next.isHighlighted = Boolean(updates.isHighlighted);
    }
    return this.db.updateEtf(code, next);
  }

  removeEtf(code) {
    const current = this.db.getEtfConfig(code);
    if (!current || !current.enabled) {
      throw catalogError('ETF_NOT_FOUND', '该 ETF 当前不在监控中');
    }
    const removed = this.db.removeEtf(code);
    this.db.log('catalog', 'success', `ETF ${code} 已移出监控，历史数据保留`, this.now().toISOString());
    return removed;
  }

  restoreEtf(code) {
    const current = this.db.getEtfConfig(code);
    if (!current) throw catalogError('ETF_NOT_FOUND', 'ETF 不存在');
    if (current.enabled) throw catalogError('ETF_ALREADY_EXISTS', '该 ETF 已在监控中');
    if (this.db.countEnabledEtfs() >= ETF_CAPACITY) {
      throw catalogError('ETF_CAPACITY_REACHED', `最多监控 ${ETF_CAPACITY} 只 ETF`);
    }
    const restored = this.db.restoreEtf(code);
    this.db.log('catalog', 'success', `ETF ${code} 已恢复监控，沿用已有历史`, this.now().toISOString());
    return restored;
  }

  saveEtfOrder(payload) {
    return this.db.saveEtfOrder(payload);
  }

  restoreEtfOrder() {
    return this.db.restoreEtfOrder();
  }

  async backfillEtf(code) {
    const etf = this.getEtfConfig(code);
    if (!etf) return null;
    try {
      const quote = await this.quoteProvider(etf);
      if (quote?.timestamp) {
        const capturedAt = this.now().toISOString();
        const tradeDate = tradeDateFromTimestamp(quote.timestamp);
        this.db.saveSnapshot(quote, tradeDate, capturedAt);
        if (quote.shares !== null) {
          this.db.saveShareHistory([{
            code,
            tradeDate,
            shares: quote.shares,
            source: '行情快照'
          }], capturedAt);
        }
      }
    } catch (error) {
      this.db.log('catalog', 'warning', `${code} 实时行情补抓失败：${error.message}`, this.now().toISOString());
    }
    try {
      const bars = await this.klineProvider(etf, 520);
      this.db.upsertBars(code, bars);
    } catch (error) {
      this.db.log('catalog', 'warning', `${code} 日线历史补抓失败：${error.message}`, this.now().toISOString());
    }
    await this.refreshIopv();
    try {
      await this.syncOfficialShareHistory();
    } catch (error) {
      this.db.log('catalog', 'warning', `${code} 官方份额补抓失败：${error.message}`, this.now().toISOString());
    }
    return this.getSummary();
  }

  async initialize({ force = false } = {}) {
    if (this.initializing) return;
    this.initializing = true;
    this.db.log('startup', 'running', '开始报价、日线、份额与 IOPV 差异补数', this.now().toISOString());
    try {
      await this.ensureTradingCalendar({ force: true });
      await this.refreshQuotes();
      await this.syncHistoricalBars({ force });
      try {
        await this.syncOfficialShareHistory();
      } catch (error) {
        this.db.log('shares', 'error', `官方份额同步失败：${error.message}`, this.now().toISOString());
      }
      const dates = this.db.getDataDates();
      if (!dates.iopvDate || (dates.barDate && dates.iopvDate < dates.barDate)) {
        await this.refreshIopv();
      }
      this.initializedAt = this.now().toISOString();
      this.db.setMeta('initializedAt', this.initializedAt);
      this.db.log('startup', 'success', '历史数据与实时行情同步完成', this.initializedAt);
    } catch (error) {
      this.db.log('startup', 'error', error.message, this.now().toISOString());
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  async refreshQuotes() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performQuoteRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async ensureTradingCalendar({ force = false, date = this.now() } = {}) {
    const nowMs = this.now().getTime();
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
    const cached = this.db.getTradingCalendar(dateKey);
    const cachedAt = cached?.fetchedAt ? new Date(cached.fetchedAt).getTime() : NaN;
    if (
      !force &&
      cached &&
      Number.isFinite(cachedAt) &&
      nowMs - cachedAt < 60 * 60 * 1000
    ) {
      return this.getTradingCalendarStatus(date);
    }
    if (this.calendarRefreshPromise) return this.calendarRefreshPromise;
    this.calendarRefreshPromise = (async () => {
      try {
        const calendar = await this.calendarProvider(date);
        const fetchedAt = this.now().toISOString();
        this.db.saveTradingCalendar(calendar.rows, {
          source: calendar.source,
          sourceUrl: calendar.sourceUrl,
          fetchedAt
        });
        this.calendarLastAttemptAt = nowMs;
        this.calendarLastError = null;
        this.db.log(
          'calendar',
          'success',
          `${calendar.source}交易日历更新至 ${calendar.month}`,
          fetchedAt
        );
      } catch (error) {
        this.calendarLastAttemptAt = nowMs;
        this.calendarLastError = error.message;
        this.db.log(
          'calendar',
          'warning',
          `交易日历刷新失败，使用缓存并标记可能过期：${error.message}`,
          this.now().toISOString()
        );
      }
      return this.getTradingCalendarStatus(date);
    })();
    try {
      return await this.calendarRefreshPromise;
    } finally {
      this.calendarRefreshPromise = null;
    }
  }

  getTradingCalendarStatus(date = this.now()) {
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
    const status = calendarStatusFor(this.db.getTradingCalendar(dateKey), {
      now: date,
      maxAgeMs: this.calendarMaxAgeMs
    });
    if (this.calendarLastError && !status.stale) {
      return {
        ...status,
        stale: true,
        message: `交易日历可能过期：刷新失败，正在使用缓存（${this.calendarLastError}）`
      };
    }
    return status;
  }

  isTradingSession(date = this.now()) {
    return isTradingSession(date, this.getTradingCalendarStatus(date));
  }

  async syncHistoricalBars({ force = false } = {}) {
    const attemptedAt = this.now().toISOString();
    const before = this.db.getDataDates();
    const targets = this.getEnabledEtfs().filter((etf) => {
      if (force) return true;
      const dates = this.db.getEtfDataDates(etf.code);
      return this.db.countBars(etf.code) < OFFICIAL_HISTORY_DAYS ||
        (dates.quoteDate && (!dates.barDate || dates.barDate < dates.quoteDate));
    });
    const targetDates = [...new Set(
      targets.map((etf) => this.db.getEtfDataDates(etf.code).quoteDate).filter(Boolean)
    )].sort();
    this.db.startSyncTask('history', { targetDates, attemptedAt });
    if (!targets.length) {
      this.db.finishSyncTask('history', {
        status: 'success',
        lastSuccessDate: before.barDate,
        message: '报价日期与日线日期已对齐',
        attemptedAt
      });
      return {
        requestedCodes: [],
        failedCodes: [],
        barDate: before.barDate
      };
    }

    const results = await Promise.allSettled(targets.map(async (etf) => {
      const bars = await this.klineProvider(etf, 520);
      this.db.upsertBars(etf.code, bars);
      return etf.code;
    }));
    const failedCodes = results.flatMap((result, index) => (
      result.status === 'rejected' ? [targets[index].code] : []
    ));
    const after = this.db.getDataDates();
    const failedDates = targets
      .filter((etf) => {
        const dates = this.db.getEtfDataDates(etf.code);
        return dates.quoteDate && (!dates.barDate || dates.barDate < dates.quoteDate);
      })
      .map((etf) => this.db.getEtfDataDates(etf.code).quoteDate);
    const status = failedCodes.length
      ? (failedCodes.length === targets.length ? 'error' : 'partial')
      : 'success';
    const message = failedCodes.length
      ? `${failedCodes.length}/${targets.length} 只日线补数失败`
      : `${targets.length} 只日线已补齐至报价交易日`;
    this.db.log('history', status, message, this.now().toISOString());
    this.db.finishSyncTask('history', {
      status,
      lastSuccessDate: after.barDate,
      failedDates,
      message,
      attemptedAt: this.now().toISOString()
    });
    return {
      requestedCodes: targets.map((etf) => etf.code),
      failedCodes,
      barDate: after.barDate
    };
  }

  async syncHistory() {
    await this.refreshQuotes();
    await this.syncHistoricalBars({ force: true });
    try {
      await this.syncOfficialShareHistory();
    } catch (error) {
      this.db.log('shares', 'error', `官方份额同步失败：${error.message}`, this.now().toISOString());
    }
    return this.getSummary();
  }

  async refreshAllData() {
    await this.refreshQuotes();
    try {
      await this.syncOfficialShareHistory();
    } catch (error) {
      this.db.log('shares', 'error', `官方份额补抓失败：${error.message}`, this.now().toISOString());
    }
    return this.getSummary();
  }

  async performQuoteRefresh() {
    const capturedAt = this.now().toISOString();
    this.db.startSyncTask('quotes', { attemptedAt: capturedAt });
    const enabledEtfs = this.getEnabledEtfs();
    const results = await Promise.allSettled(
      enabledEtfs.map((etf) => this.quoteProvider(etf))
    );
    let successCount = 0;
    const failures = [];
    results.forEach((result, index) => {
      const etf = enabledEtfs[index];
      if (result.status === 'fulfilled' && result.value.timestamp) {
        const quote = result.value;
        const tradeDate = tradeDateFromTimestamp(quote.timestamp);
        this.db.saveSnapshot(quote, tradeDate, capturedAt);
        if (quote.shares !== null) {
          this.db.saveShareHistory([{
            code: quote.code,
            tradeDate,
            shares: quote.shares,
            source: '行情快照'
          }], capturedAt);
        }
        successCount += 1;
        this.db.recordFetchStatus(etf.code, 'quote', {
          status: 'success',
          attemptedAt: capturedAt,
          successAt: capturedAt,
          error: null
        });
      } else {
        const error = result.reason?.message || '无有效时间戳';
        failures.push(`${etf.code}: ${result.reason?.message || '无有效时间戳'}`);
        this.db.recordFetchStatus(etf.code, 'quote', {
          status: 'error',
          attemptedAt: capturedAt,
          error
        });
      }
    });
    const status = failures.length ? (successCount ? 'partial' : 'error') : 'success';
    const quoteDate = this.db.getDataDates().quoteDate;
    this.db.finishSyncTask('quotes', {
      status,
      lastSuccessDate: quoteDate,
      failedDates: failures.map((failure) => failure.split(':')[0]),
      message: failures.length
        ? `${successCount}/${enabledEtfs.length} 行情成功`
        : `${enabledEtfs.length} 只 ETF 行情全部成功`,
      attemptedAt: capturedAt
    });
    this.db.log(
      'quotes',
      status,
      failures.length
        ? `${successCount}/${enabledEtfs.length} 成功；${failures.join('；')}`
        : `更新 ${successCount}/${enabledEtfs.length}`,
      capturedAt
    );
    try {
      await this.refreshIopv();
    } catch (error) {
      this.db.log('iopv', 'error', `IOPV 同步失败：${error.message}`, this.now().toISOString());
    }
    const summary = this.getSummary();
    this.persistSummaryMetrics(summary, capturedAt);
    return summary;
  }

  async refreshIopv() {
    if (this.iopvRefreshPromise) return this.iopvRefreshPromise;
    this.iopvRefreshPromise = this.performIopvRefresh();
    try {
      return await this.iopvRefreshPromise;
    } finally {
      this.iopvRefreshPromise = null;
    }
  }

  async performIopvRefresh() {
    const attemptedAt = this.now().toISOString();
    this.db.startSyncTask('iopv', { attemptedAt });
    const enabledEtfs = this.getEnabledEtfs();
    let supplementary = new Map();
    let supplementaryFailure = null;
    try {
      supplementary = await this.supplementaryIopvProvider(enabledEtfs);
    } catch (error) {
      supplementaryFailure = error;
    }
    const officialResults = await Promise.allSettled(
      enabledEtfs.map((etf) => this.officialIopvProvider(etf))
    );
    const failures = [];
    let validCount = 0;
    let fallbackCount = 0;
    let anomalyCount = 0;
    const samples = [];

    officialResults.forEach((result, index) => {
      const etf = enabledEtfs[index];
      const latestTradeDate = this.db.getBars(etf.code, 1).at(-1)?.date || null;
      let state;
      if (result.status === 'fulfilled') {
        const official = result.value;
        const secondary = supplementary.get(etf.code) || null;
        const crossCheck = crossCheckIopv(official, secondary);
        state = {
          ...official,
          crossCheck,
          status: crossCheck.status === 'conflict' ? 'conflict' : 'valid',
          fetchedAt: attemptedAt,
          attemptedAt
        };
      } else {
        const fallback = supplementary.get(etf.code);
        if (fallback) {
          fallbackCount += 1;
          state = {
            ...fallback,
            crossCheck: {
              status: 'unavailable',
              message: '官方实时接口不可用，使用东方财富公开报价字段'
            },
            status: 'valid',
            fetchedAt: attemptedAt,
            attemptedAt
          };
        } else {
          const reason = result.reason?.message || '未知错误';
          failures.push(`${etf.code}: ${reason}`);
          this.db.markIopvFailure(etf.code, `官方与补充源均不可用：${reason}`, attemptedAt);
          anomalyCount += 1;
          return;
        }
      }

      const resolved = resolveIopvState(state, {
        now: this.now(),
        latestTradeDate,
        tradingSession: this.isTradingSession(this.now())
      });
      const stored = {
        ...state,
        status: resolved.status,
        message: resolved.message,
        premiumRate: resolved.premiumRate ?? calculatePremiumRate(state.marketPrice, state.iopv)
      };
      this.db.saveIopvLatest(stored);
      if (resolved.status !== 'valid') {
        anomalyCount += 1;
        failures.push(`${etf.code}: ${resolved.message}`);
        return;
      }
      validCount += 1;
      const currentSample = {
        code: etf.code,
        tradeDate: state.tradeDate,
        dataTime: state.dataTime,
        observedAt: state.observedAt,
        marketPrice: state.marketPrice,
        iopv: state.iopv,
        premiumRate: resolved.premiumRate,
        source: state.source,
        sourceKind: state.sourceKind,
        sourceUrl: state.sourceUrl
      };
      samples.push(currentSample);
      for (const point of state.series || []) {
        if (
          point.dataTime &&
          point.dataTime < state.dataTime &&
          iopvPointIsValid(point)
        ) {
          samples.push({
            ...point,
            source: state.source,
            sourceKind: state.sourceKind,
            sourceUrl: state.sourceUrl
          });
        }
      }
    });

    if (samples.length) this.db.saveIopvSamples(samples, attemptedAt);
    const status = anomalyCount || supplementaryFailure
      ? (validCount ? 'partial' : 'error')
      : 'success';
    const detail = [
      `${validCount}/${enabledEtfs.length} 有效`,
      fallbackCount ? `${fallbackCount} 只使用东方财富补充源` : null,
      anomalyCount ? `${anomalyCount} 只数据异常或过期` : null,
      supplementaryFailure ? `补充校验源失败：${supplementaryFailure.message}` : null,
      failures.length ? failures.join('；') : null
    ].filter(Boolean).join('；');
    this.db.log('iopv', status, detail, attemptedAt);
    this.db.finishSyncTask('iopv', {
      status,
      lastSuccessDate: this.db.getDataDates().iopvDate,
      failedDates: failures.map((failure) => this.db.getDataDates().barDate).filter(Boolean),
      message: detail || 'IOPV 同步完成',
      attemptedAt
    });
    return { validCount, fallbackCount, anomalyCount, failures };
  }

  persistSummaryMetrics(summary, updatedAt) {
    for (const row of summary.etfs) {
      if (row.tradeDate) {
        this.db.saveDailyMetrics({
          code: row.code,
          tradeDate: row.tradeDate,
          volumeRatio: row.volumeRatio,
          return5d: row.return5d,
          return20d: row.return20d,
          amountPercentile: row.amountPercentile,
          previousShares: row.previousShares,
          shares: row.shares,
          shareDelta: row.shareDelta,
          estimatedSubscription: row.estimatedSubscription,
          signals: row.signals,
          updatedAt
        });
      }
    }
  }

  async syncOfficialShareHistory(tradeDate, {
    historyDays = OFFICIAL_FETCH_DAYS
  } = {}) {
    if (this.shareSyncPromise) return this.shareSyncPromise;
    this.shareSyncPromise = (async () => {
      try {
        return await this.performOfficialShareSync(tradeDate, historyDays);
      } catch (error) {
        this.db.finishSyncTask('shares', {
          status: 'error',
          message: `官方份额同步异常：${error.message}`,
          attemptedAt: this.now().toISOString()
        });
        this.db.log('shares', 'error', `官方份额同步异常：${error.message}`, this.now().toISOString());
        throw error;
      }
    })();
    try {
      return await this.shareSyncPromise;
    } finally {
      this.shareSyncPromise = null;
    }
  }

  latestQuoteTradeDate() {
    const enabledCodes = new Set(this.getEnabledEtfs().map((etf) => etf.code));
    const quoteDate = this.db.getLatestSnapshots()
      .filter((row) => enabledCodes.has(row.code))
      .map((row) => row.trade_date)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (quoteDate) return quoteDate;
    return this.getEnabledEtfs()
      .map((etf) => this.db.getEtfDataDates(etf.code).barDate)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  }

  getActiveDataDates() {
    const dates = this.getEnabledEtfs().map((etf) => this.db.getEtfDataDates(etf.code));
    const latest = (field) => dates.map((item) => item[field]).filter(Boolean).sort().at(-1) || null;
    return {
      quoteDate: latest('quoteDate'),
      barDate: latest('barDate'),
      officialShareDate: latest('officialShareDate'),
      iopvDate: latest('iopvDate')
    };
  }

  async syncRecentOfficialShareGaps() {
    const targetDate = this.latestQuoteTradeDate();
    if (!targetDate) return null;
    return this.syncOfficialShareHistory(targetDate, {
      historyDays: OFFICIAL_RECOVERY_DAYS
    });
  }

  async retryPendingOfficialShares() {
    const status = this.getOfficialShareSyncStatus();
    if (!status?.needsRetry) return null;
    const calendar = this.getTradingCalendarStatus();
    if (!isOfficialShareRetryDue(this.now(), {
      isTradingDay: Boolean(calendar?.isTradingDay),
      lastAttemptAt: status.lastAttemptAt
    })) {
      return null;
    }
    return this.syncRecentOfficialShareGaps();
  }

  getOfficialShareSyncStatus(now = this.now()) {
    const targetDate = this.latestQuoteTradeDate();
    if (!targetDate) {
      return {
        state: 'unavailable',
        targetDate: null,
        message: '尚无行情交易日，无法检查官方份额',
        needsRetry: false,
        lastAttemptAt: null,
        attemptCount: 0,
        retryCount: 0,
        nextRetryAt: null,
        exchanges: {},
        history: {
          status: 'unavailable',
          requestedDays: OFFICIAL_STATUS_HISTORY_DAYS,
          availableDays: 0,
          missingRecentDates: []
        }
      };
    }
    const task = this.db.getSyncTask('shares');
    const enabledEtfs = this.getEnabledEtfs();
    const exchanges = {};
    for (const [exchange, etfs] of [
      ['SSE', enabledEtfs.filter((etf) => getMarket(etf.code) === 1)],
      ['SZSE', enabledEtfs.filter((etf) => getMarket(etf.code) === 0)]
    ]) {
      const expectedCodes = etfs.map((etf) => etf.code);
      const record = this.db.getOfficialShareSyncRecord(exchange, targetDate);
      const actualCodes = this.db.getActualOfficialShareCodes(targetDate, expectedCodes);
      const complete = this.db.getCompletedOfficialShareSyncDates(
        exchange,
        [targetDate],
        expectedCodes
      ).has(targetDate);
      const status = complete
        ? 'ready'
        : record?.status === 'error'
          ? 'failed'
          : actualCodes.length
            ? 'incomplete'
            : 'waiting';
      exchanges[exchange] = {
        status,
        expectedCount: expectedCodes.length,
        actualCount: actualCodes.length,
        missingCodes: expectedCodes.filter((code) => !actualCodes.includes(code)),
        message: record?.message || (
          complete
            ? '官方份额完整'
            : status === 'waiting'
              ? '交易所尚未返回该交易日份额'
              : `官方份额不完整（${actualCodes.length}/${expectedCodes.length}）`
        ),
        fetchedAt: record?.fetchedAt || null
      };
    }

    let historyComplete = null;
    let historyDates = this.db.getRecentTradeDates(
      OFFICIAL_STATUS_HISTORY_DAYS,
      targetDate
    );
    if (!historyDates.includes(targetDate)) historyDates.push(targetDate);
    historyDates = [...new Set(historyDates)].sort();
    for (const [exchange, etfs] of [
      ['SSE', enabledEtfs.filter((etf) => getMarket(etf.code) === 1)],
      ['SZSE', enabledEtfs.filter((etf) => getMarket(etf.code) === 0)]
    ]) {
      const dates = this.db.getCompletedOfficialShareSyncDates(
        exchange,
        historyDates,
        etfs.map((etf) => etf.code)
      );
      historyComplete = historyComplete === null
        ? dates
        : new Set([...historyComplete].filter((date) => dates.has(date)));
    }
    historyComplete ||= new Set();
    const missingRecentDates = historyDates.filter((date) => !historyComplete.has(date));
    const exchangeList = Object.values(exchanges);
    const targetFailed = exchangeList.some((item) => item.status === 'failed');
    const targetWaiting = exchangeList.some((item) => item.status !== 'ready');
    const historyIncomplete = missingRecentDates.length > 0;
    const state = targetFailed
      ? 'failed'
      : targetWaiting
        ? 'waiting'
        : historyIncomplete
          ? 'incomplete'
          : 'ready';
    const actualTotal = exchangeList.reduce((sum, item) => sum + item.actualCount, 0);
    const expectedTotal = exchangeList.reduce((sum, item) => sum + item.expectedCount, 0);
    const lastAttemptAt = task?.lastAttemptAt || exchangeList
      .map((item) => item.fetchedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const calendar = this.getTradingCalendarStatus(now);
    const needsRetry = state === 'waiting' || state === 'failed';
    const message = state === 'failed'
      ? `官方份额同步失败（${actualTotal}/${expectedTotal}），等待自动重试`
      : state === 'waiting'
        ? `交易所尚未返回完整份额（${actualTotal}/${expectedTotal}），等待自动重试`
        : state === 'incomplete'
          ? `最近 ${OFFICIAL_STATUS_HISTORY_DAYS} 个交易日官方份额不完整`
          : `${targetDate} 官方份额已完整（${actualTotal}/${expectedTotal}）`;
    return {
      state,
      targetDate,
      latestOfficialDate: this.getActiveDataDates().officialShareDate,
      message,
      needsRetry,
      lastAttemptAt,
      attemptCount: task?.retryCount || 0,
      retryCount: Math.max(0, (task?.retryCount || 0) - 1),
      nextRetryAt: needsRetry
        ? nextOfficialShareRetryAt(now, {
          isTradingDay: Boolean(calendar?.isTradingDay),
          lastAttemptAt
        })
        : null,
      completedCount: actualTotal,
      expectedCount: expectedTotal,
      exchanges,
      history: {
        status: !historyDates.length
          ? 'unavailable'
          : historyIncomplete ? 'partial' : 'complete',
        requestedDays: OFFICIAL_STATUS_HISTORY_DAYS,
        availableDays: historyDates.length - missingRecentDates.length,
        missingRecentDates: missingRecentDates.slice(-5)
      }
    };
  }

  async performOfficialShareSync(tradeDate, historyDays) {
    const currentTradeDate = tradeDate ||
      this.db.getLatestSnapshots().map((row) => row.trade_date).sort().at(-1);
    if (!currentTradeDate) return null;
    this.db.startSyncTask('shares', {
      targetDates: [currentTradeDate],
      attemptedAt: this.now().toISOString()
    });
    const previousTradeDate = this.db.getLatestBarDateBefore(currentTradeDate);
    const tradeDates = this.db.getRecentTradeDates(historyDays, currentTradeDate);
    if (!tradeDates.includes(currentTradeDate)) tradeDates.push(currentTradeDate);
    const requestedDates = [...new Set(tradeDates)].sort().slice(-historyDays);
    if (!requestedDates.length) return null;
    const enabledEtfs = this.getEnabledEtfs();
    const sseEtfs = enabledEtfs.filter((etf) => getMarket(etf.code) === 1);
    const szseEtfs = enabledEtfs.filter((etf) => getMarket(etf.code) === 0);
    const [sseResult, szseResult] = await Promise.all([
      this.syncSseShareDates(sseEtfs, requestedDates),
      this.syncSzseShareDates(szseEtfs, requestedDates)
    ]);
    const entries = [...sseResult.entries, ...szseResult.entries];
    const failures = [...sseResult.failures, ...szseResult.failures];
    const sseCompleted = new Set(sseResult.completedDates);
    const szseCompleted = new Set(szseResult.completedDates);
    const completedDates = requestedDates.filter(
      (date) => sseCompleted.has(date) && szseCompleted.has(date)
    );
    const missingDates = requestedDates.filter((date) => !completedDates.includes(date));
    const syncStatus = this.getOfficialShareSyncStatus();
    const status = syncStatus.state === 'ready'
      ? 'success'
      : syncStatus.state === 'waiting'
        ? 'pending'
        : entries.length || completedDates.length
          ? 'partial'
          : 'error';
    this.db.log(
      'shares',
      status,
      failures.length
        ? `历史份额完成 ${completedDates.length}/${requestedDates.length} 个交易日，本次写入 ${entries.length} 条；${failures.join('；')}`
        : `历史份额完成 ${completedDates.length}/${requestedDates.length} 个交易日，本次写入 ${entries.length} 条官方份额`,
      this.now().toISOString()
    );
    this.db.finishSyncTask('shares', {
      status,
      lastSuccessDate: this.getActiveDataDates().officialShareDate,
      failedDates: [...new Set([
        ...missingDates,
        ...failures.map((failure) => failure.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean)
      ])],
      message: failures.length
        ? `${completedDates.length}/${requestedDates.length} 个日期完成，${failures.length} 项失败`
        : `${completedDates.length}/${requestedDates.length} 个日期完成`,
      attemptedAt: this.now().toISOString()
    });
    const summary = this.getSummary();
    this.persistSummaryMetrics(summary, this.now().toISOString());
    return {
      tradeDate: previousTradeDate,
      requestedDates,
      completedDates,
      entries,
      failures,
      summary
    };
  }

  async syncSseShareDates(etfs, requestedDates) {
    const expectedCodes = etfs.map((etf) => etf.code);
    const completed = this.db.getCompletedOfficialShareSyncDates(
      'SSE',
      requestedDates,
      expectedCodes
    );
    const datesToFetch = requestedDates.filter((date) => !completed.has(date));
    const results = await mapLimit(datesToFetch, SSE_FETCH_CONCURRENCY, async (date) => {
      try {
        const values = await this.sseShareProvider(date);
        const entries = etfs.flatMap((etf) => {
          const shares = values.get(etf.code);
          return Number.isFinite(shares) && shares > 0
            ? [{ code: etf.code, tradeDate: date, shares, source: '上交所' }]
            : [];
        });
        const saved = this.db.saveOfficialShareDay({
          exchange: 'SSE',
          tradeDate: date,
          entries,
          expectedCodes,
          message: entries.length === expectedCodes.length
            ? null
            : `上交所仅返回 ${entries.length}/${expectedCodes.length} 只目标 ETF`,
          fetchedAt: this.now().toISOString()
        });
        return {
          date,
          entries,
          status: saved.status,
          failure: saved.status === 'success'
            ? null
            : `上交所 ${date}：${saved.status}（${saved.writtenCodes.length}/${expectedCodes.length}）`
        };
      } catch (error) {
        try {
          this.db.recordOfficialShareDayFailure({
            exchange: 'SSE',
            tradeDate: date,
            expectedCodes,
            message: error.message,
            fetchedAt: this.now().toISOString()
          });
        } catch {
          // The original write error is the useful failure for retry state.
        }
        return { date, entries: [], status: 'pending', failure: `上交所 ${date}：${error.message}` };
      }
    });
    const successfulDates = results
      .filter((result) => result.status === 'success')
      .map((result) => result.date);
    return {
      entries: results.flatMap((result) => result.entries),
      failures: results.map((result) => result.failure).filter(Boolean),
      completedDates: [...completed, ...successfulDates]
    };
  }

  async syncSzseShareDates(etfs, requestedDates) {
    const expectedCodes = etfs.map((etf) => etf.code);
    const completed = this.db.getCompletedOfficialShareSyncDates(
      'SZSE',
      requestedDates,
      expectedCodes
    );
    const datesToFetch = requestedDates.filter((date) => !completed.has(date));
    if (!datesToFetch.length) {
      return { entries: [], failures: [], completedDates: [...completed] };
    }
    const codes = etfs.map((etf) => etf.code);
    if (datesToFetch.length >= 4) {
      try {
        const entries = await this.szseRangeProvider(
          codes,
          datesToFetch[0],
          datesToFetch.at(-1)
        );
        const dateSet = new Set(datesToFetch);
        const results = datesToFetch.map((date) => {
          const dateEntries = entries.filter((entry) => entry.tradeDate === date);
          const saved = this.db.saveOfficialShareDay({
            exchange: 'SZSE',
            tradeDate: date,
            entries: dateEntries,
            expectedCodes,
            message: dateEntries.length === expectedCodes.length
              ? null
              : `深交所 ${date} 仅返回 ${dateEntries.length}/${expectedCodes.length} 只目标 ETF`,
            fetchedAt: this.now().toISOString()
          });
          return { date, status: saved.status, entries: dateEntries };
        });
        return {
          entries: entries.filter((entry) => dateSet.has(entry.tradeDate)),
          failures: results
            .filter((result) => result.status !== 'success')
            .map((result) => `深交所 ${result.date}：${result.status}`),
          completedDates: [
            ...completed,
            ...results.filter((result) => result.status === 'success').map((result) => result.date)
          ]
        };
      } catch (error) {
        for (const date of datesToFetch) {
          try {
            this.db.recordOfficialShareDayFailure({
              exchange: 'SZSE',
              tradeDate: date,
              expectedCodes,
              message: error.message,
              fetchedAt: this.now().toISOString()
            });
          } catch {
            // Preserve the provider failure as the primary retry reason.
          }
        }
        return {
          entries: [],
          failures: [`深交所 ${datesToFetch[0]} 至 ${datesToFetch.at(-1)}：${error.message}`],
          completedDates: [...completed]
        };
      }
    }
    const results = await Promise.allSettled(datesToFetch.map(async (date) => ({
      date,
      values: await this.szseShareProvider(codes, date)
    })));
    const entries = [];
    const failures = [];
    const successfulDates = [];
    results.forEach((result, index) => {
      const date = datesToFetch[index];
      if (result.status === 'rejected') {
        try {
          this.db.recordOfficialShareDayFailure({
            exchange: 'SZSE',
            tradeDate: date,
            expectedCodes,
            message: result.reason.message,
            fetchedAt: this.now().toISOString()
          });
        } catch {
          // Preserve the provider failure as the primary retry reason.
        }
        failures.push(`深交所 ${date}：${result.reason.message}`);
        return;
      }
      const dateEntries = [];
      for (const etf of etfs) {
        const shares = result.value.values.get(etf.code);
        if (Number.isFinite(shares) && shares > 0) {
          dateEntries.push({ code: etf.code, tradeDate: date, shares, source: '深交所' });
        }
      }
      entries.push(...dateEntries);
      const saved = this.db.saveOfficialShareDay({
        exchange: 'SZSE',
        tradeDate: date,
        entries: dateEntries,
        expectedCodes,
        message: dateEntries.length === expectedCodes.length
          ? null
          : `深交所 ${date} 仅返回 ${dateEntries.length}/${expectedCodes.length} 只目标 ETF`,
        fetchedAt: this.now().toISOString()
      });
      if (saved.status === 'success') successfulDates.push(date);
      else failures.push(`深交所 ${date}：${saved.status}`);
    });
    return {
      entries,
      failures,
      completedDates: [...completed, ...successfulDates]
    };
  }

  getShareWindowMetric({ history, bars, days, latestOfficial }) {
    const endDate = latestOfficial?.tradeDate || null;
    const expectedDates = endDate
      ? this.db.getRecentTradeDates(days, endDate)
      : [];
    const availableDates = new Set(history.map((row) => row.tradeDate));
    const completeDates = expectedDates.length === days &&
      expectedDates.every((tradeDate) => availableDates.has(tradeDate));
    const analysis = calculateShareWindow(history, bars, days);
    const coverageDays = analysis.points
      .filter((point) => Number.isFinite(point.estimatedSubscription))
      .length;
    const ready = completeDates && coverageDays === days;
    return {
      status: ready ? 'ready' : 'accumulating',
      estimatedSubscription: ready ? analysis.periodEstimatedSubscription : null,
      shareDelta: ready ? analysis.periodShareDelta : null,
      coverageDays,
      expectedDays: days,
      endDate
    };
  }

  getSummary() {
    const enabledEtfs = this.getEnabledEtfs();
    const snapshotByCode = new Map(
      this.db.getLatestSnapshots().map((row) => [row.code, snapshotToQuote(row)])
    );
    const quoteRows = enabledEtfs.map((etf) => ({
      name: etf.name,
      category: etf.category,
      tone: etf.tone,
      isPinned: etf.isPinned,
      isHighlighted: etf.isHighlighted,
      sortOrder: etf.sortOrder,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      open: null,
      high: null,
      low: null,
      volume: null,
      amount: null,
      turnoverRate: null,
      shares: null,
      marketValue: null,
      dataTime: null,
      capturedAt: null,
      tradeDate: null,
      ...(snapshotByCode.get(etf.code) || {}),
      code: etf.code,
      name: etf.name,
      category: etf.category,
      tone: etf.tone,
      isPinned: etf.isPinned,
      isHighlighted: etf.isHighlighted,
      sortOrder: etf.sortOrder
    }));
    const marketData = quoteRows.map((quote) => {
      const bars = this.db.getBars(quote.code, 520);
      const officialHistory = this.db.getOfficialShareHistory(
        quote.code,
        OFFICIAL_HISTORY_DAYS + 1
      );
      return {
        quote,
        etf: enabledEtfs.find((etf) => etf.code === quote.code),
        bars,
        shares: officialHistory,
        officialHistory
      };
    });
    const scoreObservations = buildSignalScores(
      marketData.map(({ etf, bars, shares }) => ({ etf, bars, shares }))
    );
    const latestScoreByCode = new Map();
    for (const observation of scoreObservations) {
      latestScoreByCode.set(observation.code, observation);
    }
    const baseRows = marketData.map(({ quote, bars, officialHistory }) => {
      const priorBars = bars.filter((bar) => bar.date < quote.tradeDate);
      const ratio = volumeRatio(
        quote.amount,
        priorBars.slice(-20).map((bar) => bar.amount)
      );
      const priorDayBar = priorBars.at(-1);
      const previousRatio = priorDayBar
        ? volumeRatio(priorDayBar.amount, priorBars.slice(-21, -1).map((bar) => bar.amount))
        : null;
      const currentOfficialShare = this.db.getOfficialShareRecord(quote.code, quote.tradeDate);
      const previousOfficialShare = this.db.getPreviousOfficialShareRecord(
        quote.code,
        quote.tradeDate
      );
      const closeByDate = new Map(bars.map((bar) => [bar.date, bar.close]));
      const currentClose = closeByDate.get(quote.tradeDate);
      const currentMetric = calculateOfficialShareMetric({
        current: currentOfficialShare,
        previous: previousOfficialShare,
        expectedPreviousDate: this.db.getPreviousTradingDate(quote.tradeDate),
        price: Number.isFinite(currentClose) ? currentClose : quote.price,
        priceSource: Number.isFinite(currentClose) ? '官方日收盘价' : '行情快照'
      });
      const latestOfficial = officialHistory.at(-1) || null;
      const latestPreviousOfficial = latestOfficial
        ? this.db.getPreviousOfficialShareRecord(quote.code, latestOfficial.tradeDate)
        : null;
      const latestClose = latestOfficial ? closeByDate.get(latestOfficial.tradeDate) : null;
      const latestMetricPrice = Number.isFinite(latestClose)
        ? latestClose
        : latestOfficial?.tradeDate === quote.tradeDate
          ? quote.price
          : null;
      const latestMetric = calculateOfficialShareMetric({
        current: latestOfficial,
        previous: latestPreviousOfficial,
        expectedPreviousDate: latestOfficial
          ? this.db.getPreviousTradingDate(latestOfficial.tradeDate)
          : null,
        price: latestMetricPrice,
        priceSource: Number.isFinite(latestClose) ? '官方日收盘价' : '行情快照'
      });
      const officialTradeDates = latestOfficial
        ? this.db.getRecentTradeDates(officialHistory.length, latestOfficial.tradeDate)
        : [];
      const shareStreak = calculateShareStreak(officialHistory, officialTradeDates);
      const iopv = this.getCurrentIopv(quote.code, bars.at(-1)?.date || null);
      const shareWindow5d = this.getShareWindowMetric({
        history: officialHistory,
        bars,
        days: 5,
        latestOfficial
      });
      const shareWindow20d = this.getShareWindowMetric({
        history: officialHistory,
        bars,
        days: 20,
        latestOfficial
      });
      const historyStatus = bars.length >= 20 && officialHistory.length >= 2
        ? 'ready'
        : 'accumulating';
      return {
        ...quote,
        quoteShares: quote.shares,
        quoteShareDate: quote.tradeDate,
        quoteShareSource: '行情快照',
        shares: currentMetric.currentShares,
        sharesSource: currentOfficialShare?.source || null,
        currentOfficialShares: currentMetric.currentShares,
        officialShares: latestOfficial?.shares ?? null,
        currentDayShareMetrics: {
          tradeDate: quote.tradeDate,
          status: currentMetric.status,
          shareDelta: currentMetric.shareDelta,
          estimatedSubscription: currentMetric.estimatedSubscription,
          officialShares: currentMetric.currentShares,
          officialShareDate: currentMetric.currentDate,
          previousOfficialShares: currentMetric.previousShares,
          previousOfficialShareDate: currentMetric.previousDate,
          price: currentMetric.price,
          priceSource: currentMetric.priceSource
        },
        volumeRatio: ratio,
        previousVolumeRatio: previousRatio,
        return5d: periodReturn(quote.price, priorBars.map((bar) => bar.close), 5),
        return20d: periodReturn(quote.price, priorBars.map((bar) => bar.close), 20),
        amountPercentile: percentile(
          quote.amount,
          priorBars.slice(-250).map((bar) => bar.amount)
        ),
        previousShares: previousOfficialShare?.shares ?? null,
        previousShareDate: previousOfficialShare?.tradeDate || null,
        previousShareSource: previousOfficialShare?.source || null,
        previousOfficialShares: previousOfficialShare?.shares ?? null,
        previousOfficialShareDate: previousOfficialShare?.tradeDate || null,
        previousOfficialShareSource: previousOfficialShare?.source || null,
        shareDelta: currentMetric.shareDelta,
        estimatedSubscription: currentMetric.estimatedSubscription,
        shareMetricStatus: currentMetric.status,
        shareMetricPrice: currentMetric.price,
        shareMetricPriceSource: currentMetric.priceSource,
        officialShareDate: latestOfficial?.tradeDate || null,
        officialShareSource: latestOfficial?.source || null,
        officialShareFetchedAt: latestOfficial?.officialFetchedAt || latestOfficial?.fetchedAt || null,
        currentOfficialShareFetchedAt: currentOfficialShare?.officialFetchedAt ||
          currentOfficialShare?.fetchedAt || null,
        snapshotFetchedAt: quote.capturedAt,
        latestOfficialShareDelta: latestMetric.shareDelta,
        latestOfficialShareDeltaDate: latestMetric.currentDate,
        latestOfficialShares: latestMetric.currentShares,
        latestOfficialShareSource: latestOfficial?.source || null,
        latestOfficialPreviousShares: latestMetric.previousShares,
        latestOfficialPreviousDate: latestMetric.previousDate,
        latestOfficialPreviousSource: latestPreviousOfficial?.source || null,
        latestOfficialEstimatedSubscription: latestMetric.estimatedSubscription,
        latestOfficialMetricStatus: latestMetric.status,
        latestOfficialMetricPrice: latestMetric.price,
        latestOfficialMetricPriceSource: latestMetric.priceSource,
        estimatedFundSize: Number.isFinite(quote.marketValue)
          ? quote.marketValue
          : Number.isFinite(latestOfficial?.shares) && Number.isFinite(quote.price)
            ? latestOfficial.shares * quote.price
            : null,
        officialShareDays: officialHistory.length,
        shareStreak,
        shareStreakDays: shareStreak.days,
        shareStreakDirection: shareStreak.direction,
        shareStreakDate: latestOfficial?.tradeDate || null,
        estimatedSubscription5d: shareWindow5d.estimatedSubscription,
        shareDelta5d: shareWindow5d.shareDelta,
        estimatedSubscription5dStatus: shareWindow5d.status,
        estimatedSubscription5dCoverage: shareWindow5d.coverageDays,
        estimatedSubscription20d: shareWindow20d.estimatedSubscription,
        shareDelta20d: shareWindow20d.shareDelta,
        estimatedSubscription20dStatus: shareWindow20d.status,
        estimatedSubscription20dCoverage: shareWindow20d.coverageDays,
        volatility20d: annualizedVolatility(bars.map((bar) => bar.close), 20),
        sharePercentile: latestOfficial
          ? percentile(
            latestOfficial.shares,
            officialHistory.slice(-OFFICIAL_HISTORY_DAYS).map((row) => row.shares)
          )
          : null,
        iopvMarketPrice: iopv.marketPrice,
        iopv: iopv.iopv,
        premiumRate: iopv.premiumRate,
        premiumStatus: iopv.status,
        premiumStatusLabel: iopv.label,
        premiumMessage: iopv.message,
        premiumAbnormal: iopv.isAbnormal === true,
        premiumAlertThreshold: IOPV_ALERT_THRESHOLD,
        iopvSource: iopv.source,
        iopvSourceKind: iopv.sourceKind,
        iopvSourceUrl: iopv.sourceUrl || null,
        iopvDataTime: iopv.dataTime || null,
        iopvObservedAt: iopv.observedAt || null,
        iopvFetchedAt: iopv.fetchedAt || null,
        iopvCrossCheck: iopv.crossCheck || null,
        historyStatus,
        historyDays: officialHistory.length,
        barHistoryDays: bars.length,
        sourceUrl: `https://quote.eastmoney.com/${quote.code}.html`
      };
    });
    const broadResonance = baseRows.filter(
      (row) => row.category === '宽基核心' && row.volumeRatio !== null && row.volumeRatio >= 2
    ).length >= 2;
    const rows = baseRows.map((row) => {
      const result = calculateSignals({
        isBroad: row.category === '宽基核心',
        volumeRatio: row.volumeRatio,
        previousVolumeRatio: row.previousVolumeRatio,
        shareDelta: row.shareDelta,
        broadResonance,
        tailVolumeShare: null
      });
      const latestScore = latestScoreByCode.get(row.code) || null;
      return {
        ...row,
        broadResonance,
        signals: result.signals,
        composite: result.composite,
        score: latestScore?.score ?? null,
        scoreDate: latestScore?.date ?? null,
        scoreLevel: latestScore?.level ?? null,
        scoreComponents: latestScore?.components ?? null,
        scoreReasons: latestScore?.reasons ?? [],
        scoreStatus: latestScore ? 'ready' : 'insufficient',
        scoreSignal: latestScore?.isSignal || false
      };
    }).sort((left, right) => (
      Number(right.isPinned) - Number(left.isPinned) ||
      left.sortOrder - right.sortOrder ||
      left.code.localeCompare(right.code)
    ));
    const dataTime = quoteRows
      .map((row) => row.dataTime)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const amountRows = rows.filter((row) => Number.isFinite(row.amount));
    const latestQuoteDate = quoteRows.map((row) => row.tradeDate).filter(Boolean).sort().at(-1) || null;
    const fetchStatuses = this.db.getFetchStatuses('quote');
    const freshnessRows = rows.map((row) => {
      const freshness = this.getQuoteFreshness(row, {
        latestQuoteDate,
        fetchStatus: fetchStatuses[row.code] || null
      });
      return { ...row, ...freshness };
    });
    const shareMetricStatusCounts = {
      ready: freshnessRows.filter((row) => row.shareMetricStatus === 'ready').length,
      pending: freshnessRows.filter((row) => row.shareMetricStatus === 'pending').length,
      insufficient: freshnessRows.filter((row) => row.shareMetricStatus === 'insufficient').length
    };
    const readyShareRows = freshnessRows.filter((row) => row.shareMetricStatus === 'ready');
    const latestOfficialReadyRows = freshnessRows.filter(
      (row) => row.latestOfficialMetricStatus === 'ready'
    );
    const staleRows = freshnessRows.filter((row) => row.isStale);
    const freshRows = freshnessRows.filter((row) => !row.isStale);
    const oldestDataTime = freshnessRows
      .map((row) => row.dataTime)
      .filter(Boolean)
      .sort()
      .at(0) || null;
    const latestDataTime = freshnessRows
      .map((row) => row.dataTime)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const quoteStatus = !freshRows.length
      ? 'error'
      : staleRows.length ? 'partial' : 'ok';
    return {
      generatedAt: this.now().toISOString(),
      monitorCount: rows.length,
      capacity: ETF_CAPACITY,
      dataTime: latestDataTime,
      oldestDataTime,
      latestDataTime,
      quoteStatus,
      quoteStatusLabel: quoteStatus === 'ok'
        ? '行情已连接'
        : quoteStatus === 'partial'
          ? '部分数据异常'
          : '行情数据异常',
      staleCount: staleRows.length,
      freshCount: freshRows.length,
      totalAmount: amountRows.length
        ? amountRows.reduce((sum, row) => sum + row.amount, 0)
        : null,
      amountCoverage: {
        available: amountRows.length,
        total: rows.length
      },
      volumeUpCount: rows.filter((row) => row.volumeRatio !== null && row.volumeRatio >= 2).length,
      shareUpCount: readyShareRows.filter((row) => row.shareDelta > 0).length,
      shareUpAsOfDate: readyShareRows.map((row) => row.quoteShareDate).filter(Boolean).sort().at(-1) ||
        null,
      shareMetricStatusCounts,
      shareSyncStatus: this.getOfficialShareSyncStatus(),
      latestOfficialShareUpCount: latestOfficialReadyRows.filter(
        (row) => row.latestOfficialShareDelta > 0
      ).length,
      latestOfficialShareUpAsOfDate: latestOfficialReadyRows
        .map((row) => row.latestOfficialShareDeltaDate)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      compositeCount: rows.filter((row) => row.composite).length,
      scoreSignalCount: rows.filter((row) => row.scoreSignal).length,
      highScoreCount: rows.filter((row) => row.score >= SIGNAL_PARAMETERS.levels.high).length,
      iopvAvailableCount: rows.filter((row) => row.premiumStatus === 'valid').length,
      iopvAbnormalCount: rows.filter((row) => row.premiumAbnormal).length,
      broadResonance,
      dataStatus: this.getDataStatus(),
      etfs: freshnessRows,
      logs: this.db.recentLogs()
    };
  }

  getQuoteFreshness(row, { latestQuoteDate, fetchStatus }) {
    const now = this.now();
    const dataTime = row.dataTime || row.capturedAt || null;
    const observedMs = dataTime ? new Date(dataTime).getTime() : NaN;
    const ageSeconds = Number.isFinite(observedMs)
      ? Math.max(0, Math.floor((now.getTime() - observedMs) / 1000))
      : null;
    const failedAttempt = fetchStatus?.status === 'error';
    const behindLatest = Boolean(
      row.tradeDate &&
      latestQuoteDate &&
      row.tradeDate < latestQuoteDate
    );
    const intradayStale = this.isTradingSession(now) &&
      Number.isFinite(ageSeconds) &&
      ageSeconds > 3 * 60;
    const generalStale = Number.isFinite(ageSeconds) &&
      ageSeconds > 72 * 60 * 60;
    const isStale = !row.dataTime || failedAttempt || behindLatest ||
      intradayStale || generalStale;
    const reasons = [
      !row.dataTime ? '缺少行情数据时间' : null,
      failedAttempt ? `最近抓取失败：${fetchStatus.lastError || '未知错误'}` : null,
      behindLatest ? `行情日期早于全池最新交易日 ${latestQuoteDate}` : null,
      intradayStale ? '盘中行情超过 3 分钟未更新' : null,
      generalStale ? '行情超过 72 小时未更新' : null
    ].filter(Boolean);
    return {
      capturedAt: row.capturedAt || fetchStatus?.lastAttemptAt || null,
      dataTime: row.dataTime || null,
      quoteStatus: !row.dataTime
        ? 'missing'
        : failedAttempt
          ? 'error'
          : isStale ? 'stale' : 'fresh',
      staleness: reasons[0] || '正常',
      stalenessSeconds: ageSeconds,
      isStale,
      quoteAttemptedAt: fetchStatus?.lastAttemptAt || null,
      quoteLastSuccessAt: fetchStatus?.lastSuccessAt || null
    };
  }

  getDataStatus() {
    const dates = this.getActiveDataDates();
    const tasks = Object.fromEntries(
      this.db.getSyncTasks().map((task) => [task.key, task])
    );
    const calendar = this.getTradingCalendarStatus();
    const etfs = this.getEnabledEtfs().map((etf) => {
      const item = this.db.getEtfDataDates(etf.code);
      return {
        code: etf.code,
        ...item,
        quoteBarLag: Boolean(item.quoteDate && (!item.barDate || item.barDate < item.quoteDate)),
        quoteShareLag: Boolean(item.quoteDate && (
          !item.officialShareDate || item.officialShareDate < item.quoteDate
        )),
        barIopvLag: Boolean(item.barDate && (!item.iopvDate || item.iopvDate < item.barDate))
      };
    });
    return {
      generatedAt: this.now().toISOString(),
      dates: {
        quoteDate: dates.quoteDate,
        barDate: dates.barDate,
        officialShareDate: dates.officialShareDate,
        iopvDate: dates.iopvDate
      },
      calendar,
      tasks,
      lagCounts: {
        quoteBars: etfs.filter((etf) => etf.quoteBarLag).length,
        quoteShares: etfs.filter((etf) => etf.quoteShareLag).length,
        barIopv: etfs.filter((etf) => etf.barIopvLag).length
      },
      etfs
    };
  }

  getCurrentIopv(code, latestTradeDate) {
    const record = this.db.getIopvLatest(code);
    return resolveIopvState(record, {
      now: this.now(),
      latestTradeDate
    });
  }

  getDetail(code) {
    const summary = this.getSummary();
    const quote = summary.etfs.find((row) => row.code === code);
    if (!quote) return null;
    return {
      quote,
      bars: this.db.getBars(code, 520),
      shareHistory: this.getShareHistory(code, OFFICIAL_HISTORY_DAYS),
      iopvHistory: this.getIopvHistory(code, OFFICIAL_HISTORY_DAYS),
      updatedAt: summary.generatedAt
    };
  }

  getShareHistory(code, selectedDays = OFFICIAL_HISTORY_DAYS) {
    const etf = this.getEtfConfig(code);
    if (!etf) return null;
    const history = this.db.getOfficialShareHistory(
      code,
      Math.max(...OFFICIAL_RANGES) + 1
    );
    const bars = this.db.getBars(code, 520);
    const latestOfficial = history.at(-1) || null;
    const officialTradeDates = latestOfficial
      ? this.db.getRecentTradeDates(history.length, latestOfficial.tradeDate)
      : [];
    const ranges = Object.fromEntries(OFFICIAL_RANGES.map((days) => {
      const analysis = calculateShareWindow(history, bars, days);
      const targetDates = latestOfficial
        ? this.db.getRecentTradeDates(days, latestOfficial.tradeDate)
        : [];
      const availableDates = new Set(history.map((row) => row.tradeDate));
      const missingDates = targetDates.filter((tradeDate) => !availableDates.has(tradeDate));
      const unavailableBeforeWindow = Math.max(0, days - targetDates.length);
      const availableDays = targetDates.length - missingDates.length;
      const missingDays = unavailableBeforeWindow + missingDates.length;
      return [days, {
        ...analysis,
        coverage: {
          requestedDays: days,
          availableDays,
          missingDays,
          targetStartDate: targetDates[0] || null,
          targetEndDate: targetDates.at(-1) || null,
          missingRecentDates: missingDates.slice(-5),
          status: !targetDates.length
            ? 'unavailable'
            : missingDays ? 'partial' : 'complete'
        }
      }];
    }));
    const market = getMarket(code) === 1 ? '上交所' : '深交所';
    return {
      code,
      selectedDays,
      generatedAt: this.now().toISOString(),
      latestOfficialDate: latestOfficial?.tradeDate || null,
      firstOfficialDate: history[0]?.tradeDate || null,
      officialRecordCount: history.length,
      source: latestOfficial?.source || null,
      sourceName: market,
      sourceUrl: getMarket(code) === 1
        ? 'https://www.sse.com.cn/market/funddata/volumn/etfvolumn/'
        : 'https://fund.szse.cn/marketdata/fundslist/index.html',
      note: history.length
        ? '份额数据取交易所官方接口；缺失日期不补值，较晚上市的 ETF 仅展示实际上线后的官方记录。'
        : '官方接口暂未返回该 ETF 的份额记录，不使用模拟值补齐。',
      streak: calculateShareStreak(history, officialTradeDates),
      range: ranges[selectedDays] || ranges[OFFICIAL_HISTORY_DAYS],
      ranges
    };
  }

  getIopvHistory(code, selectedDays = OFFICIAL_HISTORY_DAYS) {
    const etf = this.getEtfConfig(code);
    if (!etf) return null;
    const days = Number.isInteger(selectedDays) && selectedDays > 0
      ? Math.min(selectedDays, OFFICIAL_HISTORY_DAYS)
      : OFFICIAL_HISTORY_DAYS;
    const bars = this.db.getBars(code, 2);
    const latestTradeDate = bars.at(-1)?.date || null;
    const current = this.getCurrentIopv(code, latestTradeDate);
    const quote = this.db.getLatestSnapshots().find((row) => row.code === code);
    const tradeDate = current.tradeDate || quote?.trade_date || latestTradeDate;
    const rawIntraday = tradeDate
      ? this.db.getIopvSamplesForDate(code, tradeDate)
      : [];
    const intraday = dedupeIopvSeries(rawIntraday);
    const rates = intraday
      .map((point) => point.premiumRate)
      .filter(Number.isFinite);
    const stats = rates.length
      ? {
        open: rates[0],
        first: rates[0],
        high: Math.max(...rates),
        low: Math.min(...rates),
        mean: rates.reduce((sum, value) => sum + value, 0) / rates.length,
        latest: rates.at(-1),
        sampleCount: rates.length,
        firstTime: intraday[0]?.dataTime || null,
        lastTime: intraday.at(-1)?.dataTime || null,
        firstRecordLabel: '首个记录时点'
      }
      : {
        open: null,
        first: null,
        high: null,
        low: null,
        mean: null,
        latest: null,
        sampleCount: 0,
        firstTime: null,
        lastTime: null,
        firstRecordLabel: '首个记录时点'
      };
    const targetDates = latestTradeDate
      ? this.db.getRecentTradeDates(days, latestTradeDate)
      : [];
    const closeHistory = this.db.getIopvCloseHistory(
      code,
      days,
      targetDates[0] || null,
      targetDates.at(-1) || null
    );
    const closeRates = closeHistory
      .map((point) => point.premiumRate)
      .filter(Number.isFinite);
    const latestCloseRate = closeRates.at(-1) ?? null;
    const closePercentile = latestCloseRate === null || closeRates.length < 5
      ? null
      : percentile(latestCloseRate, closeRates);
    const availableDates = new Set(closeHistory.map((point) => point.tradeDate));
    const missingDates = targetDates.filter((date) => !availableDates.has(date));
    const recent = closeHistory.slice(-20);
    const direction = recent.length >= 2
      ? Math.sign(recent.at(-1).premiumRate - recent[0].premiumRate)
      : 0;
    return {
      code,
      selectedDays: days,
      generatedAt: this.now().toISOString(),
      tradeDate,
      current,
      source: current.source || null,
      sourceKind: current.sourceKind || null,
      sourceUrl: current.sourceUrl || null,
      sourceName: current.source || (tradeDate ? null : '暂无'),
      formula: '市场价 ÷ IOPV − 1',
      alertThreshold: IOPV_ALERT_THRESHOLD,
      updateFrequency: '交易所实时行情；本地交易时段每 30 秒刷新',
      intraday,
      stats,
      closeHistory,
      closePercentile,
      closeSampleCount: closeRates.length,
      latestCloseRate,
      recent,
      trend: direction > 0 ? 'up' : direction < 0 ? 'down' : 'flat',
      coverage: {
        requestedDays: days,
        availableDays: closeRates.length,
        missingDays: missingDates.length,
        targetStartDate: targetDates[0] || null,
        targetEndDate: targetDates.at(-1) || null,
        missingRecentDates: missingDates.slice(-5),
        status: !closeRates.length
          ? 'unavailable'
          : missingDates.length ? 'partial' : 'complete'
      },
      note: intraday.length <= 1
        ? '当日 IOPV 历史样本尚不足；统计仅基于已实际记录的交易所时点，不推算或补零。'
        : '当日统计仅使用同一交易日已记录的市场价与 IOPV 配对样本。',
      historyNote: closeRates.length < 5
        ? `收盘折溢价历史仅积累 ${closeRates.length} 个交易日，暂不计算分位。`
        : '收盘折溢价按每个交易日最后一个有效 IOPV 样本计算。'
    };
  }

  async getIntraday(code) {
    const etf = this.getEtfConfig(code);
    if (!etf) return null;
    const trends = await this.trendProvider(etf);
    const totalAmount = trends.reduce((sum, point) => sum + point.amount, 0);
    const tailAmount = trends
      .filter((point) => point.time.slice(11) >= '14:30')
      .reduce((sum, point) => sum + point.amount, 0);
    return {
      code,
      points: trends,
      tailVolumeShare: totalAmount > 0 ? tailAmount / totalAmount : null
    };
  }
}

module.exports = {
  MarketService,
  tradeDateFromTimestamp,
  snapshotToQuote,
  mapLimit
};

function catalogError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function iopvPointIsValid(point) {
  return Number.isFinite(point.marketPrice) &&
    point.marketPrice > 0 &&
    Number.isFinite(point.iopv) &&
    point.iopv > 0 &&
    Number.isFinite(point.premiumRate);
}

