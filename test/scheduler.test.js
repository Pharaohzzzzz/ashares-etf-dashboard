'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shanghaiClock, isTradingSession } = require('../server/scheduler');

test('Shanghai clock and trading sessions use China market hours', () => {
  assert.equal(shanghaiClock(new Date('2026-11-20T01:31:00.000Z')).time, '09:31:00');
  assert.equal(isTradingSession(new Date('2026-11-20T01:31:00.000Z')), true);
  assert.equal(isTradingSession(new Date('2026-11-20T03:31:00.000Z')), false);
  assert.equal(isTradingSession(new Date('2026-11-20T05:01:00.000Z')), true);
  assert.equal(isTradingSession(new Date('2026-11-20T07:01:00.000Z')), false);
});

test('weekends are not trading sessions', () => {
  assert.equal(isTradingSession(new Date('2026-11-21T02:00:00.000Z')), false);
  assert.equal(isTradingSession(new Date('2026-11-22T06:00:00.000Z')), false);
});
