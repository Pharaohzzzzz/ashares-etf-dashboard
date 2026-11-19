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

function calculateShareStreak(history, tradeDates) {
  const latest = history.at(-1);
  if (!latest || !tradeDates.length || tradeDates.at(-1) !== latest.tradeDate) {
    return { direction: null, label: '持平', days: 0 };
  }
  const sharesByDate = new Map(history.map((row) => [row.tradeDate, row.shares]));
  let direction = null;
  let days = 0;
  for (let index = tradeDates.length - 1; index > 0; index -= 1) {
    const currentShares = sharesByDate.get(tradeDates[index]);
    const previousShares = sharesByDate.get(tradeDates[index - 1]);
    if (!Number.isFinite(currentShares) || !Number.isFinite(previousShares)) break;
    const change = currentShares - previousShares;
    if (change === 0) {
      if (days === 0) direction = null;
      break;
    }
    const currentDirection = change > 0 ? 'subscription' : 'redemption';
    if (direction === null) direction = currentDirection;
    if (currentDirection !== direction) break;
    days += 1;
  }
  if (direction === null) return { direction: null, label: '持平', days: 0 };
  return {
    direction,
    label: direction === 'subscription' ? '连续净申购' : '连续净赎回',
    days
  };
}

function calculateShareWindow(history, bars, days) {
  if (!history.length || !Number.isInteger(days) || days < 1) {
    return {
      days,
      points: [],
      periodShareDelta: null,
      periodEstimatedSubscription: null,
      sharePercentile: null,
      startDate: null,
      endDate: null
    };
  }
  const closeByDate = new Map(bars.map((bar) => [bar.date, bar.close]));
  const baseHistory = history.slice(-(days + 1));
  const points = [];
  let runningEstimatedSubscription = 0;
  let runningShareDelta = 0;
  for (let index = 1; index < baseHistory.length; index += 1) {
    const current = baseHistory[index];
    const previous = baseHistory[index - 1];
    const shareDelta = current.shares - previous.shares;
    const close = closeByDate.get(current.tradeDate) ?? null;
    const estimatedSubscription = Number.isFinite(close)
      ? shareDelta * close
      : null;
    runningShareDelta += shareDelta;
    if (Number.isFinite(estimatedSubscription)) {
      runningEstimatedSubscription += estimatedSubscription;
    }
    points.push({
      tradeDate: current.tradeDate,
      shares: current.shares,
      source: current.source,
      shareDelta,
      close,
      estimatedSubscription,
      cumulativeShareDelta: runningShareDelta,
      cumulativeEstimatedSubscription: Number.isFinite(estimatedSubscription)
        ? runningEstimatedSubscription
        : null
    });
  }
  const windowPoints = points.slice(-days);
  const finiteEstimates = windowPoints
    .map((point) => point.estimatedSubscription)
    .filter((value) => Number.isFinite(value));
  const currentShares = baseHistory.at(-1).shares;
  return {
    days,
    points: windowPoints,
    periodShareDelta: windowPoints.length
      ? windowPoints.reduce((sum, point) => sum + point.shareDelta, 0)
      : null,
    periodEstimatedSubscription: finiteEstimates.length
      ? finiteEstimates.reduce((sum, value) => sum + value, 0)
      : null,
    sharePercentile: percentile(
      currentShares,
      baseHistory.slice(-days).map((row) => row.shares)
    ),
    startDate: windowPoints[0]?.tradeDate || null,
    endDate: windowPoints.at(-1)?.tradeDate || null
  };
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
  const participatesInResonance = isBroad && broadResonance && ratio !== null && ratio >= 1.5;
  if (participatesInResonance) {
    signals.push({ key: 'broad-resonance', label: '宽基共振', level: 'high' });
  }
  const composite = (
    (ratio !== null && ratio >= 2 && shareDelta !== null && shareDelta > 0) ||
    participatesInResonance
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
  calculateShareStreak,
  calculateShareWindow,
  calculateSignals
};

