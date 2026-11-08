import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDailyReport, buildFailureReport, runDailyCheck } from '../src/app.js';

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
  assert.equal(calls[0].title, '预翻红｜待收盘确认｜现价1.100');
  assert.match(calls[0].description, /日期：2026-08-27/);
  assert.match(calls[0].description, /MACD 参数：12,26,9/);
  assert.match(calls[0].description, /最新价格：1.100/);
  assert.match(calls[0].description, /昨日 MACD Hist：/);
  assert.match(calls[0].description, /今日 MACD Hist：/);
  assert.match(calls[0].description, /预计翻绿临界价：1.000/);
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
  assert.equal(calls[0].title, '预翻绿｜待收盘确认｜现价0.900');
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
  assert.match(calls[0].title, /^红柱变长｜距翻绿\d+(\.\d)?%｜现价1\.110$/);
  assert.ok(calls[0].title.length <= 32, '标题不能超过 32 个字符');
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
    assert.equal(calls[0].title, '今日MACD检查失败');
    assert.match(calls[0].description, /MACD 参数：12,26,9/);
    assert.match(calls[0].description, scenario.reason);
  }
});

test('微信标题保留状态、距离、现价；翻色明确标记为待收盘确认', () => {
  const scenarios = [
    { previousHist: -0.01, currentHist: -0.02, latestClose: 0.865, zeroHistClose: 1.08125,
      signal: 'NONE', title: '绿柱变长｜距翻红25%｜现价0.865' },
    { previousHist: -0.02, currentHist: -0.01, latestClose: 0.893, zeroHistClose: 0.921576,
      signal: 'NONE', title: '绿柱变短｜距翻红3.2%｜现价0.893' },
    { previousHist: 0.02, currentHist: 0.01, latestClose: 1, zeroHistClose: 0.95,
      signal: 'NONE', title: '红柱变短｜距翻绿5.0%｜现价1.000' },
    { previousHist: 0.01, currentHist: 0.01, latestClose: 1, zeroHistClose: 0.95,
      signal: 'NONE', title: '红柱持平｜距翻绿5.0%｜现价1.000' },
    { previousHist: -0.01, currentHist: 0.01, latestClose: 0.912, zeroHistClose: 0.9,
      signal: 'BUY', title: '预翻红｜待收盘确认｜现价0.912' },
    { previousHist: 0.01, currentHist: -0.01, latestClose: 0.886, zeroHistClose: 0.9,
      signal: 'SELL', title: '预翻绿｜待收盘确认｜现价0.886' },
    { previousHist: -0.01, currentHist: 0, latestClose: 1, zeroHistClose: 1,
      signal: 'NONE', title: '零轴临界｜现价1.000' },
    { previousHist: -0.02, currentHist: -0.01, latestClose: 1, zeroHistClose: NaN,
      signal: 'NONE', title: '绿柱变短｜现价1.000' }
  ];
  for (const scenario of scenarios) {
    const report = buildDailyReport({ today: TODAY, checkTime: '14:55', ...scenario });
    assert.equal(report.title, scenario.title);
    assert.ok(report.title.length <= 32);
    assert.doesNotMatch(report.title, /512760|每日|可买入|可卖出/);
    assert.match(report.description, /以最终收盘数据为准/);
    assert.match(report.description, new RegExp(`今日信号：${scenario.signal}`));
  }
  assert.equal(buildFailureReport({ today: TODAY, checkTime: '14:55', reason: 'network' }).title,
    '今日MACD检查失败');
});

test('主策略配置决定通知检查的标的，并在通知里标注代码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macd-notifier-'));
  const configFile = join(directory, 'strategy-config.json');
  await writeFile(configFile, JSON.stringify({ primaryCode: '510300' }));
  const calls = [];
  let requested = null;

  const signal = await runDailyCheck({
    now: NOW,
    stateFile: join(directory, 'state.json'),
    configFile,
    getBars: async (options) => { requested = options; return barsWithLast(1.1); },
    notify: async (message) => calls.push(message),
    logger: quietLogger()
  });

  assert.equal(signal, 'BUY');
  assert.deepEqual(requested, { symbol: '510300' });
  assert.match(calls[0].description, /标的：510300/);
});
