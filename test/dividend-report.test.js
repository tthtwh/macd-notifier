import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runDividendBacktest } from '../web/src/dividend-strategy.js';
import { buildTradeReport } from '../web/src/dividend-report.js';

const DATES = [
  '2024-01-31', '2024-02-01', '2024-02-15', '2024-02-16', '2024-02-19', '2024-02-20',
  '2024-02-29', '2024-03-01', '2024-03-29', '2024-04-01', '2024-04-30', '2024-05-01',
  '2024-05-31', '2024-06-03', '2024-06-28', '2024-07-01', '2024-07-31', '2024-08-01'
];
const PERCENTILES = {
  '2024-01-31': 0.95, '2024-02-29': 0.95, '2024-03-29': 0.45,
  '2024-04-30': 0.30, '2024-05-31': 0.30, '2024-06-28': 0.95, '2024-07-31': 0.30
};
const PRICES = {
  '2024-02-01': 100, '2024-03-01': 200, '2024-04-01': 150, '2024-05-01': 120,
  '2024-06-03': 180, '2024-07-01': 100, '2024-08-01': 110
};

function scenario(phase, etfStart = '2024-04-30') {
  const series = DATES.map(date => ({
    date, priceClose: 100, totalClose: PRICES[date] ?? 100,
    dividendYield: 0.04, percentile: PERCENTILES[date] ?? null
  }));
  const etfRows = phase === 'index' ? []
    : DATES.filter(date => phase === 'etf' || date >= etfStart)
      .map(date => ({ date, close: (PRICES[date] ?? 100) / 10 }));
  return runDividendBacktest({
    series, etfRows,
    dividends: [{ registerDate: '2024-02-15', exDate: '2024-02-16', payDate: '2024-02-19', cashPerShare: 1 }],
    initialCapital: 100000, feeRate: 0.01, startDate: DATES[0], endDate: DATES.at(-1)
  });
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

function assertFirstCycle(rows, averageCost) {
  const sells = rows.filter(row => row.side === 'sell' && row.date <= '2024-06-03');
  assert.equal(sells.length, 2, '一次部分减仓后再清仓');
  assert.equal(sells.at(-1).toLevel, 0);
  let profit = 0;
  let basis = 0;
  for (const row of sells) {
    closeTo(row.costBasis, row.quantity * averageCost);
    closeTo(row.profit, row.amount - row.fee - row.costBasis);
    profit += row.profit;
    basis += row.costBasis;
    closeTo(row.cycleRealizedReturn, profit / basis);
  }
  assert.ok(rows.filter(row => row.side === 'buy').every(row => row.cycleRealizedReturn === null));
  return sells.at(-1);
}

test('指数报表按含入场费用的平均成本累计部分卖出，清仓后新一轮重新计收益', () => {
  const result = scenario('index');
  const rows = buildTradeReport(result);
  const firstBuys = rows.filter(row => row.side === 'buy' && row.date < '2024-04-01');
  assert.deepEqual(firstBuys.map(row => [row.amount, row.fee, row.quantity]), [[25000, 250, 250], [12375, 123.75, 61.875]]);
  const averageCost = (25000 + 250 + 12375 + 123.75) / (250 + 61.875);
  assertFirstCycle(rows, averageCost);
  const nextCycleSale = rows.at(-1);
  closeTo(nextCycleSale.costBasis, nextCycleSale.quantity * 100 * 1.01);
  closeTo(nextCycleSale.cycleRealizedReturn, (110 * 0.99) / (100 * 1.01) - 1);
  assert.ok(rows.every(row => row.phaseLabel === '指数模拟'));
});

test('ETF 报表复用含费用的持仓成本，现金分红另列、再投不产生已实现比例', () => {
  const result = scenario('etf');
  const rows = buildTradeReport(result);
  const acquisitions = rows.filter(row => row.side === 'buy' && row.date < '2024-04-01');
  assert.deepEqual(acquisitions.map(row => [row.type, row.amount, row.fee, row.quantity]), [
    ['rebalance', 25000, 250, 2500], ['reinvest', 2000, 20, 200], ['rebalance', 10000, 100, 500]
  ]);
  const averageCost = (25000 + 250 + 2000 + 20 + 10000 + 100) / (2500 + 200 + 500);
  const cleared = assertFirstCycle(rows, averageCost);
  const cycleSells = rows.filter(row => row.side === 'sell' && row.date <= '2024-06-03');
  const cycleProfit = cycleSells.reduce((sum, row) => sum + row.profit, 0);
  const cycleBasis = cycleSells.reduce((sum, row) => sum + row.costBasis, 0);
  closeTo(cleared.cycleRealizedReturn, cycleProfit / cycleBasis);
  assert.equal(result.dividends[0].amount, 2500);
  assert.equal(result.dividends[0].status, '已到账');
  assert.notEqual(cleared.cycleRealizedReturn, (cycleProfit + 2500) / cycleBasis, '现金分红不加入卖出盈利分子');
  const reinvest = rows.find(row => row.type === 'reinvest');
  assert.equal(reinvest.cycleRealizedReturn, null);
  assert.equal(reinvest.signalDividendYield, null);
  assert.equal(reinvest.signalPercentile, null);
  closeTo(rows.at(-1).cycleRealizedReturn, (11 * 0.99) / (10 * 1.01) - 1);
  assert.ok(rows.every(row => row.phaseLabel === 'ETF历史回测'));
});

test('上市切换开启 ETF 新成本账本与轮次，不混入指数阶段的已实现盈亏', () => {
  const rows = buildTradeReport(scenario('convert'));
  const priorIndexSale = rows.find(row => row.phase === 'index' && row.side === 'sell');
  assert.ok(Number.isFinite(priorIndexSale.profit));
  const conversion = rows.find(row => row.type === 'convert');
  assert.equal(conversion.amount, 27000);
  assert.equal(conversion.phaseLabel, '上市切换');
  assert.equal(conversion.cycleRealizedReturn, null);
  assert.equal(conversion.signalPercentile, null);
  const firstEtfSale = rows.find(row => row.phase === 'etf' && row.side === 'sell');
  assert.equal(firstEtfSale.costBasis, 27000);
  assert.equal(firstEtfSale.profit, 5076);
  closeTo(firstEtfSale.cycleRealizedReturn, 5076 / 27000);
  const cleared = rows.find(row => row.phase === 'etf' && row.side === 'sell' && row.toLevel === 0);
  closeTo(cleared.cycleRealizedReturn, 5076 / 27000);
  closeTo(rows.at(-1).cycleRealizedReturn, (11 * 0.99) / (10 * 1.01) - 1);
});

test('报表严格关联信号日，保留交易顺序与字段，金额买正卖负且不修改结果', () => {
  const result = {
    trades: [
      { date: '2024-02-01', signalDate: '2024-01-31', type: 'rebalance', side: 'buy', phase: 'etf', quantity: 100, amount: 1000, fee: 1, profit: null, reason: '保留说明' },
      { date: '2024-02-01', type: 'reinvest', side: 'buy', phase: 'etf', quantity: 100, amount: 1000, fee: 1, profit: null },
      { date: '2024-02-02', signalDate: '2024-01-30', type: 'rebalance', side: 'sell', phase: 'etf', quantity: 200, amount: 2200, fee: 2.2, costBasis: 2002, profit: 195.8 }
    ],
    signals: [{ signalDate: '2024-01-31', dividendYield: 0.045, percentile: 0.82 }],
    nav: [
      { date: '2024-02-01', equity: 99000, dividendYield: 0.99, percentile: 0.01 },
      { date: '2024-02-02', equity: 100000, dividendYield: 0.98, percentile: 0.02 }
    ]
  };
  const before = structuredClone(result);
  for (const row of [...result.trades, ...result.signals, ...result.nav]) Object.freeze(row);
  Object.freeze(result);
  const rows = buildTradeReport(result);
  assert.deepEqual(result, before);
  assert.deepEqual(rows.map(row => row.date), result.trades.map(trade => trade.date));
  for (let index = 0; index < rows.length; index += 1) {
    for (const [key, value] of Object.entries(result.trades[index])) assert.equal(rows[index][key], value);
  }
  assert.equal(rows[0].signalDividendYield, 0.045);
  assert.equal(rows[0].signalPercentile, 0.82);
  assert.equal(rows[1].signalDividendYield, null, '无信号日的再投不借用执行日指标');
  assert.equal(rows[2].signalPercentile, null, '不存在的信号日不回退到执行日指标');
  assert.deepEqual(rows.map(row => row.signedAmount), [1000, 1000, -2200]);
  assert.deepEqual(rows.map(row => row.equity), [99000, 99000, 100000]);
});

test('同日上市切换和调仓均关联扣除当日费用后的日终权益', () => {
  const result = scenario('convert', '2024-03-01');
  const sameDay = buildTradeReport(result).filter(row => row.date === '2024-03-01');
  assert.equal(sameDay.length, 2);
  const equity = result.nav.find(row => row.date === '2024-03-01').equity;
  assert.ok(sameDay.every(row => row.equity === equity));
  assert.equal(sameDay[0].phaseLabel, '上市切换');
  assert.equal(sameDay[1].phaseLabel, 'ETF历史回测');
  assert.equal(sameDay[0].cycleRealizedReturn, null);
});

test('每次卖出收益率只使用本次卖出成本，与多次减仓累计收益率区分', () => {
  for (const phase of ['index', 'etf']) {
    const rows = buildTradeReport(scenario(phase));
    const sells = rows.filter(row => row.side === 'sell' && row.date <= '2024-06-03');
    assert.equal(sells.length, 2);
    for (const row of sells) closeTo(row.sellReturn, (row.amount - row.fee - row.costBasis) / row.costBasis);
    closeTo(sells[0].sellReturn, sells[0].cycleRealizedReturn);
    assert.ok(Math.abs(sells[1].sellReturn - sells[1].cycleRealizedReturn) > 0.01, `${phase} 清仓仍展示本次卖出收益率`);
    assert.ok(rows.filter(row => row.side !== 'sell').every(row => row.sellReturn === null));
  }
});

test('首次调仓权益差额留空，不拿初始资金或此前每日权益作比较', () => {
  for (const phase of ['index', 'etf', 'convert']) {
    const result = scenario(phase);
    const first = buildTradeReport(result).find(row => row.type === 'rebalance');
    assert.ok(result.nav.some(row => row.date < first.date));
    assert.notEqual(first.equity, result.initialCapital, '首笔交易已扣费');
    assert.equal(first.equityChange, null);
    assert.equal(first.equityChangePct, null);
  }
});

test('权益变化以上次调仓日终值为基准，跳过上市切换与分红再投并保留期间损益', () => {
  const result = {
    trades: [
      { date: '2024-01-02', type: 'rebalance', side: 'buy', phase: 'index', quantity: 100 },
      { date: '2024-02-01', type: 'convert', side: 'buy', phase: 'convert', quantity: 1000 },
      { date: '2024-02-02', type: 'reinvest', side: 'buy', phase: 'etf', quantity: 100 },
      { date: '2024-03-01', type: 'rebalance', side: 'sell', phase: 'etf', quantity: 100, profit: 90, costBasis: 1000 },
      { date: '2024-03-04', type: 'reinvest', side: 'buy', phase: 'etf', quantity: 100 },
      { date: '2024-04-01', type: 'rebalance', side: 'sell', phase: 'etf', quantity: 100, profit: -90, costBasis: 1000 }
    ],
    nav: [
      { date: '2024-01-02', equity: 99000 },
      { date: '2024-02-01', equity: 110000 },
      { date: '2024-02-02', equity: 112000 },
      { date: '2024-03-01', equity: 108900 },
      { date: '2024-03-04', equity: 109500 },
      { date: '2024-04-01', equity: 98010 }
    ]
  };
  const rows = buildTradeReport(result);
  for (const index of [0, 1, 2, 4]) {
    assert.equal(rows[index].equityChange, null);
    assert.equal(rows[index].equityChangePct, null);
  }
  assert.equal(rows[1].sellReturn, null);
  assert.equal(rows[3].equityChange, 9900);
  closeTo(rows[3].equityChangePct, 0.1);
  assert.equal(rows[5].equityChange, -10890);
  closeTo(rows[5].equityChangePct, -0.1);
  for (const [previous, current] of [[rows[0], rows[3]], [rows[3], rows[5]]]) {
    closeTo(current.equityChange, current.equity - previous.equity);
    closeTo(current.equityChangePct, current.equityChange / previous.equity);
  }
});

// 在添加成本/报表字段之前捕获：覆盖两次建仓、部分卖出、清仓、
// ETF 分红到账与再投、指数转 ETF。交易报表不能改变任何每日净值或统计数。
const NAV_STATS_BASELINES = {
  index: '23065be98845d798158e18a506e32538a0c87afbd626b344bf94910bbfb4c52c',
  etf: '1aafa422df8c91b72d4a4331eea0c75e55ddb31d2667d72df68dc2f2fbe28019',
  convert: 'af5b1e2e96c9afdf3766372b6d1100d38b3da50bb32128d1f8f339604809f11b'
};
for (const [phase, expected] of Object.entries(NAV_STATS_BASELINES)) {
  test(`${phase} 成本字段与报表扩展不改变既有 nav/stats`, () => {
    const result = scenario(phase);
    const hash = () => createHash('sha256').update(JSON.stringify({ nav: result.nav, stats: result.stats })).digest('hex');
    assert.equal(hash(), expected);
    buildTradeReport(result);
    assert.equal(hash(), expected);
  });
}
