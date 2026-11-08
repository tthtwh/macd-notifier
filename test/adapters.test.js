import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDailyKlines, normalizeSymbol, parseKline } from '../src/market.js';
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

test('东方财富短暂失败时重试，成功后不切换行情源', async () => {
  const urls = [];
  const bars = await fetchDailyKlines(async (url) => {
    urls.push(String(url));
    if (urls.length < 3) throw new Error('temporary failure');
    return {
      ok: true,
      json: async () => ({ rc: 0, data: { klines: ['2026-09-30,1.050,1.010,1.050,1.010,2925397'] } })
    };
  }, {
    retryDelays: [0, 0],
    sleep: async () => {},
    logger: { warn() {} }
  });

  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.startsWith('https://push2his.eastmoney.com/')));
  assert.equal(bars.at(-1).date, '2026-09-30');
});

test('东方财富连续失败后切换腾讯前复权日线', async () => {
  const urls = [];
  const bars = await fetchDailyKlines(async (url) => {
    urls.push(String(url));
    if (url.hostname === 'push2his.eastmoney.com') throw new Error('fetch failed');
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          sh512760: {
            qfqday: [
              ['2026-09-29', '1.030', '1.042', '1.047', '1.028', '2292614.000'],
              ['2026-09-30', '1.050', '1.010', '1.050', '1.010', '2925397']
            ],
            qt: {
              sh512760: [
                '1', '芯片ETF国泰', '512760', '1.012', '1.042', '1.048', '2925397',
                ...Array(23).fill(''), '20260930160024', '', '', '1.049', '1.008'
              ]
            }
          }
        }
      })
    };
  }, {
    retryDelays: [0, 0],
    sleep: async () => {},
    logger: { warn() {} }
  });

  assert.equal(urls.filter((url) => url.startsWith('https://push2his.eastmoney.com/')).length, 3);
  assert.equal(urls.filter((url) => url.startsWith('https://web.ifzq.gtimg.cn/')).length, 1);
  assert.deepEqual(bars.at(-1), {
    date: '2026-09-30', open: 1.048, close: 1.012, high: 1.049, low: 1.008, volume: 2925397
  });
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

test('主策略标的决定东方财富 secid 与腾讯市场前缀（深市代码）', async () => {
  const requested = [];
  const bars = await fetchDailyKlines(async (url) => {
    requested.push(new URL(url));
    if (url.hostname === 'push2his.eastmoney.com') throw new Error('fetch failed');
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          sz159915: {
            qfqday: [['2026-09-30', '2.000', '2.100', '2.200', '1.900', '1000']],
            qt: {
              sz159915: [
                '1', '创业板ETF', '159915', '2.150', '2.100', '2.100', '1000',
                ...Array(23).fill(''), '20260930160024', '', '', '2.250', '1.950'
              ]
            }
          }
        }
      })
    };
  }, { symbol: '159915', retryDelays: [], sleep: async () => {}, logger: { warn() {} } });

  assert.equal(requested[0].searchParams.get('secid'), '0.159915');
  const tencent = requested.find((url) => url.hostname === 'web.ifzq.gtimg.cn');
  assert.equal(tencent.searchParams.get('param'), 'sz159915,day,,,640,qfq');
  assert.deepEqual(bars.at(-1), { date: '2026-09-30', open: 2.1, close: 2.15, high: 2.25, low: 1.95, volume: 1000 });
  assert.throws(() => normalizeSymbol('abc123'), /6 位数字/);
});
