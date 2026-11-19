'use strict';

const { getMarket } = require('../config/etfs');
const { isTradingSession } = require('./scheduler');

const IOPV_ALERT_THRESHOLD = 0.01;
const CROSS_CHECK_TOLERANCE = 0.001;
const CROSS_CHECK_MAX_GAP_SECONDS = 90;
const INTRADAY_STALE_MS = 3 * 60 * 1000;
const GENERAL_STALE_MS = 72 * 60 * 60 * 1000;

const SSE_HOST = 'http://yunhq.sse.com.cn:32041';
const SZSE_URL = 'https://fund.szse.cn/api/market/ssjjhq/getTimeData';
const EASTMONEY_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

const shanghaiPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function calculatePremiumRate(marketPrice, iopv) {
  if (
    !Number.isFinite(marketPrice) ||
    !Number.isFinite(iopv) ||
    marketPrice <= 0 ||
    iopv <= 0
  ) {
    return null;
  }
  return marketPrice / iopv - 1;
}

function shanghaiParts(date) {
  return Object.fromEntries(
    shanghaiPartsFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

function dateTimeFromIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = shanghaiParts(date);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

function parseClock(value) {
  const digits = String(value ?? '').replace(/\D/g, '').padStart(6, '0').slice(-6);
  if (digits.length !== 6) return null;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
}

function parseCompactDate(value) {
  const text = String(value ?? '');
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function sourceDateTimeToIso(tradeDate, dataTime) {
  if (!tradeDate || !dataTime) return null;
  const date = new Date(`${tradeDate}T${dataTime}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function requestJson(url, { headers = {}, timeout = 8000 } = {}) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*',
      ...headers
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseSseIopv(etf, body) {
  if (!Array.isArray(body?.snap) || body.snap.length < 13) {
    throw new Error('上交所 IOPV 响应缺少必要字段');
  }
  const [code, name, marketPrice, , open, high, low, , , iopv, , compactDate, compactTime] =
    body.snap;
  const tradeDate = parseCompactDate(compactDate ?? body.date);
  const dataTime = parseClock(compactTime ?? body.time);
  if (code !== etf.code || !tradeDate || !dataTime) {
    throw new Error('上交所 IOPV 响应时间或代码无法解析');
  }
  const observedAt = sourceDateTimeToIso(tradeDate, dataTime);
  return {
    code: etf.code,
    name: name || etf.name,
    marketPrice: Number(marketPrice),
    iopv: Number(iopv),
    tradeDate,
    dataTime: `${tradeDate} ${dataTime}`,
    observedAt,
    source: '上交所',
    sourceKind: 'official',
    sourceUrl: `http://www.sse.com.cn/assortment/stock/list/info/company/index.shtml?COMPANY_CODE=${etf.code}`,
    extra: {
      open: Number(open),
      high: Number(high),
      low: Number(low)
    }
  };
}

async function fetchSseIopv(etf) {
  const fields = [
    'code', 'name', 'last', 'prev_close', 'open', 'high', 'low',
    'volume', 'amount', 'iopv', 'tradephase', 'date', 'time'
  ].join(',');
  const body = await requestJson(
    `${SSE_HOST}/v1/sh1/snap/${etf.code}?select=${fields}`,
    { headers: { Referer: 'http://www.sse.com.cn/' } }
  );
  return parseSseIopv(etf, body);
}

function parseSzseIopv(etf, body) {
  const data = body?.data;
  if (body?.code !== '0' || !data?.code) {
    throw new Error(body?.message || '深交所 IOPV 响应异常');
  }
  const marketTime = String(data.marketTime || '');
  const match = marketTime.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) throw new Error('深交所 IOPV 响应时间无法解析');
  const [, tradeDate, dataTime] = match;
  const iopv = Number(data.netValue);
  const marketPrice = Number(data.now);
  const prices = new Map(
    (data.picupdata || []).map((row) => [
      String(row[0]),
      Number(row[1])
    ])
  );
  const series = (data.piciopv || []).flatMap((row) => {
    const clock = String(row[0]);
    const pointIopv = Number(row[1]);
    const pointPrice = prices.get(clock);
    if (
      !/^\d{2}:\d{2}$/.test(clock) ||
      !Number.isFinite(pointIopv) ||
      pointIopv <= 0 ||
      !Number.isFinite(pointPrice) ||
      pointPrice <= 0
    ) {
      return [];
    }
    const pointTime = `${clock}:00`;
    return [{
      code: etf.code,
      tradeDate,
      dataTime: `${tradeDate} ${pointTime}`,
      observedAt: sourceDateTimeToIso(tradeDate, pointTime),
      marketPrice: pointPrice,
      iopv: pointIopv,
      premiumRate: calculatePremiumRate(pointPrice, pointIopv)
    }];
  });
  return {
    code: etf.code,
    name: data.name || etf.name,
    marketPrice,
    iopv,
    tradeDate,
    dataTime: `${tradeDate} ${dataTime}`,
    observedAt: sourceDateTimeToIso(tradeDate, dataTime),
    source: '深交所',
    sourceKind: 'official',
    sourceUrl: `https://fund.szse.cn/marketdata/trade/index.html?code=${etf.code}`,
    series
  };
}

async function fetchSzseIopv(etf) {
  const body = await requestJson(
    `${SZSE_URL}?marketId=1&code=${etf.code}`,
    { headers: { Referer: `https://fund.szse.cn/marketdata/trade/index.html?code=${etf.code}` } }
  );
  return parseSzseIopv(etf, body);
}

function fetchOfficialIopv(etf) {
  return getMarket(etf.code) === 1 ? fetchSseIopv(etf) : fetchSzseIopv(etf);
}

function parseEastmoneyIopvList(body) {
  const rows = body?.data?.diff;
  if (!Array.isArray(rows)) throw new Error('东方财富 IOPV 补充源响应异常');
  return new Map(rows.map((row) => {
    const observedAt = Number.isFinite(Number(row.f124))
      ? new Date(Number(row.f124) * 1000).toISOString()
      : null;
    const parts = dateTimeFromIso(observedAt);
    return [String(row.f12), {
      code: String(row.f12),
      name: row.f14 || String(row.f12),
      marketPrice: Number(row.f2),
      iopv: Number(row.f441),
      tradeDate: parts?.date || parseCompactDate(row.f297),
      dataTime: parts ? `${parts.date} ${parts.time}` : null,
      observedAt,
      source: '东方财富（补充）',
      sourceKind: 'supplementary',
      sourceUrl: `https://quote.eastmoney.com/${String(row.f12)}.html`
    }];
  }));
}

async function fetchSupplementaryIopv(etfs) {
  const secids = etfs.map((etf) => `${getMarket(etf.code)}.${etf.code}`).join(',');
  const fields = 'f12,f13,f14,f2,f441,f402,f124,f297';
  const body = await requestJson(
    `${EASTMONEY_URL}?fltt=2&invt=2&fields=${fields}&secids=${secids}`,
    { headers: { Referer: 'https://quote.eastmoney.com/' } }
  );
  return parseEastmoneyIopvList(body);
}

function crossCheckIopv(primary, secondary, {
  tolerance = CROSS_CHECK_TOLERANCE,
  maxGapSeconds = CROSS_CHECK_MAX_GAP_SECONDS
} = {}) {
  if (!secondary) {
    return { status: 'unavailable', message: '补充源未返回该 ETF', secondaryIopv: null };
  }
  const primaryTime = new Date(primary.observedAt).getTime();
  const secondaryTime = new Date(secondary.observedAt).getTime();
  const gapSeconds = Number.isFinite(primaryTime) && Number.isFinite(secondaryTime)
    ? Math.abs(primaryTime - secondaryTime) / 1000
    : null;
  const relativeDifference = Number.isFinite(primary.iopv) &&
    Number.isFinite(secondary.iopv) &&
    primary.iopv > 0
    ? Math.abs(primary.iopv - secondary.iopv) / primary.iopv
    : null;
  const aligned = primary.tradeDate === secondary.tradeDate &&
    gapSeconds !== null &&
    gapSeconds <= maxGapSeconds;
  if (aligned && relativeDifference !== null && relativeDifference > tolerance) {
    return {
      status: 'conflict',
      message: `官方与补充源 IOPV 相差 ${(relativeDifference * 100).toFixed(3)}%`,
      secondaryIopv: secondary.iopv,
      secondaryDataTime: secondary.dataTime,
      relativeDifference,
      gapSeconds
    };
  }
  return {
    status: aligned ? 'matched' : 'unaligned',
    message: aligned
      ? '时间已对齐，IOPV 在容差内'
      : '来源时间无法可靠对齐，保留官方值且不合并',
    secondaryIopv: Number.isFinite(secondary.iopv) ? secondary.iopv : null,
    secondaryDataTime: secondary.dataTime || null,
    relativeDifference,
    gapSeconds
  };
}

function resolveIopvState(record, {
  now = new Date(),
  latestTradeDate = null,
  refreshFailed = false,
  tradingSession = false
} = {}) {
  if (!record) {
    return { status: 'missing', label: '暂无', message: '尚无有效 IOPV 记录', premiumRate: null };
  }
  if (!Number.isFinite(record.iopv) || record.iopv === null) {
    return { ...record, status: 'missing', label: '暂无', message: record.message || 'IOPV 缺失', premiumRate: null };
  }
  if (record.iopv <= 0) {
    return { ...record, status: 'zero', label: '数据异常', message: 'IOPV 为 0 或负值，禁止计算', premiumRate: null };
  }
  if (!Number.isFinite(record.marketPrice) || record.marketPrice <= 0) {
    return { ...record, status: 'invalid', label: '数据异常', message: '市场价缺失或无效', premiumRate: null };
  }
  if (record.crossCheck?.status === 'conflict' || record.status === 'conflict') {
    return {
      ...record,
      status: 'conflict',
      label: '数据异常',
      message: record.crossCheck?.message || record.message || 'IOPV 来源冲突',
      premiumRate: null
    };
  }
  if (record.status === 'stale') {
    return {
      ...record,
      status: 'stale',
      label: '数据过期',
      message: record.message || '数据源降级，保留最后有效值',
      premiumRate: null
    };
  }
  const observedAt = record.observedAt ? new Date(record.observedAt) : null;
  const observedMs = observedAt?.getTime();
  const nowMs = now.getTime();
  if (record.tradeDate && latestTradeDate && record.tradeDate < latestTradeDate) {
    return {
      ...record,
      status: 'stale',
      label: '数据过期',
      message: `IOPV 日期 ${record.tradeDate} 早于最新交易日 ${latestTradeDate}`,
      premiumRate: null
    };
  }
  if (refreshFailed) {
    return {
      ...record,
      status: 'stale',
      label: '数据过期',
      message: '本轮数据源降级，保留最后有效值',
      premiumRate: null
    };
  }
  if (Number.isFinite(observedMs)) {
    if (observedMs - nowMs > 2 * 60 * 1000) {
      return {
        ...record,
        status: 'invalid',
        label: '数据异常',
        message: 'IOPV 发布时间晚于当前时间',
        premiumRate: null
      };
    }
    const age = nowMs - observedMs;
    if (tradingSession && age > INTRADAY_STALE_MS) {
      return {
        ...record,
        status: 'stale',
        label: '数据过期',
        message: '盘中 IOPV 已超过 3 分钟未更新',
        premiumRate: null
      };
    }
    if (age > GENERAL_STALE_MS) {
      return {
        ...record,
        status: 'stale',
        label: '数据过期',
        message: 'IOPV 已超过 72 小时未更新',
        premiumRate: null
      };
    }
  }
  const premiumRate = calculatePremiumRate(record.marketPrice, record.iopv);
  if (premiumRate === null) {
    return { ...record, status: 'invalid', label: '数据异常', message: '折溢价无法计算', premiumRate: null };
  }
  return {
    ...record,
    status: 'valid',
    label: '正常',
    message: record.crossCheck?.status === 'unaligned'
      ? '官方值有效；补充源时间未对齐，未合并'
      : 'IOPV 与市场价有效',
    premiumRate,
    isAbnormal: Math.abs(premiumRate) >= IOPV_ALERT_THRESHOLD
  };
}

function dedupeIopvSeries(rows) {
  const byTime = new Map();
  for (const row of rows) {
    const existing = byTime.get(row.dataTime);
    if (!existing || (existing.sourceKind !== 'official' && row.sourceKind === 'official')) {
      byTime.set(row.dataTime, row);
    }
  }
  return [...byTime.values()].sort((left, right) => left.dataTime.localeCompare(right.dataTime));
}

module.exports = {
  IOPV_ALERT_THRESHOLD,
  CROSS_CHECK_TOLERANCE,
  calculatePremiumRate,
  parseSseIopv,
  parseSzseIopv,
  parseEastmoneyIopvList,
  fetchSseIopv,
  fetchSzseIopv,
  fetchOfficialIopv,
  fetchSupplementaryIopv,
  crossCheckIopv,
  resolveIopvState,
  dedupeIopvSeries,
  dateTimeFromIso,
  sourceDateTimeToIso
};
