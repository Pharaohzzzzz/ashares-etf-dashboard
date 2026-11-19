'use strict';

const path = require('node:path');
const { createDatabase } = require('./db');
const { MarketService } = require('./service');
const { createApp } = require('./app');
const { createScheduler } = require('./scheduler');

const port = Number(process.env.PORT || 37821);
const host = '127.0.0.1';
const db = createDatabase(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dashboard.db'));
const service = new MarketService({ db });
const server = createApp({ service });
const scheduler = createScheduler(service);

server.listen(port, host, () => {
  console.log(`ETF dashboard: http://${host}:${port}`);
  service.initialize().catch((error) => {
    console.error(`初始化失败: ${error.message}`);
  });
});

function shutdown() {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

