import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendClosedRealtimeQuote,
  fetchInstrumentData,
  normalizeInstrumentCode,
  parseJsonp,
  parseThsYearRows
} from '../web/src/market-data.js';

test('15:00 后日 K 未更新时补入 ETF 当日收盘价', () => {
  const historicalRows = [{ date: '2026-09-03', close: 1.066 }];
  const realtime = [];
  realtime[3] = '1.036';
  realtime[30] = '20260904151851';

  assert.deepEqual(
    appendClosedRealtimeQuote(historicalRows, { qt: { sh512760: realtime } }, 'sh512760'),
    {
      rows: [
        { date: '2026-09-03', close: 1.066 },
        { date: '2026-09-04', close: 1.036 }
      ],
      appended: true
    }
  );
});

test('15:00 前不补未完成日 K，正式日 K 已存在时不重复', () => {
  const rows = [{ date: '2026-09-03', close: 1.066 }];
  const beforeClose = [];
  beforeClose[3] = '1.040';
  beforeClose[30] = '20260904145500';
  assert.deepEqual(
    appendClosedRealtimeQuote(rows, { qt: { sh512760: beforeClose } }, 'sh512760'),
    { rows, appended: false }
  );

  const completedRows = [...rows, { date: '2026-09-04', close: 1.036 }];
  const afterClose = [];
  afterClose[3] = '1.036';
  afterClose[30] = '20260904151851';
  assert.deepEqual(
    appendClosedRealtimeQuote(completedRows, { qt: { sh512760: afterClose } }, 'sh512760'),
    { rows: completedRows, appended: false }
  );
});

test('自动区分沪深 ETF 和 88 开头的同花顺指数', () => {
  assert.deepEqual(normalizeInstrumentCode('510300'), {
    code: '510300', kind: 'etf', provider: 'tencent', market: 'sh', symbol: 'sh510300'
  });
  assert.deepEqual(normalizeInstrumentCode('159915'), {
    code: '159915', kind: 'etf', provider: 'tencent', market: 'sz', symbol: 'sz159915'
  });
  assert.deepEqual(normalizeInstrumentCode('881121'), {
    code: '881121', kind: 'index', provider: 'ths', symbol: 'bk_881121'
  });
  assert.throws(() => normalizeInstrumentCode('123'), /6 位 ETF 或指数代码/);
});

test('解析同花顺指数 JSONP 和年度日线', () => {
  assert.deepEqual(parseJsonp('callback({"name":"半导体"})'), { name: '半导体' });
  assert.deepEqual(
    parseThsYearRows('callback({"data":"20260105,1,3,1,2.5,10;20260106,2,4,2,3.5,20"})'),
    [
      { date: '2026-01-05', close: 2.5, open: 1 },
      { date: '2026-01-06', close: 3.5, open: 2 }
    ]
  );
});

test('881121 走指数接口并合并多年行情', async () => {
  const calls = [];
  const result = await fetchInstrumentData('881121', {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/v6/')) {
        return responseText('meta({"name":"半导体","sortYear":[[2025,20],[2026,20]]})');
      }
      const year = url.includes('/2025.js') ? 2025 : 2026;
      const rows = Array.from({ length: 20 }, (_, index) => {
        const day = String(index + 1).padStart(2, '0');
        return `${year}01${day},1,2,1,${100 + index},10`;
      }).join(';');
      return responseText(`year({"data":"${rows}"})`);
    }
  });

  assert.equal(result.name, '半导体');
  assert.equal(result.rows.length, 40);
  assert.equal(result.rows[0].date, '2025-01-01');
  assert.match(result.source, /同花顺指数日线/);
  assert.ok(calls.some((url) => url.includes('bk_881121')));
});

function responseText(text) {
  return { ok: true, status: 200, text: async () => text };
}
