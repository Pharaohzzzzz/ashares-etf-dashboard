'use strict';

const { unzipSync, strFromU8 } = require('fflate');

const SSE_URL = 'https://query.sse.com.cn/commonQuery.do';
const SZSE_URL = 'https://fund.szse.cn/api/report/ShowReport';
const SZSE_RANGE_DAYS = 90;

async function fetchWithRetry(url, options, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function parseSseShares(data, tradeDate = null) {
  const result = new Map();
  for (const row of data.result || []) {
    if (tradeDate && row.STAT_DATE !== tradeDate) continue;
    const shares = Math.round(Number(row.TOT_VOL) * 10000);
    if (row.SEC_CODE && Number.isFinite(shares) && shares > 0) {
      result.set(String(row.SEC_CODE), shares);
    }
  }
  return result;
}

async function fetchSseEtfShares(tradeDate) {
  const body = new URLSearchParams({
    isPagination: 'true',
    'pageHelp.pageSize': '10000',
    'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1',
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': '1',
    sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',
    STAT_DATE: tradeDate
  });
  const response = await fetchWithRetry(SSE_URL, {
    method: 'POST',
    headers: {
      Referer: 'https://www.sse.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const data = await response.json();
  if (!Array.isArray(data.result)) throw new Error('上交所份额响应缺少数据列表');
  if (data.result.length && !data.result.every((row) => row.STAT_DATE === tradeDate)) {
    throw new Error('上交所返回的份额日期与请求不一致');
  }
  return parseSseShares(data, tradeDate);
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function parseWorksheetRows(xml) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const content = cellMatch[2];
      const type = attributes.match(/\bt="([^"]+)"/)?.[1];
      let value = '';
      if (type === 'inlineStr') {
        value = [...content.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((match) => decodeXml(match[1]))
          .join('');
      } else {
        value = decodeXml(content.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
      }
      values.push(value.trim());
    }
    if (values.length) rows.push(values);
  }
  return rows;
}

function parseSzseWorkbook(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const sheetName = Object.keys(files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new Error('深交所份额文件缺少工作表');
  return parseWorksheetRows(strFromU8(files[sheetName]));
}

function extractSzseShare(rows, code, tradeDate) {
  const match = rows.find((row) => row[0] === tradeDate && row[1]?.trim() === code);
  if (!match) return null;
  const shares = Number(String(match[3]).replaceAll(',', ''));
  return Number.isFinite(shares) && shares > 0 ? shares : null;
}

function splitDateRange(startDate, endDate, maxDays = SZSE_RANGE_DAYS) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end ||
    !Number.isInteger(maxDays) ||
    maxDays < 1
  ) {
    throw new Error('无效的深交所份额查询日期范围');
  }
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(
      cursor.getTime() + (maxDays - 1) * 86400000,
      end.getTime()
    ));
    chunks.push({
      startDate: cursor.toISOString().slice(0, 10),
      endDate: chunkEnd.toISOString().slice(0, 10)
    });
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

function extractSzseShareRange(rows, codes, startDate, endDate) {
  const codeSet = new Set(codes);
  return rows.flatMap((row) => {
    const tradeDate = row[0]?.trim();
    const code = row[1]?.trim();
    if (
      !codeSet.has(code) ||
      !tradeDate ||
      tradeDate < startDate ||
      tradeDate > endDate
    ) {
      return [];
    }
    const shares = Number(String(row[3]).replaceAll(',', ''));
    return Number.isFinite(shares) && shares > 0
      ? [{ code, tradeDate, shares, source: '深交所' }]
      : [];
  });
}

async function fetchSzseEtfShares(codes, tradeDate) {
  const result = new Map();
  for (const code of codes) {
    const query = new URLSearchParams({
      SHOWTYPE: 'xlsx',
      CATALOGID: 'fund_jjgm',
      TABKEY: 'tab1',
      txtDm: code,
      txtStart: tradeDate,
      txtEnd: tradeDate
    });
    const response = await fetchWithRetry(`${SZSE_URL}?${query}`, {
      headers: {
        Referer: 'https://fund.szse.cn/marketdata/fundslist/index.html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    const rows = parseSzseWorkbook(await response.arrayBuffer());
    const shares = extractSzseShare(rows, code, tradeDate);
    if (shares !== null) result.set(code, shares);
  }
  return result;
}

async function fetchSzseEtfShareRange(codes, startDate, endDate) {
  if (!codes.length) return [];
  const entries = [];
  for (const chunk of splitDateRange(startDate, endDate)) {
    const query = new URLSearchParams({
      SHOWTYPE: 'xlsx',
      CATALOGID: 'fund_jjgm',
      TABKEY: 'tab1',
      txtStart: chunk.startDate,
      txtEnd: chunk.endDate
    });
    const response = await fetchWithRetry(`${SZSE_URL}?${query}`, {
      headers: {
        Referer: 'https://fund.szse.cn/marketdata/fundslist/index.html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    const rows = parseSzseWorkbook(await response.arrayBuffer());
    entries.push(...extractSzseShareRange(
      rows,
      codes,
      chunk.startDate,
      chunk.endDate
    ));
  }
  return entries;
}

module.exports = {
  parseSseShares,
  fetchSseEtfShares,
  parseWorksheetRows,
  parseSzseWorkbook,
  extractSzseShare,
  fetchSzseEtfShares,
  splitDateRange,
  extractSzseShareRange,
  fetchSzseEtfShareRange
};

