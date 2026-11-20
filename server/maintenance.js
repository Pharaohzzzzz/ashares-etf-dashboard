'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

function timestampToken(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

function verifyDatabase(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const ok = integrity.length === 1 && integrity[0].integrity_check === 'ok' &&
      foreignKeys.length === 0;
    return { ok, integrity, foreignKeys };
  } finally {
    db.close();
  }
}

async function createBackup({
  dbPath,
  backupDir,
  now = new Date(),
  prefix = 'dashboard',
  retention = 14,
  verify = true
}) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${prefix}-${timestampToken(now)}.db`);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(source, backupPath);
  } finally {
    source.close();
  }
  const verification = verify ? verifyDatabase(backupPath) : null;
  if (verification && !verification.ok) {
    throw new Error(`备份完整性检查失败：${backupPath}`);
  }
  const removed = pruneBackups(backupDir, { prefix, retention });
  return { backupPath, verification, removed };
}

function listBackups(backupDir, { prefix = 'dashboard' } = {}) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.db'))
    .map((name) => ({
      name,
      path: path.join(backupDir, name),
      mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function pruneBackups(backupDir, { prefix = 'dashboard', retention = 14 } = {}) {
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error('备份保留数量必须为正整数');
  }
  const stale = listBackups(backupDir, { prefix }).slice(retention);
  for (const item of stale) fs.rmSync(item.path, { force: true });
  return stale.map((item) => item.path);
}

function cleanupDatabase({
  dbPath,
  snapshotDays = 90,
  logDays = 30,
  now = new Date(),
  checkpoint = true
}) {
  if (!Number.isInteger(snapshotDays) || snapshotDays < 1) {
    throw new Error('盘中快照保留天数必须为正整数');
  }
  if (!Number.isInteger(logDays) || logDays < 1) {
    throw new Error('更新日志保留天数必须为正整数');
  }
  const snapshotCutoff = new Date(now.getTime() - snapshotDays * 86400000).toISOString();
  const logCutoff = new Date(now.getTime() - logDays * 86400000).toISOString();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  let snapshotsRemoved = 0;
  let logsRemoved = 0;
  db.exec('BEGIN');
  try {
    snapshotsRemoved = Number(
      db.prepare('DELETE FROM snapshots WHERE captured_at < ?').run(snapshotCutoff).changes
    );
    logsRemoved = Number(
      db.prepare('DELETE FROM update_log WHERE created_at < ?').run(logCutoff).changes
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (checkpoint) {
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    } finally {
      db.close();
    }
  } else {
    db.close();
  }
  return {
    snapshotCutoff,
    logCutoff,
    snapshotsRemoved,
    logsRemoved,
    preserved: [
      'daily_bars',
      'share_history',
      'daily_metrics',
      'iopv_samples'
    ]
  };
}

async function restoreDatabase({
  backupPath,
  dbPath,
  safetyDir,
  now = new Date()
}) {
  if (!fs.existsSync(backupPath)) throw new Error(`备份不存在：${backupPath}`);
  const backupCheck = verifyDatabase(backupPath);
  if (!backupCheck.ok) throw new Error('待恢复备份未通过完整性检查');
  let safetyBackup = null;
  if (fs.existsSync(dbPath)) {
    const result = await createBackup({
      dbPath,
      backupDir: safetyDir,
      prefix: 'before-restore',
      now,
      retention: 14
    });
    safetyBackup = result.backupPath;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.restore-${process.pid}.tmp`;
  fs.copyFileSync(backupPath, temporary);
  const temporaryCheck = verifyDatabase(temporary);
  if (!temporaryCheck.ok) {
    fs.rmSync(temporary, { force: true });
    throw new Error('恢复临时库未通过完整性检查');
  }
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.rmSync(dbPath, { force: true });
  fs.renameSync(temporary, dbPath);
  const restored = verifyDatabase(dbPath);
  if (!restored.ok) throw new Error('恢复后的数据库未通过完整性检查');
  return { restored, safetyBackup };
}

module.exports = {
  timestampToken,
  verifyDatabase,
  createBackup,
  listBackups,
  pruneBackups,
  cleanupDatabase,
  restoreDatabase
};
