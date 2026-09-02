import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPersistentEnv, startWebServer } from '../src/index.js';

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
