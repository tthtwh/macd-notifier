import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEtfDividendYield, calculateDividendYieldChange, getSignalSchedule } from '../web/src/dividend-status.js';

test('ETF 分红率使用全量近一年每份分红，与策略是否持仓和回测起点无关', () => {
  const dividends = [
    { exDate: '2025-10-26', cashPerShare: 0.2 },
    { exDate: '2025-12-10', cashPerShare: 0.012 },
    { exDate: '2026-03-11', cashPerShare: 0.012 },
    { exDate: '2026-06-10', cashPerShare: 0.012 },
    { exDate: '2026-09-11', cashPerShare: 0.012 },
    { exDate: '2026-12-10', cashPerShare: 0.5 }
  ];
  const etfRows = [{ date: '2026-10-27', close: 2 }, { date: '2026-10-26', close: 1.2 }];
  const before = structuredClone({ dividends, etfRows });
  const actual = calculateEtfDividendYield({ dividends, etfRows, asOf: '2026-10-26' });
  assert.equal(actual.cashPerShare, 0.048);
  assert.equal(actual.yield, 0.04);
  assert.equal(actual.price, 1.2);
  assert.equal(actual.priceDate, '2026-10-26');
  assert.deepEqual({ dividends, etfRows }, before);
  // 输入没有持仓、策略所得分红或回测开始日，空仓也显示相同的 ETF 分红率。
  assert.equal(calculateEtfDividendYield({ dividends, etfRows, asOf: '2026-10-26' }).yield, 0.04);
});

test('ETF 分红率按历史截止日取最近真实价格，上市前留空，零分红返回零', () => {
  const etfRows = [{ date: '2024-01-03', close: 1.1 }, { date: '2024-01-02', close: 1 }];
  assert.deepEqual(calculateEtfDividendYield({ etfRows, asOf: '2024-01-01' }), {
    yield: null, cashPerShare: 0, price: null, priceDate: null
  });
  assert.deepEqual(calculateEtfDividendYield({ etfRows, asOf: '2024-01-02' }), {
    yield: 0, cashPerShare: 0, price: 1, priceDate: '2024-01-02'
  });
  const leapYear = calculateEtfDividendYield({
    etfRows: [{ date: '2024-02-29', close: 1 }], asOf: '2024-02-29',
    dividends: [{ exDate: '2023-02-28', cashPerShare: 0.1 }, { exDate: '2023-03-01', cashPerShare: 0.02 }]
  });
  assert.equal(leapYear.yield, 0.02);
});

test('历史国庆月末以实际交易日执行，不把 10 月 1 日当执行日', () => {
  const tradingDates = ['2024-09-27', '2024-09-30', '2024-10-08', '2024-10-31', '2024-11-01'];
  const actual = getSignalSchedule({ asOf: '2024-09-30', tradingDates });
  assert.deepEqual(actual, {
    isCheckDay: true, checkDate: '2024-09-30', executionDate: '2024-10-08', nextCheckDate: '2024-10-31',
    checkEstimated: false, executionEstimated: false, nextCheckEstimated: false, estimated: false
  });
  const beforeMonthEnd = getSignalSchedule({ asOf: '2024-09-27', tradingDates });
  assert.equal(beforeMonthEnd.isCheckDay, false);
  assert.equal(beforeMonthEnd.checkDate, '2024-09-30');
  assert.equal(beforeMonthEnd.executionDate, '2024-10-08');
  assert.equal(beforeMonthEnd.nextCheckDate, '2024-09-30');
});

test('历史截断仍用完整交易日历确认春节前月末与节后执行', () => {
  const actual = getSignalSchedule({
    asOf: '2025-01-27',
    tradingDates: ['2025-01-24', '2025-01-27', '2025-02-05', '2025-02-28', '2025-03-03']
  });
  assert.equal(actual.isCheckDay, true);
  assert.equal(actual.checkDate, '2025-01-27');
  assert.equal(actual.executionDate, '2025-02-05');
  assert.equal(actual.nextCheckDate, '2025-02-28');
  assert.equal(actual.estimated, false);
});

test('缺少后续交易日时仅返回带估算标记的日期，不能确认正式月末', () => {
  const actual = getSignalSchedule({ asOf: '2024-09-30', tradingDates: ['2024-09-27', '2024-09-30'] });
  assert.equal(actual.isCheckDay, null);
  assert.equal(actual.checkDate, '2024-09-30');
  assert.equal(actual.executionDate, '2024-10-01');
  assert.equal(actual.nextCheckDate, '2024-10-31');
  assert.equal(actual.checkEstimated, true);
  assert.equal(actual.executionEstimated, true);
  assert.equal(actual.nextCheckEstimated, true);
  assert.equal(actual.estimated, true);
  const monthEndUnknown = getSignalSchedule({ asOf: '2024-09-27', tradingDates: ['2024-09-30', '2024-09-27'] });
  assert.equal(monthEndUnknown.isCheckDay, false, '已知还有同月交易日，可确认不是检查日');
  assert.equal(monthEndUnknown.checkEstimated, true, '但缺少下月数据，不能确认哪个日期是月末');
});

function yieldChangeSeries({ price = 90, newPoint = 0.1, removedPoint = 2 } = {}) {
  const series = Array.from({ length: 254 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    priceClose: 100, dividendYield: 0.05, percentile: 0.6, dividendPoints: 0
  }));
  series[1].dividendPoints = removedPoint;
  series.at(-1).priceClose = price;
  series.at(-1).dividendPoints = newPoint;
  series.at(-1).dividendYield = (5 + newPoint - removedPoint) / price;
  return series;
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test('历史分红移出导致股息率下降时，不把价格下跌的正贡献解释为下降原因', () => {
  const series = yieldChangeSeries();
  const change = calculateDividendYieldChange({ series, asOf: series.at(-1).date });
  assert.ok(change.priceChange < 0);
  assert.ok(change.priceEffect > 0);
  assert.ok(change.total < 0);
  assert.equal(change.dominantSource, 'removed');
  closeTo(change.removedEffect, -2 / 90);
  closeTo(change.newEffect + change.removedEffect + change.priceEffect, change.total);
});

test('三项贡献合计等于总变化，并按同方向最大贡献选择新增、价格或零变化', () => {
  for (const [input, expectedSource] of [
    [{ price: 100, newPoint: 2, removedPoint: 0.2 }, 'new'],
    [{ price: 50, newPoint: 0, removedPoint: 0 }, 'price'],
    [{ price: 100, newPoint: 0.5, removedPoint: 0.5 }, null]
  ]) {
    const series = yieldChangeSeries(input);
    const change = calculateDividendYieldChange({ series, asOf: series.at(-1).date });
    assert.equal(change.dominantSource, expectedSource);
    closeTo(change.newEffect + change.removedEffect + change.priceEffect, change.total);
    closeTo(change.total, change.latestYield - change.prevYield);
  }
});

test('前后股息率、价格或移入移出点缺失时不伪造零值或变化', () => {
  for (const [index, field, value] of [
    [252, 'dividendYield', null], [253, 'dividendYield', null],
    [252, 'priceClose', null], [253, 'priceClose', 0],
    [253, 'dividendPoints', null], [1, 'dividendPoints', null],
    [252, 'dividendYield', '0.05'], [253, 'priceClose', Infinity]
  ]) {
    const series = yieldChangeSeries();
    series[index][field] = value;
    assert.equal(calculateDividendYieldChange({ series, asOf: series.at(-1).date }), null, `${index}.${field}`);
  }
  const short = yieldChangeSeries().slice(0, 252);
  assert.equal(calculateDividendYieldChange({ series: short, asOf: short.at(-1).date }), null);
});

test('分位缺失保留 null，已有有效股息率拆解仍可展示', () => {
  const series = yieldChangeSeries();
  series[252].percentile = null;
  series[253].percentile = undefined;
  const change = calculateDividendYieldChange({ series, asOf: series.at(-1).date });
  assert.equal(change.prevPct, null);
  assert.equal(change.latestPct, null);
  assert.equal(change.dominantSource, 'removed');
});

test('历史截止日不读取未来数值，也不修改原始序列', () => {
  const series = yieldChangeSeries();
  const asOf = series.at(-1).date;
  const expected = calculateDividendYieldChange({ series, asOf });
  const future = { date: '2026-01-01' };
  for (const field of ['dividendYield', 'priceClose', 'dividendPoints', 'percentile']) {
    Object.defineProperty(future, field, { get() { throw new Error(`不可读取未来 ${field}`); } });
  }
  const before = structuredClone(series);
  series.forEach(Object.freeze);
  const withFuture = Object.freeze([...series, future]);
  assert.deepEqual(calculateDividendYieldChange({ series: withFuture, asOf }), expected);
  assert.deepEqual(series, before);
});
