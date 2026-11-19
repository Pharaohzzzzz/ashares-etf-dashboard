'use strict';

function shanghaiClock(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    minute: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday
  };
}

function isTradingSession(date = new Date()) {
  const clock = shanghaiClock(date);
  if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return false;
  const minutes = Number(clock.time.slice(0, 2)) * 60 + Number(clock.time.slice(3, 5));
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) ||
    (minutes >= 13 * 60 && minutes <= 15 * 60);
}

function createScheduler(service, { log = console.log } = {}) {
  let stopped = false;
  let running = false;
  let lastQuoteTick = 0;
  let lastDailySlot = null;

  const timer = setInterval(async () => {
    if (stopped || running) return;
    const now = new Date();
    const clock = shanghaiClock(now);
    const weekday = clock.weekday !== 'Sat' && clock.weekday !== 'Sun';
    const shouldQuote = isTradingSession(now) && now.getTime() - lastQuoteTick >= 30000;
    const dailySlot = weekday && (clock.minute === '15:30' || clock.minute === '18:00')
      ? `${clock.date}-${clock.minute}`
      : null;
    if (!shouldQuote && (!dailySlot || dailySlot === lastDailySlot)) return;
    running = true;
    try {
      if (shouldQuote) {
        lastQuoteTick = now.getTime();
        await service.refreshQuotes();
      }
      if (dailySlot && dailySlot !== lastDailySlot) {
        lastDailySlot = dailySlot;
        if (clock.minute === '18:00') await service.syncHistory();
        else await service.refreshQuotes();
        log(`[scheduler] 完成 ${dailySlot} 数据更新`);
      }
    } catch (error) {
      log(`[scheduler] 更新失败: ${error.message}`);
    } finally {
      running = false;
    }
  }, 5000);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

module.exports = { shanghaiClock, isTradingSession, createScheduler };

