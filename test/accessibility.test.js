'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('detail drawer and sortable headers expose accessible dialog semantics', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const sortButtons = html.match(/class="sort-button"/g) || [];

  assert.match(html, /id="detailDrawer"[^>]*role="dialog"/);
  assert.match(html, /id="detailDrawer"[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby="drawerTitle"/);
  assert.ok(sortButtons.length >= 9);
  assert.match(html, /aria-sort="none"/);
  assert.match(app, /header\.setAttribute\(\s*'aria-sort'/);
  assert.match(app, /trapDrawerFocus/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /rememberDrawerTrigger/);
  assert.match(app, /target\?\.focus\(\)/);
  assert.match(app, /toggleAttribute\('inert'/);
  assert.match(app, /event\.key === 'Enter' \|\| event\.key === ' '/);
});
