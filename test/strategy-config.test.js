import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_PRIMARY_CODE, normalizePrimaryCode, readStrategyConfig, writeStrategyConfig
} from '../src/strategy-config.js';

test('没有配置文件时默认 512760', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-strategy-config-'));
  assert.deepEqual(await readStrategyConfig(join(directory, 'strategy-config.json')), {
    primaryCode: DEFAULT_PRIMARY_CODE
  });
});

test('写入主策略后能读回并带更新时间', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-strategy-config-'));
  const file = join(directory, 'strategy-config.json');
  const saved = await writeStrategyConfig({ primaryCode: '510300' }, file);

  assert.equal(saved.primaryCode, '510300');
  assert.ok(saved.updatedAt);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  assert.deepEqual(await readStrategyConfig(file), saved);
});

test('非法代码被拒绝，损坏或越界配置回落默认值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-strategy-config-'));
  const file = join(directory, 'strategy-config.json');

  assert.throws(() => normalizePrimaryCode('51030'), /6 位数字/);
  assert.throws(() => normalizePrimaryCode('abc123'), /6 位数字/);
  assert.throws(() => normalizePrimaryCode(null), /6 位数字/);
  assert.equal(normalizePrimaryCode(' 512760 '), '512760');

  await writeFile(file, '{not json', 'utf8');
  assert.equal((await readStrategyConfig(file)).primaryCode, DEFAULT_PRIMARY_CODE);

  await writeFile(file, JSON.stringify({ primaryCode: 'abcdef' }), 'utf8');
  assert.equal((await readStrategyConfig(file)).primaryCode, DEFAULT_PRIMARY_CODE);
});
