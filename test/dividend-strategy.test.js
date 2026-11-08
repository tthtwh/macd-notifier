import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  computeDividendSeries,
  resolveTargetPosition,
  buildMonthlySignals,
  buildYearlyReturns,
  runDividendBacktest,
  summarizeNav,
  LOT_SIZE,
  DY_WINDOW,
  MIN_VALID_HISTORY
} from '../web/src/dividend-strategy.js';

function businessDays(start, end) {
  const days = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function seriesFromPercentiles(dates, percentiles) {
  return dates.map((date) => ({
    date,
    priceClose: 100,
    totalClose: 100,
    dividendYield: 0.05,
    percentile: percentiles[date] ?? null
  }));
}

test('真实历史数据复现 2025-07-31 股息率 4.408%、分位 0.4472', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/h30269-h20269-2014-2025.json', import.meta.url), 'utf8'));
  const price = fixture.rows.map(([date, close]) => ({ date, close }));
  const totalRows = fixture.rows.map(([date, , totalClose]) => ({ date, close: totalClose }));
  const series = computeDividendSeries(price, totalRows);
  const row = series.find((item) => item.date === '2025-07-31');
  assert.ok(row, '缺少 2025-07-31');
  assert.ok(Math.abs(row.dividendYield - 0.04408) < 0.0005, `DY=${row.dividendYield}`);
  assert.ok(Math.abs(row.percentile - 0.4472) < 0.0015, `percentile=${row.percentile}`);
  assert.equal(series[0].percentile, null);
  assert.equal(series.length, fixture.rows.length);
});

test('历史分位只使用当时已有数据，不含未来函数', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/h30269-h20269-2014-2025.json', import.meta.url), 'utf8'));
  const price = fixture.rows.map(([date, close]) => ({ date, close }));
  const total = fixture.rows.map(([date, , close]) => ({ date, close }));
  const full = computeDividendSeries(price, total);

  const cutoff = '2024-06-28';
  const truncated = computeDividendSeries(
    price.filter((row) => row.date <= cutoff),
    total.filter((row) => row.date <= cutoff)
  );
  const fullRow = full.find((row) => row.date === cutoff);
  const truncatedRow = truncated.find((row) => row.date === cutoff);
  assert.equal(truncatedRow.dividendYield, fullRow.dividendYield);
  assert.equal(truncatedRow.percentile, fullRow.percentile);
});

test('滚动股息率公式在恒定股息率序列上收敛到年化 252 倍', () => {
  const dates = businessDays('2018-01-02', '2022-12-30');
  const dy = 0.0002;
  const priceRows = [];
  const totalRows = [];
  let p = 1000;
  let t = 1000;
  for (const date of dates) {
    p *= 1.0004;
    t *= 1.0006;
    priceRows.push({ date, close: p });
    totalRows.push({ date, close: t });
  }
  const series = computeDividendSeries(priceRows, totalRows);
  const last = series.at(-1);
  assert.ok(last.dividendYield > 0.04 && last.dividendYield < 0.06, `DY=${last.dividendYield}`);
  assert.ok(last.percentile >= 0 && last.percentile <= 1);
  // 前 252 个股息点未齐时不产生股息率/分位。
  assert.equal(series[DY_WINDOW - 1].dividendYield, null);
  assert.ok(series.length > MIN_VALID_HISTORY + DY_WINDOW);
});

test('五档仓位每次只调整一档，边界与示例一致', () => {
  // 单步：同一个月最多只走一格，即使分位跨过多条阈值。
  assert.equal(resolveTargetPosition(100, 0.447), 75);
  assert.equal(resolveTargetPosition(0, 0.95), 25);
  assert.equal(resolveTargetPosition(50, 0.95), 75);
  assert.equal(resolveTargetPosition(25, 0.35), 0);
  // 逐档边界。
  assert.equal(resolveTargetPosition(0, 0.791), 25);
  assert.equal(resolveTargetPosition(25, 0.855), 50);
  assert.equal(resolveTargetPosition(0, 0.59), 0);
  assert.equal(resolveTargetPosition(25, 0.69), 25);
  assert.equal(resolveTargetPosition(25, 0.39), 0);
  assert.equal(resolveTargetPosition(50, 0.79), 50);
  assert.equal(resolveTargetPosition(50, 0.80), 75);
  assert.equal(resolveTargetPosition(75, 0.60), 50);
  assert.equal(resolveTargetPosition(100, 0.70), 75);
  assert.equal(resolveTargetPosition(100, 0.71), 100);
});

test('月末信号在下一交易日执行，2025-07-31 从 100% 减到 75%，次月再减到 50%', () => {
  const dates = businessDays('2025-05-01', '2025-09-01');
  const series = seriesFromPercentiles(dates, {
    '2025-05-30': 0.98,
    '2025-06-30': 0.98,
    '2025-07-31': 0.4472,
    '2025-08-29': 0.30
  });
  const { signals } = buildMonthlySignals(series, { startDate: '2025-05-01' });
  const first = signals[0];
  assert.equal(first.signalDate, '2025-05-30');
  assert.equal(first.fromLevel, 0);
  assert.equal(first.toLevel, 25);
  assert.equal(first.executeDate, '2025-06-02');

  const june = signals.find((signal) => signal.signalDate === '2025-06-30');
  assert.equal(june.fromLevel, 25);
  assert.equal(june.toLevel, 50);

  const july = signals.find((signal) => signal.signalDate === '2025-07-31');
  assert.ok(july);
  assert.equal(july.fromLevel, 50);
  assert.equal(july.toLevel, 25);
  assert.equal(july.executeDate, '2025-08-01');

  const august = signals.find((signal) => signal.signalDate === '2025-08-29');
  assert.equal(august.fromLevel, 25);
  assert.equal(august.toLevel, 0);
});

test('ETF 调仓按 100 份整数倍、扣单边手续费，并允许持仓自然漂移', () => {
  const dates = businessDays('2024-01-02', '2024-03-29');
  const series = seriesFromPercentiles(dates, {
    '2024-01-31': 0.95,
    '2024-02-29': 0.55,
    '2024-03-29': 0.55
  });
  const etfRows = dates.map((date) => ({ date, close: 10 }));

  const result = runDividendBacktest({
    series,
    etfRows,
    initialCapital: 100000,
    feeRate: 0.0005,
    startDate: '2024-01-02'
  });

  const firstTrade = result.trades.find((trade) => trade.type === 'rebalance');
  assert.ok(firstTrade);
  assert.equal(firstTrade.date, '2024-02-01');
  assert.equal(firstTrade.toLevel, 25);
  assert.equal(firstTrade.quantity % LOT_SIZE, 0);
  assert.ok(firstTrade.quantity > 0);
  assert.ok(firstTrade.fee > 0);
  assert.ok(result.nav.every((row) => row.equity > 0));

  // 此后无新信号，持仓数量不变（价格不变时净值也不变）。
  const sharesAtStart = result.nav.find((row) => row.date === '2024-02-01').shares;
  const later = result.nav.find((row) => row.date === '2024-03-15');
  assert.equal(later.shares, sharesAtStart);
  assert.equal(later.rebalanced, false);
});

test('563020 现金分红：登记日持仓定权、除息日计应收、到账后下一交易日再投资', () => {
  const dates = businessDays('2024-01-02', '2024-04-30');
  const series = seriesFromPercentiles(dates, {
    '2024-01-31': 0.95,
    '2024-02-29': 0.95
  });
  const etfRows = dates.map((date) => ({
    date,
    close: date >= '2024-02-16' ? 1.8 : 2
  }));
  const dividends = [{
    registerDate: '2024-02-15',
    exDate: '2024-02-16',
    payDate: '2024-02-19',
    cashPerShare: 0.2
  }];

  const result = runDividendBacktest({
    series, etfRows, dividends, initialCapital: 100000, feeRate: 0.0005, startDate: '2024-01-02'
  });

  const event = result.dividends[0];
  assert.ok(event);
  assert.equal(event.status, '已到账');
  assert.equal(event.shares, result.nav.find((row) => row.date === '2024-02-15').shares);
  assert.ok(Math.abs(event.amount - event.shares * 0.2) < 1e-6);

  const beforeEx = result.nav.find((row) => row.date === '2024-02-15');
  const exDay = result.nav.find((row) => row.date === '2024-02-16');
  assert.ok(Math.abs(exDay.receivable - event.amount) < 1e-6);
  assert.ok(Math.abs((beforeEx.equity - exDay.equity) / beforeEx.equity) < 0.0005);

  const payDay = result.nav.find((row) => row.date === '2024-02-19');
  assert.equal(payDay.receivable, 0);
  assert.ok(payDay.cash >= event.amount);

  const reinvest = result.trades.find((trade) => trade.type === 'reinvest');
  assert.ok(reinvest);
  assert.equal(reinvest.date, '2024-02-20');
  assert.equal(reinvest.quantity % LOT_SIZE, 0);
  assert.ok(reinvest.quantity > 0);
  assert.equal(result.dividends.filter((item) => item.exDate === '2024-02-16').length, 1);
});

test('563020 上市前用全收益指数模拟，切换日按 ETF 收盘价建仓且不叠加现金分红', () => {
  const dates = businessDays('2023-11-01', '2023-12-29');
  const series = seriesFromPercentiles(dates, {
    '2023-11-30': 0.95
  });
  // 指数模拟阶段使用全收益点位；ETF 上市后使用真实价格。
  const indexByDate = new Map(dates.map((date, index) => [date, 3000 + index * 10]));
  for (const row of series) row.totalClose = indexByDate.get(row.date);
  const etfRows = dates.filter((date) => date >= '2023-12-04').map((date) => ({ date, close: 1.0 }));

  const result = runDividendBacktest({
    series, etfRows, dividends: [], initialCapital: 100000, feeRate: 0.0005, startDate: '2023-11-01'
  });

  const conversion = result.trades.find((trade) => trade.type === 'convert');
  assert.ok(conversion);
  assert.equal(conversion.date, '2023-12-04');
  assert.equal(conversion.quantity % LOT_SIZE, 0);
  assert.equal(conversion.fee, 0);
  assert.equal(result.nav.find((row) => row.date === '2023-12-01').phase, 'index');
  assert.equal(result.nav.find((row) => row.date === '2023-12-04').phase, 'etf');
  // 切换日前后净值连续，仅因整手取整略有余量。
  const before = result.nav.find((row) => row.date === '2023-12-01').equity;
  const after = result.nav.find((row) => row.date === '2023-12-04').equity;
  assert.ok(after <= before && before - after < 1.0);
  assert.equal(result.dividends.length, 0);
});

test('数据截断在月中时不把截断日当成月末信号', () => {
  const midMonth = seriesFromPercentiles(businessDays('2024-01-02', '2024-01-24'), { '2024-01-24': 0.95 });
  assert.equal(buildMonthlySignals(midMonth).signals.length, 0);

  const monthEnd = seriesFromPercentiles(businessDays('2024-01-02', '2024-01-31'), { '2024-01-31': 0.95 });
  const { signals } = buildMonthlySignals(monthEnd);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].pending, true);
  assert.equal(signals[0].executeDate, null);
});

test('回测结束日早于月末信号执行日时标记为待执行，不产生未来交易', () => {
  const dates = businessDays('2024-01-02', '2024-02-02');
  const series = seriesFromPercentiles(dates, { '2024-01-31': 0.95 });
  const etfRows = dates.map((date) => ({ date, close: 10 }));
  const result = runDividendBacktest({
    series, etfRows, initialCapital: 100000, startDate: '2024-01-02', endDate: '2024-01-31'
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.level, 0);
  assert.ok(result.pendingSignal);
  assert.equal(result.pendingSignal.signalDate, '2024-01-31');
});

test('空区间回测返回可渲染的空结果', () => {
  const series = seriesFromPercentiles(businessDays('2024-01-02', '2024-02-02'), { '2024-01-31': 0.95 });
  const etfRows = businessDays('2024-01-02', '2024-02-02').map((date) => ({ date, close: 10 }));
  const result = runDividendBacktest({ series, etfRows, startDate: '2024-03-01', endDate: '2024-02-01' });
  assert.equal(result.nav.length, 0);
  assert.equal(result.latest.date, null);
  assert.equal(result.latest.percentile, null);
  assert.equal(result.etfStart, null);
  assert.equal(result.feeRate, 0.0005);
  assert.ok(Number.isFinite(result.stats.totalReturn));
});

test('摘要统计的最大回撤与年化收益基于每日净值', () => {
  const nav = [
    { date: '2024-01-02', equity: 100000 },
    { date: '2024-06-28', equity: 120000 },
    { date: '2024-12-31', equity: 90000 }
  ];
  const stats = summarizeNav(nav, 100000);
  assert.ok(Math.abs(stats.totalReturn + 0.1) < 1e-9);
  assert.ok(stats.maxDrawdown < -0.249 && stats.maxDrawdown > -0.251);
  assert.ok(Number.isFinite(stats.annualizedReturn));
});

test('年度基准包括年末最后交易日，并以该日净值衔接下一年', () => {
  const nav = [
    { date: '2024-01-02', equity: 100 },
    { date: '2024-12-30', equity: 100 },
    { date: '2024-12-31', equity: 200 },
    { date: '2025-01-02', equity: 200 },
    { date: '2025-12-30', equity: 200 },
    { date: '2025-12-31', equity: 300 }
  ];
  const benchmark = nav.map((row) => ({
    ...row,
    benchmarkLabel: row.date === '2024-12-31' ? '年末基准' : '持有基准'
  }));
  const rows = buildYearlyReturns(nav, benchmark);
  assert.equal(rows[0].strategyReturn, 1);
  assert.equal(rows[0].benchmarkReturn, 1);
  assert.equal(rows[0].benchmarkLabel, '年末基准');
  assert.equal(rows[1].strategyReturn, 0.5);
  assert.equal(rows[1].benchmarkReturn, 0.5);
  assert.ok(rows.every((row) => row.excessReturn === 0));
});

test('年度收益单列 563020 买入持有，上市当年只从上市日起算', () => {
  const nav = [
    { date: '2022-12-30', equity: 100 },
    { date: '2023-12-29', equity: 110 },
    { date: '2024-12-31', equity: 132 },
  ];
  const benchmark = [
    { date: '2022-12-30', equity: 100, benchmarkLabel: 'H20269 全收益指数' },
    { date: '2023-12-14', equity: 100, benchmarkLabel: '563020 买入持有' },
    { date: '2023-12-29', equity: 102, benchmarkLabel: '563020 买入持有' },
    { date: '2024-12-31', equity: 112.2, benchmarkLabel: '563020 买入持有' },
  ];
  const [y2022, y2023, y2024] = buildYearlyReturns(nav, benchmark);

  assert.equal(y2022.etfReturn, null, '上市前没有 563020 年度收益');
  assert.ok(Math.abs(y2023.etfReturn - 0.02) < 1e-12);
  assert.equal(y2023.etfPartial, true);
  assert.equal(y2023.etfStartDate, '2023-12-14');
  assert.ok(Math.abs(y2024.etfReturn - 0.1) < 1e-12);
  assert.equal(y2024.etfPartial, false);
});

test('年度表把 H20269 指数与 563020 ETF 分成两列', () => {
  const nav = [
    { date: '2022-12-30', equity: 100 },
    { date: '2023-12-29', equity: 110 },
    { date: '2024-12-31', equity: 132 },
  ];
  const benchmark = [
    { date: '2022-12-30', equity: 100, benchmarkLabel: 'H20269 全收益指数' },
    { date: '2023-12-14', equity: 100, benchmarkLabel: '563020 买入持有' },
    { date: '2023-12-29', equity: 102, benchmarkLabel: '563020 买入持有' },
    { date: '2024-12-31', equity: 112.2, benchmarkLabel: '563020 买入持有' },
  ];
  const indexNav = [
    { date: '2022-12-30', equity: 100 },
    { date: '2023-12-29', equity: 108 },
    { date: '2024-12-31', equity: 118.8 },
  ];
  const [y2022, y2023, y2024] = buildYearlyReturns(nav, benchmark, indexNav);

  assert.ok(Math.abs(y2023.indexReturn - 0.08) < 1e-12, '指数列是 H20269 全年收益');
  assert.ok(Math.abs(y2023.etfReturn - 0.02) < 1e-12, 'ETF 列从上市日起算');
  assert.ok(Math.abs(y2024.indexReturn - 0.1) < 1e-12);
  assert.ok(Math.abs(y2024.etfReturn - 0.1) < 1e-12);
  assert.equal(y2022.indexReturn, 0, '指数列全程都有数据');
  assert.equal(y2022.etfReturn, null, 'ETF 列上市前为空');
});
