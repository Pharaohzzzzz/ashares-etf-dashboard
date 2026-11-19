'use strict';

const { ETFS, getEtf, getMarket } = require('../config/etfs');
const {
  volumeRatio,
  percentile,
  periodReturn,
  calculateShareStreak,
  calculateShareWindow,
  calculateSignals
} = require('./metrics');
const {
  SIGNAL_PARAMETERS,
  buildSignalObservations,
  buildBacktest,
  datasetFingerprint
} = require('./signal-backtest');
const { fetchQuote, fetchKlines, fetchTrends } = require('./provider');
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

const OFFICIAL_HISTORY_DAYS = 250;
const OFFICIAL_FETCH_DAYS = OFFICIAL_HISTORY_DAYS + 1;
const OFFICIAL_RANGES = [20, 60, 250];
const SSE_FETCH_CONCURRENCY = 4;

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
    name: getEtf(row.code)?.name || row.code,
    category: getEtf(row.code)?.category || '未分类',
    tone: getEtf(row.code)?.tone || 'broad',
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
    this.now = now;
    this.refreshPromise = null;
    this.shareSyncPromise = null;
    this.backtestPromise = null;
    this.iopvRefreshPromise = null;
    this.initializing = false;
    this.initializedAt = db.getMeta('initializedAt');
  }

  async initialize({ force = false } = {}) {
    if (this.initializing) return;
    this.initializing = true;
    this.db.log('startup', 'running', '开始同步两年日线与实时行情', this.now().toISOString());
    try {
      const historyResults = await Promise.allSettled(ETFS.map(async (etf) => {
        const count = this.db.countBars(etf.code);
        if (!force && count >= 250) return;
        const bars = await this.klineProvider(etf, 520);
        this.db.upsertBars(etf.code, bars);
      }));
      const failures = historyResults
        .map((result, index) => result.status === 'rejected'
          ? `${ETFS[index].code}: ${result.reason.message}`
          : null)
        .filter(Boolean);
      if (failures.length) {
        this.db.log(
          'history',
          failures.length === ETFS.length ? 'error' : 'partial',
          `${failures.length} 只日线同步失败；${failures.join('；')}`,
          this.now().toISOString()
        );
      }
      await this.refreshQuotes();
      try {
        await this.syncOfficialShareHistory();
      } catch (error) {
        this.db.log('shares', 'error', `官方份额同步失败：${error.message}`, this.now().toISOString());
      }
      try {
        await this.runSignalBacktest();
      } catch (error) {
        this.db.log('backtest', 'error', `信号回测失败：${error.message}`, this.now().toISOString());
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

  async syncHistory() {
    const startedAt = this.now().toISOString();
    this.db.log('history', 'running', '同步最近日线', startedAt);
    const results = await Promise.allSettled(
      ETFS.map(async (etf) => {
        const bars = await this.klineProvider(etf, 520);
        this.db.upsertBars(etf.code, bars);
      })
    );
    const failed = results
      .map((result, index) => result.status === 'rejected' ? `${ETFS[index].code}: ${result.reason.message}` : null)
      .filter(Boolean);
    const status = failed.length ? (failed.length === results.length ? 'error' : 'partial') : 'success';
    this.db.log(
      'history',
      status,
      failed.length ? `${failed.length} 只失败；${failed.join('；')}` : '14 只日线同步完成',
      this.now().toISOString()
    );
    await this.refreshQuotes();
    try {
      await this.syncOfficialShareHistory();
    } catch (error) {
      this.db.log('shares', 'error', `官方份额同步失败：${error.message}`, this.now().toISOString());
    }
    try {
      await this.runSignalBacktest();
    } catch (error) {
      this.db.log('backtest', 'error', `信号回测失败：${error.message}`, this.now().toISOString());
    }
    return this.getSummary();
  }

  async performQuoteRefresh() {
    const capturedAt = this.now().toISOString();
    const results = await Promise.allSettled(
      ETFS.map((etf) => this.quoteProvider(etf))
    );
    let successCount = 0;
    const failures = [];
    results.forEach((result, index) => {
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
      } else {
        failures.push(`${ETFS[index].code}: ${result.reason?.message || '无有效时间戳'}`);
      }
    });
    const status = failures.length ? (successCount ? 'partial' : 'error') : 'success';
    this.db.log(
      'quotes',
      status,
      failures.length ? `${successCount}/${ETFS.length} 成功；${failures.join('；')}` : `更新 ${successCount}/${ETFS.length}`,
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
    let supplementary = new Map();
    let supplementaryFailure = null;
    try {
      supplementary = await this.supplementaryIopvProvider(ETFS);
    } catch (error) {
      supplementaryFailure = error;
    }
    const officialResults = await Promise.allSettled(
      ETFS.map((etf) => this.officialIopvProvider(etf))
    );
    const failures = [];
    let validCount = 0;
    let fallbackCount = 0;
    let anomalyCount = 0;
    const samples = [];

    officialResults.forEach((result, index) => {
      const etf = ETFS[index];
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
        latestTradeDate
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
      `${validCount}/${ETFS.length} 有效`,
      fallbackCount ? `${fallbackCount} 只使用东方财富补充源` : null,
      anomalyCount ? `${anomalyCount} 只数据异常或过期` : null,
      supplementaryFailure ? `补充校验源失败：${supplementaryFailure.message}` : null,
      failures.length ? failures.join('；') : null
    ].filter(Boolean).join('；');
    this.db.log('iopv', status, detail, attemptedAt);
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
    this.shareSyncPromise = this.performOfficialShareSync(tradeDate, historyDays);
    try {
      return await this.shareSyncPromise;
    } finally {
      this.shareSyncPromise = null;
    }
  }

  async performOfficialShareSync(tradeDate, historyDays) {
    const currentTradeDate = tradeDate ||
      this.db.getLatestSnapshots().map((row) => row.trade_date).sort().at(-1);
    if (!currentTradeDate) return null;
    const previousTradeDate = this.db.getLatestBarDateBefore(currentTradeDate);
    const tradeDates = this.db.getRecentTradeDates(historyDays, currentTradeDate);
    if (!tradeDates.includes(currentTradeDate)) tradeDates.push(currentTradeDate);
    const requestedDates = [...new Set(tradeDates)].sort().slice(-historyDays);
    if (!requestedDates.length) return null;
    const sseEtfs = ETFS.filter((etf) => getMarket(etf.code) === 1);
    const szseEtfs = ETFS.filter((etf) => getMarket(etf.code) === 0);
    const [sseResult, szseResult] = await Promise.all([
      this.syncSseShareDates(sseEtfs, requestedDates),
      this.syncSzseShareDates(szseEtfs, requestedDates)
    ]);
    const entries = [...sseResult.entries, ...szseResult.entries];
    const failures = [...sseResult.failures, ...szseResult.failures];
    const completedDates = [...new Set([
      ...sseResult.completedDates,
      ...szseResult.completedDates
    ])];
    if (entries.length) this.db.saveShareHistory(entries, this.now().toISOString());
    const status = failures.length
      ? (entries.length ? 'partial' : 'error')
      : 'success';
    this.db.log(
      'shares',
      status,
      failures.length
        ? `历史份额完成 ${completedDates.length}/${requestedDates.length} 个交易日，本次写入 ${entries.length} 条；${failures.join('；')}`
        : `历史份额完成 ${completedDates.length}/${requestedDates.length} 个交易日，本次写入 ${entries.length} 条官方份额`,
      this.now().toISOString()
    );
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
    const completed = this.db.getCompletedOfficialShareSyncDates('SSE', requestedDates);
    const datesToFetch = requestedDates.filter((date) => !completed.has(date));
    const results = await mapLimit(datesToFetch, SSE_FETCH_CONCURRENCY, async (date) => {
      try {
        const values = await this.sseShareProvider(date);
        const entries = etfs.flatMap((etf) => {
          const shares = values.get(etf.code);
          return Number.isFinite(shares)
            ? [{ code: etf.code, tradeDate: date, shares, source: '上交所' }]
            : [];
        });
        return { date, entries, failure: null };
      } catch (error) {
        return { date, entries: [], failure: `上交所 ${date}：${error.message}` };
      }
    });
    const successfulDates = results
      .filter((result) => !result.failure)
      .map((result) => result.date);
    if (successfulDates.length) {
      this.db.markOfficialShareSyncDates(
        'SSE',
        successfulDates,
        'success',
        null,
        this.now().toISOString()
      );
    }
    return {
      entries: results.flatMap((result) => result.entries),
      failures: results.map((result) => result.failure).filter(Boolean),
      completedDates: [...completed, ...successfulDates]
    };
  }

  async syncSzseShareDates(etfs, requestedDates) {
    const completed = this.db.getCompletedOfficialShareSyncDates('SZSE', requestedDates);
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
        this.db.markOfficialShareSyncDates(
          'SZSE',
          datesToFetch,
          'success',
          null,
          this.now().toISOString()
        );
        return {
          entries: entries.filter((entry) => dateSet.has(entry.tradeDate)),
          failures: [],
          completedDates: [...completed, ...datesToFetch]
        };
      } catch (error) {
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
        failures.push(`深交所 ${date}：${result.reason.message}`);
        return;
      }
      successfulDates.push(date);
      for (const etf of etfs) {
        const shares = result.value.values.get(etf.code);
        if (Number.isFinite(shares)) {
          entries.push({ code: etf.code, tradeDate: date, shares, source: '深交所' });
        }
      }
    });
    if (successfulDates.length) {
      this.db.markOfficialShareSyncDates(
        'SZSE',
        successfulDates,
        'success',
        null,
        this.now().toISOString()
      );
    }
    return {
      entries,
      failures,
      completedDates: [...completed, ...successfulDates]
    };
  }

  getSummary() {
    const quoteRows = this.db.getLatestSnapshots().map(snapshotToQuote);
    const marketData = quoteRows.map((quote) => {
      const bars = this.db.getBars(quote.code, 520);
      const officialHistory = this.db.getOfficialShareHistory(
        quote.code,
        OFFICIAL_HISTORY_DAYS + 1
      );
      return {
        quote,
        etf: getEtf(quote.code),
        bars,
        shares: officialHistory,
        officialHistory
      };
    });
    const scoreAnalysis = buildSignalObservations(
      marketData.map(({ etf, bars, shares }) => ({ etf, bars, shares }))
    );
    const latestScoreByCode = new Map();
    for (const observation of scoreAnalysis.observations) {
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
      const currentShareRecord = this.db.getShareRecord(quote.code, quote.tradeDate);
      const shares = currentShareRecord?.shares ?? quote.shares;
      const sharesSource = currentShareRecord?.source || '行情快照';
      const previousShareRecord = this.db.getPreviousShareRecord(quote.code, quote.tradeDate);
      const previousShares = previousShareRecord?.shares ?? null;
      const shareDelta = shares !== null && previousShares !== null
        ? shares - previousShares
        : null;
      const latestOfficial = officialHistory.at(-1) || null;
      const officialTradeDates = latestOfficial
        ? this.db.getRecentTradeDates(officialHistory.length, latestOfficial.tradeDate)
        : [];
      const iopv = this.getCurrentIopv(quote.code, bars.at(-1)?.date || null);
      return {
        ...quote,
        shares,
        sharesSource,
        volumeRatio: ratio,
        previousVolumeRatio: previousRatio,
        return5d: periodReturn(quote.price, priorBars.map((bar) => bar.close), 5),
        return20d: periodReturn(quote.price, priorBars.map((bar) => bar.close), 20),
        amountPercentile: percentile(
          quote.amount,
          priorBars.slice(-250).map((bar) => bar.amount)
        ),
        previousShares,
        previousShareDate: previousShareRecord?.tradeDate || null,
        previousShareSource: previousShareRecord?.source || null,
        shareDelta,
        estimatedSubscription: shareDelta !== null && quote.price !== null
          ? shareDelta * quote.price
          : null,
        officialShareDate: latestOfficial?.tradeDate || null,
        officialShareSource: latestOfficial?.source || null,
        officialShareDays: officialHistory.length,
        shareStreak: calculateShareStreak(officialHistory, officialTradeDates),
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
    }).sort((left, right) => {
      if (left.scoreSignal !== right.scoreSignal) return left.scoreSignal ? -1 : 1;
      if ((left.score || 0) !== (right.score || 0)) return (right.score || 0) - (left.score || 0);
      if (left.composite !== right.composite) return left.composite ? -1 : 1;
      return (right.volumeRatio || 0) - (left.volumeRatio || 0);
    });
    const dataTime = quoteRows
      .map((row) => row.dataTime)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const amountRows = rows.filter((row) => Number.isFinite(row.amount));
    return {
      generatedAt: this.now().toISOString(),
      dataTime,
      totalAmount: amountRows.length
        ? amountRows.reduce((sum, row) => sum + row.amount, 0)
        : null,
      amountCoverage: {
        available: amountRows.length,
        total: rows.length
      },
      volumeUpCount: rows.filter((row) => row.volumeRatio !== null && row.volumeRatio >= 2).length,
      shareUpCount: rows.filter((row) => row.shareDelta !== null && row.shareDelta > 0).length,
      compositeCount: rows.filter((row) => row.composite).length,
      scoreSignalCount: rows.filter((row) => row.scoreSignal).length,
      highScoreCount: rows.filter((row) => row.score >= SIGNAL_PARAMETERS.levels.high).length,
      iopvAvailableCount: rows.filter((row) => row.premiumStatus === 'valid').length,
      iopvAbnormalCount: rows.filter((row) => row.premiumAbnormal).length,
      broadResonance,
      etfs: rows,
      logs: this.db.recentLogs()
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
    const etf = getEtf(code);
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
    const etf = getEtf(code);
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
        high: Math.max(...rates),
        low: Math.min(...rates),
        mean: rates.reduce((sum, value) => sum + value, 0) / rates.length,
        latest: rates.at(-1),
        sampleCount: rates.length
      }
      : {
        open: null,
        high: null,
        low: null,
        mean: null,
        latest: null,
        sampleCount: 0
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

  loadBacktestDataset() {
    return ETFS.map((etf) => ({
      etf,
      bars: this.db.getBars(etf.code, 520),
      shares: this.db.getOfficialShareHistory(etf.code, 520)
    }));
  }

  async runSignalBacktest() {
    if (this.backtestPromise) return this.backtestPromise;
    this.backtestPromise = this.performSignalBacktest();
    try {
      return await this.backtestPromise;
    } finally {
      this.backtestPromise = null;
    }
  }

  async performSignalBacktest() {
    const dataset = this.loadBacktestDataset();
    const fingerprint = datasetFingerprint(dataset);
    const existing = this.db.getBacktestRun(SIGNAL_PARAMETERS.version, fingerprint);
    if (existing) return existing;

    const run = buildBacktest(dataset);
    this.db.saveBacktestRun(run, run.events);
    const saved = this.db.getBacktestRun(SIGNAL_PARAMETERS.version, fingerprint);
    this.db.log(
      'backtest',
      'success',
      `信号回测完成：${saved.result.splits.train.signalCount} 个训练期信号，${saved.result.splits.validation.signalCount} 个验证期信号`,
      this.now().toISOString()
    );
    return saved;
  }

  async getBacktestSummary() {
    const run = await this.runSignalBacktest();
    return {
      ...run.result,
      parameterVersion: run.parameterVersion,
      datasetFingerprint: run.datasetFingerprint,
      generatedAt: run.generatedAt,
      run: {
        id: run.id,
        parameterVersion: run.parameterVersion,
        datasetFingerprint: run.datasetFingerprint,
        generatedAt: run.generatedAt,
        status: run.status,
        trainStart: run.trainStart,
        trainEnd: run.trainEnd,
        validationStart: run.validationStart,
        validationEnd: run.validationEnd
      },
      parameters: run.parameters
    };
  }

  async getBacktestEvents(filters = {}) {
    const run = await this.runSignalBacktest();
    return {
      runId: run.id,
      parameterVersion: run.parameterVersion,
      events: this.db.getSignalEvents(run.id, filters)
    };
  }

  async getBacktestEvent(id) {
    await this.runSignalBacktest();
    return this.db.getSignalEvent(id);
  }

  async getIntraday(code) {
    const etf = getEtf(code);
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

function iopvPointIsValid(point) {
  return Number.isFinite(point.marketPrice) &&
    point.marketPrice > 0 &&
    Number.isFinite(point.iopv) &&
    point.iopv > 0 &&
    Number.isFinite(point.premiumRate);
}

