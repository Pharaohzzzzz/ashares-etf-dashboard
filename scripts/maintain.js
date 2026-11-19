'use strict';

const path = require('node:path');
const { cleanupDatabase } = require('../server/maintenance');

const root = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'dashboard.db');

try {
  const result = cleanupDatabase({
    dbPath,
    snapshotDays: Number(process.env.SNAPSHOT_RETENTION_DAYS || 90),
    logDays: Number(process.env.UPDATE_LOG_RETENTION_DAYS || 30)
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
