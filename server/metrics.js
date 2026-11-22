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
  if (priorAmounts.length !== 20 || !priorAmounts.every(Number.isFinite)) return null;
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

function annualizedVolatility(closesAscending, periods = 20) {
  if (!Number.isInteger(periods) || periods < 1) return null;
  if (!Array.isArray(closesAscending) || closesAscending.length < periods + 1) return null;
  const window = closesAscending.slice(-(periods + 1));
  if (window.some((close) => !Number.isFinite(close) || close <= 0)) return null;
  const returns = [];
  for (let index = 1; index < window.length; index += 1) {
    returns.push(window[index] / window[index - 1] - 1);
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0
  ) / Math.max(returns.length - 1, 1);
  return Math.sqrt(variance) * Math.sqrt(252);
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

function calculateShareWindow(history, bars, days, tradeDates = bars.map((bar) => bar.date)) {
  const closeByDate = new Map(bars.map((bar) => [bar.date, bar.rawClose]));
  const sharesByDate = new Map(history.map((row) => [row.tradeDate, row]));
  const latestDate = history.at(-1)?.tradeDate;
  const baseDates = Number.isInteger(days) && days > 0
    ? tradeDates.filter((date) => date <= latestDate).slice(-(days + 1))
    : [];
  const firstPoint = Math.max(0, baseDates.length - days);
  let runningEstimatedSubscription = 0;
  let runningShareDelta = 0;
  let shareDeltaDays = 0;
  let estimatedDays = 0;
  const points = baseDates.slice(firstPoint).map((date, index) => {
    const current = sharesByDate.get(date);
    const previous = sharesByDate.get(baseDates[firstPoint + index - 1]);
    const shareDelta = current && previous ? current.shares - previous.shares : null;
    const rawClose = closeByDate.get(date);
    const close = Number.isFinite(rawClose) && rawClose > 0 ? rawClose : null;
    const estimatedSubscription = shareDelta !== null && close !== null ? shareDelta * close : null;
    if (shareDelta !== null) {
      shareDeltaDays += 1;
      runningShareDelta += shareDelta;
    }
    if (estimatedSubscription !== null) {
      estimatedDays += 1;
      runningEstimatedSubscription += estimatedSubscription;
    }
    return {
      tradeDate: date,
      shares: current?.shares ?? null,
      source: current?.source ?? null,
      fetchedAt: current?.fetchedAt ?? null,
      officialFetchedAt: current?.officialFetchedAt ?? null,
      shareDelta,
      close,
      estimatedSubscription,
      cumulativeShareDelta: shareDeltaDays === index + 1 ? runningShareDelta : null,
      cumulativeEstimatedSubscription: estimatedDays === index + 1 ? runningEstimatedSubscription : null
    };
  });
  return {
    days,
    points,
    periodShareDelta: days > 0 && shareDeltaDays === days ? runningShareDelta : null,
    periodEstimatedSubscription: days > 0 && estimatedDays === days ? runningEstimatedSubscription : null,
    shareDeltaDays,
    estimatedDays,
    sharePercentile: percentile(history.at(-1)?.shares, points.map((point) => point.shares)),
    startDate: points[0]?.tradeDate || null,
    endDate: points.at(-1)?.tradeDate || null
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
  if (composite) {
    signals.push({
      key: 'candidate',
      label: '异常放量+份额变化候选',
      level: 'high'
    });
  }
  return { signals, composite };
}

module.exports = {
  scale,
  average,
  volumeRatio,
  percentile,
  periodReturn,
  annualizedVolatility,
  calculateShareStreak,
  calculateShareWindow,
  calculateSignals
};

