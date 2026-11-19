'use strict';

const {
  shanghaiClock,
  isTradingSession
} = require('./trading-calendar');

function createScheduler(service, { log = console.log } = {}) {
  let stopped = false;
  let running = false;
  let lastQuoteTick = 0;
  let lastDailySlot = null;

  const timer = setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try {
      const now = new Date();
      if (service.ensureTradingCalendar) await service.ensureTradingCalendar({ date: now });
      const clock = shanghaiClock(now);
      const calendar = service.getTradingCalendarStatus
        ? service.getTradingCalendarStatus(now)
        : null;
      const tradingDay = Boolean(calendar?.isTradingDay);
      const shouldQuote = isTradingSession(now, calendar) &&
        now.getTime() - lastQuoteTick >= 30000;
      const dailySlot = tradingDay && (clock.minute === '15:30' || clock.minute === '18:00')
        ? `${clock.date}-${clock.minute}`
        : null;
      if (!shouldQuote && (!dailySlot || dailySlot === lastDailySlot)) return;
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

