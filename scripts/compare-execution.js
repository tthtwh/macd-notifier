import assert from 'node:assert/strict';
import { calculateMacd, getSignal } from '../src/macd.js';

// Same signals and fee approximation as the UI; only execution timing differs.
const initialCapital = 100000;
const fee = 0.0003;
const urls = [];
const byDate = new Map();
let realtime;
let end = '2050-12-31';
const now = new Date();
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23'
}).formatToParts(now).map(p => [p.type, p.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`;
for (let page = 0; page < 20; page++) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh512760,day,1990-01-01,${end},640,qfq`;
  urls.push(url);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const quote = payload.data?.sh512760;
  if (!realtime) realtime = quote?.qt?.sh512760;
  const data = quote?.qfqday;
  assert.ok(Array.isArray(data) && data.length, 'Missing adjusted daily data');
  for (const [date, open, close, high, low] of data) {
    const row = { date, open: +open, close: +close, high: +high, low: +low };
    assert.ok([row.open, row.close, row.high, row.low].every(v => Number.isFinite(v) && v > 0));
    assert.ok(row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close));
    if (date < today || (date === today && +parts.hour >= 15)) byDate.set(date, row);
  }
  if (data.length < 640) break;
  const earliest = new Date(`${data[0][0]}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 1);
  const next = earliest.toISOString().slice(0, 10);
  assert.ok(next < end, 'Pagination must advance');
  end = next;
}
const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
const executionRows = [...rows];
const timestamp = String(realtime?.[30] ?? '');
const realtimeDate = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
if (/^\d{14}$/.test(timestamp) && realtimeDate === today && timestamp.slice(8) >= '093000'
    && realtimeDate > rows.at(-1).date && Number(realtime[5]) > 0) {
  executionRows.push({ date: realtimeDate, open: Number(realtime[5]) });
}
assert.ok(rows.length > 1000, 'Incomplete history');
const macd = calculateMacd(rows.map(r => r.close));
const pairs = [];
let entry = null;
for (let i = 35; i < rows.length; i++) {
  const signal = getSignal(macd[i - 1].hist, macd[i].hist);
  if (entry === null && signal === 'BUY') entry = i;
  else if (entry !== null && signal === 'SELL') {
    pairs.push({ buy: entry, sell: i });
    entry = null;
  }
}
// Only pairs executable under both policies enter the realized-return comparison.
const comparable = pairs.filter(p => p.sell + 1 < executionRows.length);
function tradesFor(offset) {
  return comparable.map(({ buy, sell }) => {
    const b = executionRows[buy + offset], s = executionRows[sell + offset];
    const buyPrice = offset ? b.open : b.close;
    const sellPrice = offset ? s.open : s.close;
    return { signalBuy: rows[buy].date, signalSell: rows[sell].date,
      buyDate: b.date, sellDate: s.date, buyPrice, sellPrice,
      netReturn: sellPrice / buyPrice - 1 - fee * 2 };
  });
}
function summary(trades) {
  let capital = initialCapital;
  for (const t of trades) capital *= 1 + t.netReturn;
  return { trades: trades.length, finalCapital: capital,
    returnPercent: (capital / initialCapital - 1) * 100,
    winRatePercent: trades.filter(t => t.netReturn > 0).length / trades.length * 100 };
}
const same = tradesFor(0), next = tradesFor(1);
const years = [...new Set(comparable.map(p => rows[p.sell].date.slice(0, 4)))];
console.log(JSON.stringify({ fetchedAt: now.toISOString(), source: 'Tencent qfqday [date,open,close,high,low]',
  start: rows[0].date, end: rows.at(-1).date, bars: rows.length, initialCapital,
  executionDataEnd: executionRows.at(-1).date, realtimeTimestamp: timestamp,
  feePerSide: fee, sameClose: summary(same), nextOpen: summary(next),
  bySignalSellYear: years.map(year => ({ year,
    sameClose: summary(same.filter(t => t.signalSell.startsWith(year))),
    nextOpen: summary(next.filter(t => t.signalSell.startsWith(year))) })),
  nextOpenBetterTrades: next.filter((t, i) => t.netReturn > same[i].netReturn).length,
  excludedPairsMissingNextBar: pairs.length - comparable.length,
  openSignalPosition: entry === null ? null : rows[entry].date,
  latestBars: rows.slice(-5), latestSameTrades: same.slice(-3), latestNextTrades: next.slice(-3), urls
}, null, 2));
