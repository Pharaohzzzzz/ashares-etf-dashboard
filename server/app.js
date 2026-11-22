'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { API_VERSION, getBuildId } = require('./runtime-version');
const { isExtendedShareRange } = require('./extended-share-history');

const CSV_TYPES = new Set(['summary', 'daily', 'shares', 'iopv']);
const REFRESH_METHODS = {
  quotes: 'refreshQuotes',
  history: 'syncHistoricalBars',
  shares: 'syncOfficialShareHistory',
  iopv: 'refreshIopv'
};
const CATALOG_ERRORS = new Set([
  'INVALID_CODE',
  'ETF_NOT_FOUND',
  'ETF_ALREADY_EXISTS',
  'ETF_CAPACITY_REACHED',
  'NOT_ETF',
  'UNSUPPORTED_MARKET',
  'INVALID_CATEGORY',
  'INVALID_NAME',
  'INVALID_TONE'
]);

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

function shareRangeParameter(value) {
  if (value === 'all') return 'all';
  const days = Number(value || 250);
  return [20, 60, 250, 750, 1250].includes(days) ? days : null;
}

function clientError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readJsonBody(request, limit = 100_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw clientError('PAYLOAD_TOO_LARGE', '请求体过大', 413);
  }
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed;
  } catch {
    throw clientError('INVALID_JSON', '请求体必须为 JSON 对象');
  }
}

function createApp({
  service,
  publicDir = path.join(__dirname, '..', 'public'),
  logger = console,
  runtimeVersion = {
    apiVersion: API_VERSION,
    buildId: getBuildId()
  }
}) {
  const withRuntime = (data) => ({
    ...data,
    apiVersion: runtimeVersion.apiVersion,
    buildId: runtimeVersion.buildId
  });
  const isEnabledEtf = (code) => {
    if (typeof service.getEtfConfig === 'function') {
      return Boolean(service.getEtfConfig(code));
    }
    return service.getSummary().etfs.some((row) => row.code === code);
  };
  const catalogResponse = (etf) => withRuntime({
    etf,
    summary: service.getSummary(),
    catalog: typeof service.getCatalogState === 'function'
      ? service.getCatalogState()
      : null
  });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/health') {
        if (typeof service.getQuoteHealth === 'function') {
          return sendJson(response, 200, withRuntime(service.getQuoteHealth()));
        }
        const summary = service.getSummary();
        const status = !summary.etfs.length
          ? 'starting'
          : summary.quoteStatus === 'ok'
            ? 'ok'
            : 'degraded';
        return sendJson(response, 200, withRuntime({
          status,
          initializedAt: service.initializedAt,
          dataTime: summary.dataTime,
          etfs: summary.etfs.length,
          initializing: service.initializing,
          quoteStatus: summary.quoteStatus || null,
          staleCount: summary.staleCount ?? null,
          oldestDataTime: summary.oldestDataTime || null,
          latestDataTime: summary.latestDataTime || null,
          shareSyncStatus: summary.shareSyncStatus || null
        }));
      }

      if (url.pathname === '/api/summary' && request.method === 'GET') {
        return sendJson(response, 200, withRuntime(service.getSummary()));
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const kind = url.searchParams.get('kind');
        if (kind !== null) {
          if (!Object.hasOwn(REFRESH_METHODS, kind)) {
            return sendError(response, 400, 'INVALID_REFRESH_KIND', '数据类型无效');
          }
          const result = await service[REFRESH_METHODS[kind]]();
          return sendJson(response, 200, withRuntime(kind === 'quotes' ? result : service.getSummary()));
        }
        const summary = service.refreshAllData
          ? await service.refreshAllData()
          : await service.refreshQuotes();
        return sendJson(response, 200, withRuntime(summary));
      }

      if (url.pathname === '/api/shares/sync' && request.method === 'POST') {
        await service.syncOfficialShareHistory();
        return sendJson(response, 200, withRuntime(service.getSummary()));
      }

      if (url.pathname === '/api/etfs/manage' && request.method === 'GET') {
        if (typeof service.getCatalogState !== 'function') {
          return sendError(response, 501, 'CATALOG_UNAVAILABLE', '当前后台未提供 ETF 管理能力');
        }
        const catalog = service.getCatalogState();
        const includeSummary = url.searchParams.get('includeSummary') !== 'false';
        return sendJson(response, 200, withRuntime(includeSummary ? { ...catalog, summary: service.getSummary() } : catalog));
      }

      if (url.pathname === '/api/etfs/lookup' && request.method === 'GET') {
        const candidate = await service.lookupEtfCandidate(url.searchParams.get('code'));
        return sendJson(response, 200, withRuntime({ candidate }));
      }

      if (url.pathname === '/api/etfs' && request.method === 'POST') {
        const payload = await readJsonBody(request);
        const etf = await service.addEtf(payload);
        if (typeof service.backfillEtf === 'function') {
          setImmediate(() => {
            Promise.resolve(service.backfillEtf(etf.code)).catch((error) => {
              logger.error?.(error?.stack || error);
            });
          });
        }
        return sendJson(response, 201, catalogResponse(etf));
      }

      if (url.pathname === '/api/etfs/order' && request.method === 'PUT') {
        const payload = await readJsonBody(request);
        service.saveEtfOrder(payload);
        return sendJson(response, 200, withRuntime({
          catalog: service.getCatalogState(),
          summary: service.getSummary()
        }));
      }

      if (url.pathname === '/api/etfs/order/restore' && request.method === 'POST') {
        service.restoreEtfOrder();
        return sendJson(response, 200, withRuntime({
          catalog: service.getCatalogState(),
          summary: service.getSummary()
        }));
      }

      const restoreEtfMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})\/restore$/);
      if (restoreEtfMatch && request.method === 'POST') {
        const etf = service.restoreEtf(restoreEtfMatch[1]);
        return sendJson(response, 200, catalogResponse(etf));
      }

      const editEtfMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})$/);
      if (editEtfMatch && request.method === 'PATCH') {
        const payload = await readJsonBody(request);
        const etf = service.updateEtf(editEtfMatch[1], payload);
        return sendJson(response, 200, catalogResponse(etf));
      }

      if (editEtfMatch && request.method === 'DELETE') {
        const payload = await readJsonBody(request);
        if (payload.confirm !== true) {
          return sendError(
            response,
            400,
            'CONFIRMATION_REQUIRED',
            '移出监控需要二次确认'
          );
        }
        const etf = service.removeEtf(editEtfMatch[1]);
        return sendJson(response, 200, catalogResponse(etf));
      }

      const etfPathMatch = url.pathname.match(/^\/api\/etfs\/([^/]+)/);
      if (etfPathMatch && !isEnabledEtf(etfPathMatch[1])) {
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
      if (shareHistoryMatch && ['GET', 'POST'].includes(request.method)) {
        const days = shareRangeParameter(url.searchParams.get('days'));
        const enqueue = request.method === 'POST';
        if (days === null || (enqueue && !isExtendedShareRange(days))) {
          return sendError(response, 400, 'INVALID_SHARE_DAYS', enqueue
            ? '长历史补数仅支持 750、1250 日和全部'
            : '历史视角仅支持 20、60、250、750、1250 日和全部');
        }
        const shareHistory = enqueue
          ? service.startExtendedShareHistory(shareHistoryMatch[1], days)
          : service.getShareHistory(shareHistoryMatch[1], days);
        const status = enqueue && shareHistory?.backfill?.status === 'running' ? 202 : 200;
        return shareHistory
          ? sendJson(response, status, shareHistory)
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

      const detailMatch = url.pathname.match(/^\/api\/etfs\/(\d{6})$/);
      if (detailMatch && request.method === 'GET') {
        const detail = service.getDetail(detailMatch[1], { compact: url.searchParams.get('compact') === '1' });
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
        if (code && !isEnabledEtf(code)) {
          return sendError(response, 400, 'INVALID_CODE', 'ETF 代码不在监测清单内');
        }
        if (['shares', 'iopv', 'daily'].includes(requestedType) && !code) {
          return sendError(response, 400, 'CODE_REQUIRED', '该 CSV 类型必须指定 ETF 代码');
        }
        let csv;
        let filename;
        if (code) {
          const detail = requestedType === 'iopv' ? null : service.getDetail(code);
          if (requestedType !== 'iopv' && !detail) return sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
          if (requestedType === 'shares') {
            const days = shareRangeParameter(url.searchParams.get('days'));
            if (days === null) return sendError(response, 400, 'INVALID_SHARE_DAYS', '历史视角仅支持 20、60、250、750、1250 日和全部');
            const shareHistory = days === 250 && detail.shareHistory
              ? detail.shareHistory
              : service.getShareHistory(code, days);
            csv = toCsv([
              { key: 'tradeDate', label: '日期' },
              { key: 'shares', label: '官方总份额' },
              { key: 'shareDelta', label: '份额变化' },
              { key: 'close', label: '不复权收盘价' },
              { key: 'closeSource', label: '收盘价来源' },
              { key: 'estimatedSubscription', label: '估算净申赎' },
              { key: 'cumulativeShareDelta', label: '累计份额变化' },
              { key: 'cumulativeEstimatedSubscription', label: '累计估算净申赎' },
              { key: 'estimatedSegment', label: '估算累计区段' },
              { key: 'estimateGapReason', label: '估算缺口原因' },
              { key: 'shareActionSourceUrl', label: '份额折算公告' },
              { key: 'source', label: '来源' },
              { key: 'dataTime', label: '最新报价时间' },
              { key: 'capturedAt', label: '最新报价抓取时间' },
              { key: 'quoteStatus', label: '最新报价状态' },
              { key: 'officialShareDate', label: '官方份额日期' },
              { key: 'officialShareSource', label: '官方份额来源' },
              { key: 'officialShareFetchedAt', label: '官方份额抓取时间' }
            ], (shareHistory?.range?.points || []).map((point) => ({
              ...point,
              dataTime: detail.quote.dataTime,
              capturedAt: detail.quote.capturedAt,
              quoteStatus: detail.quote.quoteStatusLabel || detail.quote.quoteStatus,
              closeSource: Number.isFinite(point.close) ? '东方财富不复权日线' : '',
              officialShareDate: Number.isFinite(point.shares) ? point.tradeDate : null,
              officialShareSource: point.source,
              officialShareFetchedAt: point.officialFetchedAt || point.fetchedAt || null
            })));
            filename = days === 250 ? `${code}-official-shares.csv` : `${code}-official-shares-${days}.csv`;
          } else if (requestedType === 'iopv') {
            const iopvHistory = service.getIopvHistory(code, 250);
            if (!iopvHistory) return sendError(response, 404, 'ETF_NOT_FOUND', 'ETF 不存在');
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
            { key: 'quoteShares', label: '行情快照份额' },
            { key: 'shares', label: '当前官方份额' },
            { key: 'officialShares', label: '最新官方总份额' },
            { key: 'officialShareDate', label: '官方份额日期' },
            { key: 'officialShareSource', label: '官方份额来源' },
            { key: 'previousOfficialShares', label: '当前日上一官方份额' },
            { key: 'previousOfficialShareDate', label: '当前日上一官方份额日期' },
            { key: 'shareMetricStatus', label: '当前日份额状态' },
            { key: 'shareDelta', label: '当前日官方份额变化' },
            { key: 'estimatedSubscription', label: '当前日估算净申赎' },
            { key: 'latestOfficialShareDelta', label: '最近官方日份额变化' },
            { key: 'latestOfficialShareDeltaDate', label: '最近官方日份额变化日期' },
            { key: 'latestOfficialPreviousShares', label: '最近官方日上一份额' },
            { key: 'latestOfficialPreviousDate', label: '最近官方日上一份额日期' },
            { key: 'latestOfficialEstimatedSubscription', label: '最近官方日估算净申赎' },
            { key: 'latestOfficialMetricStatus', label: '最近官方日指标状态' },
            { key: 'scoreDate', label: '评分日期' },
            { key: 'estimatedSubscription5d', label: '近5日累计估算净申赎' },
            { key: 'estimatedSubscription5dStatus', label: '近5日累计状态' },
            { key: 'estimatedSubscription20d', label: '近20日累计估算净申赎' },
            { key: 'estimatedSubscription20dStatus', label: '近20日累计状态' },
            { key: 'shareStreak', label: '连续净申赎' },
            { key: 'sharePercentile', label: '份额历史分位' },
            { key: 'estimatedFundSize', label: '估算基金规模' },
            { key: 'volatility20d', label: '20日波动率' },
            { key: 'amountPercentile', label: '成交额历史分位' },
            { key: 'tradeDate', label: '交易日' },
            { key: 'dataTime', label: '行情时间' },
            { key: 'capturedAt', label: '抓取时间' },
            { key: 'quoteStatus', label: '行情状态' },
            { key: 'officialShareFetchedAt', label: '官方份额抓取时间' },
            { key: 'signals', label: '候选信号' }
          ];
          csv = toCsv(headers, summary.etfs.map((row) => ({
            ...row,
            premiumRate: Number.isFinite(row.premiumRate)
              ? `${(row.premiumRate * 100).toFixed(4)}%`
              : (row.premiumStatusLabel || '暂无'),
            shares: Number.isFinite(row.shares) ? row.shares : '数据不足',
            shareDelta: csvNumberOrMissing(row.shareDelta),
            estimatedSubscription: csvNumberOrMissing(row.estimatedSubscription),
            latestOfficialShareDelta: csvNumberOrMissing(row.latestOfficialShareDelta),
            latestOfficialEstimatedSubscription: csvNumberOrMissing(
              row.latestOfficialEstimatedSubscription
            ),
            estimatedSubscription5d: csvNumberOrMissing(row.estimatedSubscription5d),
            estimatedSubscription5dStatus: row.estimatedSubscription5dStatus === 'ready'
              ? '已就绪'
              : '历史积累中',
            estimatedSubscription20d: csvNumberOrMissing(row.estimatedSubscription20d),
            estimatedSubscription20dStatus: row.estimatedSubscription20dStatus === 'ready'
              ? '已就绪'
              : '历史积累中',
            shareStreak: row.shareStreak?.days
              ? `${row.shareStreak.label} ${row.shareStreak.days}日`
              : '无连续序列',
            sharePercentile: Number.isFinite(row.sharePercentile)
              ? `${(row.sharePercentile * 100).toFixed(1)}%`
              : '数据不足',
            volatility20d: Number.isFinite(row.volatility20d)
              ? `${(row.volatility20d * 100).toFixed(2)}%`
              : '历史积累中',
            amountPercentile: Number.isFinite(row.amountPercentile)
              ? `${(row.amountPercentile * 100).toFixed(1)}%`
              : '待数据',
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
      if (CATALOG_ERRORS.has(error?.code) || error?.statusCode) {
        return sendError(
          response,
          error.statusCode || 400,
          error.code || 'INVALID_REQUEST',
          error.message
        );
      }
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
  toCsv
};

