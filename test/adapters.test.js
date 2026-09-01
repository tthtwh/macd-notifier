import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDailyKlines, parseKline } from '../src/market.js';
import { sendServerChan } from '../src/notifier.js';

test('解析东方财富日 K 并请求完整日线历史', async () => {
  let requestedUrl;
  const bars = await fetchDailyKlines(async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ rc: 0, data: { klines: ['2026-08-27,1.000,1.100,1.200,0.900,12345'] } })
    };
  });

  assert.deepEqual(bars, [{ date: '2026-08-27', open: 1, close: 1.1, high: 1.2, low: 0.9, volume: 12345 }]);
  assert.equal(requestedUrl.searchParams.get('secid'), '1.512760');
  assert.equal(requestedUrl.searchParams.get('klt'), '101');
  assert.equal(requestedUrl.searchParams.get('lmt'), '10000');
  assert.throws(() => parseKline('bad-data'), /无效日 K/);
});

test('Server酱使用 SendKey、标题和详情发送 POST', async () => {
  let request;
  await sendServerChan({
    sendKey: 'SCT-test/key',
    title: '标题',
    description: '详情',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ code: 0 }) };
    }
  });

  assert.match(request.url, /SCT-test%2Fkey\.send$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('title'), '标题');
  assert.equal(request.options.body.get('desp'), '详情');
});
