'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const {
  parseSseShares,
  parseWorksheetRows,
  parseSzseWorkbook,
  extractSzseShare,
  splitDateRange,
  extractSzseShareRange
} = require('../server/official-shares');

const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>日期</t></is></c>
      <c r="B1" t="inlineStr"><is><t>基金代码</t></is></c>
      <c r="C1" t="inlineStr"><is><t>基金简称</t></is></c>
      <c r="D1" t="inlineStr"><is><t>基金规模(份)</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>2026-11-19</t></is></c>
      <c r="B2" t="inlineStr"><is><t>159919</t></is></c>
      <c r="C2" t="inlineStr"><is><t>沪深300ETF嘉实</t></is></c>
      <c r="D2" t="inlineStr"><is><t>16186716676.00</t></is></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>2026-11-18</t></is></c>
      <c r="B3" t="inlineStr"><is><t>159919</t></is></c>
      <c r="C3" t="inlineStr"><is><t>沪深300ETF嘉实</t></is></c>
      <c r="D3" t="inlineStr"><is><t>14191416676.00</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

test('parseSseShares converts ten-thousand share units', () => {
  const shares = parseSseShares({
    result: [{ SEC_CODE: '510300', TOT_VOL: '4968408.77' }]
  });
  assert.equal(shares.get('510300'), 49684087700);
});

test('parseWorksheetRows reads inline string cells', () => {
  const rows = parseWorksheetRows(worksheet);
  assert.deepEqual(rows[1], ['2026-11-19', '159919', '沪深300ETF嘉实', '16186716676.00']);
});

test('parseSzseWorkbook extracts the requested historical share value', () => {
  const zip = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(worksheet)
  });
  const rows = parseSzseWorkbook(zip);
  assert.equal(extractSzseShare(rows, '159919', '2026-11-18'), 14191416676);
  assert.equal(extractSzseShare(rows, '159919', '2026-11-17'), null);
});

test('splitDateRange respects the official API range limit', () => {
  assert.deepEqual(splitDateRange('2025-11-20', '2026-11-19', 90), [
    { startDate: '2025-11-20', endDate: '2026-02-17' },
    { startDate: '2026-02-18', endDate: '2026-05-18' },
    { startDate: '2026-05-19', endDate: '2026-08-16' },
    { startDate: '2026-08-17', endDate: '2026-11-14' },
    { startDate: '2026-11-15', endDate: '2026-11-19' }
  ]);
});

test('extractSzseShareRange filters selected ETFs and dates', () => {
  const rows = parseWorksheetRows(worksheet);
  assert.deepEqual(extractSzseShareRange(
    rows,
    ['159919'],
    '2026-11-18',
    '2026-11-19'
  ), [
    { code: '159919', tradeDate: '2026-11-19', shares: 16186716676, source: '深交所' },
    { code: '159919', tradeDate: '2026-11-18', shares: 14191416676, source: '深交所' }
  ]);
});
