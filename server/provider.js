'use strict';

const { getMarket } = require('../config/etfs');
const { scale } = require('./metrics');
const { shanghaiClock } = require('./trading-calendar');

const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com'
];
const HISTORY_HOST = 'https://push2his.eastmoney.com';
const SEARCH_HOST = 'https://searchadapter.eastmoney.com';

function parseOptionalNumber(value, { nonNegative = false } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === '-' || text.toLowerCase() === 'nan') return null;
  const number = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(number) || (nonNegative && number < 0)) return null;
  return number;
}

async function fetchJson(url, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Referer: 'https://quote.eastmoney.com/',
          Accept: 'application/json,text/plain,*/*'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.rc !== 0 || !body.data) throw new Error(`行情接口返回异常: rc=${body.rc}`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function parseQuote(etf, data) {
  const decimals = Number(data.f59 ?? 3);
  const price = scale(data.f43, decimals);
  const previousClose = scale(data.f60, decimals);
  const change = scale(data.f169, decimals);
  return {
    code: etf.code,
    name: data.f58 || etf.name,
    category: etf.category,
    tone: etf.tone,
    price,
    previousClose,
    change: change ?? (price !== null && previousClose !== null ? price - previousClose : null),
    changePercent: scale(data.f170, 2),
    open: scale(data.f46, decimals),
    high: scale(data.f44, decimals),
    low: scale(data.f45, decimals),
    volume: parseOptionalNumber(data.f47, { nonNegative: true }),
    amount: parseOptionalNumber(data.f48, { nonNegative: true }),
    turnoverRate: scale(data.f168, 2),
    shares: parseOptionalNumber(data.f84, { nonNegative: true }),
    marketValue: parseOptionalNumber(data.f116, { nonNegative: true }),
    timestamp: parseOptionalNumber(data.f86, { nonNegative: true })
  };
}

async function fetchQuote(etf) {
  const secid = `${getMarket(etf.code)}.${etf.code}`;
  const fields = 'f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f84,f85,f86,f116,f168,f169,f170';
  let lastError;
  for (const host of QUOTE_HOSTS) {
    try {
      const data = await fetchJson(`${host}/api/qt/stock/get?secid=${secid}&fields=${fields}`);
      return parseQuote(etf, data);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function lookupEtf(code) {
  const url = `${SEARCH_HOST}/api/suggest/get?input=${encodeURIComponent(code)}&type=14&count=20`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://quote.eastmoney.com/',
      Accept: 'application/json,text/plain,*/*'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`ETF 查询接口 HTTP ${response.status}`);
  const body = await response.json();
  const rows = body?.QuotationCodeTable?.Data;
  const candidates = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const match = candidates.find((row) => (
    row.Code === code &&
    ['1', '0'].includes(String(row.MktNum)) &&
    row.QuoteID
  ));
  if (!match) return null;
  return {
    code: match.Code,
    name: match.Name,
    market: Number(match.MktNum),
    exchange: Number(match.MktNum) === 1 ? '上交所' : '深交所',
    securityType: match.SecurityTypeName || '基金'
  };
}

function parseKlines(etf, data) {
  return (data.klines || []).map((row) => {
    const [date, open, close, high, low, volume, amount, amplitude, pctChange, change, turnoverRate] =
      row.split(',');
    return {
      code: etf.code,
      date,
      open: parseOptionalNumber(open),
      close: parseOptionalNumber(close),
      high: parseOptionalNumber(high),
      low: parseOptionalNumber(low),
      volume: parseOptionalNumber(volume, { nonNegative: true }),
      amount: parseOptionalNumber(amount, { nonNegative: true }),
      amplitude: parseOptionalNumber(amplitude, { nonNegative: true }),
      changePercent: parseOptionalNumber(pctChange),
      change: parseOptionalNumber(change),
      turnoverRate: parseOptionalNumber(turnoverRate, { nonNegative: true })
    };
  });
}

async function fetchKlines(etf, limit = 520) {
  const secid = `${getMarket(etf.code)}.${etf.code}`;
  const fields1 = 'f1,f2,f3,f4,f5,f6';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const url = `${HISTORY_HOST}/api/qt/stock/kline/get?secid=${secid}&klt=101&lmt=${limit}&end=20500101&fields1=${fields1}&fields2=${fields2}`;
  const [adjusted, raw] = await Promise.all([
    fetchJson(`${url}&fqt=1`).then((data) => parseKlines(etf, data)),
    fetchJson(`${url}&fqt=0`).then((data) => parseKlines(etf, data)).catch(() => [])
  ]);
  const { date, minute } = shanghaiClock();
  const rawCloses = new Map(raw.filter((bar) => bar.close > 0 &&
    (bar.date < date || (bar.date === date && minute >= '15:00'))).map((bar) => [bar.date, bar.close]));
  return adjusted.filter((bar) => bar.close > 0).map((bar) => ({ ...bar, rawClose: rawCloses.get(bar.date) ?? null }));
}

function parseTrends(etf, data) {
  return (data.trends || []).map((row) => {
    const [time, price, average, volume, amount] = row.split(',');
    return {
      code: etf.code,
      time,
      price: parseOptionalNumber(price),
      average: parseOptionalNumber(average),
      volume: parseOptionalNumber(volume, { nonNegative: true }),
      amount: parseOptionalNumber(amount, { nonNegative: true })
    };
  });
}

async function fetchTrends(etf) {
  const secid = `${getMarket(etf.code)}.${etf.code}`;
  const url = `${HISTORY_HOST}/api/qt/stock/trends2/get?secid=${secid}&ndays=1&iscr=0&iscca=0&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
  return parseTrends(etf, await fetchJson(url));
}

module.exports = {
  parseOptionalNumber,
  fetchJson,
  parseQuote,
  fetchQuote,
  lookupEtf,
  parseKlines,
  fetchKlines,
  parseTrends,
  fetchTrends
};

