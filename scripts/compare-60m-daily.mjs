import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { calculateMacd } from '../src/macd.js';
import { runBacktestDetails } from '../web/src/backtest.js';

const SYMBOL = '512760';
const FEE_RATE = 0.0003;
const INITIAL_CAPITAL = 100000;

const minuteRows = await fetchThsAdjustedMinuteRows();
const hourlyRows = aggregateSixtyMinute(minuteRows);
const dailyRows = await fetchEastmoneyDailyRows();
const eastmoneyHourlyRows = await fetchEastmoneyHourlyRows();
const hourlyWithMacd = withMacd(hourlyRows);
const dailyWithMacd = withMacd(dailyRows);
const startDate = hourlyRows[0].date.slice(0, 10);
const endDate = hourlyRows.at(-1).date.slice(0, 10);

const hourlyResult = runBacktestDetails(hourlyWithMacd, {
  feeRate: FEE_RATE,
  executionMode: 'nextOpenBuySameCloseSell'
});
const dailyFullResult = runBacktestDetails(dailyWithMacd, {
  feeRate: FEE_RATE,
  executionMode: 'nextOpenBuySameCloseSell'
});
const dailyResult = {
  trades: dailyFullResult.trades.filter((trade) => trade.entryDate >= startDate && trade.exitDate <= endDate),
  openPosition: dailyFullResult.openPosition?.entryDate >= startDate && dailyFullResult.openPosition.latestDate <= endDate
    ? dailyFullResult.openPosition : null
};

const hourlySummary = summarize(hourlyResult);
const dailySummary = summarize(dailyResult);
const firstDaily = dailyRows.find((row) => row.date >= startDate);
const lastDaily = [...dailyRows].reverse().find((row) => row.date <= endDate);
const benchmarkReturn = lastDaily.close / firstDaily.open - 1;
const crossCheck = compareHourlyRows(hourlyRows, eastmoneyHourlyRows);
const conservativeStart = hourlyRows[100].date.slice(0, 10);
const conservativeHourly = filterResult(hourlyResult, conservativeStart, endDate);
const conservativeDaily = filterResult(dailyFullResult, conservativeStart, endDate);

const output = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  assumptions: {
    macd: '12,26,9',
    buy: '信号周期收盘确认翻红，下一根K线开盘买入',
    sell: '信号周期收盘确认翻绿，按该周期收盘价卖出',
    feePerSide: FEE_RATE,
    compounding: true,
    initialCapital: INITIAL_CAPITAL
  },
  data: {
    source60m: '同花顺前复权逐分钟线（代码61）聚合为标准4根/日的60分钟K',
    sourceDaily: '东方财富前复权日线',
    startDate,
    endDate,
    tradingDays: new Set(hourlyRows.map((row) => row.date.slice(0, 10))).size,
    minuteBars: minuteRows.length,
    bars60m: hourlyRows.length,
    dailyBarsInWindow: dailyRows.filter((row) => row.date >= startDate && row.date <= endDate).length,
    benchmarkReturn,
    crossCheck
  },
  daily: { ...dailySummary, trades: dailyResult.trades, openPosition: dailyResult.openPosition },
  sixtyMinute: { ...hourlySummary, trades: hourlyResult.trades, openPosition: hourlyResult.openPosition },
  comparison: {
    realizedReturnDifference: hourlySummary.realizedReturn - dailySummary.realizedReturn,
    markedReturnDifference: hourlySummary.markedReturn - dailySummary.markedReturn,
    after100BarWarmup: {
      startDate: conservativeStart,
      daily: summarize(conservativeDaily),
      sixtyMinute: summarize(conservativeHourly)
    }
  }
};

await mkdir('outputs', { recursive: true });
await writeFile('outputs/512760_60分钟_vs_日线_MACD_20261006.json', `${JSON.stringify(output, null, 2)}\n`);
await writeFile('outputs/512760_60分钟_vs_日线_MACD_20261006.md', renderMarkdown(output));
console.log(JSON.stringify(output, null, 2));

async function fetchThsAdjustedMinuteRows() {
  const url = `https://d.10jqka.com.cn/v6/line/hs_${SYMBOL}/61/all.js`;
  let text;
  try {
    text = await readFile(`work/ths-${SYMBOL}-61-all.js`, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const response = await fetchWithRetry(url, {
      headers: { Referer: `https://stockpage.10jqka.com.cn/${SYMBOL}/`, 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error(`同花顺分钟行情 HTTP ${response.status}`);
    text = await response.text();
  }
  const start = text.indexOf('('), end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('同花顺分钟行情格式异常');
  const payload = JSON.parse(text.slice(start + 1, end));
  const dates = String(payload.dates ?? '').split(',');
  const prices = String(payload.price ?? '').split(',').map(Number);
  const factor = Number(payload.priceFactor);
  const years = Array.isArray(payload.sortYear) ? payload.sortYear : [];
  if (dates.length !== Number(payload.total) || prices.length !== dates.length * 4 || !factor) {
    throw new Error('同花顺分钟行情字段数量异常');
  }
  const yearByIndex = [];
  for (const [year, count] of years) {
    for (let i = 0; i < Number(count); i += 1) yearByIndex.push(String(year));
  }
  if (yearByIndex.length !== dates.length) throw new Error('同花顺分钟行情年份数量异常');
  return dates.map((compact, index) => {
    const [lowBase, openDelta, highDelta, closeDelta] = prices.slice(index * 4, index * 4 + 4);
    const row = {
      date: `${yearByIndex[index]}-${compact.slice(0, 2)}-${compact.slice(2, 4)} ${compact.slice(4, 6)}:${compact.slice(6, 8)}`,
      open: (lowBase + openDelta) / factor,
      high: (lowBase + highDelta) / factor,
      low: lowBase / factor,
      close: (lowBase + closeDelta) / factor
    };
    if (![row.open, row.high, row.low, row.close].every(Number.isFinite) ||
        row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) {
      throw new Error(`同花顺分钟OHLC解码失败：${JSON.stringify(row)}`);
    }
    return row;
  });
}

function aggregateSixtyMinute(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const day = row.date.slice(0, 10);
    const time = row.date.slice(11);
    const label = time <= '10:30' ? '10:30'
      : time <= '11:30' ? '11:30'
        : time <= '14:00' ? '14:00' : '15:00';
    const key = `${day} ${label}`;
    const current = buckets.get(key);
    if (!current) buckets.set(key, { date: key, open: row.open, high: row.high, low: row.low, close: row.close, minutes: 1 });
    else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.minutes += 1;
    }
  }
  const bars = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byDay = Map.groupBy(bars, (row) => row.date.slice(0, 10));
  for (const [day, dayBars] of byDay) {
    if (dayBars.length !== 4) throw new Error(`${day} 只有 ${dayBars.length} 根60分钟K`);
  }
  return bars;
}

async function fetchEastmoneyDailyRows() {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  for (const [key, value] of Object.entries({
    secid: `1.${SYMBOL}`, klt: '101', fqt: '1', lmt: '10000', end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56'
  })) url.searchParams.set(key, value);
  const response = await fetchWithRetry(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`东方财富日线 HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data?.klines)) throw new Error('东方财富日线格式异常');
  return payload.data.klines.map((line) => {
    const [date, open, close, high, low] = line.split(',');
    return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low) };
  });
}

async function fetchEastmoneyHourlyRows() {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  for (const [key, value] of Object.entries({
    secid: `1.${SYMBOL}`, klt: '60', fqt: '1', lmt: '10000', end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56'
  })) url.searchParams.set(key, value);
  const response = await fetchWithRetry(url, {});
  if (!response.ok) throw new Error(`东方财富60分钟线 HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data?.klines)) throw new Error('东方财富60分钟线格式异常');
  return payload.data.klines.map((line) => {
    const [date, open, close, high, low] = line.split(',');
    return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low) };
  });
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (response.ok || attempt === attempts) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  throw lastError;
}

function withMacd(rows) {
  const macd = calculateMacd(rows.map(({ close }) => close));
  return rows.map((row, index) => ({ ...row, ...macd[index] }));
}

function summarize(result) {
  const trades = result.trades ?? [];
  const wins = trades.filter(({ netReturn }) => netReturn > 0);
  const losses = trades.filter(({ netReturn }) => netReturn <= 0);
  const realizedMultiple = trades.reduce((equity, trade) => equity * (1 + trade.netReturn), 1);
  const markedMultiple = result.openPosition ? realizedMultiple * (1 + result.openPosition.unrealizedReturn) : realizedMultiple;
  const avgWin = wins.length ? wins.reduce((sum, trade) => sum + trade.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((sum, trade) => sum + trade.netReturn, 0) / losses.length) : 0;
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    completedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    pnlRatio: avgLoss ? avgWin / avgLoss : null,
    realizedReturn: realizedMultiple - 1,
    markedReturn: markedMultiple - 1,
    finalMarkedCapital: INITIAL_CAPITAL * markedMultiple,
    maxClosedTradeDrawdown: maxDrawdown
  };
}

function filterResult(result, start, end) {
  return {
    trades: (result.trades ?? []).filter((trade) => trade.entryDate >= start && trade.exitDate <= end),
    openPosition: result.openPosition?.entryDate >= start && result.openPosition.latestDate <= end
      ? result.openPosition : null
  };
}

function compareHourlyRows(ours, reference) {
  const byDate = new Map(ours.map((row) => [row.date, row]));
  const fields = ['open', 'close', 'high', 'low'];
  let commonBars = 0;
  let mismatchedBars = 0;
  let maxAbsoluteDifference = 0;
  const mismatches = [];
  for (const expected of reference) {
    const actual = byDate.get(expected.date);
    if (!actual) continue;
    commonBars += 1;
    const difference = Math.max(...fields.map((field) => Math.abs(actual[field] - expected[field])));
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
    if (difference > 0.0000001) {
      mismatchedBars += 1;
      mismatches.push({ date: expected.date, actual, expected, difference });
    }
  }
  return { referenceBars: reference.length, commonBars, mismatchedBars, maxAbsoluteDifference, mismatches };
}

function percent(value) {
  return value == null ? '—' : `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(result) {
  const d = result.daily, h = result.sixtyMinute;
  const conservative = result.comparison.after100BarWarmup;
  return `# 512760：60分钟 MACD 与日线 MACD 对比\n\n` +
    `- 数据区间：${result.data.startDate} 至 ${result.data.endDate}（${result.data.tradingDays}个交易日）\n` +
    `- 策略：MACD(12,26,9)，翻红后下一根K线开盘买入，翻绿按当根K线收盘卖出\n` +
    `- 手续费：单边 ${(FEE_RATE * 100).toFixed(2)}%，逐笔复利\n\n` +
    `| 指标 | 日线MACD | 60分钟MACD |\n|---|---:|---:|\n` +
    `| 已实现累计收益 | ${percent(d.realizedReturn)} | ${percent(h.realizedReturn)} |\n` +
    `| 含当前持仓收益 | ${percent(d.markedReturn)} | ${percent(h.markedReturn)} |\n` +
    `| 已完成交易 | ${d.completedTrades} | ${h.completedTrades} |\n` +
    `| 胜率 | ${percent(d.winRate)} | ${percent(h.winRate)} |\n` +
    `| 盈亏比 | ${d.pnlRatio?.toFixed(2) ?? '—'} | ${h.pnlRatio?.toFixed(2) ?? '—'} |\n` +
    `| 按已平仓权益最大回撤 | ${percent(d.maxClosedTradeDrawdown)} | ${percent(h.maxClosedTradeDrawdown)} |\n` +
    `| 期末估值资金（初始10万元） | ¥${d.finalMarkedCapital.toFixed(0)} | ¥${h.finalMarkedCapital.toFixed(0)} |\n\n` +
    `同期标的从首日开盘到末日收盘涨跌：${percent(result.data.benchmarkReturn)}。\n\n` +
    `## 稳健性检查\n\n` +
    `- 与东方财富原生60分钟K交叉核对：共同 ${result.data.crossCheck.commonBars} 根，差异 ${result.data.crossCheck.mismatchedBars} 根，最大绝对价差 ${result.data.crossCheck.maxAbsoluteDifference.toFixed(6)}。\n` +
    `- 剔除前100根60分钟K作为EMA预热，从 ${conservative.startDate} 起：日线含持仓收益 ${percent(conservative.daily.markedReturn)}，60分钟含持仓收益 ${percent(conservative.sixtyMinute.markedReturn)}。\n`;
}
