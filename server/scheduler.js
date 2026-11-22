'use strict';

const {
  shanghaiClock,
  isTradingSession
} = require('./trading-calendar');

function createScheduler(service, {
  log = console.log,
  now = () => new Date(),
  intervalMs = 5000
} = {}) {
  let stopped = false;
  let running = false;
  let lastQuoteTick = 0;
  let lastRetryCheck = 0;

  async function runCheck() {
    if (stopped || running) return;
    running = true;
    try {
      const currentTime = now();
      if (service.ensureTradingCalendar) {
        await service.ensureTradingCalendar({ date: currentTime });
      }
      const calendar = service.getTradingCalendarStatus
        ? service.getTradingCalendarStatus(currentTime)
        : null;
      const shouldQuote = isTradingSession(currentTime, calendar) &&
        currentTime.getTime() - lastQuoteTick >= 30000;
      if (shouldQuote) {
        lastQuoteTick = currentTime.getTime();
        await service.refreshQuotes();
      }
      await service.runPostCloseTasks?.(currentTime, calendar);
      if (
        service.retryPendingOfficialShares &&
        currentTime.getTime() - lastRetryCheck >= 30000
      ) {
        lastRetryCheck = currentTime.getTime();
        const retry = await service.retryPendingOfficialShares();
        if (retry) log('[scheduler] 已重试官方份额缺口');
      }
    } catch (error) {
      log(`[scheduler] 更新失败: ${error.message}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(runCheck, intervalMs);
  timer.unref();
  return {
    runCheck,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

module.exports = { shanghaiClock, isTradingSession, createScheduler };

