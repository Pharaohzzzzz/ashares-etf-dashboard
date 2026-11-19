'use strict';

const { getMarket } = require('../config/etfs');
const { scale } = require('./metrics');

const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com'
];
const HISTORY_HOST = 'https://push2his.eastmoney.com';

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
    volume: Number(data.f47) || 0,
    amount: Number(data.f48) || 0,
    turnoverRate: scale(data.f168, 2),
    shares: Number(data.f84) || null,
    marketValue: Number(data.f116) || null,
    timestamp: Number(data.f86) || null
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

function parseKlines(etf, data) {
  return (data.klines || []).map((row) => {
    const [date, open, close, high, low, volume, amount, amplitude, pctChange, change, turnoverRate] =
      row.split(',');
    return {
      code: etf.code,
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      amplitude: Number(amplitude),
      changePercent: Number(pctChange),
      change: Number(change),
      turnoverRate: Number(turnoverRate)
    };
  });
}

async function fetchKlines(etf, limit = 520) {
  const secid = `${getMarket(etf.code)}.${etf.code}`;
  const fields1 = 'f1,f2,f3,f4,f5,f6';
  const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  const url = `${HISTORY_HOST}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${limit}&end=20500101&fields1=${fields1}&fields2=${fields2}`;
  return parseKlines(etf, await fetchJson(url));
}

function parseTrends(etf, data) {
  return (data.trends || []).map((row) => {
    const [time, price, average, volume, amount] = row.split(',');
    return {
      code: etf.code,
      time,
      price: Number(price),
      average: Number(average),
      volume: Number(volume),
      amount: Number(amount)
    };
  });
}

async function fetchTrends(etf) {
  const secid = `${getMarket(etf.code)}.${etf.code}`;
  const url = `${HISTORY_HOST}/api/qt/stock/trends2/get?secid=${secid}&ndays=1&iscr=0&iscca=0&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
  return parseTrends(etf, await fetchJson(url));
}

module.exports = {
  fetchJson,
  parseQuote,
  fetchQuote,
  parseKlines,
  fetchKlines,
  parseTrends,
  fetchTrends
};

