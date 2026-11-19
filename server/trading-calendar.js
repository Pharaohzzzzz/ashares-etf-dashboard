'use strict';

const CALENDAR_URL = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';
const CALENDAR_REFERER = 'https://www.szse.cn/aboutus/calendar/';
const CALENDAR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const shanghaiClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function shanghaiClock(date = new Date()) {
  const parts = Object.fromEntries(
    shanghaiClockFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    minute: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday
  };
}

function monthKey(date) {
  return shanghaiClock(date).date.slice(0, 7);
}

function parseCalendarMonth(body) {
  if (!Array.isArray(body?.data)) throw new Error('交易日历响应缺少日期数据');
  return body.data.flatMap((row) => {
    const date = String(row?.jyrq || '');
    const status = String(row?.jybz ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [{
      date,
      isTrading: status === '1',
      exchangeStatus: status,
      name: row?.jjrmc || null
    }];
  });
}

async function fetchCalendarMonth(date = new Date(), {
  url = CALENDAR_URL,
  fetchImpl = fetch,
  retries = 1
} = {}) {
  const month = monthKey(date);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(`${url}?month=${month}`, {
        headers: {
          Referer: CALENDAR_REFERER,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json,text/plain,*/*'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = parseCalendarMonth(await response.json());
      if (!rows.length) throw new Error('交易日历响应为空');
      return {
        month,
        source: '深交所',
        sourceUrl: CALENDAR_REFERER,
        rows
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function calendarStatusFor(row, {
  now = new Date(),
  maxAgeMs = CALENDAR_MAX_AGE_MS
} = {}) {
  const clock = shanghaiClock(now);
  if (!row) {
    return {
      date: clock.date,
      known: false,
      isTradingDay: false,
      stale: true,
      source: null,
      fetchedAt: null,
      message: '交易日历尚无缓存，自动刷新暂停'
    };
  }
  const fetchedAt = new Date(row.fetchedAt);
  const stale = !Number.isFinite(fetchedAt.getTime()) ||
    now.getTime() - fetchedAt.getTime() > maxAgeMs;
  return {
    date: clock.date,
    known: true,
    isTradingDay: Boolean(row.isTrading),
    stale,
    source: row.source || null,
    sourceUrl: row.sourceUrl || CALENDAR_REFERER,
    exchangeStatus: row.exchangeStatus || null,
    fetchedAt: row.fetchedAt || null,
    message: stale
      ? '交易日历可能过期：官方日历刷新失败或超过 24 小时未更新，正在使用缓存'
      : row.isTrading
        ? '官方交易日历显示今日开市'
        : `官方交易日历显示今日休市${row.name ? `：${row.name}` : ''}`
  };
}

function isTradingSession(date = new Date(), calendarStatus = null) {
  if (!calendarStatus?.known || !calendarStatus.isTradingDay) return false;
  const clock = shanghaiClock(date);
  const minutes = Number(clock.time.slice(0, 2)) * 60 + Number(clock.time.slice(3, 5));
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) ||
    (minutes >= 13 * 60 && minutes <= 15 * 60);
}

module.exports = {
  CALENDAR_URL,
  CALENDAR_MAX_AGE_MS,
  shanghaiClock,
  monthKey,
  parseCalendarMonth,
  fetchCalendarMonth,
  calendarStatusFor,
  isTradingSession
};
