'use strict';

const path = require('node:path');
const { restoreDatabase } = require('../server/maintenance');

const root = path.join(__dirname, '..');
const backupPath = process.argv[2] || process.env.BACKUP_PATH;
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'dashboard.db');
const safetyDir = process.env.BACKUP_DIR || path.join(root, 'data', 'backups');
const port = Number(process.env.PORT || 37821);

async function ensureServiceStopped() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500)
    });
    if (response.ok) {
      throw new Error('网站仍在运行，请先停止服务再恢复数据库');
    }
  } catch (error) {
    if (error.message.includes('仍在运行')) throw error;
  }
}

if (!backupPath) {
  console.error('用法: node scripts/restore.js <backup.db>');
  process.exitCode = 1;
} else {
  ensureServiceStopped().then(() => restoreDatabase({
    backupPath,
    dbPath,
    safetyDir
  })).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
