'use strict';

const path = require('node:path');
const { restoreDatabase } = require('../server/maintenance');

const root = path.join(__dirname, '..');
const backupPath = process.argv[2] || process.env.BACKUP_PATH;
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'dashboard.db');
const safetyDir = process.env.BACKUP_DIR || path.join(root, 'data', 'backups');

if (!backupPath) {
  console.error('用法: node scripts/restore.js <backup.db>');
  process.exitCode = 1;
} else {
  restoreDatabase({ backupPath, dbPath, safetyDir }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
