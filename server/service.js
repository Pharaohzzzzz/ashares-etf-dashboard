'use strict';

const { ETFS, getEtf } = require('../config/etfs');
const {
  volumeRatio,
  percentile,
  periodReturn,
  calculateSignals
} = require('./metrics');
const { fetchQuote, fetchKlines, fetchTrends } = require('./provider');

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
    now = () => new Date()
  }) {
    this.db = db;
    this.quoteProvider = quoteProvider;
    this.klineProvider = klineProvider;
    this.trendProvider = trendProvider;
    this.now = now;
    this.refreshPromise = null;
    this.initializing = false;
    this.initializedAt = db.getMeta('initializedAt');
  }

  async initialize({ force = false } = {}) {
    if (this.initializing) return;
    this.initializing = true;
    this.db.log('startup', 'running', '开始同步两年日线与实时行情', this.now().toISOString());
    try {
      await mapLimit(ETFS, 4, async (etf) => {
        const count = this.db.countBars(etf.code);
        if (!force && count >= 250) return;
        const bars = await this.klineProvider(etf, 520);
        this.db.upsertBars(etf.code, bars);
      });
      await this.refreshQuotes();
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
    const summary = this.getSummary();
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
          updatedAt: capturedAt
        });
      }
    }
    return summary;
  }

  getSummary() {
    const quoteRows = this.db.getLatestSnapshots().map(snapshotToQuote);
    const baseRows = quoteRows.map((quote) => {
      const bars = this.db.getBars(quote.code, 520);
      const priorBars = bars.filter((bar) => bar.date < quote.tradeDate);
      const ratio = volumeRatio(
        quote.amount,
        priorBars.slice(-20).map((bar) => bar.amount)
      );
      const priorDayBar = priorBars.at(-1);
      const previousRatio = priorDayBar
        ? volumeRatio(priorDayBar.amount, priorBars.slice(-21, -1).map((bar) => bar.amount))
        : null;
      const previousShares = this.db.getPreviousShares(quote.code, quote.tradeDate);
      const shareDelta = quote.shares !== null && previousShares !== null
        ? quote.shares - previousShares
        : null;
      return {
        ...quote,
        volumeRatio: ratio,
        previousVolumeRatio: previousRatio,
        return5d: periodReturn(quote.price, priorBars.slice(-5).map((bar) => bar.close)),
        return20d: periodReturn(quote.price, priorBars.slice(-20).map((bar) => bar.close)),
        amountPercentile: percentile(
          quote.amount,
          priorBars.slice(-250).map((bar) => bar.amount)
        ),
        previousShares,
        shareDelta,
        estimatedSubscription: shareDelta !== null && quote.price !== null
          ? shareDelta * quote.price
          : null,
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
      return {
        ...row,
        broadResonance,
        signals: result.signals,
        composite: result.composite
      };
    }).sort((left, right) => {
      if (left.composite !== right.composite) return left.composite ? -1 : 1;
      return (right.volumeRatio || 0) - (left.volumeRatio || 0);
    });
    const dataTime = quoteRows
      .map((row) => row.dataTime)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return {
      generatedAt: this.now().toISOString(),
      dataTime,
      totalAmount: rows.reduce((sum, row) => sum + (row.amount || 0), 0),
      volumeUpCount: rows.filter((row) => row.volumeRatio !== null && row.volumeRatio >= 2).length,
      shareUpCount: rows.filter((row) => row.shareDelta !== null && row.shareDelta > 0).length,
      compositeCount: rows.filter((row) => row.composite).length,
      broadResonance,
      etfs: rows,
      logs: this.db.recentLogs()
    };
  }

  getDetail(code) {
    const summary = this.getSummary();
    const quote = summary.etfs.find((row) => row.code === code);
    if (!quote) return null;
    return {
      quote,
      bars: this.db.getBars(code, 520),
      updatedAt: summary.generatedAt
    };
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

