import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPersistentStorage, loadPersistentEnv, startWebServer } from '../src/index.js';

test('历史成交 API 返回逐日数据，拒绝写入，错误不泄漏内部信息', async () => {
  let fail = false;
  const data = { rows: [{ date: '2026-09-17', volumeLots: 300, turnover: 400 }] };
  const server = startWebServer({ port: 0, host: '127.0.0.1', logger: { info() {}, error() {} }, getMarketHistory: async () => {
    if (fail) throw new Error('internal secret');
    return data;
  } });
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/market-history`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), data);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    fail = true;
    const failure = await fetch(url);
    assert.equal(failure.status, 502);
    assert.doesNotMatch(await failure.text(), /internal secret/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('大盘 API 返回成交数据，失败明确返回 502 且不泄露内部错误', async () => {
  let fail = false;
  const server = startWebServer({
    port: 0, host: '127.0.0.1', logger: { info() {}, error() {} },
    getMarketOverview: async () => {
      if (fail) throw new Error('internal secret');
      return { date: '2026-09-29', turnover: 6000000, volumeLots: 2000 };
    },
  });
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/market-overview`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).turnover, 6000000);
    fail = true;
    const failure = await fetch(url);
    assert.equal(failure.status, 502);
    assert.doesNotMatch(await failure.text(), /internal secret/);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('页面服务能返回构建后的首页与静态资源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macd-lab-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<h1>MACD Lab</h1>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("ok")');
  const server = startWebServer({ port: 0, host: '127.0.0.1', root, logger: { info() {}, error() {} } });
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    assert.equal(home.status, 200);
    assert.equal(await home.text(), '<h1>MACD Lab</h1>');
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.equal(await asset.text(), 'console.log("ok")');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('从挂载目录 .env 加载 SendKey，且不覆盖已有环境变量', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'macd-lab-data-'));
  const envFile = join(dataDir, '.env');
  await writeFile(envFile, 'SERVERCHAN_SENDKEY=persisted-key\nPORT=9090\n');
  const env = { PORT: '8080' };

  assert.equal(await loadPersistentEnv({
    file: envFile,
    env,
    logger: { info() {}, error() {} }
  }), true);
  assert.equal(env.SERVERCHAN_SENDKEY, 'persisted-key');
  assert.equal(env.PORT, '8080');
});

test('启动时验证持久化目录可写且不留下探测文件', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'macd-lab-data-'));
  const messages = [];
  assert.equal(await checkPersistentStorage({
    dataDir,
    logger: { info(message) { messages.push(message); }, error() {} }
  }), true);
  assert.match(messages[0], /持久化目录可写/);
});

test('最近查询记录写入挂载目录并能在服务重启后读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macd-lab-web-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'macd-lab-data-'));
  await writeFile(join(root, 'index.html'), '<h1>MACD Lab</h1>');
  const history = [{
    code: '881121',
    name: '881121 半导体',
    start: '2020-01-01',
    end: '',
    queriedAt: '2026/9/2 10:00:00'
  }];

  const first = startWebServer({ port: 0, host: '127.0.0.1', root, dataDir, logger: { info() {}, error() {} } });
  await once(first, 'listening');
  const firstPort = first.address().port;
  try {
    const empty = await fetch(`http://127.0.0.1:${firstPort}/api/query-history`);
    assert.deepEqual(await empty.json(), []);
    const saved = await fetch(`http://127.0.0.1:${firstPort}/api/query-history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(history)
    });
    assert.equal(saved.status, 200);
  } finally {
    first.close();
    await once(first, 'close');
  }

  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'query-history.json'), 'utf8')), history);
  const second = startWebServer({ port: 0, host: '127.0.0.1', root, dataDir, logger: { info() {}, error() {} } });
  await once(second, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${second.address().port}/api/query-history`);
    assert.deepEqual(await response.json(), history);
  } finally {
    second.close();
    await once(second, 'close');
  }
});

test('主策略 API 读写挂载目录，非法代码返回 400', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macd-lab-web-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'macd-lab-data-'));
  await writeFile(join(root, 'index.html'), '<h1>MACD Lab</h1>');
  const server = startWebServer({ port: 0, host: '127.0.0.1', root, dataDir, logger: { info() {}, error() {} } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/strategy-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  try {
    assert.equal((await (await fetch(`${base}/api/strategy-config`)).json()).primaryCode, '512760');
    const saved = await post({ primaryCode: '510300' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).primaryCode, '510300');
    assert.equal((await (await fetch(`${base}/api/strategy-config`)).json()).primaryCode, '510300');
    assert.equal((await post({ primaryCode: 'abc' })).status, 400);
    assert.equal((await fetch(`${base}/api/strategy-config`, { method: 'PUT' })).status, 405);
  } finally {
    server.close();
    await once(server, 'close');
  }

  assert.equal(JSON.parse(await readFile(join(dataDir, 'strategy-config.json'), 'utf8')).primaryCode, '510300');
});
