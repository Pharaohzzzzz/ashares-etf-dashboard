'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createApp } = require('../server/app');
const { createDatabase } = require('../server/db');
const { MarketService } = require('../server/service');

function requestLocal(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: incoming.statusCode,
        headers: incoming.headers
      })));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('historical routes reuse stored work and restart accumulation after real gaps', async (context) => {
  const db = createDatabase(':memory:');
  const code = '588170';
  const dates = ['2025-04-08', '2025-04-09', '2025-04-10', '2025-04-11', '2025-04-14', '2025-04-15', '2025-04-16'];
  const requests = [];
  const options = {
    db,
    now: () => new Date('2025-04-16T10:00:00Z'),
    rawCloseProvider: async (symbol) => dates
      .filter((date) => symbol === '1.000001' || date !== '2025-04-10')
      .map((date) => ({ date, rawClose: 3 })),
    sseShareProvider: async (date) => {
      requests.push(date);
      const values = new Map([['510050', 500], ['599999', 800]]);
      if (date !== '2025-04-14') values.set(code, 100 + dates.indexOf(date) * 10);
      return values;
    }
  };
  const service = new MarketService(options);
  const server = createApp({ service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/etfs/${code}/share-history`;
  const before = await requestLocal(`${endpoint}?days=all`).then((response) => response.json());
  assert.equal(before.backfill.status, 'idle');
  assert.equal((await requestLocal(`${endpoint}?days=250`, { method: 'POST' })).status, 400);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestLocal(`${endpoint}?days=all`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).backfill.status, 'running');
  }
  for (let attempt = 0; service.extendedShareHistory.processing && attempt < 150; attempt += 1) await delay(25);
  const history = await requestLocal(`${endpoint}?days=all`).then((response) => response.json());
  assert.equal(history.backfill.status, 'partial');
  assert.deepEqual(requests, [...dates].reverse());
  assert.equal(history.firstOfficialDate, dates[0]);
  assert.equal(history.range.coverage.effectiveDays, 7);
  assert.equal(history.range.coverage.expectedEstimateDays, 6);
  assert.equal(history.range.coverage.availableDays, 6);
  assert.equal(history.range.coverage.estimatedDays, 3);
  assert.equal(history.range.periodEstimatedSubscription, null);
  assert.deepEqual(history.range.points.map((point) => point.estimateGapReason), [
    'baseline', null, 'missing_price', null, 'missing_share', 'missing_previous_share', null
  ]);
  assert.deepEqual(history.range.points.map((point) => point.cumulativeEstimatedSubscription), [null, 30, null, 30, null, null, 30]);
  const reopened = new MarketService(options);
  assert.equal(reopened.getShareHistory(code, 1250).range.coverage.effectiveDays, 7);
  assert.equal(reopened.getShareHistory(code, 250).officialRecordCount, 0);
  assert.deepEqual(reopened.getShareHistory(code, 250).extendedRanges, [750, 1250, 'all']);
  assert.equal(db.readExtendedShares('510050', dates[0], dates[0])[0].shares, 500);
  assert.deepEqual(db.readExtendedShares('599999', dates[0], dates[0]), []);

  reopened.startExtendedShareHistory(code, 'all');
  for (let attempt = 0; reopened.extendedShareHistory.processing && attempt < 100; attempt += 1) await delay(10);
  assert.deepEqual(requests, [...dates].reverse());

  const csv = await requestLocal(`${base}/api/export.csv?code=${code}&type=shares&days=all`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /official-shares-all/);
  const missingPriceRow = (await csv.text()).split('\r\n').find((row) => row.startsWith('2025-04-10,'));
  assert.deepEqual(missingPriceRow.split(',').slice(0, 10), ['2025-04-10', '120', '10', '', '', '', '20', '', '', 'missing_price']);

  const splitDates = ['2026-03-26', '2026-03-27', '2026-03-30'];
  const splitShares = [100, 400, 410];
  db.upsertBars('159516', splitDates.map((date) => ({
    date, open: 3, close: 3, rawClose: 3, high: 3, low: 3, volume: 100,
    amount: 300, amplitude: 0, changePercent: 0, change: 0, turnoverRate: 1
  })));
  db.saveShareHistory(splitDates.map((tradeDate, i) => ({
    tradeDate, code: '159516', shares: splitShares[i], source: '深交所'
  })));
  const splitRange = reopened.getShareHistory('159516', 20).range;
  assert.equal(splitRange.points[1].shares, 400);
  assert.equal(splitRange.points[1].estimateGapReason, 'share_split');
  assert.equal(splitRange.points[1].estimatedSubscription, null);
  assert.match(splitRange.points[1].shareActionSourceUrl, /^https:/);
  assert.equal(splitRange.points[2].cumulativeEstimatedSubscription, 30);
});
