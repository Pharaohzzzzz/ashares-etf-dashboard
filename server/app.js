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

function csvNumberOrMissing(value) {
  return Number.isFinite(value) ? value : '数据不足';
}

function parseBacktestFilters(url) {
  return {
    from: url.searchParams.get('from') || null,
    to: url.searchParams.get('to') || null,
    code: url.searchParams.get('code') || null,
    category: url.searchParams.get('category') || null,
    level: url.searchParams.get('level') || null,
    split: url.searchParams.get('split') || null,
    horizon: Number(url.searchParams.get('horizon') || 5)
  };
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

      const shareHistoryMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/share-history$/);
      if (shareHistoryMatch && request.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 250);
        if (![20, 60, 250].includes(days)) {
          return sendJson(response, 400, { error: '历史视角仅支持 20、60 或 250 日' });
        }
        const shareHistory = service.getShareHistory(shareHistoryMatch[1], days);
        return shareHistory
          ? sendJson(response, 200, shareHistory)
          : sendJson(response, 404, { error: 'ETF 不存在' });
      }

      const iopvHistoryMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/iopv-history$/);
      if (iopvHistoryMatch && request.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 250);
        if (!Number.isInteger(days) || days < 1 || days > 250) {
          return sendJson(response, 400, { error: 'IOPV 历史视角需为 1 至 250 日' });
        }
        const history = service.getIopvHistory(iopvHistoryMatch[1], days);
        return history
          ? sendJson(response, 200, history)
          : sendJson(response, 404, { error: 'ETF 不存在' });
      }

      if (url.pathname === '/api/backtests/summary' && request.method === 'GET') {
        return sendJson(response, 200, await service.getBacktestSummary());
      }

      if (url.pathname === '/api/backtests/events' && request.method === 'GET') {
        const filters = parseBacktestFilters(url);
        if (![1, 3, 5, 10].includes(filters.horizon)) {
          return sendJson(response, 400, { error: '回测周期仅支持 1、3、5 或 10 日' });
        }
        return sendJson(response, 200, await service.getBacktestEvents(filters));
      }

      const signalEventMatch = url.pathname.match(/^\/api\/backtests\/events\/(\d+)$/);
      if (signalEventMatch && request.method === 'GET') {
        const event = await service.getBacktestEvent(signalEventMatch[1]);
        return event
          ? sendJson(response, 200, event)
          : sendJson(response, 404, { error: '信号事件不存在' });
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
        if (url.searchParams.get('type') === 'backtest') {
          const filters = parseBacktestFilters(url);
          if (![1, 3, 5, 10].includes(filters.horizon)) {
            return sendJson(response, 400, { error: '回测周期仅支持 1、3、5 或 10 日' });
          }
          const { events } = await service.getBacktestEvents(filters);
          csv = toCsv([
            { key: 'code', label: '代码' },
            { key: 'name', label: '名称' },
            { key: 'category', label: '分类' },
            { key: 'signalDate', label: '信号日期' },
            { key: 'split', label: '数据切分' },
            { key: 'score', label: '评分' },
            { key: 'level', label: '等级' },
            { key: 'horizon', label: '预测周期' },
            { key: 'futureReturn', label: '未来收益' },
            { key: 'drawdown', label: '未来最大回撤' },
            { key: 'maxFavorable', label: '最大有利波动' },
            { key: 'benchmarkReturn', label: '同期基准收益' },
            { key: 'hit', label: '跑赢同期基准' },
            { key: 'baselineHitRate', label: '同ETF无条件命中率' },
            { key: 'returnVsUnconditional', label: '相对无条件收益' },
            { key: 'legacyComposite', label: '旧规则对照' }
          ], events.map((event) => {
            const outcome = event.outcomes?.[filters.horizon] || {};
            return {
              code: event.code,
              name: event.name,
              category: event.category,
              signalDate: event.date,
              split: event.split === 'train' ? '训练期' : '验证期',
              score: event.score,
              level: event.level.label,
              horizon: `${filters.horizon}日`,
              futureReturn: csvNumberOrMissing(outcome.futureReturn),
              drawdown: csvNumberOrMissing(outcome.drawdown),
              maxFavorable: csvNumberOrMissing(outcome.maxFavorable),
              benchmarkReturn: csvNumberOrMissing(outcome.benchmarkReturn),
              hit: typeof outcome.outperformedBenchmark === 'boolean'
                ? (outcome.outperformedBenchmark ? '是' : '否')
                : '数据不足',
              baselineHitRate: csvNumberOrMissing(outcome.baselineHitRate),
              returnVsUnconditional: csvNumberOrMissing(outcome.returnVsUnconditional),
              legacyComposite: event.legacyComposite ? '命中旧候选' : '未命中'
            };
          }));
          filename = 'etf-signal-backtest.csv';
        } else if (code && /^\d{6}$/.test(code)) {
          const detail = service.getDetail(code);
          if (!detail) return sendJson(response, 404, { error: 'ETF 不存在' });
          if (url.searchParams.get('type') === 'shares') {
            const shareHistory = service.getShareHistory(code, 250);
            csv = toCsv([
              { key: 'tradeDate', label: '日期' },
              { key: 'shares', label: '官方总份额' },
              { key: 'shareDelta', label: '份额变化' },
              { key: 'close', label: '收盘价' },
              { key: 'estimatedSubscription', label: '估算净申赎' },
              { key: 'cumulativeShareDelta', label: '累计份额变化' },
              { key: 'cumulativeEstimatedSubscription', label: '累计估算净申赎' },
              { key: 'source', label: '来源' }
            ], shareHistory?.range?.points || []);
            filename = `${code}-official-shares.csv`;
          } else if (url.searchParams.get('type') === 'iopv') {
            const iopvHistory = service.getIopvHistory(code, 250);
            csv = toCsv([
              { key: 'tradeDate', label: '交易日' },
              { key: 'dataTime', label: 'IOPV数据时间' },
              { key: 'marketPrice', label: '市场价' },
              { key: 'iopv', label: 'IOPV' },
              { key: 'premiumRate', label: '折溢价率' },
              { key: 'source', label: '数据来源' },
              { key: 'sourceKind', label: '来源级别' }
            ], (iopvHistory?.closeHistory || []).map((point) => ({
              ...point,
              premiumRate: Number.isFinite(point.premiumRate)
                ? `${(point.premiumRate * 100).toFixed(4)}%`
                : '',
              sourceKind: point.sourceKind === 'official' ? '交易所官方' : '公开补充源'
            })));
            filename = `${code}-iopv-premium.csv`;
          } else {
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
          }
        } else {
          const summary = service.getSummary();
          const headers = [
            { key: 'code', label: '代码' },
            { key: 'name', label: '名称' },
            { key: 'category', label: '分类' },
            { key: 'price', label: '最新价' },
            { key: 'iopvMarketPrice', label: 'IOPV对应市场价' },
            { key: 'iopv', label: 'IOPV' },
            { key: 'premiumRate', label: '折溢价率（市场价/IOPV-1）' },
            { key: 'premiumStatusLabel', label: '折溢价状态' },
            { key: 'iopvSource', label: 'IOPV来源' },
            { key: 'iopvDataTime', label: 'IOPV数据时间' },
            { key: 'changePercent', label: '涨跌幅' },
            { key: 'amount', label: '成交额' },
            { key: 'turnoverRate', label: '换手率' },
            { key: 'volumeRatio', label: '20日量比' },
            { key: 'shares', label: '份额' },
            { key: 'shareDelta', label: '份额变化' },
            { key: 'estimatedSubscription', label: '估算净申赎' },
            { key: 'shareStreak', label: '连续净申赎' },
            { key: 'sharePercentile', label: '份额历史分位' },
            { key: 'tradeDate', label: '交易日' },
            { key: 'signals', label: '候选信号' }
          ];
          csv = toCsv(headers, summary.etfs.map((row) => ({
            ...row,
            premiumRate: Number.isFinite(row.premiumRate)
              ? `${(row.premiumRate * 100).toFixed(4)}%`
              : (row.premiumStatusLabel || '暂无'),
            shareStreak: row.shareStreak?.days
              ? `${row.shareStreak.label} ${row.shareStreak.days}日`
              : '无连续序列',
            sharePercentile: Number.isFinite(row.sharePercentile)
              ? `${(row.sharePercentile * 100).toFixed(1)}%`
              : '数据不足',
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
          path.join(__dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js'),
          'public, max-age=3600'
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

function serveFile(response, filePath, cacheControl = 'no-cache') {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(response, 404, { error: '文件不存在' });
  }
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(response);
}

module.exports = { createApp, toCsv };

