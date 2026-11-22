'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { getMarket } = require('../config/etfs');
const { getOfficialShareAction } = require('../config/etf-share-actions');
const { calculateShareStreak, percentile } = require('./metrics');
const { splitDateRange } = require('./official-shares');
const { shanghaiClock } = require('./trading-calendar');

const MARKET_HISTORY = {
  0: { floor: '2016-11-23', index: '0.399001', source: '深交所', url: 'https://fund.szse.cn/marketdata/fundslist/index.html' },
  1: { floor: '2012-01-04', index: '1.000001', source: '上交所', url: 'https://www.sse.com.cn/market/funddata/volumn/etfvolumn/' }
};

// 上市日已核对。159516 的首条官方记录早于上市日一天，可作为计算基准。
const FIRST_OFFICIAL_DATES = {
  159516: '2023-07-26', 159915: '2016-11-23', 159919: '2016-11-23',
  510050: '2012-01-04', 510300: '2012-05-28', 510500: '2013-03-15',
  512100: '2016-11-04', 512170: '2019-06-17', 512800: '2017-08-03', 512880: '2016-08-08',
  513180: '2021-05-25', 515880: '2019-09-06', 588000: '2020-11-16', 588170: '2025-04-08'
};

const CHECK_COOLDOWN_MS = 7 * 86400000;
const ERROR_COOLDOWN_MS = 15 * 60000;

function isExtendedShareRange(days) {
  return days === 750 || days === 1250 || days === 'all';
}

function yearChunks(from, through) {
  const years = [];
  for (let year = Number(through.slice(0, 4)); year >= Number(from.slice(0, 4)); year -= 1) {
    years.push({
      year,
      startDate: [from, `${year}-01-01`].sort().at(-1),
      endDate: [through, `${year}-12-31`].sort()[0]
    });
  }
  return years;
}

function coveredBy(check, start, end) {
  return check?.status === 'done' && check.from <= start && check.through >= end;
}

function allOfficialSharesAvailable({ coverage, points }) {
  return coverage.calendarComplete && coverage.availableDays === coverage.effectiveDays && points.length > 0 &&
    !points.some((point) => point.estimateGapReason === 'missing_previous_share');
}

function calculateExtendedRange({ code, selectedDays, dates, shares, closes, calendarComplete }) {
  const hasBaseline = Number.isInteger(selectedDays) && dates.length > selectedDays;
  const first = Number(hasBaseline);
  const byShareDate = new Map(shares.map((row) => [row.tradeDate, row]));
  const byCloseDate = new Map(closes.map((row) => [row.date, row.rawClose]));
  let deltaDays = 0;
  let estimatedDays = 0;
  let segment = 0;
  let previousDelta = false;
  let previousEstimated = false;
  let segmentDelta = 0;
  let segmentEstimate = 0;
  let deltaTotal = 0;
  let estimateTotal = 0;
  const points = dates.slice(first).map((date, index) => {
    const current = byShareDate.get(date);
    const previous = byShareDate.get(dates[first + index - 1]);
    const close = byCloseDate.get(date) ?? null;
    const shareAction = getOfficialShareAction(code, date);
    const shareDelta = current && previous && !shareAction ? current.shares - previous.shares : null;
    const estimateGapReason = shareAction ? 'share_split'
      : !current ? 'missing_share'
        : !index && !hasBaseline && calendarComplete ? 'baseline'
          : !previous ? 'missing_previous_share'
            : close === null ? 'missing_price' : null;
    const estimatedSubscription = estimateGapReason ? null : shareDelta * close;
    if (shareDelta !== null) {
      deltaDays += 1;
      deltaTotal += shareDelta;
      if (!previousDelta) segmentDelta = 0;
      segmentDelta += shareDelta;
    }
    if (estimatedSubscription !== null) {
      estimatedDays += 1;
      estimateTotal += estimatedSubscription;
      if (!previousEstimated) {
        segment += 1;
        segmentEstimate = 0;
      }
      segmentEstimate += estimatedSubscription;
    }
    previousEstimated = estimatedSubscription !== null;
    previousDelta = shareDelta !== null;
    return {
      tradeDate: date,
      shares: current?.shares ?? null,
      source: current?.source ?? null,
      fetchedAt: current?.officialFetchedAt ?? null,
      officialFetchedAt: current?.officialFetchedAt ?? null,
      shareDelta,
      close,
      estimatedSubscription,
      cumulativeShareDelta: previousDelta ? segmentDelta : null,
      cumulativeEstimatedSubscription: previousEstimated ? segmentEstimate : null,
      estimatedSegment: previousEstimated ? segment : null,
      estimateGapReason,
      shareActionSourceUrl: shareAction?.sourceUrl ?? null,
      shareAction
    };
  });
  const requestedDays = selectedDays === 'all' ? points.length : selectedDays;
  const effectiveDays = calendarComplete ? points.length : Math.max(requestedDays, points.length);
  const expectedDays = Math.max(0, effectiveDays - (calendarComplete && !hasBaseline ? 1 : 0));
  const missingDates = points.filter((point) => point.shares === null).map((point) => point.tradeDate);
  const availableDays = points.length - missingDates.length;
  const complete = calendarComplete && availableDays === effectiveDays && estimatedDays === expectedDays;
  const startDate = points[0]?.tradeDate || null;
  const endDate = points.at(-1)?.tradeDate || null;
  return {
    days: selectedDays,
    points,
    periodShareDelta: calendarComplete && expectedDays > 0 && deltaDays === expectedDays ? deltaTotal : null,
    periodEstimatedSubscription: calendarComplete && expectedDays > 0 && estimatedDays === expectedDays ? estimateTotal : null,
    shareDeltaDays: deltaDays,
    estimatedDays,
    sharePercentile: percentile(shares.at(-1)?.shares, points.map((point) => point.shares)),
    startDate,
    endDate,
    coverage: {
      requestedDays,
      effectiveDays,
      availableDays,
      shareDeltaDays: deltaDays,
      estimatedDays,
      expectedShareDeltaDays: expectedDays,
      expectedEstimateDays: expectedDays,
      calendarComplete,
      missingDays: effectiveDays - availableDays,
      targetStartDate: startDate,
      targetEndDate: endDate,
      missingRecentDates: missingDates.slice(-5),
      status: !points.length ? 'unavailable' : complete ? 'complete' : 'partial'
    }
  };
}

class ExtendedShareHistory {
  constructor({ db, now, rawCloseProvider, sseShareProvider, szseRangeProvider }) {
    this.db = db;
    this.now = now;
    this.rawCloseProvider = rawCloseProvider;
    this.sseShareProvider = sseShareProvider;
    this.szseRangeProvider = szseRangeProvider;
    this.jobs = new Map();
    this.processing = false;
  }

  readCheck(key) {
    return JSON.parse(this.db.getMeta(`extended-shares:${key}`) || 'null');
  }

  saveCheck(key, check) {
    this.db.setMeta(`extended-shares:${key}`, JSON.stringify({ ...check, checkedAt: this.now().toISOString() }));
  }

  isRecent(check, interval = CHECK_COOLDOWN_MS) {
    return check && this.now().getTime() - Date.parse(check.checkedAt) < interval;
  }

  cooldown(date) {
    return this.now().getTime() - Date.parse(date) < CHECK_COOLDOWN_MS ? 3600000 : CHECK_COOLDOWN_MS;
  }

  getSelection(code, days, endDate) {
    const marketId = getMarket(code);
    const market = MARKET_HISTORY[marketId];
    const lower = FIRST_OFFICIAL_DATES[code] || this.readCheck(`first:${code}`)?.from || market.floor;
    const latestShort = this.db.getOfficialShareHistory(code, 1).at(-1)?.tradeDate;
    const through = endDate || latestShort || shanghaiClock(this.now()).date;
    const shares = this.db.readExtendedShares(code, lower, through);
    const closes = this.db.readExtendedCloses(code, lower, through);
    const marketDates = this.db.readExtendedCloses(market.index, lower, through).map((row) => row.date);
    const dates = [...new Set([
      ...marketDates,
      ...this.db.getRecentTradeDates(520, through).filter((date) => date >= lower),
      ...shares.map((row) => row.tradeDate),
      ...closes.map((row) => row.date)
    ])].sort();
    const selected = days === 'all' ? dates : dates.slice(-(days + 1));
    const from = Number.isInteger(days) && selected.length > days ? selected[0] : lower;
    const calendarComplete = through >= lower && yearChunks(from, through).every((chunk) =>
      coveredBy(this.readCheck(`calendar:${marketId}:${chunk.year}`), chunk.startDate, chunk.endDate)
    );
    return { marketId, market, lower, through, dates: selected, shares, closes, calendarComplete };
  }

  getHistory(code, days) {
    const key = `job:${code}:${days}`;
    const { market, lower, dates, shares, closes, calendarComplete } = this.getSelection(code, days);
    const range = calculateExtendedRange({ code, selectedDays: days, dates, shares, closes, calendarComplete });
    const saved = this.readCheck(key);
    const running = this.jobs.has(key);
    const complete = range.coverage.status === 'complete' || (saved?.status === 'complete' &&
      saved.through === range.endDate && allOfficialSharesAvailable(range));
    const status = running ? 'running' : complete ? 'complete'
      : saved?.status === 'running' || saved?.status === 'complete' ? 'partial' : saved?.status || 'idle';
    const message = status === 'running' ? '正在从最近日期逐批补齐官方份额与不复权收盘'
      : status === 'complete' ? (range.coverage.status === 'complete' ? '已配齐所选区间' : saved.message)
        : status === 'idle' ? '本机可读取已有数据。可在后台补齐该区间。'
          : saved?.status === 'running' ? '上次补数中断，已保存成功批次，可以继续补齐'
            : saved?.message || '区间仍有未取得的记录';
    return {
      code,
      selectedDays: days,
      generatedAt: this.now().toISOString(),
      latestOfficialDate: shares.at(-1)?.tradeDate || null,
      firstOfficialDate: shares[0]?.tradeDate || null,
      officialRecordCount: shares.length,
      source: shares.at(-1)?.source || null,
      sourceName: market.source,
      sourceUrl: market.url,
      historyStartBound: lower,
      note: '按交易日对齐官方总份额与当日不复权收盘；估算在缺口后按连续区间重新累计。',
      streak: calculateShareStreak(shares, dates),
      range,
      backfill: { status, message, completed: range.coverage.availableDays, requested: range.coverage.effectiveDays }
    };
  }

  start(code, days) {
    const key = `job:${code}:${days}`;
    const current = this.getHistory(code, days);
    if (this.jobs.has(key) || current.backfill.status === 'complete') return current;
    this.saveCheck(key, { status: 'running' });
    this.jobs.set(key, { code, days });
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => this.processJobs());
    }
    return this.getHistory(code, days);
  }

  async processJobs() {
    try {
      for (const [key, job] of this.jobs) {
        try {
          await this.fill(job.code, job.days);
          const { range } = this.getHistory(job.code, job.days);
          this.saveCheck(key, {
            status: allOfficialSharesAvailable(range) ? 'complete' : 'partial',
            through: range.endDate,
            message: '可取得的批次已保存。官方未返回、缺价或已知折算日期保留缺口。'
          });
        } catch (error) {
          this.saveCheck(key, { status: 'error', message: `补数未完成：${error.message}` });
        } finally {
          this.jobs.delete(key);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async fill(code, days) {
    const preliminary = this.getSelection(code, days);
    if (!FIRST_OFFICIAL_DATES[code] && !this.readCheck(`first:${code}`)) {
      const { marketId, market, through } = preliminary;
      const rows = await this.rawCloseProvider(`${marketId}.${code}`, market.floor, through, { limit: 10000 });
      if (!rows.length) throw new Error('未取得可用于确定历史起点的不复权日线');
      this.db.saveExtendedCloses(code, rows);
      const storedDate = this.db.getFirstEtfDate(code);
      const from = [rows[0].date, storedDate].filter((date) => date && date >= market.floor).sort()[0];
      this.saveCheck(`first:${code}`, { status: 'done', from });
    }
    const initial = this.getSelection(code, days, preliminary.through);
    const { marketId, market, lower, through } = initial;
    const failures = new Set();
    for (const { year, startDate, endDate } of yearChunks(lower, through)) {
      const selected = this.getSelection(code, days, through);
      if (selected.calendarComplete && selected.dates[0] > endDate) break;
      const calendarKey = `calendar:${marketId}:${year}`;
      const marketStart = [market.floor, `${year}-01-01`].sort().at(-1);
      if (!coveredBy(this.readCheck(calendarKey), marketStart, endDate)) {
        try {
          const rows = await this.rawCloseProvider(market.index, marketStart, endDate);
          if (!rows.length) throw new Error('市场交易日历样本为空');
          this.db.saveExtendedCloses(market.index, rows);
          this.saveCheck(calendarKey, { status: 'done', from: marketStart, through: endDate });
        } catch (error) {
          failures.add(`交易日 ${year}：${error.message}`);
        }
      }
      const window = this.getSelection(code, days, through);
      const dates = window.dates.filter((date) => date >= startDate && date <= endDate);
      if (!dates.length) continue;
      const closeDates = new Set(window.closes.map((row) => row.date));
      const missingCloses = dates.filter((date) => !closeDates.has(date));
      if (missingCloses.length) {
        const priceKey = `close:${code}:${year}`;
        const check = this.readCheck(priceKey);
        const from = missingCloses[0];
        const end = missingCloses.at(-1);
        if (!coveredBy(check, from, end) || !this.isRecent(check, this.cooldown(end))) {
          try {
            const rows = await this.rawCloseProvider(`${marketId}.${code}`, from, end);
            this.db.saveExtendedCloses(code, rows);
            this.saveCheck(priceKey, { status: 'done', from, through: end });
          } catch (error) {
            failures.add(`收盘价 ${year}：${error.message}`);
          }
        }
      }
      const known = new Set(window.shares.map((row) => row.tradeDate));
      const missing = dates.filter((date) => !known.has(date));
      if (marketId === 1) await this.fetchSseDays(code, missing, failures);
      else await this.fetchSzseRanges(code, dates, missing, failures);
    }
    if (failures.size) {
      const details = [...failures];
      throw new Error(`${details.length} 个批次失败，成功批次已保存。${details.slice(0, 2).join('；')}`);
    }
  }

  async fetchSseDays(code, missingDates, failures) {
    const monitoredCodes = new Set([code, ...this.db.getEtfs().filter((etf) => getMarket(etf.code) === 1).map((etf) => etf.code)]);
    for (const date of [...missingDates].reverse()) {
      const key = `sse:${date}`;
      const check = this.readCheck(key);
      if (check?.status === 'error' && this.isRecent(check, ERROR_COOLDOWN_MS)) continue;
      if (check?.codes?.includes(code) && this.isRecent(check, this.cooldown(date))) continue;
      try {
        const rows = await this.sseShareProvider(date);
        const entries = [...monitoredCodes].filter((monitoredCode) => rows.has(monitoredCode)).map((monitoredCode) => ({
          code: monitoredCode, tradeDate: date, shares: rows.get(monitoredCode), source: '上交所'
        }));
        this.db.saveExtendedShares(entries, this.now().toISOString());
        this.saveCheck(key, { status: rows.size ? 'done' : 'empty', codes: [...new Set([...(check?.codes || []), ...monitoredCodes])] });
      } catch (error) {
        failures.add(`上交所 ${date}：${error.message}`);
        this.saveCheck(key, { status: 'error' });
      }
      await delay(250);
    }
  }

  async fetchSzseRanges(code, dates, missingDates, failures) {
    if (!missingDates.length) return;
    for (const { startDate, endDate } of splitDateRange(dates[0], dates.at(-1)).reverse()) {
      if (!missingDates.some((date) => date >= startDate && date <= endDate)) continue;
      const key = `szse:${code}:${startDate}:${endDate}`;
      const check = this.readCheck(key);
      if (this.isRecent(check, check?.status === 'error' ? ERROR_COOLDOWN_MS : this.cooldown(endDate))) continue;
      try {
        const rows = await this.szseRangeProvider([code], startDate, endDate);
        this.db.saveExtendedShares(rows, this.now().toISOString());
        this.saveCheck(key, { status: rows.length ? 'done' : 'empty' });
      } catch (error) {
        failures.add(`深交所 ${startDate} 至 ${endDate}：${error.message}`);
        this.saveCheck(key, { status: 'error' });
      }
    }
  }
}

module.exports = { ExtendedShareHistory, isExtendedShareRange, calculateExtendedRange };
