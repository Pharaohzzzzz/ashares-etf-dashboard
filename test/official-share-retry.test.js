'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isOfficialShareRetryDue,
  nextOfficialShareRetryAt
} = require('../server/official-share-retry');

test('trading-day official share retries start after close and run every 30 minutes', () => {
  const beforeClose = new Date('2026-11-20T07:00:00.000Z');
  assert.equal(isOfficialShareRetryDue(beforeClose, {
    isTradingDay: true,
    lastAttemptAt: '2026-11-20T06:00:00.000Z'
  }), false);
  assert.equal(
    nextOfficialShareRetryAt(beforeClose, {
      isTradingDay: true,
      lastAttemptAt: '2026-11-20T06:00:00.000Z'
    }),
    '2026-11-20T07:30:00.000Z'
  );

  const firstSlot = new Date('2026-11-20T10:00:00.000Z');
  assert.equal(isOfficialShareRetryDue(firstSlot, {
    isTradingDay: true,
    lastAttemptAt: '2026-11-20T09:30:00.000Z'
  }), true);
  assert.equal(
    nextOfficialShareRetryAt(firstSlot, {
      isTradingDay: true,
      lastAttemptAt: firstSlot.toISOString()
    }),
    '2026-11-20T10:30:00.000Z'
  );
});

test('non-trading days retry pending shares hourly', () => {
  const saturday = new Date('2026-11-21T02:00:00.000Z');
  assert.equal(isOfficialShareRetryDue(saturday, {
    isTradingDay: false,
    lastAttemptAt: '2026-11-21T01:00:00.000Z'
  }), true);
  assert.equal(isOfficialShareRetryDue(saturday, {
    isTradingDay: false,
    lastAttemptAt: '2026-11-21T01:20:00.000Z'
  }), false);
  assert.equal(
    nextOfficialShareRetryAt(saturday, {
      isTradingDay: false,
      lastAttemptAt: '2026-11-21T01:20:00.000Z'
    }),
    '2026-11-21T02:20:00.000Z'
  );
});
