import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, runBacktestDetails } from '../web/src/backtest.js';
import { applyTradeCapital, valueOpenPosition } from '../web/src/trade-capital.js';

const rows = [
  { date: '2026-09-01', hist: -1, open: 10, close: 10 },
  { date: '2026-09-02', hist: -1, open: 10, close: 10 },
  { date: '2026-09-03', hist: 1, open: 10, close: 11 },
  { date: '2026-09-04', hist: -1, open: 12, close: 10 },
  { date: '2026-09-07', hist: -1, open: 9, close: 8 },
];
const options = { slow: 1, signal: 1, feeRate: 0.0003 };
test('次日开盘按下一行情行成交，跨周末且不使用信号日开盘价', () => {
  const [same] = runBacktest(rows, { ...options, executionMode: 'sameClose' });
  const [next] = runBacktest(rows, { ...options, executionMode: 'nextOpen' });
  assert.equal(same.entryPrice, 11);
  assert.equal(same.exitPrice, 10);
  assert.equal(next.entryDate, '2026-09-04');
  assert.equal(next.exitDate, '2026-09-07');
  assert.equal(next.entrySignalDate, '2026-09-03');
  assert.equal(next.exitSignalDate, '2026-09-04');
  assert.equal(next.entryPrice, 12);
  assert.equal(next.exitPrice, 9);
  assert.equal(next.holdingDays, 1);
  assert.equal(next.netReturn, -0.2506);
  assert.equal(applyTradeCapital([next], 100000)[0].currentCapital, 74940);
});
test('缺少次日开盘时不伪造已完成交易，也不回退用收盘价', () => {
  assert.equal(runBacktest(rows.slice(0, 4), { ...options, executionMode: 'sameClose' }).length, 1);
  assert.equal(runBacktest(rows.slice(0, 4), { ...options, executionMode: 'nextOpen' }).length, 0);
  assert.equal(runBacktest(rows.map(r => ({ ...r, open: undefined })), { ...options, executionMode: 'nextOpen' }).length, 0);
});
test('默认次日开盘买入、信号当天收盘卖出；卖出信号落在买入当天时按 T+1 顺延到次日开盘', () => {
  const [trade] = runBacktest(rows, options);
  assert.equal(trade.entryDate, '2026-09-04');
  assert.equal(trade.exitDate, '2026-09-07');
  assert.equal(trade.entrySignalDate, '2026-09-03');
  assert.equal(trade.exitSignalDate, '2026-09-04');
  assert.equal(trade.entryPrice, 12);
  assert.equal(trade.exitPrice, 9);
  assert.equal(trade.holdingDays, 1);
  assert.equal(trade.reason, 'T+1 限制，次日开盘卖出');
  assert.ok(Math.abs(trade.netReturn - (9 / 12 - 1 - 0.0006)) < 1e-12);
});

test('T+1：买入当天出现卖出信号且没有次日数据时，持仓保留而不产生当日买卖', () => {
  const result = runBacktestDetails(rows.slice(0, 4), options);
  assert.deepEqual(result.trades, [], '不能当天买当天卖');
  assert.equal(result.openPosition.entryDate, '2026-09-04');
  assert.equal(result.openPosition.exitSignalDate, '2026-09-04');
  assert.equal(result.openPosition.reason, '待下一交易日开盘卖出');
  assert.equal(result.openPosition.holdingDays, 0);
});

test('混合模式跨周末买入，持有区间风险不计入买入前价格', () => {
  const data = [
    ...rows.slice(0, 2),
    { date: '2026-09-04', hist: 1, open: 2, close: 1 },
    { date: '2026-09-07', hist: 2, open: 12, close: 11 },
    { date: '2026-09-08', hist: -1, open: 8, close: 13 },
  ];
  const [trade] = runBacktest(data, { ...options, executionMode: 'nextOpenBuySameCloseSell' });
  assert.equal(trade.entryDate, '2026-09-07');
  assert.equal(trade.exitDate, '2026-09-08');
  assert.equal(trade.entryPrice, 12);
  assert.equal(trade.exitPrice, 13);
  assert.equal(trade.holdingDays, 1);
  assert.equal(trade.risk, 1 / 12);
});

test('混合模式缺少买入开盘价或尚未出现卖出信号时，不产生完成交易', () => {
  assert.equal(runBacktest(rows.slice(0, 3), options).length, 0);
  for (const open of [undefined, NaN, 0, -1]) {
    assert.equal(runBacktest(rows.map((row, i) => i === 3 ? { ...row, open } : row), options).length, 0);
  }
  assert.equal(runBacktest(rows.map(row => ({ ...row, hist: Math.abs(row.hist) })), options).length, 0);
});

test('未卖出持仓与已实现交易分开，仅计买入手续费', () => {
  const data = rows.slice(0, 4).map((row, i) => i === 3 ? { ...row, hist: 2, close: 15 } : row);
  const result = runBacktestDetails(data, options);
  assert.equal(result.trades.length, 0);
  assert.equal(result.openPosition.entryPrice, 12);
  assert.equal(result.openPosition.latestPrice, 15);
  assert.equal(result.openPosition.exitDate, null);
  assert.equal(result.openPosition.unrealizedReturn, 0.25 - options.feeRate);
  const position = valueOpenPosition(result.openPosition, 100000);
  assert.equal(position.unrealizedProfit, 24970);
  assert.equal(position.equity, 124970);
});

test('最后一天买入信号未到次日开盘时，仅返回待买入，不伪造持仓', () => {
  const result = runBacktestDetails(rows.slice(0, 3), options);
  assert.equal(result.openPosition, null);
  assert.equal(result.pendingEntry.signalDate, '2026-09-03');
  assert.deepEqual(result.trades, []);
});

test('盘中开盘价可执行昨日买入信号，最新价仅用于估值', () => {
  const result = runBacktestDetails(rows.slice(0, 3), {
    ...options, latestQuote: { date: '2026-09-04', open: 12, price: 13 },
  });
  assert.equal(result.openPosition.entryDate, '2026-09-04');
  assert.equal(result.openPosition.entryPrice, 12);
  assert.equal(result.openPosition.latestPrice, 13);
  assert.equal(result.openPosition.holdingDays, 0);
  assert.equal(result.pendingEntry, null);
  assert.equal(result.trades.length, 0);
});

test('次日卖出尚未成交时保留持仓；有次日开盘后转成完成交易', () => {
  const config = { ...options, executionMode: 'nextOpen' };
  const pending = runBacktestDetails(rows.slice(0, 4), config);
  assert.equal(pending.openPosition.exitSignalDate, '2026-09-04');
  assert.equal(pending.openPosition.reason, '待下一交易日开盘卖出');
  const filled = runBacktestDetails(rows.slice(0, 4), {
    ...config, latestQuote: { date: '2026-09-07', open: 9, price: 8 },
  });
  assert.equal(filled.openPosition, null);
  assert.equal(filled.trades[0].exitPrice, 9);
});

test('在历史截止日估值不使用之后的卖出，持仓资金衔接已完成交易', () => {
  const data = [...rows,
    { date: '2026-09-08', hist: 1, open: 8, close: 9 },
    { date: '2026-09-09', hist: 2, open: 10, close: 11 },
    { date: '2026-09-10', hist: -1, open: 9, close: 8 },
  ];
  const result = runBacktestDetails(data.filter(row => row.date <= '2026-09-09'), options);
  const closed = applyTradeCapital(result.trades, 100000);
  const position = valueOpenPosition(result.openPosition, closed.at(-1).currentCapital);
  assert.equal(result.trades.length, 1);
  assert.equal(position.entryDate, '2026-09-09');
  assert.equal(position.latestPrice, 11);
  assert.equal(position.capitalBefore, closed[0].currentCapital);
  assert.ok(Math.abs(position.equity - position.capitalBefore * (1.1 - options.feeRate)) < 1e-8);
  assert.equal(runBacktestDetails(data, options).openPosition, null);
});
