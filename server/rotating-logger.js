'use strict';

const fs = require('node:fs');
const path = require('node:path');

function rotateFile(filePath, { maxBytes = 5 * 1024 * 1024, keep = 5 } = {}) {
  if (!fs.existsSync(filePath)) return [];
  if (fs.statSync(filePath).size < maxBytes) return [];
  const rotated = [];
  for (let index = keep - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (fs.existsSync(source)) {
      fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
      rotated.push(target);
    }
  }
  const first = `${filePath}.1`;
  fs.rmSync(first, { force: true });
  fs.renameSync(filePath, first);
  rotated.push(first);
  return rotated;
}

function createRotatingLogger({
  filePath,
  maxBytes = 5 * 1024 * 1024,
  keep = 5,
  now = () => new Date()
}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  function append(level, values) {
    const text = values
      .map((value) => typeof value === 'string' ? value : String(value))
      .join(' ');
    rotateFile(filePath, { maxBytes, keep });
    fs.appendFileSync(
      filePath,
      `${now().toISOString()} ${level} ${text}${process.platform === 'win32' ? '\r\n' : '\n'}`
    );
  }
  return {
    log: (...values) => {
      append('INFO', values);
      console.log(...values);
    },
    error: (...values) => {
      append('ERROR', values);
      console.error(...values);
    },
    info: (...values) => {
      append('INFO', values);
      console.info(...values);
    },
    warn: (...values) => {
      append('WARN', values);
      console.warn(...values);
    }
  };
}

module.exports = { rotateFile, createRotatingLogger };
