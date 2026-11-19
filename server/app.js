'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, rows) {
  return '\uFEFF' + [
    headers.map((header) => csvCell(header.label)).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header.key])).join(','))
  ].join('\r\n');
}

function createApp({ service, publicDir = path.join(__dirname, '..', 'public') }) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/health') {
        const summary = service.getSummary();
        return sendJson(response, 200, {
          status: summary.etfs.length ? 'ok' : 'starting',
          initializedAt: service.initializedAt,
          dataTime: summary.dataTime,
          etfs: summary.etfs.length,
          initializing: service.initializing
        });
      }

      if (url.pathname === '/api/summary' && request.method === 'GET') {
        return sendJson(response, 200, service.getSummary());
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const summary = await service.refreshQuotes();
        return sendJson(response, 200, summary);
      }

      const intradayMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/intraday$/);
      if (intradayMatch && request.method === 'GET') {
        const intraday = await service.getIntraday(intradayMatch[1]);
        return intraday
          ? sendJson(response, 200, intraday)
          : sendJson(response, 404, { error: 'ETF 不存在' });
      }

      const detailMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})$/);
      if (detailMatch && request.method === 'GET') {
        const detail = service.getDetail(detailMatch[1]);
        return detail
          ? sendJson(response, 200, detail)
          : sendJson(response, 404, { error: 'ETF 不存在' });
      }

      if (url.pathname === '/api/export.csv' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        let csv;
        let filename;
        if (code && /^\d{6}$/.test(code)) {
          const detail = service.getDetail(code);
          if (!detail) return sendJson(response, 404, { error: 'ETF 不存在' });
          csv = toCsv([
            { key: 'date', label: '日期' },
            { key: 'open', label: '开盘' },
            { key: 'close', label: '收盘' },
            { key: 'high', label: '最高' },
            { key: 'low', label: '最低' },
            { key: 'volume', label: '成交量' },
            { key: 'amount', label: '成交额' },
            { key: 'changePercent', label: '涨跌幅' },
            { key: 'turnoverRate', label: '换手率' }
          ], detail.bars);
          filename = `${code}-daily.csv`;
        } else {
          const summary = service.getSummary();
          const headers = [
            { key: 'code', label: '代码' },
            { key: 'name', label: '名称' },
            { key: 'category', label: '分类' },
            { key: 'price', label: '最新价' },
            { key: 'changePercent', label: '涨跌幅' },
            { key: 'amount', label: '成交额' },
            { key: 'turnoverRate', label: '换手率' },
            { key: 'volumeRatio', label: '20日量比' },
            { key: 'shares', label: '份额' },
            { key: 'shareDelta', label: '份额变化' },
            { key: 'estimatedSubscription', label: '估算净申赎' },
            { key: 'tradeDate', label: '交易日' },
            { key: 'signals', label: '候选信号' }
          ];
          csv = toCsv(headers, summary.etfs.map((row) => ({
            ...row,
            signals: row.signals.map((signal) => signal.label).join('、')
          })));
          filename = 'etf-summary.csv';
        }
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store'
        });
        return response.end(csv);
      }

      if (url.pathname === '/vendor/echarts.min.js') {
        return serveFile(
          response,
          path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js')
        );
      }

      if (!url.pathname.startsWith('/api/')) {
        const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const fullPath = path.resolve(publicDir, requested);
        if (!fullPath.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
          return sendJson(response, 403, { error: '禁止访问' });
        }
        return serveFile(response, fullPath);
      }

      return sendJson(response, 404, { error: '接口不存在' });
    } catch (error) {
      return sendJson(response, 500, { error: error.message });
    }
  });
  return server;
}

function serveFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(response, 404, { error: '文件不存在' });
  }
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(response);
}

module.exports = { createApp, toCsv };

