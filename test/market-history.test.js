import test from 'node:test';
import assert from 'node:assert/strict';
import { combineMarketHistory, createMarketHistoryLoader, fetchMarketHistory, parseMarketHistory } from '../src/market-history.js';
import { marketForDate, tradeMarketCsv } from '../web/src/trade-market.js';

const payload = lines => ({ data: { klines: lines } });
const fakeFetch = async url => ({ ok: true, json: async () => payload([
  new URL(url).searchParams.get('secid') === '1.000001'
    ? '2026-09-17,1,1,1,1,1000000,200000000'
    : '2026-09-17,1,1,1,1,2000000,300000000',
]) });

test('历史成交按日期严格合计，缺一市不填零或借用相邻日期', () => {
  const sh = parseMarketHistory(payload(['2026-09-17,1,1,1,1,100,200', '2026-09-18,1,1,1,1,300,400']));
  const sz = parseMarketHistory(payload(['2026-09-18,1,1,1,1,500,600', '2026-09-21,1,1,1,1,700,800']));
  assert.deepEqual(combineMarketHistory(sh, sz), [{ date: '2026-09-18', volumeLots: 800, turnover: 1000 }]);
  assert.throws(() => parseMarketHistory(payload(['2026-09-17,1,1,1,1,,'])), /异常/);
  assert.throws(() => parseMarketHistory(payload(['2026-09-17,1,1,1,1,NaN,-3'])), /异常/);
  assert.throws(() => parseMarketHistory({}), /缺失/);
});

test('逐笔数据使用实际成交日期，手换算亿股、元换算亿元；未卖出和缺失留空', async () => {
  const data = await fetchMarketHistory({ fetchImpl: fakeFetch, now: () => Date.parse('2026-09-17T02:00:00Z') });
  const history = new Map(data.rows.map(row => [row.date, row]));
  history.set('2026-09-18', { volumeLots: 4000000, turnover: 600000000 });
  assert.deepEqual(marketForDate(history, '2026-09-17'), { volume: 3, turnover: 5 });
  assert.deepEqual(tradeMarketCsv(history, { entryDate: '2026-09-17', entrySignalDate: '2026-09-16', exitDate: '2026-09-18' }), ['3.00', '5.00', '4.00', '6.00']);
  assert.deepEqual(tradeMarketCsv(history, { entryDate: '2026-09-17', exitDate: null }), ['3.00', '5.00', '', '']);
  assert.deepEqual(tradeMarketCsv(history, { entryDate: '2026-09-16', exitDate: '2026-09-19' }), ['', '', '', '']);
  assert.equal(data.partialDate, '2026-09-17');
  const closed = await fetchMarketHistory({ fetchImpl: fakeFetch, now: () => Date.parse('2026-09-17T08:00:00Z') });
  assert.equal(closed.partialDate, null);
});

test('历史成交缓存合并并发请求，失败可重试且不返回旧数据冒充刷新', async () => {
  let calls = 0;
  let time = 0;
  let fail = false;
  const load = createMarketHistoryLoader({ now: () => time, fetchImpl: async url => {
    calls++;
    if (fail) throw new Error('offline');
    return fakeFetch(url);
  } });
  await Promise.all([load(), load()]);
  await load();
  assert.equal(calls, 2);
  time = 61000;
  fail = true;
  await assert.rejects(load(), /offline/);
  fail = false;
  assert.equal((await load()).rows.length, 1);
  assert.equal(calls, 6);
});

