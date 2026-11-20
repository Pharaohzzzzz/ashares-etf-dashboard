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

test('ETF matrix exposes configurable columns, manual ordering and management controls', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

  assert.match(html, /id="manageEtfButton"/);
  assert.match(html, /id="manageDialog"[^>]*role="dialog"/);
  assert.match(html, /id="manageDialog"[^>]*aria-modal="true"/);
  assert.match(html, /data-column-toggle="estimatedSubscription5d"/);
  assert.match(html, /data-column-toggle="estimatedSubscription20d"/);
  assert.match(html, /data-column-toggle="volatility20d"/);
  assert.match(html, /data-column-key="sharePercentile"[^>]*hidden/);
  assert.match(html, /data-column-key="marketValue"[^>]*hidden/);
  assert.match(html, /data-column-key="volatility20d"[^>]*hidden/);
  assert.match(html, /id="etfCards"/);
  assert.match(html, /id="densityToggle"/);
  assert.match(html, /id="showNarrowColumns"/);
  assert.doesNotMatch(html, /14 只/);
  assert.match(app, /COLUMN_STORAGE_KEY/);
  assert.match(app, /localStorage\.setItem/);
  assert.match(app, /dragstart/);
  assert.match(app, /reorderRows/);
  assert.match(app, /\/api\/etfs\/order/);
  assert.match(app, /恢复默认排序/);
  assert.match(app, /历史积累中/);
  assert.match(app, /createEtfCard/);
  assert.match(app, /DENSITY_STORAGE_KEY/);
  assert.match(app, /show-narrow-secondary/);
  assert.match(styles, /\.detail-drawer\.is-open/);
  assert.match(styles, /\.manage-dialog\.is-open/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.manage-etf-row/);
  assert.match(styles, /\.table-scroll/);
  assert.match(styles, /\.etf-card-list/);
  assert.match(styles, /\.density-compact/);
  assert.match(styles, /show-narrow-secondary/);
  assert.match(styles, /--up:\s*#ee6672/);
  assert.match(styles, /--down:\s*#2bbd85/);
  assert.match(styles, /--warning:\s*#ddb153/);
  assert.match(styles, /\.positive\s*\{\s*color:\s*var\(--up\)/);
  assert.match(styles, /\.negative\s*\{\s*color:\s*var\(--down\)/);
  assert.match(styles, /\.status-warning[\s\S]*color:\s*var\(--warning\)/);
});
