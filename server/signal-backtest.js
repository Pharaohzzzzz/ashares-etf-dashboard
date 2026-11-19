'use strict';

const crypto = require('node:crypto');
const { calculateSignals, percentile } = require('./metrics');

const SIGNAL_PARAMETERS = Object.freeze({
  version: 'signal-score-v1.0.1',
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
  horizons: Object.freeze([1, 3, 5, 10]),
  trainFraction: 0.7,
  volumeBaselineDays: 20,
  volumeNormalization: Object.freeze({ start: 1, cap: 3 }),
  sharePercentileDays: 250,
  sharePercentileMinSamples: 20,
  streakCapDays: 5,
  resonanceVolumeRatio: 1.5,
  legacyResonanceVolumeRatio: 2,
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

function median(values) {
  const valid = values.filter(finite).sort((left, right) => left - right);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[middle]
    : (valid[middle - 1] + valid[middle]) / 2;
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

function buildSignalObservations(dataset) {
  const prepared = dataset.map(({ etf, bars, shares }) => {
    const sortedBars = [...bars].sort((left, right) => left.date.localeCompare(right.date));
    return {
      etf,
      bars: sortedBars,
      shareStates: createShareTimeline(sortedBars, shares),
      exclusions: []
    };
  });
  const ratiosByDate = new Map();

  for (const item of prepared) {
    item.byDate = new Map();
    for (let index = 0; index < item.bars.length; index += 1) {
      const bar = item.bars[index];
      if (index < SIGNAL_PARAMETERS.volumeBaselineDays) {
        item.byDate.set(bar.date, { bar, barIndex: index, volumeRatio: null, previousVolumeRatio: null });
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
      const earlier = item.bars[index - 1];
      const previousComparable = earlier && index - 1 >= SIGNAL_PARAMETERS.volumeBaselineDays
        ? item.bars.slice(
          index - 1 - SIGNAL_PARAMETERS.volumeBaselineDays,
          index - 1
        )
        : [];
      const previousAverage = average(previousComparable.map((row) => row.amount));
      const previousVolumeRatio = finite(earlier?.amount) && previousAverage > 0
        ? earlier.amount / previousAverage
        : null;
      const row = { bar, barIndex: index, volumeRatio, previousVolumeRatio };
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
  const exclusions = prepared.map((item) => ({
    code: item.etf.code,
    name: item.etf.name,
    category: item.etf.category,
    barCount: item.bars.length,
    officialShareCount: item.shareStates.size,
    reasons: {}
  }));
  const exclusionByCode = new Map(exclusions.map((row) => [row.code, row]));

  for (const item of prepared) {
    for (const [date, row] of item.byDate.entries()) {
      const shareState = item.shareStates.get(date);
      const missing = [];
      if (!finite(row.volumeRatio)) missing.push('日线或20日成交额基准不足');
      if (!shareState) missing.push('当日或前一交易日官方份额缺失');
      if (shareState && shareState.shareSamples < SIGNAL_PARAMETERS.sharePercentileMinSamples) {
        missing.push(`官方份额变化样本不足 ${SIGNAL_PARAMETERS.sharePercentileMinSamples} 个`);
      }
      if (missing.length) {
        const reasons = exclusionByCode.get(item.etf.code).reasons;
        for (const reason of missing) reasons[reason] = (reasons[reason] || 0) + 1;
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
      if (!scored) {
        const reason = '评分输入不完整';
        const reasons = exclusionByCode.get(item.etf.code).reasons;
        reasons[reason] = (reasons[reason] || 0) + 1;
        continue;
      }

      const legacyResonance = peers.filter((peer) => (
        peer.category === '宽基核心' &&
        peer.volumeRatio >= SIGNAL_PARAMETERS.legacyResonanceVolumeRatio
      )).length >= SIGNAL_PARAMETERS.resonanceMinCount;
      const legacy = calculateSignals({
        isBroad: item.etf.category === '宽基核心',
        volumeRatio: row.volumeRatio,
        previousVolumeRatio: row.previousVolumeRatio,
        shareDelta: shareState.shareDelta,
        broadResonance: legacyResonance,
        tailVolumeShare: null
      });
      observations.push({
        code: item.etf.code,
        name: item.etf.name,
        category: item.etf.category,
        date,
        barIndex: row.barIndex,
        score: scored.score,
        level: scored.level,
        components: scored.components,
        reasons: scored.reasons,
        parameterVersion: scored.parameterVersion,
        isSignal: scored.score >= SIGNAL_PARAMETERS.levels.observe,
        legacyComposite: legacy.composite,
        legacySignals: legacy.signals,
        legacyBroadResonance: legacyResonance
      });
    }
  }
  observations.sort((left, right) => (
    left.date.localeCompare(right.date) || left.code.localeCompare(right.code)
  ));
  return { observations, exclusions, prepared };
}

function splitDates(observations) {
  const dates = [...new Set(observations.map((row) => row.date))].sort();
  if (dates.length < 2) {
    return {
      dates,
      trainEnd: dates.at(-1) || null,
      validationStart: null,
      trainShare: dates.length ? 1 : null
    };
  }
  const trainCount = Math.max(
    1,
    Math.min(dates.length - 1, Math.floor(dates.length * SIGNAL_PARAMETERS.trainFraction))
  );
  return {
    dates,
    trainEnd: dates[trainCount - 1],
    validationStart: dates[trainCount],
    trainShare: trainCount / dates.length
  };
}

function buildBenchmarkReturns(prepared, horizons) {
  const returns = new Map();
  const barIndexes = new Map(prepared.map((item) => [
    item.etf.code,
    new Map(item.bars.map((bar, index) => [bar.date, index]))
  ]));

  for (let offset = 0; offset < horizons.length; offset += 1) {
    const horizon = horizons[offset];
    const byDate = new Map();
    for (const item of prepared) {
      const indexes = barIndexes.get(item.etf.code);
      for (const bar of item.bars) {
        const index = indexes.get(bar.date);
        const futureBar = item.bars[index + horizon];
        if (!futureBar || !finite(bar.close) || !finite(futureBar.close) || bar.close <= 0) {
          continue;
        }
        if (!byDate.has(bar.date)) byDate.set(bar.date, []);
        byDate.get(bar.date).push(futureBar.close / bar.close - 1);
      }
    }
    returns.set(horizon, new Map(
      [...byDate.entries()].map(([date, values]) => [date, average(values)])
    ));
  }
  return { returns, barIndexes };
}

function attachOutcomes(observations, prepared) {
  const horizons = SIGNAL_PARAMETERS.horizons;
  const { returns: benchmarkReturns, barIndexes } = buildBenchmarkReturns(prepared, horizons);
  const barsByCode = new Map(prepared.map((item) => [item.etf.code, item.bars]));

  for (const observation of observations) {
    const bars = barsByCode.get(observation.code);
    const index = barIndexes.get(observation.code).get(observation.date);
    const entry = bars[index];
    observation.outcomes = {};
    observation.futurePath = {};
    for (const horizon of horizons) {
      const future = bars[index + horizon];
      const benchmarkReturn = benchmarkReturns.get(horizon).get(observation.date) ?? null;
      if (
        !future ||
        !Number.isFinite(entry?.close) ||
        entry.close <= 0 ||
        !Number.isFinite(future.close) ||
        !finite(benchmarkReturn)
      ) {
        observation.outcomes[horizon] = null;
        observation.futurePath[horizon] = [];
        continue;
      }
      const pathBars = bars.slice(index + 1, index + horizon + 1);
      const futureReturn = future.close / entry.close - 1;
      const drawdown = Math.min(
        0,
        Math.min(...pathBars.map((bar) => bar.close)) / entry.close - 1
      );
      const favorable = Math.max(
        0,
        Math.max(...pathBars.map((bar) => bar.close)) / entry.close - 1
      );
      observation.outcomes[horizon] = {
        horizon,
        futureReturn: round(futureReturn, 6),
        benchmarkReturn: round(benchmarkReturn, 6),
        benchmarkExcess: round(futureReturn - benchmarkReturn, 6),
        drawdown: round(drawdown, 6),
        maxFavorable: round(favorable, 6),
        outperformedBenchmark: futureReturn > benchmarkReturn,
        entryDate: entry.date,
        exitDate: future.date
      };
      observation.futurePath[horizon] = pathBars.map((bar) => ({
        date: bar.date,
        close: bar.close,
        relative: round(bar.close / entry.close - 1, 6)
      }));
    }
  }

  const baseline = new Map();
  for (const observation of observations) {
    for (const horizon of horizons) {
      const outcome = observation.outcomes[horizon];
      if (!outcome) continue;
      const key = `${observation.split}:${observation.code}:${horizon}`;
      if (!baseline.has(key)) baseline.set(key, []);
      baseline.get(key).push(outcome);
    }
  }
  for (const observation of observations) {
    for (const horizon of horizons) {
      const outcome = observation.outcomes[horizon];
      if (!outcome) continue;
      const peers = baseline.get(`${observation.split}:${observation.code}:${horizon}`) || [];
      outcome.baselineSampleCount = peers.length;
      outcome.baselineHitRate = peers.length
        ? peers.filter((item) => item.outperformedBenchmark).length / peers.length
        : null;
      outcome.baselineAverageReturn = average(peers.map((item) => item.futureReturn));
      outcome.returnVsUnconditional = finite(outcome.baselineAverageReturn)
        ? round(outcome.futureReturn - outcome.baselineAverageReturn, 6)
        : null;
    }
  }
}

function aggregateOutcomes(observations, horizon, selector) {
  const selected = observations
    .filter(selector)
    .map((observation) => observation.outcomes?.[horizon])
    .filter((outcome) => outcome && finite(outcome.futureReturn));
  if (!selected.length) {
    return {
      horizon,
      samples: 0,
      hitRate: null,
      baselineHitRate: null,
      hitRateLift: null,
      averageReturn: null,
      medianReturn: null,
      worstDrawdown: null,
      averageMaxFavorable: null,
      averageBenchmarkReturn: null,
      relativeReturnImprovement: null
    };
  }
  const hitRate = selected.filter((outcome) => outcome.outperformedBenchmark).length / selected.length;
  const baselineHitRate = average(selected.map((outcome) => outcome.baselineHitRate));
  const averageReturn = average(selected.map((outcome) => outcome.futureReturn));
  const baselineAverageReturn = average(selected.map((outcome) => outcome.baselineAverageReturn));
  return {
    horizon,
    samples: selected.length,
    hitRate: round(hitRate, 6),
    baselineHitRate: round(baselineHitRate, 6),
    hitRateLift: round(hitRate - baselineHitRate, 6),
    averageReturn: round(averageReturn, 6),
    medianReturn: round(median(selected.map((outcome) => outcome.futureReturn)), 6),
    worstDrawdown: round(Math.min(...selected.map((outcome) => outcome.drawdown)), 6),
    averageMaxFavorable: round(average(selected.map((outcome) => outcome.maxFavorable)), 6),
    averageBenchmarkReturn: round(
      average(selected.map((outcome) => outcome.benchmarkReturn)),
      6
    ),
    relativeReturnImprovement: round(averageReturn - baselineAverageReturn, 6)
  };
}

function summarizeSplit(observations, split) {
  const rows = observations.filter((observation) => observation.split === split);
  const categories = [...new Set(rows.map((observation) => observation.category))];
  const etfs = [...new Map(rows.map((observation) => [
    observation.code,
    { code: observation.code, name: observation.name, category: observation.category }
  ])).values()];
  const byHorizon = Object.fromEntries(SIGNAL_PARAMETERS.horizons.map((horizon) => [
    horizon,
    aggregateOutcomes(rows, horizon, (observation) => observation.isSignal)
  ]));
  const legacyByHorizon = Object.fromEntries(SIGNAL_PARAMETERS.horizons.map((horizon) => [
    horizon,
    aggregateOutcomes(rows, horizon, (observation) => observation.legacyComposite)
  ]));
  const categoriesByHorizon = Object.fromEntries(categories.map((category) => [
    category,
    Object.fromEntries(SIGNAL_PARAMETERS.horizons.map((horizon) => [
      horizon,
      aggregateOutcomes(rows, horizon, (observation) => (
        observation.isSignal && observation.category === category
      ))
    ]))
  ]));
  const etfsByHorizon = Object.fromEntries(etfs.map((etf) => [
    etf.code,
    {
      ...etf,
      horizons: Object.fromEntries(SIGNAL_PARAMETERS.horizons.map((horizon) => [
        horizon,
        aggregateOutcomes(rows, horizon, (observation) => (
          observation.isSignal && observation.code === etf.code
        ))
      ]))
    }
  ]));
  return {
    observationCount: rows.length,
    signalCount: rows.filter((observation) => observation.isSignal).length,
    legacySignalCount: rows.filter((observation) => observation.legacyComposite).length,
    byHorizon,
    legacyByHorizon,
    categories: categoriesByHorizon,
    etfs: etfsByHorizon
  };
}

function datasetFingerprint(dataset) {
  const stable = dataset.map(({ etf, bars, shares }) => ({
    code: etf.code,
    bars: bars.map((bar) => [
      bar.date, bar.open, bar.close, bar.high, bar.low, bar.amount
    ]),
    shares: shares.map((row) => [row.tradeDate, row.shares, row.source])
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function buildBacktest(dataset) {
  const { observations, exclusions, prepared } = buildSignalObservations(dataset);
  const split = splitDates(observations);
  for (const observation of observations) {
    observation.split = split.validationStart && observation.date >= split.validationStart
      ? 'validation'
      : 'train';
  }
  attachOutcomes(observations, prepared);

  const etfStatus = exclusions.map((row) => {
    const eligible = observations.filter((observation) => observation.code === row.code);
    const signals = eligible.filter((observation) => observation.isSignal);
    return {
      code: row.code,
      name: row.name,
      category: row.category,
      barCount: row.barCount,
      officialShareCount: row.officialShareCount,
      eligibleScoringDays: eligible.length,
      signalCount: signals.length,
      firstSignalDate: signals[0]?.date || null,
      lastSignalDate: signals.at(-1)?.date || null,
      status: eligible.length ? 'ready' : 'insufficient',
      reason: eligible.length
        ? null
        : Object.entries(row.reasons)
          .sort((left, right) => right[1] - left[1])
          .map(([reason, count]) => `${reason}（${count} 日）`)
          .join('；') || '可用评分日为 0'
    };
  });

  return {
    parameterVersion: SIGNAL_PARAMETERS.version,
    parameters: SIGNAL_PARAMETERS,
    generatedAt: new Date().toISOString(),
    datasetFingerprint: datasetFingerprint(dataset),
    window: {
      trainStart: observations[0]?.date || null,
      trainEnd: split.trainEnd,
      validationStart: split.validationStart,
      validationEnd: observations.at(-1)?.date || null,
      trainShare: round(split.trainShare, 4),
      requestedTrainFraction: SIGNAL_PARAMETERS.trainFraction
    },
    methodology: {
      signalDayInputs: '评分只读取信号日及以前的数据；未来数据仅用于事后结果评价',
      benchmark: '同期基准为监测池内具备相同起止日数据 ETF 的等权平均收益',
      hit: '命中指 ETF 未来收益高于同期等权基准；相对提升为信号命中率减去同 ETF 同期间无条件命中率',
      missingShares: '官方份额缺失或不足时不插值、不回填，并排除该日评分',
      split: '按全池可评分交易日的先后顺序前 70% 训练、后 30% 留出验证，验证期不参与参数调整',
      tailVolume: '尾盘成交占比仅作当日辅助标签，不进入长期回测评分'
    },
    splits: {
      train: summarizeSplit(observations, 'train'),
      validation: summarizeSplit(observations, 'validation')
    },
    etfStatus,
    events: observations
      .filter((observation) => observation.isSignal)
      .map((observation) => ({
        code: observation.code,
        name: observation.name,
        category: observation.category,
        date: observation.date,
        split: observation.split,
        score: observation.score,
        level: observation.level,
        components: observation.components,
        reasons: observation.reasons,
        outcomes: observation.outcomes,
        futurePath: observation.futurePath,
        legacyComposite: observation.legacyComposite,
        legacySignals: observation.legacySignals
      }))
  };
}

module.exports = {
  SIGNAL_PARAMETERS,
  levelForScore,
  calculateSignalScore,
  buildSignalObservations,
  buildBacktest,
  datasetFingerprint,
  average,
  median
};
