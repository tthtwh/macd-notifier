import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorScale, scaleMoneyView } from '../web/src/money-anchor.js';

test('折算比例 = 当前持仓 / 当前策略权益', () => {
  assert.equal(anchorScale(150000, 644131), 150000 / 644131);
  assert.equal(anchorScale('150000', 644131), 150000 / 644131);
});

test('未填写基准或权益无效时不折算', () => {
  assert.equal(anchorScale(0, 644131), 1);
  assert.equal(anchorScale(-1000, 644131), 1);
  assert.equal(anchorScale('', 644131), 1);
  assert.equal(anchorScale('abc', 644131), 1);
  assert.equal(anchorScale(150000, 0), 1);
  assert.equal(anchorScale(150000, Number.NaN), 1);
});

test('折算后今天的权益等于填写的持仓，收益率保持不变', () => {
  const trades = [
    { netReturn: 0.1, capitalBefore: 100000, profit: 10000, currentCapital: 110000 },
    { netReturn: -0.2, capitalBefore: 110000, profit: -22000, currentCapital: 88000 },
  ];
  const stats = { totalReturn: -0.12, finalCapital: 88000, count: 2 };
  const position = { unrealizedReturn: 0.25, capitalBefore: 88000, unrealizedProfit: 22000, equity: 110000 };
  const scale = anchorScale(150000, position.equity);

  const view = scaleMoneyView({ trades, position, stats, capital: 100000 }, scale);

  assert.equal(view.capital, 100000 * scale, '等效起始资金按同一比例缩放');
  assert.equal(view.position.equity, 150000, '今天的持仓估值等于填写值');
  assert.equal(view.stats.finalCapital, 88000 * scale);
  assert.equal(view.trades[1].currentCapital, 88000 * scale);
  assert.equal(view.position.capitalBefore, 88000 * scale, '持仓成本也按同一比例缩放，收益曲线才不会跳变');
  assert.equal(view.trades[0].netReturn, 0.1, '收益率不变');
  assert.equal(view.position.unrealizedReturn, 0.25, '浮动收益率不变');
  assert.equal(trades[0].profit, 10000, '不修改原始交易');
});

test('比例为一或无效时原样返回', () => {
  const trades = [{ netReturn: 0.1, capitalBefore: 1, profit: 0.1, currentCapital: 1.1 }];
  const view = scaleMoneyView({ trades, position: null, stats: { finalCapital: 1.1 }, capital: 1 }, 1);

  assert.equal(view.trades, trades);
  assert.equal(view.position, null);
  assert.equal(scaleMoneyView({ trades, position: null, stats: {}, capital: 1 }, Number.NaN).trades, trades);
});

test('没有持仓时按已实现期末资金折算', () => {
  const stats = { totalReturn: 0.5, finalCapital: 150000, count: 1 };
  const scale = anchorScale(150000, stats.finalCapital);

  assert.equal(scale, 1);
  assert.equal(scaleMoneyView({ trades: [], position: null, stats, capital: 100000 }, scale).stats.finalCapital, 150000);
});
