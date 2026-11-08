const POSITION_EPSILON = 1e-9;

const PHASE_LABELS = {
  index: '指数模拟',
  etf: 'ETF历史回测',
  convert: '上市切换'
};

/**
 * 逐笔交易报表，不修改回测结果或重算资金。
 * 信号指标只关联 signalDate；权益是执行日全部操作完成后的日终值。
 * 本轮已实现 = 本轮累计净卖出盈利 / 已卖出份额的累计平均成本。
 * 买入费用计入成本，卖出费用扣除；ETF 现金分红由 result.dividends 单独列示，
 * 不计入该盈利分子。指数阶段沿用全收益指数价格的收益口径。
 */
export function buildTradeReport(result) {
  const signals = new Map((result?.signals ?? []).map(signal => [signal.signalDate, signal]));
  const equityByDate = new Map((result?.nav ?? []).map(row => [row.date, row.equity]));
  let phase = null;
  let position = 0;
  let realizedProfit = 0;
  let soldCostBasis = 0;
  let validCycle = true;
  let lastRebalanceEquity = null;

  const resetCycle = () => {
    realizedProfit = 0;
    soldCostBasis = 0;
    validCycle = true;
  };

  return (result?.trades ?? []).map(trade => {
    const isConversion = trade.type === 'convert' || trade.phase === 'convert';
    const tradePhase = isConversion ? 'etf' : trade.phase;
    if (isConversion || tradePhase !== phase) {
      phase = tradePhase;
      position = 0;
      resetCycle();
    }

    let cycleRealizedReturn = null;
    if (trade.side === 'buy') {
      if (position <= POSITION_EPSILON) resetCycle();
      position += trade.quantity;
    } else if (trade.side === 'sell') {
      if (Number.isFinite(trade.profit) && Number.isFinite(trade.costBasis) && trade.costBasis > 0) {
        realizedProfit += trade.profit;
        soldCostBasis += trade.costBasis;
      } else {
        validCycle = false;
      }
      if (validCycle && soldCostBasis > 0) cycleRealizedReturn = realizedProfit / soldCostBasis;
      position = Math.max(0, position - trade.quantity);
    }

    const signal = trade.signalDate ? signals.get(trade.signalDate) : null;
    const amount = Number.isFinite(trade.amount) ? Math.abs(trade.amount) : null;
    const signedAmount = amount === null ? null
      : trade.side === 'buy' ? amount
        : trade.side === 'sell' ? -amount
          : trade.side === 'none' ? 0 : null;
    const equity = finiteOrNull(equityByDate.get(trade.date));
    const sellReturn = trade.side === 'sell'
      && Number.isFinite(trade.profit)
      && Number.isFinite(trade.costBasis)
      && trade.costBasis > 0
      ? trade.profit / trade.costBasis
      : null;
    let equityChange = null;
    let equityChangePct = null;
    if (trade.type === 'rebalance' && equity !== null) {
      if (lastRebalanceEquity !== null && lastRebalanceEquity !== 0) {
        equityChange = equity - lastRebalanceEquity;
        equityChangePct = equityChange / lastRebalanceEquity;
      }
      lastRebalanceEquity = equity;
    }
    return {
      ...trade,
      signalDividendYield: finiteOrNull(signal?.dividendYield),
      signalPercentile: finiteOrNull(signal?.percentile),
      equity,
      equityChange,
      equityChangePct,
      sellReturn,
      signedAmount,
      phaseLabel: PHASE_LABELS[isConversion ? 'convert' : trade.phase] ?? '',
      cycleRealizedReturn
    };
  });
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
