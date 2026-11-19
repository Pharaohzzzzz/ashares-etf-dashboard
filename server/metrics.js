'use strict';

function scale(value, decimals = 0) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number / 10 ** decimals;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function volumeRatio(currentAmount, priorAmounts) {
  const baseline = average(priorAmounts);
  if (!Number.isFinite(currentAmount) || !baseline || baseline <= 0) return null;
  return currentAmount / baseline;
}

function percentile(value, history) {
  const valid = history.filter((item) => Number.isFinite(item));
  if (!Number.isFinite(value) || !valid.length) return null;
  return valid.filter((item) => item <= value).length / valid.length;
}

function periodReturn(close, closesAscending, periods = 1) {
  const prior = closesAscending.at(-periods);
  if (!Number.isFinite(close) || !Number.isFinite(prior) || prior <= 0) return null;
  return close / prior - 1;
}

function calculateSignals({
  isBroad,
  volumeRatio: ratio,
  previousVolumeRatio,
  shareDelta,
  broadResonance,
  tailVolumeShare
}) {
  const signals = [];
  if (ratio !== null && ratio >= 2) signals.push({ key: 'volume', label: '显著放量', level: 'high' });
  if (ratio !== null && previousVolumeRatio !== null && ratio >= 1.5 && previousVolumeRatio >= 1.5) {
    signals.push({ key: 'sustained-volume', label: '连续放量', level: 'medium' });
  }
  if (tailVolumeShare !== null && tailVolumeShare >= 0.2) {
    signals.push({ key: 'tail-volume', label: '尾盘异动', level: 'medium' });
  }
  if (shareDelta !== null && shareDelta > 0) {
    signals.push({ key: 'share-up', label: '份额增加', level: 'medium' });
  }
  if (isBroad && broadResonance) {
    signals.push({ key: 'broad-resonance', label: '宽基共振', level: 'high' });
  }
  const composite = (
    (ratio !== null && ratio >= 2 && shareDelta !== null && shareDelta > 0) ||
    (isBroad && broadResonance)
  );
  if (composite) signals.push({ key: 'candidate', label: '护盘候选', level: 'high' });
  return { signals, composite };
}

module.exports = {
  scale,
  average,
  volumeRatio,
  percentile,
  periodReturn,
  calculateSignals
};

