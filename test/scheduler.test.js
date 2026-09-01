import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { nextRunTime } from '../src/index.js';

test('14:55 前安排当天，之后安排下一个工作日', () => {
  assert.equal(
    nextRunTime(new Date('2026-08-27T14:00:00+08:00')).toISOString(),
    '2026-08-27T06:55:00.000Z'
  );
  assert.equal(
    nextRunTime(new Date('2026-08-28T15:00:00+08:00')).toISOString(),
    '2026-08-31T06:55:00.000Z'
  );
});

test('入口文件在当前平台能启动并保持调度进程', async () => {
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timeout = setTimeout(() => child.kill(), 3_000);

  try {
    const [chunk] = await once(child.stdout, 'data');
    assert.match(chunk.toString(), /MACD 通知服务已启动/);
    assert.equal(child.exitCode, null);
  } finally {
    clearTimeout(timeout);
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});
