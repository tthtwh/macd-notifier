/**
 * 红利低波股息率策略（H30269 / H20269 → 563020）
 *
 * 规则：
 * 1. 自算滚动股息率：F = 全收益 / 价格；股息点 = P * (F_t/F_{t-1} - 1)；
 *    DY = 过去 252 个交易日股息点之和 / P_t。
 * 2. 10 年历史分位：DY[t-2519..t] 中 <= DY[t] 的比例，有效样本至少 756 个。
 * 3. 五档仓位 0/25/50/75/100，按当前档位重复检查触发条件，允许一次跨多档。
 * 4. 每月最后一个交易日收盘产生信号，下一交易日收盘执行。
 * 5. 563020 上市前用 H20269 全收益指数模拟（已含分红，不再叠加现金分红）。
 * 6. 563020 上市后使用不复权价格 + 实际现金分红：除息日计入应收，发放日转为现金，
 *    发放日后的下一交易日按 100 份整数倍再投资。
 */

const DY_WINDOW = 252;
const PERCENTILE_WINDOW = 2520;
const MIN_VALID_HISTORY = 756;
const LOT_SIZE = 100;
const POSITION_LEVELS = [0, 25, 50, 75, 100];
const DEFAULT_FEE_RATE = 0.0005;
const DEFAULT_INITIAL_CAPITAL = 100000;

const EPSILON = 1e-9;

/** 根据当前仓位和分位，返回单步应调整到的仓位档位。 */
function nextPositionLevel(level, percentile) {
  if (!Number.isFinite(percentile)) return level;
  if (level === 0) return percentile >= 0.60 ? 25 : 0;
  if (level === 25) {
    if (percentile >= 0.70) return 50;
    if (percentile <= 0.40) return 0;
    return 25;
  }
  if (level === 50) {
    if (percentile >= 0.80) return 75;
    if (percentile <= 0.50) return 25;
    return 50;
  }
  if (level === 75) {
    if (percentile >= 0.90) return 100;
    if (percentile <= 0.60) return 50;
    return 75;
  }
  if (level === 100) return percentile <= 0.70 ? 75 : 100;
  return level;
}

/**
 * 重复检查档位触发条件，直到目标仓位稳定。
 * 例如 100% + 分位 0.447：100→75→50→25，最终一次减到 25%。
 */
function resolveTargetPosition(currentLevel, percentile) {
  let level = currentLevel;
  for (let guard = 0; guard < POSITION_LEVELS.length + 2; guard += 1) {
    const next = nextPositionLevel(level, percentile);
    if (next === level) return level;
    level = next;
  }
  return level;
}

function sortedUniqueRows(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const date = String(row?.date ?? '');
    const close = Number(row?.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    map.set(date, { date, close, open: Number(row?.open) > 0 ? Number(row.open) : close });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 对齐价格指数与全收益指数，计算滚动股息率及历史分位。
 * 仅使用 t 及之前的数据，无未来函数。
 */
function computeDividendSeries(priceRows, totalRows) {
  const price = sortedUniqueRows(priceRows);
  const totalByDate = new Map(sortedUniqueRows(totalRows).map((row) => [row.date, row.close]));
  const rows = price
    .filter((row) => totalByDate.has(row.date))
    .map((row) => ({ date: row.date, priceClose: row.close, totalClose: totalByDate.get(row.date) }));

  const factor = rows.map((row) => row.totalClose / row.priceClose);
  const dividendPoints = new Array(rows.length).fill(null);
  for (let i = 1; i < rows.length; i += 1) {
    dividendPoints[i] = rows[i].priceClose * (factor[i] / factor[i - 1] - 1);
  }

  const series = rows.map((row, i) => ({
    date: row.date,
    priceClose: row.priceClose,
    totalClose: row.totalClose,
    dividendPoints: dividendPoints[i],
    dividendYield: null,
    percentile: null
  }));

  let rolling = 0;
  for (let i = 1; i < dividendPoints.length; i += 1) {
    rolling += dividendPoints[i];
    if (i > DY_WINDOW) rolling -= dividendPoints[i - DY_WINDOW];
    // 需要 252 个完整股息点：i-251..i，因此首个有效值出现在 i = 252。
    if (i >= DY_WINDOW) series[i].dividendYield = rolling / rows[i].priceClose;
  }

  const yields = series.map((row) => row.dividendYield);
  for (let i = 0; i < yields.length; i += 1) {
    const current = yields[i];
    if (current === null) continue;
    const start = Math.max(0, i - PERCENTILE_WINDOW + 1);
    const history = [];
    for (let j = start; j <= i; j += 1) {
      if (yields[j] !== null) history.push(yields[j]);
    }
    if (history.length < MIN_VALID_HISTORY) continue;
    let count = 0;
    for (const value of history) if (value <= current) count += 1;
    series[i].percentile = count / history.length;
  }

  return series;
}

/** 每个自然月最后一个交易日（以指数交易日历为准）。 */
function monthEndIndices(series) {
  const result = [];
  for (let i = 0; i < series.length; i += 1) {
    const month = series[i].date.slice(0, 7);
    if (i < series.length - 1) {
      if (series[i + 1].date.slice(0, 7) !== month) result.push(i);
    } else if (isLastWeekdayOfMonth(series[i].date)) {
      // 数据最后一行若只是月中，不能把截断日当成月末信号。
      result.push(i);
    }
  }
  return result;
}

function isLastWeekdayOfMonth(date) {
  const current = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(current.getTime())) return false;
  for (let offset = 1; offset <= 7; offset += 1) {
    const next = new Date(current.getTime());
    next.setUTCDate(current.getUTCDate() + offset);
    if (next.getUTCMonth() !== current.getUTCMonth()) return true;
    const weekday = next.getUTCDay();
    if (weekday !== 0 && weekday !== 6) return false;
  }
  return false;
}

/**
 * 生成月末信号：signalDate 为月末交易日，executeDate 为下一交易日。
 * 回测起点从 0% 仓位开始，起点之前的信号不计入。
 */
function buildMonthlySignals(series, { startDate = '', endDate = '' } = {}) {
  const signals = [];
  let level = 0;
  for (const index of monthEndIndices(series)) {
    const row = series[index];
    if (startDate && row.date < startDate) continue;
    if (endDate && row.date > endDate) continue;
    if (!Number.isFinite(row.percentile)) continue;
    const target = resolveTargetPosition(level, row.percentile);
    if (target === level) continue;
    const next = series[index + 1];
    signals.push({
      signalDate: row.date,
      executeDate: next?.date ?? null,
      percentile: row.percentile,
      dividendYield: row.dividendYield,
      fromLevel: level,
      toLevel: target,
      direction: target > level ? 'increase' : 'decrease',
      pending: !next
    });
    level = target;
  }
  return { signals, level };
}

function findFirstIndexOnOrAfter(dates, target) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (dates[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low < dates.length ? low : -1;
}

function findLastIndexBefore(dates, target) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (dates[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

function nextDateAfter(dates, target) {
  const index = findFirstIndexOnOrAfter(dates, target);
  if (index < 0) return null;
  if (dates[index] > target) return dates[index];
  return index + 1 < dates.length ? dates[index + 1] : null;
}

function summarizeNav(nav, initialCapital) {
  if (!nav.length) {
    return { totalReturn: 0, annualizedReturn: 0, maxDrawdown: 0, finalEquity: initialCapital, tradingDays: 0, years: 0 };
  }
  const finalEquity = nav.at(-1).equity;
  const totalReturn = finalEquity / initialCapital - 1;
  const firstTime = Date.parse(`${nav[0].date}T00:00:00Z`);
  const lastTime = Date.parse(`${nav.at(-1).date}T00:00:00Z`);
  const years = Math.max((lastTime - firstTime) / (365.25 * 24 * 3600 * 1000), 1 / 365.25);
  const annualizedReturn = Math.pow(1 + totalReturn, 1 / years) - 1;

  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const point of nav) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  }
  return { totalReturn, annualizedReturn, maxDrawdown, finalEquity, tradingDays: nav.length, years };
}

/**
 * 年度收益：按自然年首尾净值计算，首年按回测起点，跨年连续。
 */
function buildYearlyReturns(nav, benchmarkNav = []) {
  if (!nav.length) return [];
  const benchmarkByDate = new Map(benchmarkNav.map((row) => [row.date, row.equity]));
  const labelByDate = new Map(benchmarkNav.map((row) => [row.date, row.benchmarkLabel ?? '']));
  const benchmarkDates = benchmarkNav.map((row) => row.date);
  const years = [...new Set(nav.map((row) => row.date.slice(0, 4)))];
  let previousEquity = nav[0].equity;
  let previousBenchmark = benchmarkNav.length ? benchmarkNav[0].equity : null;

  return years.map((year) => {
    const rows = nav.filter((row) => row.date.startsWith(year));
    const end = rows.at(-1);
    const strategyReturn = end.equity / previousEquity - 1;

    let benchmarkReturn = null;
    let benchmarkLabel = '';
    if (benchmarkNav.length) {
      const lastBenchmark = lastValueOnOrBefore(benchmarkDates, benchmarkByDate, end.date);
      if (lastBenchmark !== null && previousBenchmark) {
        benchmarkReturn = lastBenchmark / previousBenchmark - 1;
        benchmarkLabel = labelOnOrBefore(benchmarkDates, labelByDate, end.date);
      }
      if (lastBenchmark !== null) previousBenchmark = lastBenchmark;
    }

    const result = {
      year,
      startDate: rows[0].date,
      endDate: end.date,
      strategyReturn,
      benchmarkReturn,
      benchmarkLabel,
      excessReturn: benchmarkReturn === null ? null : strategyReturn - benchmarkReturn,
      endLevel: end.level ?? null,
      rebalances: rows.reduce((count, row) => count + (row.rebalanced ? 1 : 0), 0)
    };
    previousEquity = end.equity;
    return result;
  });
}

function labelOnOrBefore(dates, map, target) {
  const index = lastIndexOnOrBefore(dates, target);
  return index >= 0 ? (map.get(dates[index]) ?? '') : '';
}

function lastValueOnOrBefore(dates, map, target) {
  const index = lastIndexOnOrBefore(dates, target);
  if (index >= 0) return map.get(dates[index]) ?? null;
  return null;
}

function lastIndexOnOrBefore(dates, target) {
  const before = findLastIndexBefore(dates, target);
  return dates[before + 1] === target ? before + 1 : before;
}

function emptyResult({ initialCapital, startDate, endDate, feeRate = DEFAULT_FEE_RATE }) {
  return {
    nav: [],
    trades: [],
    dividends: [],
    signals: [],
    pendingSignal: null,
    level: 0,
    targetLevel: 0,
    stats: summarizeNav([], initialCapital),
    yearly: [],
    benchmark: { nav: [], stats: null, trades: [] },
    comparison: null,
    startDate,
    endDate,
    etfStart: null,
    indexStart: null,
    latest: { date: null, priceClose: null, dividendYield: null, percentile: null },
    initialCapital,
    feeRate,
    openPosition: null
  };
}

/**
 * 运行完整回测。
 * series: computeDividendSeries 的结果
 * etfRows: 563020 不复权日线 [{ date, open, close }]
 * dividends: [{ registerDate, exDate, payDate, cashPerShare }]
 */
function runDividendBacktest({
  series,
  etfRows = [],
  dividends = [],
  initialCapital = DEFAULT_INITIAL_CAPITAL,
  feeRate = DEFAULT_FEE_RATE,
  startDate = '',
  endDate = ''
} = {}) {
  const capital = Number(initialCapital);
  if (!Number.isFinite(capital) || capital <= 0) throw new TypeError('初始资金必须是正数');
  const cost = Number.isFinite(Number(feeRate)) && Number(feeRate) >= 0 ? Number(feeRate) : DEFAULT_FEE_RATE;

  const priceSeries = (series ?? []).filter((row) => Number.isFinite(row.totalClose) && Number.isFinite(row.priceClose));
  if (!priceSeries.length) return emptyResult({ initialCapital: capital, startDate, endDate, feeRate: cost });

  const etf = sortedUniqueRows(etfRows);
  const lastSeriesDate = priceSeries.at(-1).date;
  const lastEtfDate = etf.at(-1)?.date ?? '';
  const dataEnd = [lastSeriesDate, lastEtfDate].filter(Boolean).sort().at(-1);
  const finalEnd = endDate && endDate < dataEnd ? endDate : dataEnd;
  const firstReady = priceSeries.find((row) => Number.isFinite(row.percentile))?.date ?? priceSeries[0].date;
  const firstDataDate = priceSeries[0].date;
  const requestedStart = startDate || firstReady;
  const finalStart = requestedStart < firstDataDate ? firstDataDate : requestedStart;
  if (finalStart > finalEnd) return emptyResult({ initialCapital: capital, startDate: finalStart, endDate: finalEnd, feeRate: cost });

  const etfUpToEnd = etf.filter((row) => row.date <= finalEnd);
  const etfStart = etfUpToEnd[0]?.date ?? null;
  const etfDates = etfUpToEnd.map((row) => row.date);
  const etfByDate = new Map(etfUpToEnd.map((row) => [row.date, row]));
  const indexByDate = new Map(priceSeries.map((row) => [row.date, row]));
  const etfOnly = Boolean(etfStart && finalStart >= etfStart);
  const hasEtfPhase = Boolean(etfStart && etfStart <= finalEnd);

  const indexDatesInRange = priceSeries
    .map((row) => row.date)
    .filter((date) => date >= finalStart && date <= finalEnd);
  const etfDatesInRange = etfDates.filter((date) => date >= finalStart && date <= finalEnd);

  const timeline = [];
  if (etfOnly) {
    timeline.push(...etfDatesInRange);
  } else if (hasEtfPhase) {
    for (const date of indexDatesInRange) if (date < etfStart) timeline.push(date);
    for (const date of etfDatesInRange) if (date >= etfStart) timeline.push(date);
  } else {
    timeline.push(...indexDatesInRange);
  }
  const dates = [...new Set(timeline)].sort((a, b) => a.localeCompare(b));
  if (!dates.length) return emptyResult({ initialCapital: capital, startDate: finalStart, endDate: finalEnd, feeRate: cost });

  const signals = buildMonthlySignals(priceSeries, { startDate: finalStart, endDate: finalEnd }).signals;
  for (const signal of signals) {
    let executeDate = signal.executeDate;
    let pending = signal.pending;
    if (executeDate && hasEtfPhase && executeDate >= etfStart) {
      const index = findFirstIndexOnOrAfter(etfDates, executeDate);
      executeDate = index >= 0 ? etfDates[index] : null;
      if (!executeDate) pending = true;
    }
    if (executeDate && executeDate > finalEnd) {
      executeDate = null;
      pending = true;
    }
    signal.executeDate = executeDate;
    signal.pending = pending;
  }
  const signalByDate = new Map(
    signals.filter((signal) => !signal.pending && signal.executeDate).map((signal) => [signal.executeDate, signal])
  );
  const pendingSignal = signals.filter((signal) => signal.pending).at(-1) ?? null;

  const { byRegister, byEx, byPay } = createDividendMaps(dividends);

  let cash = capital;
  let units = 0;
  let shares = 0;
  let averageCost = 0;
  // 仅供交易报表使用的指数平均成本，不参与资金、仓位或信号计算。
  let indexAverageCost = 0;
  let level = 0;
  let receivable = 0;
  let phase = etfOnly ? 'etf' : 'index';
  const trades = [];
  const dividendEvents = [];
  const entitlements = [];
  const reinvestQueue = [];
  const nav = [];
  let lastEtfPrice = null;

  const indexPriceOn = (date) => indexByDate.get(date)?.totalClose ?? null;
  const etfPriceOn = (date) => etfByDate.get(date)?.close ?? lastEtfPrice;

  const convertAtIndexToEtf = () => {
    if (!etfStart || phase !== 'index') return;
    const previousIndexDate = [...indexByDate.keys()].filter((date) => date < etfStart).sort().at(-1);
    const indexPrice = previousIndexDate ? indexPriceOn(previousIndexDate) : null;
    const openingPrice = etfByDate.get(etfStart)?.close;
    if (!Number.isFinite(indexPrice) || !Number.isFinite(openingPrice)) return;
    const equity = cash + units * indexPrice;
    cash = equity;
    const desired = Math.floor((level / 100) * equity / openingPrice / LOT_SIZE) * LOT_SIZE;
    const buyShares = Math.min(desired, Math.floor(cash / openingPrice / LOT_SIZE) * LOT_SIZE);
    const amount = buyShares * openingPrice;
    cash -= amount;
    shares = buyShares;
    averageCost = buyShares > 0 ? openingPrice : 0;
    units = 0;
    indexAverageCost = 0;
    phase = 'etf';
    trades.push({
      date: etfStart,
      type: 'convert',
      side: buyShares > 0 ? 'buy' : 'none',
      fromLevel: level,
      toLevel: level,
      price: openingPrice,
      quantity: buyShares,
      amount,
      fee: 0,
      profit: null,
      phase: 'convert',
      reason: `指数模拟切换为 563020（${level}% 目标仓位，按收盘价建仓，不计费用）`
    });
  };

  for (const date of dates) {
    if (phase === 'index' && etfStart && date >= etfStart) convertAtIndexToEtf();

    let price;
    if (phase === 'etf') {
      const row = etfByDate.get(date);
      if (row) lastEtfPrice = row.close;
      price = etfPriceOn(date);
    } else {
      price = indexPriceOn(date);
    }
    if (!Number.isFinite(price)) continue;

    // 1) 权益登记日：按当日交易前的持仓确定分红资格。
    if (phase === 'etf' && shares > 0) {
      for (const dividend of byRegister.get(date) ?? []) {
        entitlements.push({ dividend, shares, amount: shares * dividend.cashPerShare, accrued: false, paid: false, event: null });
      }
    }

    // 2) 除息日：确认应收分红，避免除息造成净值假跌。
    for (const dividend of byEx.get(date) ?? []) {
      const item = entitlements.find((entry) => entry.dividend === dividend && !entry.accrued);
      if (!item) continue;
      item.accrued = true;
      receivable += item.amount;
      item.event = {
        registerDate: dividend.registerDate,
        exDate: dividend.exDate,
        payDate: dividend.payDate,
        cashPerShare: dividend.cashPerShare,
        shares: item.shares,
        amount: item.amount,
        status: dividend.payDate <= finalEnd ? '待发放' : '待发放（回测结束）'
      };
      dividendEvents.push(item.event);
    }

    // 3) 发放日：应收转为现金，并安排下一交易日再投资。
    for (const dividend of byPay.get(date) ?? []) {
      const item = entitlements.find((entry) => entry.dividend === dividend && entry.accrued && !entry.paid);
      if (!item) continue;
      item.paid = true;
      receivable -= item.amount;
      cash += item.amount;
      if (item.event) item.event.status = '已到账';
      const schedule = nextDateAfter(etfDates, date);
      if (schedule && schedule <= finalEnd) {
        reinvestQueue.push({ date: schedule, amount: item.amount, entitlement: item });
      }
    }

    // 4) 到账后的下一交易日再投资。若当日有策略调仓，由调仓统一使用现金，避免重复买卖。
    const rebalanceSignal = signalByDate.get(date);
    if (phase === 'etf' && !rebalanceSignal) {
      const due = reinvestQueue.filter((item) => item.date === date);
      if (due.length) {
        const pool = due.reduce((sum, item) => sum + item.amount, 0);
        const buyShares = Math.floor(Math.min(cash, pool) / (price * (1 + cost)) / LOT_SIZE) * LOT_SIZE;
        if (buyShares > 0 && cash >= buyShares * price * (1 + cost)) {
          const amount = buyShares * price;
          const fee = amount * cost;
          cash -= amount + fee;
          averageCost = (averageCost * shares + amount + fee) / (shares + buyShares);
          shares += buyShares;
          for (const item of due) {
            if (item.entitlement.event) {
              item.entitlement.event.reinvestDate = date;
              item.entitlement.event.reinvestShares = buyShares;
              item.entitlement.event.reinvestPrice = price;
            }
          }
          trades.push({
            date,
            type: 'reinvest',
            side: 'buy',
            fromLevel: level,
            toLevel: level,
            price,
            quantity: buyShares,
            amount,
            fee,
            profit: null,
            phase: 'etf',
            reason: `分红到账后下一交易日再投资（${pool.toFixed(2)} 元）`
          });
        }
        for (const item of due) reinvestQueue.splice(reinvestQueue.indexOf(item), 1);
      }
    }

    // 5) 执行月末信号调仓。
    if (rebalanceSignal) {
      const target = rebalanceSignal.toLevel;
      if (phase === 'etf') {
        const equity = cash + shares * price + receivable;
        const targetShares = Math.floor(((target / 100) * equity) / price / LOT_SIZE) * LOT_SIZE;
        if (targetShares > shares) {
          const wanted = targetShares - shares;
          const affordable = Math.floor(cash / (price * (1 + cost)) / LOT_SIZE) * LOT_SIZE;
          const buyShares = Math.min(wanted, affordable);
          if (buyShares > 0) {
            const amount = buyShares * price;
            const fee = amount * cost;
            cash -= amount + fee;
            averageCost = (averageCost * shares + amount + fee) / (shares + buyShares);
            shares += buyShares;
            trades.push({
              date, type: 'rebalance', side: 'buy', signalDate: rebalanceSignal.signalDate,
              fromLevel: level, toLevel: target, price, quantity: buyShares, amount, fee, profit: null, phase: 'etf',
              reason: `调仓 ${level}% → ${target}%（分位 ${(rebalanceSignal.percentile * 100).toFixed(1)}%）`
            });
          }
        } else if (targetShares < shares) {
          const sellShares = shares - targetShares;
          const amount = sellShares * price;
          const fee = amount * cost;
          const costBasis = averageCost * sellShares;
          const profit = amount - fee - costBasis;
          cash += amount - fee;
          shares -= sellShares;
          if (shares === 0) averageCost = 0;
          trades.push({
            date, type: 'rebalance', side: 'sell', signalDate: rebalanceSignal.signalDate,
            fromLevel: level, toLevel: target, price, quantity: sellShares, amount, fee, costBasis, profit, phase: 'etf',
            reason: `调仓 ${level}% → ${target}%（分位 ${(rebalanceSignal.percentile * 100).toFixed(1)}%）`
          });
        }
      } else {
        const equity = cash + units * price;
        const deltaValue = (target / 100) * equity - units * price;
        if (Math.abs(deltaValue) > EPSILON) {
          const fee = Math.abs(deltaValue) * cost;
          const quantity = Math.abs(deltaValue / price);
          const costBasis = deltaValue < 0 ? indexAverageCost * quantity : null;
          const profit = deltaValue < 0 ? Math.abs(deltaValue) - fee - costBasis : null;
          if (deltaValue > 0) {
            indexAverageCost = (indexAverageCost * units + deltaValue + fee) / (units + quantity);
          } else if (target === 0) {
            indexAverageCost = 0;
          }
          cash -= deltaValue + fee;
          units += deltaValue / price;
          trades.push({
            date, type: 'rebalance', side: deltaValue > 0 ? 'buy' : 'sell', signalDate: rebalanceSignal.signalDate,
            fromLevel: level, toLevel: target, price,
            quantity, amount: Math.abs(deltaValue), fee, costBasis, profit, phase: 'index',
            reason: `指数模拟调仓 ${level}% → ${target}%（分位 ${(rebalanceSignal.percentile * 100).toFixed(1)}%）`
          });
        }
      }
      level = target;
      // 调仓按目标仓位统一使用全部现金，已到账但尚未再投资的分红现金也包含在内。
      reinvestQueue.length = 0;
    }

    const equity = phase === 'etf'
      ? cash + shares * price + receivable
      : cash + units * price;
    nav.push({
      date,
      equity,
      level,
      phase,
      price,
      cash,
      shares,
      units,
      receivable,
      percentile: indexByDate.get(date)?.percentile ?? null,
      dividendYield: indexByDate.get(date)?.dividendYield ?? null,
      rebalanced: Boolean(rebalanceSignal)
    });
  }

  if (!nav.length) return emptyResult({ initialCapital: capital, startDate: finalStart, endDate: finalEnd, feeRate: cost });

  const benchmark = buildBlendedBenchmark({
    priceSeries, etf, dividends, dates, etfStart, finalStart, finalEnd, capital, feeRate: cost
  });
  const stats = summarizeNav(nav, capital);
  const benchmarkStats = benchmark.nav.length ? summarizeNav(benchmark.nav, capital) : null;

  const etfPhaseIndex = etfStart ? nav.findIndex((row) => row.date >= etfStart) : -1;
  const etfPhaseNav = etfPhaseIndex >= 0 ? nav.slice(etfPhaseIndex) : [];
  const etfPhaseBase = etfPhaseIndex > 0 ? nav[etfPhaseIndex - 1].equity : (etfPhaseNav[0]?.equity ?? capital);
  const etfPhaseStats = etfPhaseNav.length ? summarizeNav(etfPhaseNav, etfPhaseBase) : null;

  const benchmarkEtfIndex = etfStart ? benchmark.nav.findIndex((row) => row.date >= etfStart) : -1;
  const benchmarkEtfNav = benchmarkEtfIndex >= 0 ? benchmark.nav.slice(benchmarkEtfIndex) : [];
  const benchmarkEtfBase = benchmarkEtfIndex > 0
    ? benchmark.nav[benchmarkEtfIndex - 1].equity
    : (benchmarkEtfNav[0]?.equity ?? capital);
  const benchmarkEtfStats = benchmarkEtfNav.length ? summarizeNav(benchmarkEtfNav, benchmarkEtfBase) : null;

  const lastInRange = priceSeries.filter((row) => row.date <= finalEnd).at(-1);
  const latestPercentile = Number.isFinite(lastInRange?.percentile) ? lastInRange.percentile : null;
  const targetLevel = latestPercentile === null ? level : resolveTargetPosition(level, latestPercentile);

  return {
    nav,
    trades,
    dividends: dividendEvents,
    signals: signals.filter((signal) => !signal.pending),
    pendingSignal,
    level,
    targetLevel,
    stats,
    yearly: buildYearlyReturns(nav, benchmark.nav),
    benchmark: { nav: benchmark.nav, stats: benchmarkStats, trades: benchmark.trades },
    comparison: {
      strategy: stats,
      strategyEtfPhase: etfPhaseStats,
      etfBenchmark: benchmarkEtfStats
    },
    startDate: finalStart,
    endDate: nav.at(-1).date,
    etfStart,
    indexStart: priceSeries[0].date,
    latest: {
      date: lastInRange?.date ?? null,
      priceClose: lastInRange?.priceClose ?? null,
      dividendYield: lastInRange?.dividendYield ?? null,
      percentile: latestPercentile
    },
    initialCapital: capital,
    feeRate: cost,
    openPosition: phase === 'etf' && shares > 0
      ? {
        shares,
        price: nav.at(-1).price,
        marketValue: shares * nav.at(-1).price,
        cash,
        receivable,
        equity: nav.at(-1).equity
      }
      : null
  };
}

/**
 * 归一化分红记录，并让登记日/除息日/发放日三个索引共享同一对象，
 * 便于按引用跟踪“登记 → 除息 → 到账 → 再投资”。
 */
function normalizeDividends(dividends) {
  const result = [];
  for (const raw of dividends ?? []) {
    const registerDate = String(raw?.registerDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(registerDate)) continue;
    const cashPerShare = Number(raw?.cashPerShare);
    if (!Number.isFinite(cashPerShare) || cashPerShare <= 0) continue;
    const exDate = validDate(raw?.exDate) && raw.exDate >= registerDate ? raw.exDate : registerDate;
    const payDate = validDate(raw?.payDate) && raw.payDate >= exDate ? raw.payDate : exDate;
    result.push({ registerDate, exDate, payDate, cashPerShare });
  }
  return result;
}

function createDividendMaps(dividends) {
  const byRegister = new Map();
  const byEx = new Map();
  const byPay = new Map();
  for (const dividend of normalizeDividends(dividends)) {
    pushDividend(byRegister, dividend.registerDate, dividend);
    pushDividend(byEx, dividend.exDate, dividend);
    pushDividend(byPay, dividend.payDate, dividend);
  }
  return { byRegister, byEx, byPay };
}

function pushDividend(map, key, dividend) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(dividend);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
}

/**
 * 全程持有基准：起点买入 H20269 全收益指数；563020 上市后切换为买入持有 563020。
 * 指数阶段已含分红，ETF 阶段使用不复权价格 + 现金分红再投资，不重复计算。
 */
function buildBlendedBenchmark({ priceSeries, etf, dividends, dates, etfStart, finalStart, finalEnd, capital, feeRate }) {
  const indexByDate = new Map(priceSeries.map((row) => [row.date, row.totalClose]));
  const etfDates = etf.map((row) => row.date);
  const etfByDate = new Map(etf.map((row) => [row.date, row]));
  const { byRegister, byEx, byPay } = createDividendMaps(dividends);

  let phase = etfStart && finalStart >= etfStart ? 'etf' : 'index';
  let cash = capital;
  let units = 0;
  let shares = 0;
  let averageCost = 0;
  let receivable = 0;
  const nav = [];
  const trades = [];
  const entitlements = [];
  const reinvestQueue = [];
  let lastEtfPrice = null;

  const firstDate = dates[0];
  if (phase === 'index') {
    const firstPrice = indexByDate.get(firstDate);
    if (Number.isFinite(firstPrice)) {
      const fee = cash * feeRate;
      units = (cash - fee) / firstPrice;
      cash = 0;
    }
  } else {
    const firstPrice = etfByDate.get(firstDate)?.close;
    if (Number.isFinite(firstPrice)) {
      const buyShares = Math.floor(cash / (firstPrice * (1 + feeRate)) / LOT_SIZE) * LOT_SIZE;
      const amount = buyShares * firstPrice;
      const fee = amount * feeRate;
      cash -= amount + fee;
      shares = buyShares;
      averageCost = buyShares > 0 ? amount / buyShares : 0;
      trades.push({ date: firstDate, side: 'buy', price: firstPrice, quantity: buyShares, amount, fee, type: 'benchmark' });
    }
  }

  for (const date of dates) {
    if (phase === 'index' && etfStart && date >= etfStart) {
      const previousIndexDate = [...indexByDate.keys()].filter((item) => item < etfStart).sort().at(-1);
      const indexPrice = previousIndexDate ? indexByDate.get(previousIndexDate) : null;
      const etfPrice = etfByDate.get(etfStart)?.close;
      if (Number.isFinite(indexPrice) && Number.isFinite(etfPrice)) {
        const equity = cash + units * indexPrice;
        const buyShares = Math.floor(equity / etfPrice / LOT_SIZE) * LOT_SIZE;
        const amount = buyShares * etfPrice;
        cash = equity - amount;
        shares = buyShares;
        averageCost = buyShares > 0 ? amount / buyShares : 0;
        units = 0;
        phase = 'etf';
        trades.push({ date: etfStart, side: 'buy', price: etfPrice, quantity: buyShares, amount, fee: 0, type: 'convert' });
      }
    }

    let price;
    if (phase === 'etf') {
      const row = etfByDate.get(date);
      if (row) lastEtfPrice = row.close;
      price = lastEtfPrice;
    } else {
      price = indexByDate.get(date);
    }
    if (!Number.isFinite(price)) continue;

    if (phase === 'etf') {
      // 分红资格、应收、到账与再投资（与策略账户同一口径）。
      if (shares > 0) {
        for (const dividend of byRegister.get(date) ?? []) {
          entitlements.push({ dividend, shares, amount: shares * dividend.cashPerShare, accrued: false, paid: false });
        }
      }
      for (const dividend of byEx.get(date) ?? []) {
        const item = entitlements.find((entry) => entry.dividend === dividend && !entry.accrued);
        if (item) { item.accrued = true; receivable += item.amount; }
      }
      for (const dividend of byPay.get(date) ?? []) {
        const item = entitlements.find((entry) => entry.dividend === dividend && entry.accrued && !entry.paid);
        if (item) {
          item.paid = true;
          receivable -= item.amount;
          cash += item.amount;
          const schedule = nextDateAfter(etfDates, date);
          if (schedule && schedule <= finalEnd) reinvestQueue.push({ date: schedule, amount: item.amount });
        }
      }
      const due = reinvestQueue.filter((item) => item.date === date);
      if (due.length) {
        const pool = due.reduce((sum, item) => sum + item.amount, 0);
        const buyShares = Math.floor(Math.min(cash, pool) / (price * (1 + feeRate)) / LOT_SIZE) * LOT_SIZE;
        if (buyShares > 0 && cash >= buyShares * price * (1 + feeRate)) {
          const amount = buyShares * price;
          const fee = amount * feeRate;
          cash -= amount + fee;
          averageCost = (averageCost * shares + amount + fee) / (shares + buyShares);
          shares += buyShares;
          trades.push({ date, side: 'buy', price, quantity: buyShares, amount, fee, type: 'reinvest' });
        }
        for (const item of due) reinvestQueue.splice(reinvestQueue.indexOf(item), 1);
      }
    }

    nav.push({
      date,
      equity: phase === 'etf' ? cash + shares * price + receivable : cash + units * price,
      benchmarkLabel: phase === 'etf' ? '563020 买入持有' : 'H20269 全收益指数'
    });
  }

  return { nav, trades };
}



module.exports = { runDividendBacktest, computeDividendSeries, buildMonthlySignals };