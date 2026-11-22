'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { API_VERSION, FINGERPRINT_FILES, getBuildId } = require('../server/runtime-version');

test('runtime version exposes a stable API contract and source fingerprint', () => {
  assert.equal(API_VERSION, 3);
  const first = getBuildId();
  const second = getBuildId();
  assert.match(first, /^[a-f0-9]{16}$/);
  assert.equal(first, second);
  const serverFiles = fs.readdirSync(path.join(__dirname, '..', 'server'))
    .filter((file) => file.endsWith('.js'));
  assert.deepEqual(serverFiles.filter((file) => !FINGERPRINT_FILES.includes(`server/${file}`)), []);
});

test('startup script detects an outdated backend before declaring it running', () => {
  const root = path.join(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'scripts', 'start-dashboard.ps1'), 'utf8');
  assert.match(script, /runtime-version\.js/);
  assert.match(script, /buildId/);
  assert.match(script, /apiVersion/);
  assert.match(script, /stop-dashboard\.ps1/);
});
