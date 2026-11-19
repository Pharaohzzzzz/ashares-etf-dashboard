'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuote, parseKlines, parseTrends } = require('../server/provider');

const etf = { code: '510300', name: '沪深300ETF华泰柏瑞', category: '宽基核心', tone: 'broad' };

test('parseQuote applies market decimal scaling', () => {
  const quote = parseQuote(etf, {
    f43: 4060,
    f44: 4072,
    f45: 4013,
    f46: 4046,
    f47: 27909417,
    f48: 11293465472,
    f58: '沪深300ETF华泰柏瑞',
    f59: 3,
    f60: 4058,
    f84: 49684087808,
    f86: 1795075898,
    f168: 562,
    f169: 2,
    f170: 5
  });
  assert.equal(quote.price, 4.06);
  assert.equal(quote.previousClose, 4.058);
  assert.equal(quote.change, 0.002);
  assert.equal(quote.changePercent, 0.05);
  assert.equal(quote.turnoverRate, 5.62);
  assert.equal(quote.shares, 49684087808);
});

test('parseKlines converts CSV rows to ascending daily bars', () => {
  const bars = parseKlines(etf, {
    klines: [
      '2026-11-18,4.059,4.058,4.065,4.023,18843618,7639193014.000,1.04,0.40,0.016,3.79',
      '2026-11-19,4.046,4.060,4.072,4.013,27909417,11293465472.000,1.45,0.05,0.002,5.62'
    ]
  });
  assert.equal(bars.length, 2);
  assert.equal(bars[1].date, '2026-11-19');
  assert.equal(bars[1].close, 4.06);
  assert.equal(bars[1].amount, 11293465472);
});

test('parseTrends maps minute rows', () => {
  const trends = parseTrends(etf, {
    trends: ['2026-11-19 09:30,4.062,4.060,100,406000,0,0,4.0600']
  });
  assert.deepEqual(trends[0], {
    code: '510300',
    time: '2026-11-19 09:30',
    price: 4.062,
    average: 4.06,
    volume: 100,
    amount: 406000
  });
});
