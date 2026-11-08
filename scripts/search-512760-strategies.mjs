import { mkdir, writeFile } from 'node:fs/promises';
import { calculateMacd } from '../src/macd.js';

const SYMBOL = '512760';
const FEE_RATE = 0.0003;
const INITIAL_CAPITAL = 100000;
const PERIODS = {
  early: ['2019-06-12', '2021-12-31'],
  middle: ['2022-01-01', '2023-12-31'],
  recent: ['2024-01-01', '2026-09-30'],
  full: ['2019-06-12', '2026-09-30']
};

const rows = await fetchDailyRows();
const closes = rows.map((row) => row.close);
const smaCache = new Map();
const sma = (period) => {
  if (smaCache.has(period)) return smaCache.get(period);
  let sum = 0;
  const values = closes.map((value, index) => {
    sum += value;
    if (index >= period) sum -= closes[index - period];
    return index >= period - 1 ? sum / period : null;
  });
  smaCache.set(period, values);
  return values;
};

const candidates = [];
const addCandidate = (name, family, buySignals, sellSignals, parameters = {}, minIndex = 1) => {
  const periods = Object.fromEntries(Object.entries(PERIODS).map(([key, [start, end]]) =>
    [key, summarize(backtest(rows, buySignals, sellSignals, start, end, minIndex))]));
  candidates.push({ name, family, parameters, periods });
};

const macdCache = new Map();
const macdSignals = (fast, slow, signal) => {
  const key = `${fast},${slow},${signal}`;
  if (macdCache.has(key)) return macdCache.get(key);
  const values = calculateMacd(closes, { short: fast, long: slow, signal });
  const buy = values.map((row, i) => i > 0 && row.hist > 0 && values[i - 1].hist <= 0);
  const sell = values.map((row, i) => i > 0 && row.hist < 0 && values[i - 1].hist >= 0);
  const result = { buy, sell };
  macdCache.set(key, result);
  return result;
};

const fastValues = [6, 8, 10, 12, 15, 18];
const slowValues = [20, 26, 30, 35, 40, 50];
const signalValues = [5, 7, 9, 12, 15];
const trendPeriods = [null, 20, 60, 120, 200];
for (const fast of fastValues) for (const slow of slowValues) for (const signal of signalValues) {
  if (fast >= slow) continue;
  const base = macdSignals(fast, slow, signal);
  for (const trend of trendPeriods) {
    const trendSma = trend ? sma(trend) : null;
    const buy = base.buy.map((value, index) => value && (!trend || (trendSma[index] != null && closes[index] > trendSma[index])));
    addCandidate(`MACD(${fast},${slow},${signal})${trend ? ` + 收盘>MA${trend}` : ''}`, 'MACD', buy, base.sell,
      { fast, slow, signal, trendMa: trend }, slow + signal);
  }
}

const baselineMacd = macdSignals(12, 26, 9);
for (const exitMa of [10, 20, 50, 100]) {
  const average = sma(exitMa);
  const sell = baselineMacd.sell.map((value, index) => value || (index > 0 && average[index] != null && closes[index] < average[index] && closes[index - 1] >= average[index - 1]));
  addCandidate(`MACD(12,26,9) + 跌破MA${exitMa}退出`, 'MACD保护退出', baselineMacd.buy, sell, { exitMa }, 35);
}

for (const fast of [5, 10, 20, 30, 50]) for (const slow of [20, 50, 100, 120, 200]) {
  if (fast >= slow) continue;
  const fastMa = sma(fast), slowMa = sma(slow);
  const buy = closes.map((_, index) => index > 0 && fastMa[index] != null && slowMa[index] != null && fastMa[index] > slowMa[index] && fastMa[index - 1] <= slowMa[index - 1]);
  const sell = closes.map((_, index) => index > 0 && fastMa[index] != null && slowMa[index] != null && fastMa[index] < slowMa[index] && fastMa[index - 1] >= slowMa[index - 1]);
  addCandidate(`MA${fast}/MA${slow}金叉死叉`, '均线交叉', buy, sell, { fastMa: fast, slowMa: slow }, slow);
}

for (const lookback of [20, 55, 100, 120]) for (const exitMa of [10, 20, 50, 100]) {
  const exitAverage = sma(exitMa);
  const buy = closes.map((value, index) => index >= lookback && value > Math.max(...closes.slice(index - lookback, index)));
  const sell = closes.map((value, index) => index > 0 && exitAverage[index] != null && value < exitAverage[index] && closes[index - 1] >= exitAverage[index - 1]);
  addCandidate(`${lookback}日新高突破 + 跌破MA${exitMa}退出`, '突破趋势', buy, sell, { lookback, exitMa }, Math.max(lookback, exitMa));
}

addCandidate('原始MACD(12,26,9)', '基准', baselineMacd.buy, baselineMacd.sell, { fast: 12, slow: 26, signal: 9 }, 35);

const baseline = candidates.find((item) => item.family === '基准');
const superior = candidates.filter((item) => item !== baseline &&
  item.periods.full.markedReturn > baseline.periods.full.markedReturn &&
  item.periods.recent.markedReturn > baseline.periods.recent.markedReturn &&
  item.periods.full.maxDrawdown >= baseline.periods.full.maxDrawdown - 0.05 &&
  item.periods.early.completedTrades >= 3 && item.periods.middle.completedTrades >= 3 && item.periods.recent.completedTrades >= 3)
  .sort((a, b) => b.periods.full.markedReturn - a.periods.full.markedReturn);

const developmentRanked = candidates.filter((item) => item !== baseline && item.periods.early.completedTrades >= 3 &&
  item.periods.middle.completedTrades >= 3 && item.periods.early.maxDrawdown >= baseline.periods.early.maxDrawdown - 0.05)
  .sort((a, b) => (b.periods.early.markedReturn + b.periods.middle.markedReturn) - (a.periods.early.markedReturn + a.periods.middle.markedReturn));

const output = {
  generatedAt: new Date().toISOString(), symbol: SYMBOL,
  assumptions: { macd: '日线；信号收盘确认；下一交易日开盘买入；退出信号当日收盘卖出', feePerSide: FEE_RATE, initialCapital: INITIAL_CAPITAL },
  data: { startDate: rows[0].date, endDate: rows.at(-1).date, bars: rows.length, source: '东方财富/腾讯同口径前复权日线（东方财富失败时分段回退腾讯）' },
  search: { candidateCount: candidates.length, periods: PERIODS, selectionRule: '完整期和2024-2026收益均高于原策略，完整期逐笔权益最大回撤最多恶化5个百分点，每段至少3笔交易' },
  baseline,
  superior: superior.slice(0, 30),
  developmentTop: developmentRanked.slice(0, 20)
};

await mkdir('outputs', { recursive: true });
await writeFile('outputs/512760_高收益策略搜索_2019至今_20261008.json', `${JSON.stringify(output, null, 2)}\n`);
await writeFile('outputs/512760_高收益策略搜索_2019至今_20261008.md', renderMarkdown(output));
console.log(JSON.stringify({ candidateCount: candidates.length, baseline, superior: superior.slice(0, 10), developmentTop: developmentRanked.slice(0, 5) }, null, 2));

function backtest(data, buySignals, sellSignals, startDate, endDate, minIndex = 1) {
  const trades = [];
  let entry = null;
  let lastIndex = -1;
  for (let index = Math.max(1, minIndex); index < data.length; index += 1) {
    const row = data[index];
    if (row.date > endDate) break;
    if (row.date < startDate) continue;
    lastIndex = index;
    if (!entry && buySignals[index]) {
      const fill = data[index + 1];
      if (fill && fill.date <= endDate) entry = { index: index + 1, date: fill.date, price: fill.open, signalDate: row.date };
    } else if (entry && sellSignals[index]) {
      const grossReturn = row.close / entry.price - 1;
      trades.push({ entryDate: entry.date, exitDate: row.date, entryPrice: entry.price, exitPrice: row.close,
        grossReturn, netReturn: grossReturn - FEE_RATE * 2 });
      entry = null;
    }
  }
  const mark = lastIndex >= 0 ? data[lastIndex] : null;
  const openPosition = entry && mark ? { entryDate: entry.date, entryPrice: entry.price, latestDate: mark.date,
    latestPrice: mark.close, unrealizedReturn: mark.close / entry.price - 1 - FEE_RATE } : null;
  return { trades, openPosition };
}

function summarize(result) {
  const trades = result.trades;
  const wins = trades.filter((trade) => trade.netReturn > 0), losses = trades.filter((trade) => trade.netReturn <= 0);
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
  return { completedTrades: trades.length, winRate: trades.length ? wins.length / trades.length : null,
    pnlRatio: avgLoss ? avgWin / avgLoss : null, realizedReturn: realizedMultiple - 1, markedReturn: markedMultiple - 1,
    finalMarkedCapital: markedMultiple * INITIAL_CAPITAL, maxDrawdown, openPosition: result.openPosition };
}

async function fetchDailyRows() {
  const hosts = ['https://push2his.eastmoney.com', 'https://push2his.eastmoney.com', 'https://push2delay.eastmoney.com'];
  let payload, lastError;
  for (const host of hosts) {
    const url = new URL('/api/qt/stock/kline/get', host);
    for (const [key, value] of Object.entries({ secid: `1.${SYMBOL}`, klt: '101', fqt: '1', lmt: '10000', end: '20500101',
      fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56' })) url.searchParams.set(key, value);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { Referer: 'https://quote.eastmoney.com/' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
      if (Array.isArray(payload?.data?.klines)) break;
      throw new Error('返回格式异常');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (Array.isArray(payload?.data?.klines)) {
    return payload.data.klines.map((line) => {
      const [date, open, close, high, low] = line.split(',');
      return { date, open: Number(open), close: Number(close), high: Number(high), low: Number(low) };
    }).filter((row) => row.date >= PERIODS.full[0] && row.date <= PERIODS.full[1]);
  }
  const chunks = [['2019-06-12', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2025-12-31'], ['2026-01-01', '2026-09-30']];
  const merged = [];
  for (const [start, end] of chunks) {
    const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
    url.searchParams.set('param', `sh${SYMBOL},day,${start},${end},640,qfq`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`腾讯日线 HTTP ${response.status}；东方财富：${lastError?.message ?? '失败'}`);
    const data = await response.json(), market = data?.data?.[`sh${SYMBOL}`], values = market?.qfqday ?? market?.day;
    if (!Array.isArray(values) || !values.length) throw new Error(`腾讯日线 ${start}~${end} 返回异常`);
    merged.push(...values.map((row) => ({ date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]) })));
  }
  return [...new Map(merged.map((row) => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

function pct(value) { return value == null ? '—' : `${(value * 100).toFixed(2)}%`; }
function rowLine(item) {
  const full = item.periods.full, recent = item.periods.recent;
  return `| ${item.name} | ${pct(full.markedReturn)} | ${pct(full.maxDrawdown)} | ${full.completedTrades} | ${pct(recent.markedReturn)} | ${pct(recent.maxDrawdown)} |`;
}
function renderMarkdown(result) {
  const base = result.baseline.periods;
  const top = result.superior.slice(0, 10);
  const best = top[0], bestPeriods = best?.periods;
  const years = (Date.parse(result.data.endDate) - Date.parse(result.data.startDate)) / (365.2425 * 86400000);
  const cagr = (value) => (1 + value) ** (1 / years) - 1;
  return `# 512760 高收益策略搜索\n\n` +
    `- 数据：${result.data.startDate} 至 ${result.data.endDate}，同口径前复权日线 ${result.data.bars} 根\n` +
    `- 共测试 ${result.search.candidateCount} 个候选；全部采用T日收盘确认、T+1开盘买入、退出信号当日收盘卖出，单边手续费0.03%\n` +
    `- 分段：2019-2021、2022-2023、2024-2026；筛选要求完整期和最近期均超过原策略，且完整期最大回撤最多恶化5个百分点\n\n` +
    `## 原策略\n\n` +
    `MACD(12,26,9)：完整期 ${pct(base.full.markedReturn)}，最大回撤 ${pct(base.full.maxDrawdown)}；2024-2026 ${pct(base.recent.markedReturn)}。\n\n` +
    (best ? `## 当前最优候选\n\n` +
      `**${best.name}**：完整期 ${pct(bestPeriods.full.markedReturn)}，年化 ${pct(cagr(bestPeriods.full.markedReturn))}，最大回撤 ${pct(bestPeriods.full.maxDrawdown)}，${bestPeriods.full.completedTrades} 笔。\n\n` +
      `| 分段 | 原策略 | ${best.name} |\n|---|---:|---:|\n` +
      `| 2019-2021 | ${pct(base.early.markedReturn)} | ${pct(bestPeriods.early.markedReturn)} |\n` +
      `| 2022-2023 | ${pct(base.middle.markedReturn)} | ${pct(bestPeriods.middle.markedReturn)} |\n` +
      `| 2024-2026 | ${pct(base.recent.markedReturn)} | ${pct(bestPeriods.recent.markedReturn)} |\n\n` : '') +
    `## 通过筛选的前10名\n\n` +
    (top.length ? `| 策略 | 完整期收益 | 完整期回撤 | 交易数 | 2024-2026收益 | 近期回撤 |\n|---|---:|---:|---:|---:|---:|\n${top.map(rowLine).join('\n')}\n` : '没有候选同时满足收益和回撤约束。\n') +
    `\n> 这些仍属于历史数据筛选结果，需要继续用后续新数据验证，不能把最高收益项直接视为未来最优。\n`;
}
