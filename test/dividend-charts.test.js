import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCandles, renderDividendCharts } from '../web/src/dividend-charts.js';

test('周K跨年按周一至周日聚合真实 OHLC 和成交量，保留原始日期界限', () => {
  const rows = [
    { date: '2025-01-03', open: 11, high: 14, low: 10, close: 13, volumeLots: 30 },
    { date: '2024-12-30', open: 10, high: 12, low: 9, close: 11, volumeLots: 10 },
    { date: '2025-01-06', open: 13, high: 15, low: 12, close: 14, volumeLots: 40 },
    { date: '2024-12-31', open: 11, high: 13, low: 8, close: 10, volumeLots: 20 }
  ];
  const original = JSON.stringify(rows);
  const candles = aggregateCandles(rows);
  assert.equal(candles.length, 2);
  assert.deepEqual(Object.fromEntries(['open', 'high', 'low', 'close', 'volumeLots', 'startDate', 'endDate', 'bucketStart', 'bucketEnd'].map((key) => [key, candles[0][key]])), {
    open: 10, high: 14, low: 8, close: 13, volumeLots: 60,
    startDate: '2024-12-30', endDate: '2025-01-03', bucketStart: '2024-12-30', bucketEnd: '2025-01-05'
  });
  assert.equal(candles[1].open, 13);
  assert.equal(JSON.stringify(rows), original, '聚合不得排序或修改调用者的数据');
});

test('日K保留每天真实 OHLC 和成交量，ETF图点数等于输入交易日数', () => {
  const etfRows = [
    { date: '2025-01-03', open: 2.111, high: 2.234, low: 2.098, close: 2.175, volumeLots: 300 },
    { date: '2024-12-30', open: 2.021, high: 2.145, low: 2.001, close: 2.111, volumeLots: 100 },
    { date: '2025-01-06', open: 2.181, high: 2.285, low: 2.131, close: 2.222, volumeLots: 400 },
    { date: '2024-12-31', open: 2.113, high: 2.156, low: 2.083, close: 2.121, volumeLots: 200 }
  ];
  const expected = [...etfRows].sort((a, b) => a.date.localeCompare(b.date));
  const candles = aggregateCandles(etfRows, { period: 'day' });
  assert.equal(candles.length, etfRows.length, '同一周内的不同交易日也必须保持独立');
  candles.forEach((candle, i) => {
    const row = expected[i];
    assert.deepEqual([candle.date, candle.startDate, candle.endDate, candle.bucketStart, candle.bucketEnd], Array(5).fill(row.date));
    assert.deepEqual([candle.open, candle.high, candle.low, candle.close, candle.volumeLots], [row.open, row.high, row.low, row.close, row.volumeLots]);
    assert.equal(candle.count, 1);
  });
  const result = { startDate: '2024-12-30', endDate: '2025-01-06', nav: [], trades: [], benchmark: { nav: [] } };
  const html = renderDividendCharts({ result, etfRows });
  const etf = chartData(html).find((chart) => chart.kind === 'etf');
  assert.equal(etf.points.length, etfRows.length);
  assert.deepEqual(etf.points.map((point) => [point.date, point.open, point.high, point.low, point.close, point.volumeLots]), expected.map((row) => [row.date, row.open, row.high, row.low, row.close, row.volumeLots]));
  assert.match(html, /① 563020 日K线/);
  assert.match(html, /日成交量（手）/);
});

test('月K用 H30269 日收盘合成，不使用日内高低或全收益指数', () => {
  const rows = [100, 80, 120, 90].map((priceClose, i) => ({ date: `2025-01-${String(i + 2).padStart(2, '0')}`, priceClose, totalClose: 9999, open: 500, high: 1000, low: 1, close: 600 }));
  rows.push({ date: '2025-02-03', priceClose: 110 });
  const candles = aggregateCandles(rows, { period: 'month', synthetic: true });
  assert.equal(candles.length, 2);
  assert.deepEqual([candles[0].open, candles[0].high, candles[0].low, candles[0].close], [100, 120, 80, 90]);
  assert.equal(candles[0].bucketStart, '2025-01-01');
  assert.equal(candles[0].bucketEnd, '2025-01-31');
});

test('真实周K缺失 OHLC 时不伪造为收盘合成K，未知成交量不标为已知', () => {
  assert.deepEqual(aggregateCandles([{ date: '2025-01-02', close: 3 }]), []);
  const [candle] = aggregateCandles([{ date: '2025-01-02', open: 3, high: 4, low: 2, close: 3.5 }]);
  assert.equal(candle.hasVolume, false);
});

function fixture(length = 2500) {
  const dates = [];
  const cursor = new Date('2012-01-02T00:00:00Z');
  while (dates.length < length) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const nav = dates.map((date, i) => ({ date, equity: 100000 + i * 90, price: 1000 + i, level: i >= 18 ? 25 : 0, phase: i >= 18 ? 'etf' : 'index' }));
  const trades = [17, 18, 991, 996, length - 1].filter((i) => i < length).map((i, t) => ({ date: dates[i], type: 'rebalance', phase: t === 0 ? 'index' : 'etf', fromLevel: t ? 75 : 0, toLevel: t === 4 ? 0 : 25, side: t ? 'sell' : 'buy', price: 2 + i / 10000 }));
  return { result: { nav, trades, benchmark: { nav: nav.map((r) => ({ date: r.date, equity: r.equity * 1.1 })) }, startDate: dates[0], endDate: dates.at(-1) },
    series: dates.map((date, i) => ({ date, priceClose: 1000 + i, totalClose: 9000 + i })),
    etfRows: dates.map((date, i) => ({ date, open: 2 + i / 10000, high: 2.1 + i / 10000, low: 1.9 + i / 10000, close: 2.05 + i / 10000, volumeLots: 100 + i })) };
}

function chartData(html) {
  return [...html.matchAll(/<script type="application\/json" class="dc-chart-data">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
}

test('三个图保留所有应显示的调仓，净值查询保留完整每日数据及非抽样日', () => {
  const input = fixture();
  const html = renderDividendCharts(input);
  const charts = chartData(html);
  assert.deepEqual(charts.map((c) => c.kind), ['etf', 'index', 'net']);
  assert.equal((html.match(/<section class="card dc-card/g) ?? []).length, 3);
  const etfTrades = charts[0].points.flatMap((p) => p.trades);
  const indexTrades = charts[1].points.flatMap((p) => p.trades);
  assert.deepEqual(etfTrades.map((t) => t.date), input.result.trades.filter((t) => t.phase === 'etf').map((t) => t.date));
  assert.deepEqual(indexTrades.map((t) => t.date), input.result.trades.map((t) => t.date));
  assert.equal(charts[2].points.length, input.result.nav.length);
  assert.equal(charts[2].points[19].date, input.result.nav[19].date);
  assert.equal(charts[2].points[19].equity, input.result.nav[19].equity);
  const netPath = html.match(/class="dc-net strategy" points="([^"]+)"/)[1].split(' ');
  for (const trade of input.result.trades) {
    const point = charts[2].points.find((p) => p.date === trade.date);
    assert.ok(netPath.includes(`${point.x},${point.y}`), `调仓日 ${trade.date} 不得因抽样漏画`);
  }
  assert.match(html, /减至25%/);
  assert.match(html, /清仓/);
  assert.match(html, /日收盘合成，非盘中高低/);
});

test('显示区间以回测结束日为锚点，切换不修改回测数据或净值查询日期', () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const all = chartData(renderDividendCharts(input));
  const limited = chartData(renderDividendCharts({ ...input, ranges: { etf: '1y', index: '5y' }, netScale: 'linear' }));
  assert.ok(limited[0].points.length < all[0].points.length);
  assert.ok(limited[1].points.length < all[1].points.length);
  assert.equal(limited[0].points.at(-1).endDate, input.result.endDate);
  assert.equal(limited[2].points.length, all[2].points.length);
  assert.equal(limited[2].scale, 'linear');
  assert.equal(all[2].scale, 'log');
  assert.equal(JSON.stringify(input), before);
});

test('仓位阶梯按实际执行日期变化，而非月首统一变化', () => {
  const input = fixture(75);
  const html = renderDividendCharts(input);
  const chart = chartData(html).find((c) => c.kind === 'index');
  const path = html.match(/class="dc-position-line" d="([^"]+)"/)[1];
  const execution = input.result.nav[18];
  const candleIndex = chart.points.findIndex((p) => execution.date >= p.bucketStart && execution.date <= p.bucketEnd);
  const candle = chart.points[candleIndex];
  const fraction = (new Date(execution.date) - new Date(candle.bucketStart)) / (new Date(candle.bucketEnd) - new Date(candle.bucketStart) + 86400000);
  const x = 76 + (candleIndex + fraction) * (1200 - 76 - 30) / chart.points.length;
  assert.ok(path.includes(`H${x}V496`), `执行日阶梯缺失：${path}`);
});

test('不足两根周/月K或每日净值时给出各自空态', () => {
  const html = renderDividendCharts({ result: { nav: [], trades: [], benchmark: { nav: [] }, endDate: '2025-01-02' }, series: [], etfRows: [] });
  assert.equal((html.match(/class="dc-empty"/g) ?? []).length, 3);
  assert.match(html, /data-chart-range="etf"/);
  assert.match(html, /data-chart-range="index"/);
  assert.match(html, /data-net-scale="log"/);
});

test('净值对数刻度使相同比例增长等距，线性刻度保持金额差距', () => {
  const nav = [100, 200, 400].map((equity, i) => ({ date: `2025-01-0${i + 2}`, equity, level: 100, phase: 'etf', price: 2 }));
  const result = { nav, trades: [], benchmark: { nav }, endDate: nav.at(-1).date };
  const log = chartData(renderDividendCharts({ result, netScale: 'log' })).find((c) => c.kind === 'net');
  const linear = chartData(renderDividendCharts({ result, netScale: 'linear' })).find((c) => c.kind === 'net');
  assert.ok(Math.abs((log.points[0].y - log.points[1].y) - (log.points[1].y - log.points[2].y)) < 1e-8);
  const first = linear.points[0].y - linear.points[1].y;
  const second = linear.points[1].y - linear.points[2].y;
  assert.ok(Math.abs(second / first - 2) < 1e-8);
});

test('历史区间不会被输入中更晚的 ETF 行情推到未来', () => {
  const input = fixture();
  input.result.endDate = input.result.nav[2000].date;
  const charts = chartData(renderDividendCharts({ ...input, ranges: { etf: '1y', index: '5y' } }));
  assert.equal(charts.find((c) => c.kind === 'etf').points.at(-1).endDate, input.result.endDate);
  assert.equal(charts.find((c) => c.kind === 'index').points.at(-1).endDate, input.result.endDate);
});

test('周K/月K先裁切顶部回测区间，首尾周期只聚合区间内日线', () => {
  const input = fixture();
  input.result.startDate = input.result.nav[777].date;
  input.result.endDate = input.result.nav[2000].date;
  const html = renderDividendCharts(input);
  const charts = chartData(html);
  const etf = charts.find((c) => c.kind === 'etf');
  const index = charts.find((c) => c.kind === 'index');
  const net = charts.find((c) => c.kind === 'net');
  assert.equal(etf.points[0].startDate, input.result.startDate);
  assert.equal(index.points[0].startDate, input.result.startDate);
  assert.equal(etf.points[0].open, input.etfRows[777].open);
  assert.equal(index.points[0].open, input.series[777].priceClose);
  assert.equal(etf.points.at(-1).endDate, input.result.endDate);
  assert.equal(index.points.at(-1).endDate, input.result.endDate);
  assert.equal(net.points[0].date, input.result.startDate);
  assert.equal(net.points.at(-1).date, input.result.endDate);
  assert.equal(net.points.length, 2000 - 777 + 1);
  assert.match(html, /仅展示回测区间/);
  assert.match(html, /首尾月可能未完整/);
});

test('长区间净值抽样保留策略和基准的桶内峰谷，完整 hover 序列不变', () => {
  const input = fixture(1801);
  input.result.nav.forEach((row) => { row.equity = 100; });
  input.result.benchmark.nav.forEach((row) => { row.equity = 100; });
  input.result.nav[1].equity = 1000;
  input.result.nav[2].equity = 60;
  input.result.benchmark.nav[3].equity = 1200;
  input.result.benchmark.nav[4].equity = 45;
  // Also exercise a distant bucket, not just the beginning of the series.
  input.result.nav[1001].equity = 950;
  input.result.nav[1002].equity = 65;
  input.result.benchmark.nav[1003].equity = 1100;
  input.result.benchmark.nav[1004].equity = 50;
  const before = JSON.stringify(input.result);
  const html = renderDividendCharts(input);
  const chart = chartData(html).find((item) => item.kind === 'net');
  const strategyPath = html.match(/<polyline class="dc-net strategy" points="([^"]+)"/)[1].split(' ');
  const benchmarkPath = html.match(/<polyline class="dc-net benchmark" points="([^"]+)"/)[1].split(' ');
  const strategyX = new Set(strategyPath.map((point) => point.split(',')[0]));
  const benchmarkX = new Set(benchmarkPath.map((point) => point.split(',')[0]));
  for (const index of [0, 1, 2, 3, 4, 1001, 1002, 1003, 1004, 1800]) {
    assert.ok(strategyX.has(String(chart.points[index].x)), `策略折线缺少日期索引 ${index}`);
    assert.ok(benchmarkX.has(String(chart.points[index].x)), `基准折线缺少日期索引 ${index}`);
  }
  assert.equal(chart.points.length, 1801);
  assert.equal(chart.points[1].equity, 1000);
  assert.equal(chart.points[3].benchmarkEquity, 1200);
  assert.equal(JSON.stringify(input.result), before);
});

test('相邻高位卖出标签在最终边界夹取后仍避让，保留全部交易和悬停数据', () => {
  const input = fixture();
  const months = [...new Set(input.series.map((row) => row.date.slice(0, 7)))];
  const finalMonths = months.slice(-6);
  input.series.forEach((row) => { row.priceClose = finalMonths.includes(row.date.slice(0, 7)) ? 10000 : 100; });
  input.result.trades = finalMonths.map((month, i) => ({
    date: input.series.find((row) => row.date.startsWith(month)).date,
    type: 'rebalance', phase: 'etf', side: 'sell', fromLevel: 75, toLevel: i % 2 ? 25 : 50, price: 2.345
  }));
  const html = renderDividendCharts(input);
  const indexSection = html.match(/<section class="card dc-card dc-index-card">([\s\S]*?)<\/section>/)[1];
  const labels = [...indexSection.matchAll(/<g class="dc-trade sell" data-trade-date="([^"]+)">[\s\S]*?<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]+)<\/text><\/g>/g)]
    .map((match) => ({ date: match[1], x: Number(match[2]), y: Number(match[3]), text: match[4] }));
  assert.equal(labels.length, input.result.trades.length);
  assert.deepEqual(labels.map((label) => label.date), input.result.trades.map((trade) => trade.date));
  const halfWidth = (text) => (Array.from(text).reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 11 : 7), 0) + 6) / 2;
  let nearbyPairs = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (Math.abs(labels[i].x - labels[j].x) >= halfWidth(labels[i].text) + halfWidth(labels[j].text) + 5) continue;
      nearbyPairs += 1;
      assert.ok(Math.abs(labels[i].y - labels[j].y) >= 15, `标签重叠：${JSON.stringify([labels[i], labels[j]])}`);
    }
  }
  assert.ok(nearbyPairs > 0, '场景必须包含横向相邻标签');
  const indexChart = chartData(html).find((chart) => chart.kind === 'index');
  assert.deepEqual(indexChart.points.flatMap((point) => point.trades).map((trade) => trade.date), input.result.trades.map((trade) => trade.date));
});
