'use strict';

const { createConnection } = require('node:net');
const path = require('node:path');
const { restoreDatabase } = require('../server/maintenance');

const root = path.join(__dirname, '..');
const backupPath = process.argv[2] || process.env.BACKUP_PATH;
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'dashboard.db');
const safetyDir = process.env.BACKUP_DIR || path.join(root, 'data', 'backups');
const port = Number(process.env.PORT || 37821);

function ensureServiceStopped() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('网站端口仍在监听，请先停止服务再恢复数据库'));
    });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error('无法确认网站已停止，请检查服务端口后再恢复数据库'));
    });
  });
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
