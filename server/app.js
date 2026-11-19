'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ETFS } = require('../config/etfs');

const ETF_CODES = new Set(ETFS.map((etf) => etf.code));
const CATEGORIES = new Set(ETFS.map((etf) => etf.category));
const LEVELS = new Set(['observe', 'active', 'high']);
const SPLITS = new Set(['train', 'validation']);
const HORIZONS = new Set([1, 3, 5, 10]);
const CSV_TYPES = new Set(['summary', 'daily', 'shares', 'iopv', 'backtest']);

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

function sendError(response, status, code, message) {
  return sendJson(response, status, { error: { code, message } });
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
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

function validateBacktestFilters(url) {
  const filters = parseBacktestFilters(url);
  if (!HORIZONS.has(filters.horizon)) {
    return { error: ['INVALID_HORIZON', '回测周期仅支持 1、3、5 或 10 日'] };
  }
  if (filters.code && !ETF_CODES.has(filters.code)) {
    return { error: ['INVALID_CODE', 'ETF 代码不在监测清单内'] };
  }
  if (filters.category && !CATEGORIES.has(filters.category)) {
    return { error: ['INVALID_CATEGORY', 'ETF 分类不在白名单内'] };
  }
  if (filters.level && !LEVELS.has(filters.level)) {
    return { error: ['INVALID_LEVEL', '评分等级不在白名单内'] };
  }
  if (filters.split && !SPLITS.has(filters.split)) {
    return { error: ['INVALID_SPLIT', '数据切分仅支持 train 或 validation'] };
  }
  for (const key of ['from', 'to']) {
    if (filters[key] && !isValidDate(filters[key])) {
      return { error: ['INVALID_DATE', '日期必须为有效的 YYYY-MM-DD'] };
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return { error: ['INVALID_DATE_RANGE', '开始日期不得晚于结束日期'] };
  }
  return { filters };
}

function createApp({
  service,
  publicDir = path.join(__dirname, '..', 'public'),
  logger = console
}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/health') {
        const summary = service.getSummary();
        const status = !summary.etfs.length
          ? 'starting'
          : summary.quoteStatus === 'ok'
            ? 'ok'
            : 'degraded';
        return sendJson(response, 200, {
          status,
          initializedAt: service.initializedAt,
          dataTime: summary.dataTime,
          etfs: summary.etfs.length,
          initializing: service.initializing,
          quoteStatus: summary.quoteStatus || null,
          staleCount: summary.staleCount ?? null,
          oldestDataTime: summary.oldestDataTime || null,
          latestDataTime: summary.latestDataTime || null
        });
      }

      if (url.pathname === '/api/summary' && request.method === 'GET') {
        return sendJson(response, 200, service.getSummary());
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const summary = await service.refreshQuotes();
        return sendJson(response, 200, summary);
      }

      const etfPathMatch = url.pathname.match(/^\/api\/etfs\/([^/]+)/);
      if (etfPathMatch && !ETF_CODES.has(etfPathMatch[1])) {
        return sendError(response, 400, 'INVALID_CODE', 'ETF 代码不在监测清单内');
      }

      const intradayMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/intraday$/);
      if (intradayMatch && request.method === 'GET') {
        const intraday = await service.getIntraday(intradayMatch[1]);
        return intraday
          ? sendJson(response, 200, intraday)
          : sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
      }

      const shareHistoryMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/share-history$/);
      if (shareHistoryMatch && request.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 250);
        if (![20, 60, 250].includes(days)) {
          return sendError(response, 400, 'INVALID_SHARE_DAYS', '历史视角仅支持 20、60 或 250 日');
        }
        const shareHistory = service.getShareHistory(shareHistoryMatch[1], days);
        return shareHistory
          ? sendJson(response, 200, shareHistory)
          : sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
      }

      const iopvHistoryMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/iopv-history$/);
      if (iopvHistoryMatch && request.method === 'GET') {
        const days = Number(url.searchParams.get('days') || 250);
        if (!Number.isInteger(days) || days < 1 || days > 250) {
          return sendError(response, 400, 'INVALID_IOPV_DAYS', 'IOPV 历史视角需为 1 至 250 日');
        }
        const history = service.getIopvHistory(iopvHistoryMatch[1], days);
        return history
          ? sendJson(response, 200, history)
          : sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
      }

      if (url.pathname === '/api/backtests/summary' && request.method === 'GET') {
        return sendJson(response, 200, await service.getBacktestSummary());
      }

      if (url.pathname === '/api/backtests/events' && request.method === 'GET') {
        const validated = validateBacktestFilters(url);
        if (validated.error) return sendError(response, 400, ...validated.error);
        const { filters } = validated;
        return sendJson(response, 200, await service.getBacktestEvents(filters));
      }

      const signalEventMatch = url.pathname.match(/^\/api\/backtests\/events\/(\d+)$/);
      if (signalEventMatch && request.method === 'GET') {
        const event = await service.getBacktestEvent(signalEventMatch[1]);
        return event
          ? sendJson(response, 200, event)
          : sendError(response, 404, 'SIGNAL_EVENT_NOT_FOUND', '信号事件不存在');
      }

      const detailMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})$/);
      if (detailMatch && request.method === 'GET') {
        const detail = service.getDetail(detailMatch[1]);
        return detail
          ? sendJson(response, 200, detail)
          : sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
      }

      if (url.pathname === '/api/export.csv' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const requestedType = url.searchParams.get('type') || (code ? 'daily' : 'summary');
        if (!CSV_TYPES.has(requestedType)) {
          return sendError(response, 400, 'INVALID_CSV_TYPE', 'CSV type 不在白名单内');
        }
        if (code && !ETF_CODES.has(code)) {
          return sendError(response, 400, 'INVALID_CODE', 'ETF 代码不在监测清单内');
        }
        if (['shares', 'iopv', 'daily'].includes(requestedType) && !code) {
          return sendError(response, 400, 'CODE_REQUIRED', '该 CSV 类型必须指定 ETF 代码');
        }
        let csv;
        let filename;
        if (requestedType === 'backtest') {
          const validated = validateBacktestFilters(url);
          if (validated.error) return sendError(response, 400, ...validated.error);
          const { filters } = validated;
          const { events } = await service.getBacktestEvents(filters);
          csv = toCsv([
            { key: 'code', label: '代码' },
            { key: 'name', label: '名称' },
            { key: 'category', label: '分类' },
            { key: 'signalDate', label: '信号日期' },
            { key: 'signalAvailableAt', label: '信号可用时间' },
            { key: 'earliestEntryDate', label: '最早入场日' },
            { key: 'entryPriceMode', label: '入场价格口径' },
            { key: 'entryPrice', label: '入场价' },
            { key: 'exitDate', label: '退出日' },
            { key: 'split', label: '数据切分' },
            { key: 'score', label: '评分' },
            { key: 'level', label: '等级' },
            { key: 'horizon', label: '预测周期' },
            { key: 'futureReturn', label: '未来收益' },
            { key: 'zeroCostReturn', label: '零成本未来收益' },
            { key: 'costDrag', label: '成本拖累' },
            { key: 'drawdown', label: '入场后盘中低点回撤' },
            { key: 'maxDrawdownMethod', label: '回撤口径' },
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
              signalAvailableAt: event.signalAvailableAt,
              earliestEntryDate: event.earliestEntryDate,
              entryPriceMode: event.entryPriceMode,
              entryPrice: csvNumberOrMissing(outcome.entryPrice),
              exitDate: outcome.exitDate,
              split: event.split === 'train' ? '训练期' : '验证期',
              score: event.score,
              level: event.level.label,
              horizon: `${filters.horizon}日`,
              futureReturn: csvNumberOrMissing(outcome.futureReturn),
              zeroCostReturn: csvNumberOrMissing(outcome.zeroCostReturn),
              costDrag: csvNumberOrMissing(outcome.costDrag),
              drawdown: csvNumberOrMissing(outcome.drawdown),
              maxDrawdownMethod: outcome.maxDrawdownMethod || '',
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
        } else if (code) {
          const detail = service.getDetail(code);
          if (!detail) return sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
          if (requestedType === 'shares') {
            const shareHistory = service.getShareHistory(code, 250);
            csv = toCsv([
              { key: 'tradeDate', label: '日期' },
              { key: 'shares', label: '官方总份额' },
              { key: 'shareDelta', label: '份额变化' },
              { key: 'close', label: '收盘价' },
              { key: 'estimatedSubscription', label: '估算净申赎' },
              { key: 'cumulativeShareDelta', label: '累计份额变化' },
              { key: 'cumulativeEstimatedSubscription', label: '累计估算净申赎' },
              { key: 'source', label: '来源' },
              { key: 'dataTime', label: '行情时间' },
              { key: 'capturedAt', label: '抓取时间' },
              { key: 'quoteStatus', label: '行情状态' },
              { key: 'officialShareDate', label: '官方份额日期' },
              { key: 'officialShareSource', label: '官方份额来源' },
              { key: 'officialShareFetchedAt', label: '官方份额抓取时间' }
            ], (shareHistory?.range?.points || []).map((point) => ({
              ...point,
              dataTime: detail.quote.dataTime,
              capturedAt: detail.quote.capturedAt,
              quoteStatus: detail.quote.quoteStatusLabel || detail.quote.quoteStatus,
              officialShareDate: point.tradeDate,
              officialShareSource: point.source,
              officialShareFetchedAt: point.officialFetchedAt || point.fetchedAt || null
            })));
            filename = `${code}-official-shares.csv`;
          } else if (requestedType === 'iopv') {
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
            { key: 'dataTime', label: '行情时间' },
            { key: 'capturedAt', label: '抓取时间' },
            { key: 'quoteStatus', label: '行情状态' },
            { key: 'officialShareDate', label: '官方份额日期' },
            { key: 'officialShareSource', label: '官方份额来源' },
            { key: 'officialShareFetchedAt', label: '官方份额抓取时间' },
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
            quoteStatus: row.quoteStatusLabel || row.quoteStatus,
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

      return sendError(response, 404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      logger.error(error?.stack || error);
      return sendError(response, 500, 'INTERNAL_ERROR', '服务内部错误');
    }
  });
  return server;
}

function serveFile(response, filePath, cacheControl = 'no-cache') {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(response, 404, { error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } });
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

module.exports = {
  createApp,
  toCsv,
  isValidDate,
  validateBacktestFilters
};

