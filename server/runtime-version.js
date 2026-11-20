'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API_VERSION = 3;
const FINGERPRINT_FILES = [
  'package.json',
  'package-lock.json',
  'config/etfs.js',
  'server/app.js',
  'server/db.js',
  'server/index.js',
  'server/official-share-retry.js',
  'server/official-shares.js',
  'server/runtime-version.js',
  'server/scheduler.js',
  'server/service.js',
  'server/trading-calendar.js',
  'public/app.js',
  'public/index.html',
  'public/styles.css'
];

function getBuildId(root = path.join(__dirname, '..')) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of FINGERPRINT_FILES) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

if (require.main === module) {
  process.stdout.write(getBuildId());
}

module.exports = {
  API_VERSION,
  FINGERPRINT_FILES,
  getBuildId
};
