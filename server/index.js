'use strict';

const path = require('node:path');
const { createDatabase } = require('./db');
const { MarketService } = require('./service');
const { createApp } = require('./app');
const { createScheduler } = require('./scheduler');
const { createRotatingLogger } = require('./rotating-logger');
const { createBackup, cleanupDatabase } = require('./maintenance');

const port = Number(process.env.PORT || 37821);
const host = '127.0.0.1';
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'dashboard.db');
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
const logger = createRotatingLogger({
  filePath: process.env.LOG_PATH || path.join(dataDir, 'logs', 'dashboard.log'),
  maxBytes: Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024),
  keep: Number(process.env.LOG_ROTATION_FILES || 5)
});
const db = createDatabase(dbPath);
const service = new MarketService({ db });
const server = createApp({ service, logger });
const scheduler = createScheduler(service, { log: logger.log });

let maintenanceTimer;
let maintenancePromise = null;

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

async function runDailyMaintenance() {
  if (maintenancePromise) return maintenancePromise;
  maintenancePromise = (async () => {
    const day = shanghaiDate();
    if (db.getMeta('lastMaintenanceDate') === day) return;
    const result = await createBackup({
      dbPath,
      backupDir,
      retention: Number(process.env.BACKUP_RETENTION || 14)
    });
    const cleanup = cleanupDatabase({
      dbPath,
      snapshotDays: Number(process.env.SNAPSHOT_RETENTION_DAYS || 90),
      logDays: Number(process.env.UPDATE_LOG_RETENTION_DAYS || 30)
    });
    db.setMeta('lastMaintenanceDate', day);
    logger.log(
      `[maintenance] 备份 ${result.backupPath}；清理快照 ${cleanup.snapshotsRemoved} 条、更新日志 ${cleanup.logsRemoved} 条`
    );
  })().catch((error) => {
    logger.error(`[maintenance] 失败：${error.stack || error.message}`);
  }).finally(() => {
    maintenancePromise = null;
  });
  return maintenancePromise;
}

server.listen(port, host, () => {
  logger.log(`ETF dashboard: http://${host}:${port}`);
  service.initialize().catch((error) => {
    logger.error(`初始化失败: ${error.stack || error.message}`);
  });
  runDailyMaintenance();
});
maintenanceTimer = setInterval(runDailyMaintenance, 15 * 60 * 1000);
maintenanceTimer.unref();

function shutdown() {
  scheduler.stop();
  clearInterval(maintenanceTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

