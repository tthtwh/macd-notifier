import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTradeCapital } from '../web/src/trade-capital.js';

test('逐笔按上一笔结束资金复利计算收益和当前资金', () => {
  const trades = applyTradeCapital([
    { id: 1, netReturn: 0.1 },
    { id: 2, netReturn: -0.2 },
    { id: 3, netReturn: 0.5 },
  ], 100000);

  assert.deepEqual(
    trades.map(({ capitalBefore, profit, currentCapital }) => ({ capitalBefore, profit, currentCapital })),
    [
      { capitalBefore: 100000, profit: 10000, currentCapital: 110000 },
      { capitalBefore: 110000, profit: -22000, currentCapital: 88000 },
      { capitalBefore: 88000, profit: 44000, currentCapital: 132000 },
    ],
  );
});

test('资金计算不修改原始交易数据', () => {
  const source = [{ netReturn: 0.1 }];
  const [trade] = applyTradeCapital(source, 100000);

  assert.equal(source[0].profit, undefined);
  assert.notEqual(trade, source[0]);
});

test('拒绝无效初始资金', () => {
  assert.throws(() => applyTradeCapital([], -1), /非负数字/);
  assert.throws(() => applyTradeCapital([], 'not-a-number'), /非负数字/);
});
