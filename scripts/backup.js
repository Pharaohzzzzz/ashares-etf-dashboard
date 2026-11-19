'use strict';

const path = require('node:path');
const { createBackup } = require('../server/maintenance');

const root = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'dashboard.db');
const backupDir = process.env.BACKUP_DIR || path.join(root, 'data', 'backups');

createBackup({
  dbPath,
  backupDir,
  retention: Number(process.env.BACKUP_RETENTION || 14)
}).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
