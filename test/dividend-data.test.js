import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEtfRawDaily } from '../web/src/dividend-data.js';

test('ETF 不复权日线保留真实高低价和成交量，供周 K 聚合', async () => {
  const day = Array.from({ length: 45 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    return [date, '1.10', '1.15', '1.22', '1.03', '123400'];
  });
  const result = await fetchEtfRawDaily('563020', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { sh563020: { day } } }) })
  });
  assert.equal(result.rows.length, 45);
  assert.deepEqual(result.rows[0], {
    date: '2025-01-01', open: 1.10, close: 1.15, high: 1.22, low: 1.03, volumeLots: 123400
  });
});
