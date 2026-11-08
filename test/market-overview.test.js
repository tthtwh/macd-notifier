import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketOverviewLoader, fetchMarketOverview, parseMarketQuote } from '../src/market-overview.js';

function payload(symbol, date = '20260929150000', volume = 1000, turnover = 3000000) {
  const quote = [];
  quote[30] = date;
  quote[35] = `3800/${volume}/${turnover}`;
  quote[37] = String(turnover / 10000);
  return { data: { [symbol]: { qt: { [symbol]: quote } } } };
}
const fakeFetch = async url => {
  const symbol = new URL(url).searchParams.get('param').split(',')[0];
  return { ok: true, json: async () => payload(symbol) };
};

test('沪深成交额按元合计、成交量按手保留，不重复叠加成分指数', async () => {
  const result = await fetchMarketOverview({ fetchImpl: fakeFetch });
  assert.equal(result.turnover, 6000000);
  assert.equal(result.volumeLots, 2000);
  assert.equal(result.date, '2026-09-29');
  assert.equal(result.time, '15:00:00');
  assert.deepEqual(result.markets.map(m => m.symbol), ['sh000001', 'sz399001']);
});

test('行情缺失、两市日期错位时不返回虚假的零值或合计', async () => {
  assert.throws(() => parseMarketQuote({}, 'sh000001'), /异常/);
  assert.throws(() => parseMarketQuote(payload('sh000001', '20260929150000', '', ''), 'sh000001'), /异常/);
  await assert.rejects(fetchMarketOverview({ fetchImpl: async url => {
    const symbol = new URL(url).searchParams.get('param').split(',')[0];
    return { ok: true, json: async () => payload(symbol, symbol === 'sh000001' ? '20260929150000' : '20260928150000') };
  } }), /日期不一致/);
  await assert.rejects(fetchMarketOverview({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});

test('大盘数据缓存合并并发请求，过期失败不会伪装成更新成功', async () => {
  let count = 0;
  let time = 0;
  let fail = false;
  const load = createMarketOverviewLoader({ now: () => time, fetchImpl: async url => {
    count++;
    if (fail) throw new Error('offline');
    return fakeFetch(url);
  } });
  await Promise.all([load(), load(), load()]);
  assert.equal(count, 2);
  await load();
  assert.equal(count, 2);
  time = 31000;
  fail = true;
  await assert.rejects(load(), /offline/);
  fail = false;
  await load();
  assert.equal(count, 6);
});
