export function createHistoryCsv(rows) {
  const header = ['日期', '开盘价', '收盘价', '成交量(手)', 'DIF', 'DEA', 'Histogram'];
  const data = rows.map((row) => [
    row.date,
    Number.isFinite(row.open) && row.open > 0 ? row.open.toFixed(3) : '',
    row.close.toFixed(3),
    Number.isFinite(row.volumeLots) && row.volumeLots >= 0 ? row.volumeLots : '',
    row.dif.toFixed(6), row.dea.toFixed(6), row.hist.toFixed(6),
  ]);
  return '\ufeff' + [header, ...data].map((row) => row.join(',')).join('\n');
}
