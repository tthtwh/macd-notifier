import { mkdir, writeFile } from 'node:fs/promises';
import { calculateMacd } from '../src/macd.js';

const SYMBOL = '512760';
const FEE_RATE = 0.0003;
const START = '2019-06-12';
const END = '2026-09-30';
const INITIAL_CAPITAL = 100000;

const rows = await fetchDailyRows();
const baselineSignals = signals(12, 26, 9);
const candidateSignals = signals(12, 30, 9);
const baselineRun = backtest(baselineSignals, START, END, 35);
const candidateRun = backtest(candidateSignals, START, END, 39);
const baseline = summarize(baselineRun);
const candidate = summarize(candidateRun);
const years = [...new Set(rows.map((row) => row.date.slice(0, 4)))];
const yearly = years.map((year) => comparePeriod(year, `${year}-01-01`, `${year}-12-31`));
const rollingThreeYear = years.slice(0, -2).map((year, index) => comparePeriod(
  `${year}-${years[index + 2]}`, `${year}-01-01`, `${years[index + 2]}-12-31`
));
const slowNeighborhood = [];
for (let slow = 24; slow <= 34; slow += 1) {
  const run = backtest(signals(12, slow, 9), START, END, slow + 9);
  slowNeighborhood.push({ slow, ...summarize(run) });
}

const exactBaseline = new Set(baselineRun.trades.map(tradeKey));
const exactCandidate = new Set(candidateRun.trades.map(tradeKey));
const entryBaseline = new Map(baselineRun.trades.map((trade) => [trade.entryDate, trade]));
const entryCandidate = new Map(candidateRun.trades.map((trade) => [trade.entryDate, trade]));
const sharedExactTrades = [...exactBaseline].filter((key) => exactCandidate.has(key)).length;
const sharedEntries = [...entryBaseline.keys()].filter((key) => entryCandidate.has(key)).length;
const differingTrades = [...new Set([...entryBaseline.keys(), ...entryCandidate.keys()])].sort().flatMap((entryDate) => {
  const base = entryBaseline.get(entryDate), next = entryCandidate.get(entryDate);
  if (base && next && tradeKey(base) === tradeKey(next)) return [];
  return [{ entryDate, baseline: base ?? null, candidate: next ?? null }];
});

const baselineCurve = equityCurve(baselineRun);
const candidateCurve = equityCurve(candidateRun);
const bootstrap = blockBootstrapDifference(baselineCurve, candidateCurve, 20, 20000, 20261008);
const concentration = {
  baseline: contributionDiagnostics(baselineRun),
  candidate: contributionDiagnostics(candidateRun)
};

const output = {
  generatedAt: new Date().toISOString(), symbol: SYMBOL,
  assumptions: { start: START, end: END, feePerSide: FEE_RATE, buy: 'T日收盘确认翻红，T+1开盘买入', sell: '翻绿当日收盘卖出' },
  data: { source: '腾讯前复权日线（与东方财富抽样价格一致）', bars: rows.length, start: rows[0].date, end: rows.at(-1).date },
  baseline: { parameters: [12, 26, 9], ...baseline, trades: baselineRun.trades, openPosition: baselineRun.openPosition },
  candidate: { parameters: [12, 30, 9], ...candidate, trades: candidateRun.trades, openPosition: candidateRun.openPosition },
  yearly, rollingThreeYear, slowNeighborhood,
  tradeComparison: { sharedExactTrades, sharedEntries, baselineTrades: baselineRun.trades.length, candidateTrades: candidateRun.trades.length, differingTrades },
  concentration, bootstrap
};

await mkdir('outputs', { recursive: true });
await writeFile('outputs/512760_MACD_12309_vs_12269_稳定性分析_20261008.json', `${JSON.stringify(output, null, 2)}\n`);
await writeFile('outputs/512760_MACD_12309_vs_12269_稳定性分析_20261008.md', renderMarkdown(output));
console.log(JSON.stringify({ baseline, candidate, yearly, rollingThreeYear, slowNeighborhood,
  tradeComparison: output.tradeComparison, concentration, bootstrap }, null, 2));

function signals(fast, slow, signal) {
  const values = calculateMacd(rows.map((row) => row.close), { short: fast, long: slow, signal });
  return {
    buy: values.map((row, index) => index > 0 && row.hist > 0 && values[index - 1].hist <= 0),
    sell: values.map((row, index) => index > 0 && row.hist < 0 && values[index - 1].hist >= 0)
  };
}

function backtest(strategy, start, end, minIndex) {
  const trades = [];
  let entry = null, lastIndex = -1;
  for (let index = Math.max(1, minIndex); index < rows.length; index += 1) {
    const row = rows[index];
    if (row.date > end) break;
    if (row.date < start) continue;
    lastIndex = index;
    if (!entry && strategy.buy[index]) {
      const fill = rows[index + 1];
      if (fill && fill.date <= end) entry = { index: index + 1, date: fill.date, price: fill.open, signalDate: row.date };
    } else if (entry && strategy.sell[index]) {
      const grossReturn = row.close / entry.price - 1;
      trades.push({ entryDate: entry.date, exitDate: row.date, entrySignalDate: entry.signalDate,
        entryPrice: entry.price, exitPrice: row.close, grossReturn, netReturn: grossReturn - FEE_RATE * 2 });
      entry = null;
    }
  }
  const mark = lastIndex >= 0 ? rows[lastIndex] : null;
  const openPosition = entry && mark ? { entryDate: entry.date, entryPrice: entry.price, latestDate: mark.date,
    latestPrice: mark.close, unrealizedReturn: mark.close / entry.price - 1 - FEE_RATE } : null;
  return { trades, openPosition, start, end };
}

function summarize(run) {
  const wins = run.trades.filter((trade) => trade.netReturn > 0), losses = run.trades.filter((trade) => trade.netReturn <= 0);
  const realizedMultiple = run.trades.reduce((equity, trade) => equity * (1 + trade.netReturn), 1);
  const markedMultiple = run.openPosition ? realizedMultiple * (1 + run.openPosition.unrealizedReturn) : realizedMultiple;
  const avgWin = wins.length ? wins.reduce((sum, trade) => sum + trade.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((sum, trade) => sum + trade.netReturn, 0) / losses.length) : 0;
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const trade of run.trades) {
    equity *= 1 + trade.netReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  const durationYears = (Date.parse(run.end) - Date.parse(run.start)) / (365.2425 * 86400000);
  return { completedTrades: run.trades.length, wins: wins.length, winRate: run.trades.length ? wins.length / run.trades.length : null,
    pnlRatio: avgLoss ? avgWin / avgLoss : null, realizedReturn: realizedMultiple - 1, markedReturn: markedMultiple - 1,
    annualizedReturn: durationYears > 0 ? markedMultiple ** (1 / durationYears) - 1 : null,
    finalCapital: markedMultiple * INITIAL_CAPITAL, maxDrawdown };
}

function comparePeriod(label, start, end) {
  const base = summarize(backtest(baselineSignals, start, end, 35));
  const next = summarize(backtest(candidateSignals, start, end, 39));
  return { label, start, end, baseline: base, candidate: next, candidateAdvantage: next.markedReturn - base.markedReturn };
}

function contributionDiagnostics(run) {
  const sorted = [...run.trades].sort((a, b) => b.netReturn - a.netReturn);
  const productWithout = (count) => sorted.slice(count).reduce((equity, trade) => equity * (1 + trade.netReturn), 1) - 1;
  return { topTrades: sorted.slice(0, 5), realizedReturn: summarize(run).realizedReturn,
    withoutBestTrade: productWithout(1), withoutTopThreeTrades: productWithout(3) };
}

function equityCurve(run) {
  const entries = new Map(run.trades.map((trade) => [trade.entryDate, trade]));
  const exits = new Map(run.trades.map((trade) => [trade.exitDate, trade]));
  if (run.openPosition) entries.set(run.openPosition.entryDate, { ...run.openPosition, netReturn: null });
  let realized = 1, base = 1, position = null, previousMark = 1;
  const curve = [];
  for (const row of rows) {
    if (row.date < run.start || row.date > run.end) continue;
    if (entries.has(row.date)) { position = entries.get(row.date); base = realized; }
    if (position && exits.has(row.date) && exits.get(row.date).entryDate === position.entryDate) {
      realized = base * (1 + exits.get(row.date).netReturn);
      position = null;
    }
    const mark = position ? base * (row.close / position.entryPrice - FEE_RATE) : realized;
    curve.push({ date: row.date, equity: mark, logReturn: Math.log(mark / previousMark) });
    previousMark = mark;
  }
  return curve;
}

function blockBootstrapDifference(baselineCurve, candidateCurve, blockSize, samples, seed) {
  const candidateByDate = new Map(candidateCurve.map((row) => [row.date, row.logReturn]));
  const differences = baselineCurve.flatMap((row) => candidateByDate.has(row.date) ? [candidateByDate.get(row.date) - row.logReturn] : []);
  const random = mulberry32(seed);
  const sampledAdvantages = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0, count = 0;
    while (count < differences.length) {
      const start = Math.floor(random() * Math.max(1, differences.length - blockSize + 1));
      for (let offset = 0; offset < blockSize && count < differences.length; offset += 1, count += 1) total += differences[start + offset];
    }
    sampledAdvantages.push(Math.exp(total) - 1);
  }
  sampledAdvantages.sort((a, b) => a - b);
  return { blockSize, samples, probabilityCandidateOutperforms: sampledAdvantages.filter((value) => value > 0).length / samples,
    medianRelativeAdvantage: sampledAdvantages[Math.floor(samples / 2)],
    interval90: [sampledAdvantages[Math.floor(samples * 0.05)], sampledAdvantages[Math.floor(samples * 0.95)]] };
}

function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}

function tradeKey(trade) { return `${trade.entryDate}|${trade.exitDate}`; }

async function fetchDailyRows() {
  const chunks = [['2019-06-12', '2021-12-31'], ['2022-01-01', '2023-12-31'], ['2024-01-01', '2025-12-31'], ['2026-01-01', '2026-09-30']];
  const merged = [];
  for (const [start, end] of chunks) {
    const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
    url.searchParams.set('param', `sh${SYMBOL},day,${start},${end},640,qfq`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`腾讯日线 HTTP ${response.status}`);
    const payload = await response.json(), market = payload?.data?.[`sh${SYMBOL}`], values = market?.qfqday ?? market?.day;
    if (!Array.isArray(values) || !values.length) throw new Error(`腾讯日线 ${start}~${end} 返回异常`);
    merged.push(...values.map((row) => ({ date: row[0], open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]) })));
  }
  return [...new Map(merged.map((row) => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

function pct(value) { return value == null ? '—' : `${(value * 100).toFixed(2)}%`; }
function renderMarkdown(result) {
  const yearlyRows = result.yearly.map((row) => `| ${row.label} | ${pct(row.baseline.markedReturn)} | ${pct(row.candidate.markedReturn)} | ${pct(row.candidateAdvantage)} |`).join('\n');
  const rollingRows = result.rollingThreeYear.map((row) => `| ${row.label} | ${pct(row.baseline.markedReturn)} | ${pct(row.candidate.markedReturn)} | ${pct(row.candidateAdvantage)} |`).join('\n');
  const neighborRows = result.slowNeighborhood.map((row) => `| ${row.slow} | ${pct(row.markedReturn)} | ${pct(row.maxDrawdown)} | ${row.completedTrades} |`).join('\n');
  return `# 512760：MACD(12,30,9) 与原始 MACD(12,26,9) 稳定性分析\n\n` +
    `- 区间：${START} 至 ${END}；前复权日线；单边手续费0.03%\n` +
    `- 成交：T日翻红确认，T+1开盘买；翻绿当日收盘卖\n\n` +
    `| 指标 | 原始(12,26,9) | 候选(12,30,9) |\n|---|---:|---:|\n` +
    `| 含持仓累计收益 | ${pct(result.baseline.markedReturn)} | ${pct(result.candidate.markedReturn)} |\n` +
    `| 年化收益 | ${pct(result.baseline.annualizedReturn)} | ${pct(result.candidate.annualizedReturn)} |\n` +
    `| 最大回撤 | ${pct(result.baseline.maxDrawdown)} | ${pct(result.candidate.maxDrawdown)} |\n` +
    `| 交易数 | ${result.baseline.completedTrades} | ${result.candidate.completedTrades} |\n` +
    `| 胜率 | ${pct(result.baseline.winRate)} | ${pct(result.candidate.winRate)} |\n` +
    `| 盈亏比 | ${result.baseline.pnlRatio.toFixed(2)} | ${result.candidate.pnlRatio.toFixed(2)} |\n\n` +
    `## 独立年度\n\n| 年份 | 原始 | 候选 | 候选差值 |\n|---|---:|---:|---:|\n${yearlyRows}\n\n` +
    `## 滚动三年\n\n| 区间 | 原始 | 候选 | 候选差值 |\n|---|---:|---:|---:|\n${rollingRows}\n\n` +
    `## 慢线参数邻域\n\n| 慢线 | 含持仓收益 | 最大回撤 | 交易数 |\n|---:|---:|---:|---:|\n${neighborRows}\n\n` +
    `## 集中度与重采样\n\n` +
    `- 去掉单笔最佳交易：原始 ${pct(result.concentration.baseline.withoutBestTrade)}，候选 ${pct(result.concentration.candidate.withoutBestTrade)}。\n` +
    `- 去掉前三笔最佳交易：原始 ${pct(result.concentration.baseline.withoutTopThreeTrades)}，候选 ${pct(result.concentration.candidate.withoutTopThreeTrades)}。\n` +
    `- 20交易日区块重采样 ${result.bootstrap.samples} 次：候选跑赢概率 ${pct(result.bootstrap.probabilityCandidateOutperforms)}，相对优势90%区间 ${pct(result.bootstrap.interval90[0])} 至 ${pct(result.bootstrap.interval90[1])}。\n` +
    `- 两套策略完全相同的交易 ${result.tradeComparison.sharedExactTrades} 笔，相同买入日 ${result.tradeComparison.sharedEntries} 个。\n`;
}
