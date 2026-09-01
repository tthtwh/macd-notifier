import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMacd, estimateZeroHistClose, getSignal } from '../src/macd.js';

test('固定价格的 MACD Hist 为 0', () => {
  const result = calculateMacd(Array(40).fill(1));
  assert.ok(result.every(({ hist }) => hist === 0));
});

test('MACD 使用固定 12,26,9 且能识别翻红/翻绿', () => {
  const buy = calculateMacd([...Array(39).fill(1), 1.1]);
  const sell = calculateMacd([...Array(39).fill(1), 0.9]);
  assert.equal(getSignal(buy.at(-2).hist, buy.at(-1).hist), 'BUY');
  assert.equal(getSignal(sell.at(-2).hist, sell.at(-1).hist), 'SELL');
  assert.equal(getSignal(0.1, 0.2), 'NONE');
});

test('能反推当天 Hist 等于 0 的临界收盘价', () => {
  const closes = [...Array(39).fill(1), 1.1];
  const threshold = estimateZeroHistClose(closes);
  const result = calculateMacd([...closes.slice(0, -1), threshold]);
  assert.ok(Math.abs(threshold - 1) < 1e-12);
  assert.ok(Math.abs(result.at(-1).hist) < 1e-12);
});
