import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { calculateMacd } from '../src/macd.js';
import { runBacktestDetails } from '../web/src/backtest.js';

const SYMBOL = '512760';
const FEE_RATE = 0.0003;
const INITIAL_CAPITAL = 100000;

const localHourly = await fetchLocalHourlyRows();
const minuteRows = await fetchThsAdjustedMinuteRows();
const thsHourlyRows = aggregateSixtyMinute(minuteRows);
const localThsCrossCheck = compareHourlyRows(localHourly.rows, thsHourlyRows);
const rawHourlyRows = mergeHourlyRows(localHourly.rows, thsHourlyRows);
const dailyRows = await fetchEastmoneyDailyRows();
const hourlyRows = alignHourlyToDaily(rawHourlyRows, dailyRows);
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
hourlySummary.annualizedReturn = annualize(hourlySummary.markedReturn, startDate, endDate);
dailySummary.annualizedReturn = annualize(dailySummary.markedReturn, startDate, endDate);
const firstDaily = dailyRows.find((row) => row.date >= startDate);
const lastDaily = [...dailyRows].reverse().find((row) => row.date <= endDate);
const benchmarkReturn = lastDaily.close / firstDaily.open - 1;
const hourlyDates = new Set(hourlyRows.map((row) => row.date.slice(0, 10)));
const dailyDates = new Set(dailyRows.filter((row) => row.date >= startDate && row.date <= endDate).map((row) => row.date.slice(0, 10)));
const missingHourlyDates = [...dailyDates].filter((date) => !hourlyDates.has(date));
const extraHourlyDates = [...hourlyDates].filter((date) => !dailyDates.has(date));
const crossCheck = compareHourlyRows(hourlyRows, eastmoneyHourlyRows);
const dailyCloseCrossCheck = compareDailyCloses(hourlyRows, dailyRows, startDate, endDate);
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
    source60m: '本地1分钟历史库聚合的标准60分钟K（至2026-08-24）+ 同花顺逐分钟线续接；按东方财富日线前复权收盘因子逐日归一',
    sourceDaily: '东方财富前复权日线',
    startDate,
    endDate,
    tradingDays: new Set(hourlyRows.map((row) => row.date.slice(0, 10))).size,
    minuteBars: minuteRows.length,
    bars60m: hourlyRows.length,
    dailyBarsInWindow: dailyRows.filter((row) => row.date >= startDate && row.date <= endDate).length,
    benchmarkReturn,
    localCoverage: localHourly.coverage,
    localInvalidDates: localHourly.invalidDates,
    missingHourlyDates,
    extraHourlyDates,
    localThsCrossCheck,
    crossCheck,
    dailyCloseCrossCheck
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
await writeFile('outputs/512760_60分钟_vs_日线_MACD_2019至今_20261006.json', `${JSON.stringify(output, null, 2)}\n`);
await writeFile('outputs/512760_60分钟_vs_日线_MACD_2019至今_20261006.md', renderMarkdown(output));
console.log(JSON.stringify(output, null, 2));

async function fetchLocalHourlyRows() {
  const module = await import('file:///D:/lh/lib/local-parquet-reader.mjs');
  try {
    const payload = await module.bars(SYMBOL, 'SH', '60m', '2019-06-12', '2026-08-24');
    const rawRows = (payload.bars ?? []).map((row) => ({
      date: String(row.datetime).slice(0, 19),
      open: Number(row.openMicros) / 1_000_000,
      high: Number(row.highMicros) / 1_000_000,
      low: Number(row.lowMicros) / 1_000_000,
      close: Number(row.closeMicros) / 1_000_000,
      volume: Number(row.volume)
    }));
    const volumeByDay = new Map();
    for (const row of rawRows) volumeByDay.set(row.date.slice(0, 10), (volumeByDay.get(row.date.slice(0, 10)) ?? 0) + row.volume);
    const rows = rawRows.filter((row) => (volumeByDay.get(row.date.slice(0, 10)) ?? 0) > 0);
    if (!rows.length) throw new Error('本地60分钟行情为空');
    return { rows, coverage: payload.coverage, invalidDates: payload.invalid_dates ?? [] };
  } finally {
    await module.closeLocalParquetReader();
  }
}

function mergeHourlyRows(primary, continuation) {
  const rows = new Map(primary.map((row) => [row.date, row]));
  const normalized = new Set(primary.map((row) => row.date.length === 16 ? `${row.date}:00` : row.date));
  for (const row of continuation) {
    const key = row.date.length === 16 ? `${row.date}:00` : row.date;
    if (!normalized.has(key)) rows.set(row.date, row);
  }
  const merged = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byDay = Map.groupBy(merged, (row) => row.date.slice(0, 10));
  for (const [day, dayBars] of byDay) {
    if (dayBars.length !== 4) throw new Error(`${day} 只有 ${dayBars.length} 根60分钟K`);
  }
  return merged;
}

function alignHourlyToDaily(hourly, daily) {
  const dailyClose = new Map(daily.map((row) => [row.date, row.close]));
  const lastByDay = new Map();
  for (const row of hourly) lastByDay.set(row.date.slice(0, 10), row.close);
  return hourly.map((row) => {
    const day = row.date.slice(0, 10);
    const targetClose = dailyClose.get(day), sourceClose = lastByDay.get(day);
    if (!Number.isFinite(targetClose) || !Number.isFinite(sourceClose) || sourceClose <= 0) {
      throw new Error(`${day} 无法对齐60分钟与日线复权因子`);
    }
    const factor = targetClose / sourceClose;
    return {
      ...row,
      open: row.open * factor,
      high: row.high * factor,
      low: row.low * factor,
      close: row.close * factor
    };
  });
}

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

function annualize(totalReturn, start, end) {
  const years = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (365.2425 * 86400000);
  return years > 0 && totalReturn > -1 ? (1 + totalReturn) ** (1 / years) - 1 : null;
}

function filterResult(result, start, end) {
  return {
    trades: (result.trades ?? []).filter((trade) => trade.entryDate >= start && trade.exitDate <= end),
    openPosition: result.openPosition?.entryDate >= start && result.openPosition.latestDate <= end
      ? result.openPosition : null
  };
}

function compareHourlyRows(ours, reference) {
  const normalizeDate = (value) => String(value).length === 16 ? `${value}:00` : String(value);
  const byDate = new Map(ours.map((row) => [normalizeDate(row.date), row]));
  const fields = ['open', 'close', 'high', 'low'];
  let commonBars = 0;
  let mismatchedBars = 0;
  let maxAbsoluteDifference = 0;
  const mismatches = [];
  for (const expected of reference) {
    const actual = byDate.get(normalizeDate(expected.date));
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

function compareDailyCloses(hourly, daily, start, end) {
  const lastByDay = new Map();
  for (const row of hourly) lastByDay.set(row.date.slice(0, 10), row);
  let commonDays = 0, overHalfCent = 0, maxAbsoluteDifference = 0;
  const largest = [];
  for (const expected of daily) {
    if (expected.date < start || expected.date > end) continue;
    const actual = lastByDay.get(expected.date);
    if (!actual) continue;
    commonDays += 1;
    const difference = Math.abs(actual.close - expected.close);
    if (difference > 0.0005) overHalfCent += 1;
    if (difference > maxAbsoluteDifference) maxAbsoluteDifference = difference;
    largest.push({ date: expected.date, hourlyClose: actual.close, dailyClose: expected.close, difference });
  }
  largest.sort((a, b) => b.difference - a.difference);
  return { commonDays, overHalfCent, maxAbsoluteDifference, largest: largest.slice(0, 10) };
}

function percent(value) {
  return value == null ? '—' : `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(result) {
  const d = result.daily, h = result.sixtyMinute;
  const conservative = result.comparison.after100BarWarmup;
  return `# 512760：60分钟 MACD 与日线 MACD 对比\n\n` +
    `- 数据区间：${result.data.startDate} 至 ${result.data.endDate}（${result.data.tradingDays}个交易日）\n` +
    `- 数据完整性：日线 ${result.data.dailyBarsInWindow} 根；60分钟 ${result.data.bars60m} 根（每天4根），交易日无缺失、无多余\n` +
    `- 策略：MACD(12,26,9)，翻红后下一根K线开盘买入，翻绿按当根K线收盘卖出\n` +
    `- 手续费：单边 ${(FEE_RATE * 100).toFixed(2)}%，逐笔复利\n\n` +
    `| 指标 | 日线MACD | 60分钟MACD |\n|---|---:|---:|\n` +
    `| 已实现累计收益 | ${percent(d.realizedReturn)} | ${percent(h.realizedReturn)} |\n` +
    `| 含当前持仓收益 | ${percent(d.markedReturn)} | ${percent(h.markedReturn)} |\n` +
    `| 年化收益（含当前持仓） | ${percent(d.annualizedReturn)} | ${percent(h.annualizedReturn)} |\n` +
    `| 已完成交易 | ${d.completedTrades} | ${h.completedTrades} |\n` +
    `| 胜率 | ${percent(d.winRate)} | ${percent(h.winRate)} |\n` +
    `| 盈亏比 | ${d.pnlRatio?.toFixed(2) ?? '—'} | ${h.pnlRatio?.toFixed(2) ?? '—'} |\n` +
    `| 按已平仓权益最大回撤 | ${percent(d.maxClosedTradeDrawdown)} | ${percent(h.maxClosedTradeDrawdown)} |\n` +
    `| 期末估值资金（初始10万元） | ¥${d.finalMarkedCapital.toFixed(0)} | ¥${h.finalMarkedCapital.toFixed(0)} |\n\n` +
    `**结论：完整区间内日线MACD更好。** 日线含持仓累计收益比60分钟高 ${percent(d.markedReturn - h.markedReturn).replace('%', '个百分点')}，已平仓权益最大回撤少 ${percent(Math.abs(h.maxClosedTradeDrawdown) - Math.abs(d.maxClosedTradeDrawdown)).replace('%', '个百分点')}。\n\n` +
    `同期标的从首日开盘到末日收盘涨跌：${percent(result.data.benchmarkReturn)}。\n\n` +
    `## 稳健性检查\n\n` +
    `- 本地历史库与同花顺重叠区间核对：共同 ${result.data.localThsCrossCheck.commonBars} 根，差异 ${result.data.localThsCrossCheck.mismatchedBars} 根，最大绝对价差 ${result.data.localThsCrossCheck.maxAbsoluteDifference.toFixed(6)}。\n` +
    `- 与东方财富原生60分钟K交叉核对：共同 ${result.data.crossCheck.commonBars} 根，差异 ${result.data.crossCheck.mismatchedBars} 根，最大绝对价差 ${result.data.crossCheck.maxAbsoluteDifference.toFixed(6)}。\n` +
    `- 全区间逐日收盘核对：${result.data.dailyCloseCrossCheck.commonDays} 个交易日；60分钟末根收盘与日线收盘价差超过0.0005元的有 ${result.data.dailyCloseCrossCheck.overHalfCent} 天，最大价差 ${result.data.dailyCloseCrossCheck.maxAbsoluteDifference.toFixed(6)} 元。\n` +
    `- 剔除前100根60分钟K作为EMA预热，从 ${conservative.startDate} 起：日线含持仓收益 ${percent(conservative.daily.markedReturn)}，60分钟含持仓收益 ${percent(conservative.sixtyMinute.markedReturn)}。\n`;
}
