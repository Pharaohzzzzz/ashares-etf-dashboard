'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scale,
  average,
  volumeRatio,
  percentile,
  periodReturn,
  calculateSignals
} = require('../server/metrics');

test('scale handles null and decimal scaling', () => {
  assert.equal(scale(null, 3), null);
  assert.equal(scale('-', 3), null);
  assert.equal(scale(4060, 3), 4.06);
});

test('average ignores invalid values', () => {
  assert.equal(average([1, 2, null, 3]), 2);
  assert.equal(average([]), null);
});

test('volume ratio compares current amount with prior average', () => {
  assert.equal(volumeRatio(300, [100, 100, 100]), 3);
  assert.equal(volumeRatio(300, []), null);
});

test('percentile returns an inclusive rank', () => {
  assert.equal(percentile(3, [1, 2, 3, 4]), 0.75);
  assert.equal(percentile(null, [1, 2]), null);
});

test('period return uses the last prior close', () => {
  assert.ok(Math.abs(periodReturn(110, [100]) - 0.1) < 1e-12);
  assert.equal(periodReturn(110, []), null);
});

test('period return can use a multi-day lookback', () => {
  assert.ok(Math.abs(periodReturn(120, [80, 90, 100], 3) - 0.5) < 1e-12);
  assert.equal(periodReturn(120, [80, 90], 3), null);
});

test('signals flag broad resonance and composite candidate', () => {
  const result = calculateSignals({
    isBroad: true,
    volumeRatio: 2.2,
    previousVolumeRatio: 1.6,
    shareDelta: 100,
    broadResonance: true,
    tailVolumeShare: 0.25
  });
  assert.equal(result.composite, true);
  assert.deepEqual(
    result.signals.map((signal) => signal.key),
    ['volume', 'sustained-volume', 'tail-volume', 'share-up', 'broad-resonance', 'candidate']
  );
});

test('a single share increase is not a composite signal', () => {
  const result = calculateSignals({
    isBroad: false,
    volumeRatio: 1.1,
    previousVolumeRatio: 1,
    shareDelta: 100,
    broadResonance: false,
    tailVolumeShare: 0.1
  });
  assert.equal(result.composite, false);
  assert.equal(result.signals.length, 1);
});
