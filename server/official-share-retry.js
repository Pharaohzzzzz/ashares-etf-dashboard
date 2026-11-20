'use strict';

const { shanghaiClock } = require('./trading-calendar');

const TRADING_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const NON_TRADING_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_WINDOW_START = '15:30';
const RETRY_WINDOW_END = '23:30';

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shanghaiLocalToIso(dateKey, time) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0)).toISOString();
}

function retryDeadline(now) {
  const clock = shanghaiClock(now);
  const today = shanghaiLocalToIso(clock.date, RETRY_WINDOW_END);
  if (now.getTime() <= new Date(today).getTime()) return today;
  return shanghaiLocalToIso(addDays(clock.date, 1), RETRY_WINDOW_END);
}

function retryInterval(now, isTradingDay) {
  if (!isTradingDay) return NON_TRADING_RETRY_INTERVAL_MS;
  const clock = shanghaiClock(now);
  return clock.minute >= RETRY_WINDOW_START && clock.minute <= RETRY_WINDOW_END
    ? TRADING_RETRY_INTERVAL_MS
    : NON_TRADING_RETRY_INTERVAL_MS;
}

function isOfficialShareRetryDue(now, {
  isTradingDay,
  lastAttemptAt = null
} = {}) {
  if (!lastAttemptAt) return true;
  const lastAttempt = new Date(lastAttemptAt);
  if (!Number.isFinite(lastAttempt.getTime())) return true;
  if (isTradingDay) {
    const clock = shanghaiClock(now);
    if (clock.minute < RETRY_WINDOW_START) return false;
    if (clock.minute <= RETRY_WINDOW_END) {
      return now.getTime() - lastAttempt.getTime() >= TRADING_RETRY_INTERVAL_MS;
    }
  }
  return now.getTime() - lastAttempt.getTime() >= NON_TRADING_RETRY_INTERVAL_MS;
}

function nextOfficialShareRetryAt(now, {
  isTradingDay,
  lastAttemptAt = null
} = {}) {
  const lastAttempt = lastAttemptAt ? new Date(lastAttemptAt) : null;
  if (!lastAttempt || !Number.isFinite(lastAttempt.getTime())) return now.toISOString();
  if (isTradingDay) {
    const clock = shanghaiClock(now);
    if (clock.minute < RETRY_WINDOW_START) {
      const openingRetry = shanghaiLocalToIso(clock.date, RETRY_WINDOW_START);
      if (lastAttempt.getTime() < new Date(openingRetry).getTime()) return openingRetry;
    }
  }
  const interval = retryInterval(now, isTradingDay);
  return new Date(lastAttempt.getTime() + interval).toISOString();
}

module.exports = {
  TRADING_RETRY_INTERVAL_MS,
  NON_TRADING_RETRY_INTERVAL_MS,
  RETRY_WINDOW_START,
  RETRY_WINDOW_END,
  retryInterval,
  retryDeadline,
  isOfficialShareRetryDue,
  nextOfficialShareRetryAt
};
