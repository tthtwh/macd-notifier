import test from 'node:test';
import assert from 'node:assert/strict';
import { pricePositionMetrics } from '../web/src/backtest.js';

function series(values) {
  return values.map((close, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    close,
  }));
}

test('价格分位：最高价是 100%，最低价接近 0%', () => {
  const rows = series([1, 2, 3, 4, 5]);
  const metrics = pricePositionMetrics(rows, { window3: 5, window5: 5 });
  assert.equal(metrics.pctAll, 1);
  const low = pricePositionMetrics(series([5, 4, 3, 2, 1]), { window3: 5, window5: 5 });
  assert.equal(low.pctAll, 0.2);
});

test('距 252 日高点与 MA200 偏离，以及深跌打分', () => {
  const rows = series([10, 10, 10, 10, 10, 6, 5]);
  const metrics = pricePositionMetrics(rows, { highWindow: 7, maWindow: 7 });
  assert.equal(metrics.high, 10);
  assert.ok(Math.abs(metrics.drawdown - (5 / 10 - 1)) < 1e-9);
  assert.ok(metrics.ma200 < -0.1);
  assert.equal(metrics.score, 2);
});

test('正常上涨趋势中深跌打分为 0，且不接受空数据', () => {
  const metrics = pricePositionMetrics(series([1, 2, 3, 4, 5]), { maWindow: 5 });
  assert.equal(metrics.score, 0);
  assert.equal(pricePositionMetrics([]), null);
  assert.equal(pricePositionMetrics(series([NaN, 0])), null);
});

test('分位窗口不足时使用已有样本', () => {
  const metrics = pricePositionMetrics(series([1, 2, 3]), { window3: 756, window5: 1260 });
  assert.equal(metrics.pct3, 1);
  assert.equal(metrics.pct5, 1);
  assert.equal(metrics.date, '2026-01-03');
});
