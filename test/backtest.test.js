import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../web/src/backtest.js';
import { applyTradeCapital } from '../web/src/trade-capital.js';

const rows = [
  { date: '2026-09-01', hist: -1, open: 10, close: 10 },
  { date: '2026-09-02', hist: -1, open: 10, close: 10 },
  { date: '2026-09-03', hist: 1, open: 10, close: 11 },
  { date: '2026-09-04', hist: -1, open: 12, close: 10 },
  { date: '2026-09-07', hist: -1, open: 9, close: 8 },
];
const options = { slow: 1, signal: 1, feeRate: 0.0003 };
test('次日开盘按下一行情行成交，跨周末且不使用信号日开盘价', () => {
  const [same] = runBacktest(rows, options);
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
  assert.equal(runBacktest(rows.slice(0, 4), options).length, 1);
  assert.equal(runBacktest(rows.slice(0, 4), { ...options, executionMode: 'nextOpen' }).length, 0);
  assert.equal(runBacktest(rows.map(r => ({ ...r, open: undefined })), { ...options, executionMode: 'nextOpen' }).length, 0);
});
