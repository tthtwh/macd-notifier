import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDailyCheck } from '../src/app.js';

const TODAY = '2026-08-27';
const NOW = new Date('2026-08-27T14:55:00+08:00');

function barsWithLast(close, date = TODAY, count = 40) {
  return Array.from({ length: count }, (_, index) => ({
    date: index === count - 1 ? date : '2026-08-26',
    close: index === count - 1 ? close : 1
  }));
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

test('BUY 通知包含每日状态和临界价，成功后写状态并阻止同日重复发送', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-notifier-'));
  const stateFile = join(directory, 'state.json');
  const calls = [];
  const options = {
    now: NOW,
    stateFile,
    sendKey: 'test-key',
    getBars: async () => barsWithLast(1.1),
    notify: async (message) => calls.push(message),
    logger: quietLogger()
  };

  assert.equal(await runDailyCheck(options), 'BUY');
  assert.equal(await runDailyCheck(options), 'BUY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '512760 MACD翻红，可以买入');
  assert.match(calls[0].description, /日期：2026-08-27/);
  assert.match(calls[0].description, /最新价格：1.1000/);
  assert.match(calls[0].description, /昨日 MACD Hist：/);
  assert.match(calls[0].description, /今日 MACD Hist：/);
  assert.match(calls[0].description, /预计翻绿临界价：1.0000/);
  assert.match(calls[0].description, /今日信号：BUY/);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
    lastSentDate: TODAY,
    lastSignal: 'BUY'
  });
});

test('SELL 发送卖出文案', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-notifier-'));
  const calls = [];
  const signal = await runDailyCheck({
    now: NOW,
    stateFile: join(directory, 'state.json'),
    getBars: async () => barsWithLast(0.9),
    notify: async (message) => calls.push(message),
    logger: quietLogger()
  });
  assert.equal(signal, 'SELL');
  assert.equal(calls[0].title, '512760 MACD翻绿，可以卖出');
});

test('无交易信号也发送每日状态和翻色距离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-notifier-'));
  const calls = [];
  const bars = barsWithLast(1.11);
  bars.at(-2).close = 1.1;

  assert.equal(await runDailyCheck({
    now: NOW,
    stateFile: join(directory, 'state.json'),
    getBars: async () => bars,
    notify: async (message) => calls.push(message),
    logger: quietLogger()
  }), 'NONE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '512760 每日 MACD：红柱');
  assert.match(calls[0].description, /柱体变化：红柱/);
  assert.match(calls[0].description, /距离翻绿：还需下跌/);
  assert.match(calls[0].description, /今日信号：NONE/);
});

test('非当日日 K、数据不足、行情失败均发送失败报告', async () => {
  const scenarios = [
    { getBars: async () => barsWithLast(1.1, '2026-08-26'), reason: /最新日 K 为 2026-08-26/ },
    { getBars: async () => barsWithLast(1.1, TODAY, 10), reason: /数据不足/ },
    { getBars: async () => { throw new Error('network'); }, reason: /network/ }
  ];

  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(tmpdir(), 'macd-notifier-'));
    const calls = [];
    assert.equal(await runDailyCheck({
      now: NOW,
      stateFile: join(directory, 'state.json'),
      getBars: scenario.getBars,
      notify: async (message) => calls.push(message),
      logger: quietLogger()
    }), 'NONE');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, '512760 MACD 今日检查失败');
    assert.match(calls[0].description, scenario.reason);
  }
});
