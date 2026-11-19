'use strict';

const { unzipSync, strFromU8 } = require('fflate');

const SSE_URL = 'https://query.sse.com.cn/commonQuery.do';
const SZSE_URL = 'https://fund.szse.cn/api/report/ShowReport';

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

function parseSseShares(data) {
  const result = new Map();
  for (const row of data.result || []) {
    const shares = Math.round(Number(row.TOT_VOL) * 10000);
    if (row.SEC_CODE && Number.isFinite(shares)) result.set(String(row.SEC_CODE), shares);
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
  return parseSseShares(await response.json());
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
  return Number.isFinite(shares) ? shares : null;
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

module.exports = {
  parseSseShares,
  fetchSseEtfShares,
  parseWorksheetRows,
  parseSzseWorkbook,
  extractSzseShare,
  fetchSzseEtfShares
};

