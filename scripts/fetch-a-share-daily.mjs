import { mkdir, writeFile } from 'node:fs/promises';

const markets = [
  { key: 'shanghai', secid: '1.000001', name: '沪市' },
  { key: 'shenzhen', secid: '0.399001', name: '深市' },
];
const endDate = '2026-09-30';
const startDate = '2019-09-30';

async function fetchMarket(market) {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.search = new URLSearchParams({
    secid: market.secid,
    klt: '101',
    fqt: '0',
    lmt: '10000',
    beg: startDate.replaceAll('-', ''),
    end: endDate.replaceAll('-', ''),
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${market.name} HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data?.klines)) throw new Error(`${market.name}数据缺失`);
  return payload.data.klines.map(line => {
    const fields = line.split(',');
    const date = fields[0];
    const volumeLots = Number(fields[5]);
    const turnoverYuan = Number(fields[6]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(volumeLots) ||
        !Number.isFinite(turnoverYuan) || volumeLots < 0 || turnoverYuan < 0) {
      throw new Error(`${market.name}${date || ''}数据格式异常`);
    }
    return { date, volumeLots, turnoverYuan };
  });
}

const [shanghaiRows, shenzhenRows] = await Promise.all(markets.map(fetchMarket));
const shenzhenByDate = new Map(shenzhenRows.map(row => [row.date, row]));
const rows = shanghaiRows.flatMap(shanghai => {
  const shenzhen = shenzhenByDate.get(shanghai.date);
  if (!shenzhen) return [];
  return [{
    date: shanghai.date,
    shanghaiVolumeLots: shanghai.volumeLots,
    shanghaiTurnoverYuan: shanghai.turnoverYuan,
    shenzhenVolumeLots: shenzhen.volumeLots,
    shenzhenTurnoverYuan: shenzhen.turnoverYuan,
    totalVolumeLots: shanghai.volumeLots + shenzhen.volumeLots,
    totalTurnoverYuan: shanghai.turnoverYuan + shenzhen.turnoverYuan,
  }];
}).filter(row => row.date >= startDate && row.date <= endDate);

if (rows.length < 1500) throw new Error(`共同交易日数量异常：${rows.length}`);
for (let index = 1; index < rows.length; index += 1) {
  if (rows[index - 1].date >= rows[index].date) throw new Error('日期未严格递增');
}

const output = {
  requestedRange: { startDate, endDate },
  actualRange: { startDate: rows[0].date, endDate: rows.at(-1).date },
  generatedAt: new Date().toISOString(),
  source: '东方财富历史日线：上证指数 1.000001、深证成指 0.399001；沪深合计，不含北交所',
  rows,
};
await mkdir('work/a-share-daily-20260930', { recursive: true });
await writeFile('work/a-share-daily-20260930/data.json', JSON.stringify(output));
console.log(JSON.stringify({ count: rows.length, actualRange: output.actualRange, last: rows.at(-1) }));
