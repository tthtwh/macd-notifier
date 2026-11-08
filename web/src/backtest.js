export const DEFAULT_EXECUTION_MODE = 'nextOpenBuySameCloseSell';

/**
 * 标的当前所处位置：价格分位、距高点回撤、相对均线，以及「深跌打分」。
 * 只用于展示与仓位参考，不参与回测。
 */
export function pricePositionMetrics(rows, { highWindow = 252, maWindow = 200, window3 = 756, window5 = 1260 } = {}) {
  const valid = (rows ?? []).filter((row) => Number.isFinite(row?.close) && row.close > 0);
  if (!valid.length) return null;
  const closes = valid.map((row) => row.close);
  const last = closes.at(-1);
  const percentile = (window) => {
    const slice = closes.slice(Math.max(0, closes.length - window));
    return slice.length ? slice.filter((value) => value <= last).length / slice.length : null;
  };
  const high = Math.max(...closes.slice(Math.max(0, closes.length - highWindow)));
  const drawdown = high > 0 ? last / high - 1 : null;
  const maSlice = closes.slice(Math.max(0, closes.length - maWindow));
  const ma = maSlice.reduce((sum, value) => sum + value, 0) / maSlice.length;
  const ma200 = ma > 0 ? last / ma - 1 : null;
  const score = (ma200 !== null && ma200 <= -0.1 ? 1 : 0) + (drawdown !== null && drawdown <= -0.3 ? 1 : 0);
  return {
    date: valid.at(-1).date,
    last,
    high,
    drawdown,
    ma200,
    score,
    pct3: percentile(window3),
    pct5: percentile(window5),
    pctAll: percentile(closes.length),
  };
}

export function runBacktest(rows, options = {}) {
  return runBacktestDetails(rows, options).trades;
}

export function runBacktestDetails(rows, {
  slow = 26, signal = 9, feeRate = 0.0003, executionMode = DEFAULT_EXECUTION_MODE, latestQuote = null,
} = {}) {
  const buyOffset = executionMode === 'nextOpen' || executionMode === 'nextOpenBuySameCloseSell' ? 1 : 0;
  const sellOffset = executionMode === 'nextOpen' ? 1 : 0;
  const trades = [];
  let entry = null;
  let pendingEntry = null;
  let pendingExit = null;
  const currentQuote = latestQuote && latestQuote.date >= (rows.at(-1)?.date ?? '') &&
    Number.isFinite(latestQuote.price) && latestQuote.price > 0 ? latestQuote : null;
  const executionRows = currentQuote && currentQuote.date > (rows.at(-1)?.date ?? '')
    ? [...rows, { date: currentQuote.date, open: currentQuote.open, close: currentQuote.price }]
    : rows;
  for (let i = slow + signal; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1];
    if (!entry && row.hist > 0 && previous.hist <= 0) {
      const fill = executionRows[i + buyOffset];
      const price = buyOffset ? fill?.open : fill?.close;
      if (Number.isFinite(price) && price > 0) entry = { index: i + buyOffset, price, date: fill.date, signalDate: row.date };
      else if (i === rows.length - 1) pendingEntry = { signalDate: row.date, status: 'pending', reason: '待下一交易日开盘价，尚未买入' };
    } else if (entry && previous.hist >= 0 && row.hist < 0) {
      // T+1：当天买入的份额最早次日才能卖出，卖出信号落在买入当天时顺延到次日开盘。
      const target = Math.max(i + sellOffset, entry.index + 1);
      const delayed = target > i + sellOffset;
      const fill = executionRows[target];
      const price = sellOffset || delayed ? fill?.open : fill?.close;
      if (!Number.isFinite(price) || price <= 0) {
        pendingExit = row.date;
        break;
      }
      const grossReturn = price / entry.price - 1;
      const netReturn = grossReturn - feeRate * 2;
      // 次日开盘卖出的持仓不含卖出日之后的价格；T+1 顺延时含买入当天收盘价。
      const closes = rows.slice(entry.index, target).map(r => r.close);
      const low = Math.min(entry.price, price, ...closes);
      const risk = Math.max(0, (entry.price - low) / entry.price);
      trades.push({ entryDate: entry.date, exitDate: fill.date,
        entrySignalDate: entry.signalDate, exitSignalDate: row.date,
        entryPrice: entry.price, exitPrice: price, holdingDays: target - entry.index,
        grossReturn, netReturn, risk, rMultiple: risk > 0.00001 ? netReturn / risk : null,
        reason: delayed ? 'T+1 限制，次日开盘卖出' : sellOffset ? '绿柱首次出现，次日开盘卖出' : '绿柱首次出现，当天收盘卖出' });
      entry = null;
    }
  }
  let openPosition = null;
  if (entry) {
    const mark = executionRows.at(-1);
    const latestPrice = currentQuote?.price ?? mark.close;
    const low = Math.min(entry.price, latestPrice, ...executionRows.slice(entry.index).map(row => row.close));
    openPosition = {
      status: 'open', entryDate: entry.date, entrySignalDate: entry.signalDate, entryPrice: entry.price,
      exitDate: null, exitPrice: null, exitSignalDate: pendingExit,
      latestDate: currentQuote?.date ?? mark.date, latestPrice,
      holdingDays: executionRows.length - 1 - entry.index,
      // Only the buy-side fee has been incurred; no hypothetical sale fee.
      unrealizedReturn: latestPrice / entry.price - 1 - feeRate,
      risk: Math.max(0, (entry.price - low) / entry.price),
      reason: pendingExit ? '待下一交易日开盘卖出' : '持仓中，尚未出现卖出信号',
    };
  }
  return { trades, openPosition, pendingEntry };
}
