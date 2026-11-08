import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInstrumentData } from '../web/src/market-data.js';
import { createHistoryCsv } from '../web/src/history-export.js';

test('历史行情 CSV 从行情源到导出保留开盘价及成交量，不截断到100行', async () => {
  const day = Array.from({ length: 135 }, (_, i) => [
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    '1.234', '1.256', '1.3', '1.2', '12345.67',
  ]);
  const result = await fetchInstrumentData('512760', { fetchImpl: async () => ({
    ok: true, json: async () => ({ data: { sh512760: { qfqday: day } } }),
  }) });
  const rows = result.rows.map((row) => ({ ...row, dif: 0.1234567, dea: 0.1, hist: 0.0469134 }));
  const csv = createHistoryCsv(rows);
  assert.ok(csv.startsWith('\ufeff'));
  const lines = csv.slice(1).split('\n');
  assert.equal(lines[0], '日期,开盘价,收盘价,成交量(手),DIF,DEA,Histogram');
  assert.equal(lines.length, 136);
  assert.equal(lines[1], '2026-01-01,1.234,1.256,12345.67,0.123457,0.100000,0.046913');
  assert.equal(lines.at(-1).split(',')[0], day.at(-1)[0]);
});

test('历史行情 CSV 保留零成交量，缺失开盘价或成交量留空', () => {
  const base = { date: '2026-01-05', close: 1.2, dif: 0, dea: 0, hist: 0 };
  const lines = createHistoryCsv([base, { ...base, open: 0, volumeLots: 0 }]).slice(1).split('\n');
  assert.equal(lines[1], '2026-01-05,,1.200,,0.000000,0.000000,0.000000');
  assert.equal(lines[2], '2026-01-05,,1.200,0,0.000000,0.000000,0.000000');
});
