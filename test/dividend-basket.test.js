import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCsindexHistory,
  parseEtfDividendHtml,
  createDividendBasketLoader
} from '../src/dividend-basket.js';
import { startWebServer } from '../src/index.js';

function csindexRows(code, count = 45) {
  const rows = [];
  const cursor = new Date('2025-01-02T00:00:00Z');
  while (rows.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      rows.push({
        tradeDate: cursor.toISOString().slice(0, 10).replaceAll('-', ''),
        indexCode: code,
        close: code === 'H30269' ? 1000 + rows.length : 1200 + rows.length
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

function response(body, contentType = 'text/html; charset=utf-8') {
  const buffer = Buffer.from(String(body));
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => buffer,
    text: async () => String(body)
  };
}

const DIVIDEND_HTML = `<table>
  <tr><th>年度</th><th>权益登记日</th><th>除息日</th><th>分红</th><th>分红发放日</th></tr>
  <tr><td>2025年</td><td>2025-03-11</td><td>2025-03-12</td><td>每10份派现金0.0900元</td><td>2025-03-17</td></tr>
  <tr><td>2024年</td><td>2024-06-14</td><td>2024-06-17</td><td>每10份派现金0.1200元</td><td>2024-06-20</td></tr>
  <tr><td>2024年</td><td>2024-01-02</td><td>2024-01-03</td><td>每10份拆分折算</td><td>2024-01-05</td></tr>
</table>`;

test('中证指数日线解析：过滤无效值并按日期升序', () => {
  const payload = {
    code: '200',
    data: [
      { tradeDate: '20250103', close: '1001.5' },
      { tradeDate: '20250102', close: 1000 },
      { tradeDate: '2025-01-04', close: 1002 },
      { tradeDate: '20250106', close: null },
      ...csindexRows('H30269', 42)
    ]
  };
  const rows = parseCsindexHistory(payload);
  assert.ok(rows.length >= 40);
  assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].date <= row.date));
  assert.equal(rows[0].date, '2025-01-02');
  assert.equal(rows[0].close, 1000);
});

test('分红页面解析：按每 10 份派现折算每股，忽略拆分行', () => {
  const dividends = parseEtfDividendHtml(DIVIDEND_HTML);
  assert.equal(dividends.length, 2);
  assert.deepEqual(dividends[0], {
    registerDate: '2024-06-14',
    exDate: '2024-06-17',
    payDate: '2024-06-20',
    cashPerShare: 0.012
  });
  assert.equal(dividends[1].cashPerShare, 0.009);
});

test('数据加载器聚合双指数与分红，写缓存并在 TTL 内复用内存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dividend-basket-'));
  const cacheFile = join(dir, 'dividend-basket.json');
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).includes('csindex')) {
      const code = /indexCode=([^&]+)/.exec(url)?.[1] ?? 'H30269';
      return response(JSON.stringify({ code: '200', data: csindexRows(code) }), 'application/json;charset=UTF-8');
    }
    return response(DIVIDEND_HTML);
  };

  const loader = createDividendBasketLoader({ fetchImpl, cacheFile, ttlMs: 60_000 });
  const basket = await loader();
  assert.equal(basket.priceIndex.length, 45);
  assert.equal(basket.totalReturnIndex.length, 45);
  assert.equal(basket.dividends.length, 2);
  assert.equal(basket.priceIndexCode, 'H30269');
  assert.equal(basket.totalReturnIndexCode, 'H20269');
  assert.equal(calls, 3);

  await loader();
  assert.equal(calls, 3, '内存缓存应避免重复请求');
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(saved.dividends.length, 2);
  assert.ok(Array.isArray(saved.priceIndex[0]));
});

test('网络失败时回退到磁盘缓存并标记 stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dividend-basket-'));
  const cacheFile = join(dir, 'dividend-basket.json');
  await writeFile(cacheFile, JSON.stringify({
    etfCode: '563020',
    priceIndexCode: 'H30269',
    totalReturnIndexCode: 'H20269',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: { index: '中证指数官网', dividends: '天天基金分红送配' },
    priceIndex: [['2025-01-02', 1000], ['2025-01-03', 1001]],
    totalReturnIndex: [['2025-01-02', 1200], ['2025-01-03', 1201]],
    dividends: [{ registerDate: '2024-06-14', exDate: '2024-06-17', payDate: '2024-06-20', cashPerShare: 0.012 }]
  }), 'utf8');

  const loader = createDividendBasketLoader({
    fetchImpl: async () => { throw new Error('network down'); },
    cacheFile,
    logger: { error() {} }
  });
  const basket = await loader();
  assert.equal(basket.stale, true);
  assert.match(basket.warning, /缓存/);
  assert.equal(basket.priceIndex.length, 2);
  assert.equal(basket.dividends.length, 1);
});

test('无缓存且网络失败时抛出错误，由 API 返回 502', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dividend-basket-'));
  const failure = createDividendBasketLoader({
    fetchImpl: async () => { throw new Error('internal secret'); },
    cacheFile: join(dir, 'missing.json'),
    logger: { error() {} }
  });
  const server = startWebServer({
    port: 0, host: '127.0.0.1', logger: { info() {}, error() {} },
    getDividendBasket: failure
  });
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/dividend-basket`;
    const response = await fetch(url);
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /internal secret/);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('红利低波 API 返回聚合数据', async () => {
  const data = { priceIndex: [['2025-01-02', 1000]], totalReturnIndex: [['2025-01-02', 1200]], dividends: [] };
  const server = startWebServer({
    port: 0, host: '127.0.0.1', logger: { info() {}, error() {} },
    getDividendBasket: async () => data
  });
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dividend-basket`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), data);
    assert.match(response.headers.get('content-type'), /application\/json/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
