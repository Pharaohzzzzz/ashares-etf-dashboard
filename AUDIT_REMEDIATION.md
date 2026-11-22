# ETF 资金雷达审计整改报告

日期：2026-11-20  
范围：`ashares-etf-dashboard` 当前工作区、SQLite 历史数据、HTTP API、CSV、调度器、备份恢复和桌面/移动端界面。

> 2026-11-21 更新：信号评估页面、历史回测调度、评估 API 和专属 CSV 已从当前产品移除。本文保留为历史审计整改记录，其中回测相关条目仅说明当时的整改过程；当前版本保留首页异常资金评分。

> 2026-11-22 补充：当前版本从运行状态中移除了回测任务，并保留旧库尚存的历史回测表。新库只初始化现行功能所需表。现行口径和运维步骤见 [README](README.md)。

## 结论

审计报告的 P1-1 至 P1-5、P2-1 至 P2-8 均已在当前代码中修复。历史日线、官方份额、IOPV、信号事件和回测运行未删除；旧回测参数版本保留为历史记录，新口径使用 `signal-score-v2.0.0`。

## P1 修复

| 问题 | 修复位置 | 修复前后 |
|---|---|---|
| P1-1 回测前视偏差 | `server/signal-backtest.js`、`server/db.js`、`server/app.js`、`public/app.js` | 旧版以信号日收盘价入场；新版在下一可交易日开盘入场，记录 `signalDate`、`signalAvailableAt`、`earliestEntryDate`、`entryPriceMode`，基准使用相同进出场与成本规则。回撤改为入场后持有期最低价。 |
| P1-2 启动补数 | `server/service.js`、`server/db.js` | 旧版只判断日线是否达到 250 根；新版按报价、日线、官方份额、IOPV、回测日期差异补数，并将状态、失败日期和重试次数写入 `sync_tasks`。 |
| P1-3 交易日历 | `server/trading-calendar.js`、`server/scheduler.js`、`server/db.js` | 旧版只排除周末；新版缓存深交所官方 `monthList` 休市状态，处理法定节假日、调休状态与午休，接口失败时标记缓存可能过期。 |
| P1-4 官方份额原子完成 | `server/db.js`、`server/service.js` | 旧版空结果或部分结果也会标记日期成功；新版按交易所/日期/目标 ETF 核对实际记录，份额写入与完成状态同一事务，空表为 `pending`、部分返回为 `partial`。 |
| P1-5 逐 ETF 新鲜度 | `server/db.js`、`server/service.js`、`public/app.js` | 新版返回逐 ETF 的 `capturedAt`、`dataTime`、`quoteStatus`、`staleness`、`isStale`，概要返回最旧/最新时间和“部分数据异常”整体状态，表格标灰并显示过期标签。 |

## P2 修复

| 问题 | 修复位置 | 修复前后 |
|---|---|---|
| P2-1 IOPV 统计标签 | `server/service.js`、`public/app.js` | 不再把非 09:30 首样本称为“开盘折溢价”；统一为“首个记录时点”，返回首末时间、样本数，并覆盖 1/2/完整分钟样本测试。 |
| P2-2 官方份额 provenance | `server/db.js` | 新增 `official_fetched_at`、`snapshot_fetched_at`。行情快照覆盖尝试不会改写官方值、来源或官方抓取时间。 |
| P2-3 API/CSV 校验与来源字段 | `server/app.js`、`server/metrics.js` | 代码、日期、分类、等级、切分、周期、CSV type 白名单校验；稳定错误码；内部错误隐藏；总览和份额 CSV 增加行情与官方份额 provenance。 |
| P2-4 回测稳健性 | `server/signal-backtest.js`、`public/app.js` | 增加每 ETF 持仓区间去重、有效独立样本、重叠剔除数、固定种子日期分块 bootstrap 95% 区间，以及验证期滚动子样本。 |
| P2-5 缺失数值 | `server/provider.js`、`server/service.js` | `-`、空字符串、NaN、负成交量/成交额返回 `null`，合法 0 保留；总成交额只汇总有效值并返回覆盖数量。 |
| P2-6 备份恢复清理 | `server/maintenance.js`、`server/rotating-logger.js`、`scripts/*.js` | 每日在线备份、完整性校验、14 份保留、恢复前安全备份、恢复后校验、快照/日志保留策略、WAL checkpoint、5 MB 日志轮转均已实现。 |
| P2-7 键盘与可访问性 | `public/index.html`、`public/app.js`、`public/styles.css` | 抽屉改为模态 dialog，聚焦关闭按钮、Tab 循环、Escape 关闭、焦点恢复；排序表头改为按钮并维护 `aria-sort`。 |
| P2-8 误导性命名 | `server/metrics.js`、`public/app.js`、README | 生产名称改为“异常放量+份额变化候选”；只允许历史规则对照显示“旧版护盘候选（行为代理）”。 |

## 数据迁移与保护

- 修改前已生成 `data/backups/dashboard-baseline-20261120-023609.db`，完整性检查通过。
- schema 变更使用 `ALTER TABLE ... ADD COLUMN` 和 `CREATE TABLE/INDEX IF NOT EXISTS` 增量迁移。
- 旧回测运行、历史事件、日线、官方份额和 IOPV 样本保留。
- 新回测参数版本为 `signal-score-v2.0.0`，不会把旧口径结果伪装成新版本。
- 当前数据库最终执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`。

## 测试证据

自动化测试覆盖：

- 信号日收盘后生成、次日开盘入场、成本/基准/盘中低点回撤。
- 520 根旧日线、新报价日期、中间官方份额缺口启动补数。
- 国庆、春节、午休、调休状态、日历缓存失败。
- 官方份额空表、部分返回、事务中断和恢复重试。
- 13 只报价失败/1 只成功、少量过期行。
- 1/2/完整 IOPV 分钟样本与首条时间标签。
- API 非法参数、稳定错误码、内部异常隐藏。
- 固定数据集重复回测与 bootstrap 确定性。
- 临时数据库在线备份、清理、安全恢复和日志轮转。
- dialog/焦点/排序控件静态语义。

最终验收实际结果：

- `npm test`：71 项通过，0 失败。
- `npm audit --omit=dev --audit-level=moderate`：0 个漏洞。
- 全部 30 个 JavaScript 文件通过 `node --check`。
- 当前数据库 `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 返回空结果。
- 在线备份实际生成 `data/backups/dashboard-20261120-025236.db`，备份完整性检查通过；日常清理删除 0 条快照、0 条日志。
- 真实浏览器在桌面、390px、320px 下无整页横向溢出；排序、Enter/Space、dialog Tab 循环、Escape、焦点恢复、IOPV 图表均通过，控制台错误/警告为 0。
- 当前服务健康，14 只 ETF 可访问；行情、日线、官方份额、IOPV、回测均更新到 2026-11-19。

## 已知限制

- 上交所逐分钟 IOPV 盘后可追溯性受官方接口限制；服务盘后首次启动时只能保留实际抓取到的时点，不用 0 或推算补齐。
- 交易日历当前以深交所官方 A 股交易日历作为沪深市场缓存源；源不可用时保留旧缓存并明确告警。
- 基准成本 0.10% 单边是透明、固定的保守假设，并非用户实际券商费率。
- bootstrap 和滚动子样本描述历史数据不确定性，不构成未来收益保证。
