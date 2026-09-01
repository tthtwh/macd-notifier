import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWebServer } from '../src/index.js';

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
