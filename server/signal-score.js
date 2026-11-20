'use strict';

const { percentile } = require('./metrics');

const SIGNAL_PARAMETERS = Object.freeze({
  version: 'signal-score-v2.0.0',
  weights: Object.freeze({
    volume: 35,
    shareChange: 30,
    streak: 15,
    resonance: 20
  }),
  levels: Object.freeze({
    observe: 40,
    active: 60,
    high: 80
  }),
  volumeBaselineDays: 20,
  volumeNormalization: Object.freeze({ start: 1, cap: 3 }),
  sharePercentileDays: 250,
  sharePercentileMinSamples: 20,
  streakCapDays: 5,
  resonanceVolumeRatio: 1.5,
  resonanceMinCount: 2
});

function finite(value) {
  return Number.isFinite(value);
}

function round(value, digits = 1) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function average(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function levelForScore(score) {
  if (!finite(score) || score < SIGNAL_PARAMETERS.levels.observe) {
    return { key: 'below', label: '未达阈值' };
  }
  if (score >= SIGNAL_PARAMETERS.levels.high) {
    return { key: 'high', label: '高强度异动' };
  }
  if (score >= SIGNAL_PARAMETERS.levels.active) {
    return { key: 'active', label: '活跃异动' };
  }
  return { key: 'observe', label: '观察' };
}

function calculateSignalScore({
  volumeRatio,
  shareDelta,
  sharePercentile,
  shareSamples,
  streak,
  resonanceCount,
  resonanceSource,
  categorySize
}) {
  if (
    !finite(volumeRatio) ||
    !finite(shareDelta) ||
    !finite(sharePercentile) ||
    !finite(streak?.days) ||
    shareSamples < SIGNAL_PARAMETERS.sharePercentileMinSamples
  ) {
    return null;
  }

  const volumeFactor = clamp(
    (volumeRatio - SIGNAL_PARAMETERS.volumeNormalization.start) /
      (SIGNAL_PARAMETERS.volumeNormalization.cap - SIGNAL_PARAMETERS.volumeNormalization.start)
  );
  const shareFactor = clamp(Math.abs(sharePercentile - 0.5) * 2);
  const streakFactor = clamp(streak.days / SIGNAL_PARAMETERS.streakCapDays);
  const resonanceFactor = clamp(resonanceCount / SIGNAL_PARAMETERS.resonanceMinCount);

  const components = [
    {
      key: 'volume',
      label: '20日成交额量比',
      actual: round(volumeRatio, 2),
      actualLabel: `${volumeRatio.toFixed(2)}×`,
      normalized: round(volumeFactor, 4),
      weight: SIGNAL_PARAMETERS.weights.volume,
      contribution: round(volumeFactor * SIGNAL_PARAMETERS.weights.volume),
      direction: volumeRatio >= 1 ? 'up' : 'down',
      note: '当前成交额 ÷ 前 20 个完整交易日成交额均值'
    },
    {
      key: 'shareChange',
      label: '官方份额变化历史分位',
      actual: shareDelta,
      actualLabel: `${shareDelta > 0 ? '+' : ''}${shareDelta}`,
      percentile: round(sharePercentile, 4),
      samples: shareSamples,
      normalized: round(shareFactor, 4),
      weight: SIGNAL_PARAMETERS.weights.shareChange,
      contribution: round(shareFactor * SIGNAL_PARAMETERS.weights.shareChange),
      direction: shareDelta > 0 ? 'subscription' : shareDelta < 0 ? 'redemption' : 'flat',
      note: `不含未来份额；分位基于当日及以前最多 ${SIGNAL_PARAMETERS.sharePercentileDays} 个连续官方变化`
    },
    {
      key: 'streak',
      label: '连续净申购/净赎回',
      actual: streak.days,
      actualLabel: `${streak.label} ${streak.days}日`,
      normalized: round(streakFactor, 4),
      weight: SIGNAL_PARAMETERS.weights.streak,
      contribution: round(streakFactor * SIGNAL_PARAMETERS.weights.streak),
      direction: streak.direction || 'flat',
      note: '遇到官方份额日期缺口即中断，不插值'
    },
    {
      key: 'resonance',
      label: '宽基或同分类共振',
      actual: resonanceCount,
      actualLabel: resonanceSource === '同分类'
        ? `${resonanceCount} 只同分类 ETF 放量`
        : resonanceSource === '宽基'
          ? `${resonanceCount} 只宽基 ETF 同步放量`
          : categorySize < SIGNAL_PARAMETERS.resonanceMinCount
            ? '同分类样本不足'
            : '未形成共振',
      normalized: round(resonanceFactor, 4),
      weight: SIGNAL_PARAMETERS.weights.resonance,
      contribution: round(resonanceFactor * SIGNAL_PARAMETERS.weights.resonance),
      direction: resonanceCount >= SIGNAL_PARAMETERS.resonanceMinCount ? 'resonance' : 'none',
      note: `成交额量比达到 ${SIGNAL_PARAMETERS.resonanceVolumeRatio.toFixed(2)}× 计为放量`
    }
  ];

  const score = round(components.reduce((sum, component) => sum + component.contribution, 0));
  const level = levelForScore(score);
  const reasons = [...components]
    .filter((component) => component.contribution > 0)
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, 3)
    .map((component) => `${component.label}贡献 ${component.contribution} 分`);

  return {
    score,
    level,
    components,
    reasons,
    parameterVersion: SIGNAL_PARAMETERS.version
  };
}

function createShareTimeline(bars, shares) {
  const sharesByDate = new Map(
    shares
      .filter((row) => finite(row.shares))
      .map((row) => [row.tradeDate, row])
  );
  const deltaByDate = new Map();
  for (let index = 1; index < bars.length; index += 1) {
    const current = sharesByDate.get(bars[index].date);
    const previous = sharesByDate.get(bars[index - 1].date);
    if (!current || !previous) continue;
    deltaByDate.set(bars[index].date, current.shares - previous.shares);
  }

  const states = new Map();
  const rollingDeltas = [];
  for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
    const bar = bars[barIndex];
    if (deltaByDate.has(bar.date)) {
      rollingDeltas.push(deltaByDate.get(bar.date));
      if (rollingDeltas.length > SIGNAL_PARAMETERS.sharePercentileDays) rollingDeltas.shift();
    }
    const delta = deltaByDate.get(bar.date);
    if (!finite(delta)) continue;

    let direction = delta > 0 ? 'subscription' : delta < 0 ? 'redemption' : null;
    let days = delta === 0 ? 0 : 1;
    if (days) {
      for (let index = barIndex - 1; index > 0; index -= 1) {
        const priorDelta = deltaByDate.get(bars[index].date);
        if (!finite(priorDelta) || priorDelta === 0) break;
        const priorDirection = priorDelta > 0 ? 'subscription' : 'redemption';
        if (priorDirection !== direction) break;
        days += 1;
      }
    }

    states.set(bar.date, {
      shareDelta: delta,
      sharePercentile: percentile(delta, rollingDeltas),
      shareSamples: rollingDeltas.length,
      streak: {
        direction,
        label: direction === 'subscription'
          ? '连续净申购'
          : direction === 'redemption'
            ? '连续净赎回'
            : '持平',
        days
      }
    });
  }
  return states;
}

function buildSignalScores(dataset) {
  const prepared = dataset.map(({ etf, bars, shares }) => {
    const sortedBars = [...bars].sort((left, right) => left.date.localeCompare(right.date));
    return {
      etf,
      bars: sortedBars,
      shareStates: createShareTimeline(sortedBars, shares)
    };
  });
  const ratiosByDate = new Map();

  for (const item of prepared) {
    item.byDate = new Map();
    for (let index = 0; index < item.bars.length; index += 1) {
      const bar = item.bars[index];
      if (index < SIGNAL_PARAMETERS.volumeBaselineDays) {
        item.byDate.set(bar.date, { bar, volumeRatio: null });
        continue;
      }
      const priorBars = item.bars.slice(
        index - SIGNAL_PARAMETERS.volumeBaselineDays,
        index
      );
      const priorAverage = average(priorBars.map((row) => row.amount));
      const volumeRatio = finite(bar.amount) && priorAverage > 0
        ? bar.amount / priorAverage
        : null;
      const row = { bar, volumeRatio };
      item.byDate.set(bar.date, row);
      if (finite(volumeRatio)) {
        if (!ratiosByDate.has(bar.date)) ratiosByDate.set(bar.date, []);
        ratiosByDate.get(bar.date).push({
          code: item.etf.code,
          category: item.etf.category,
          volumeRatio
        });
      }
    }
  }

  const observations = [];

  for (const item of prepared) {
    for (const [date, row] of item.byDate.entries()) {
      const shareState = item.shareStates.get(date);
      if (
        !finite(row.volumeRatio) ||
        !shareState ||
        shareState.shareSamples < SIGNAL_PARAMETERS.sharePercentileMinSamples
      ) {
        continue;
      }

      const peers = ratiosByDate.get(date) || [];
      const broadCount = peers.filter((peer) => (
        peer.category === '宽基核心' &&
        peer.volumeRatio >= SIGNAL_PARAMETERS.resonanceVolumeRatio
      )).length;
      const categoryPeers = peers.filter((peer) => peer.category === item.etf.category);
      const categoryCount = categoryPeers.filter(
        (peer) => peer.volumeRatio >= SIGNAL_PARAMETERS.resonanceVolumeRatio
      ).length;
      let resonanceSource = null;
      let resonanceCount = categoryCount;
      if (item.etf.category === '宽基核心') {
        resonanceSource = broadCount ? '宽基' : null;
        resonanceCount = broadCount;
      } else if (broadCount >= SIGNAL_PARAMETERS.resonanceMinCount && broadCount > categoryCount) {
        resonanceSource = '宽基';
        resonanceCount = broadCount;
      } else if (categoryCount) {
        resonanceSource = '同分类';
      }

      const scored = calculateSignalScore({
        volumeRatio: row.volumeRatio,
        shareDelta: shareState.shareDelta,
        sharePercentile: shareState.sharePercentile,
        shareSamples: shareState.shareSamples,
        streak: shareState.streak,
        resonanceCount,
        resonanceSource,
        categorySize: prepared.filter(
          (entry) => entry.etf.category === item.etf.category
        ).length
      });
      if (!scored) continue;
      observations.push({
        code: item.etf.code,
        name: item.etf.name,
        category: item.etf.category,
        date,
        score: scored.score,
        level: scored.level,
        components: scored.components,
        reasons: scored.reasons,
        parameterVersion: scored.parameterVersion,
        isSignal: scored.score >= SIGNAL_PARAMETERS.levels.observe
      });
    }
  }
  observations.sort((left, right) => (
    left.date.localeCompare(right.date) || left.code.localeCompare(right.code)
  ));
  return observations;
}

module.exports = {
  SIGNAL_PARAMETERS,
  levelForScore,
  calculateSignalScore,
  buildSignalScores
};
