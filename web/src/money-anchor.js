// 以「当前持仓」作为金额基准：收益率、回撤和买卖信号不变，所有金额按同一比例缩放。
export function anchorScale(anchorValue, currentEquity) {
  const anchor = Number(anchorValue);
  const equity = Number(currentEquity);
  if (!Number.isFinite(anchor) || anchor <= 0) return 1;
  if (!Number.isFinite(equity) || equity <= 0) return 1;
  return anchor / equity;
}

export function scaleMoneyView({ trades = [], position = null, stats = {}, capital = 0 }, scale) {
  const factor = Number(scale);
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-12) {
    return { trades, position, stats, capital };
  }
  const scaled = (value) => value * factor;
  return {
    capital: scaled(capital),
    stats: { ...stats, finalCapital: scaled(stats.finalCapital) },
    trades: trades.map((trade) => ({
      ...trade,
      capitalBefore: scaled(trade.capitalBefore),
      profit: scaled(trade.profit),
      currentCapital: scaled(trade.currentCapital),
    })),
    position: position
      ? {
        ...position,
        capitalBefore: scaled(position.capitalBefore),
        unrealizedProfit: scaled(position.unrealizedProfit),
        equity: scaled(position.equity),
      }
      : null,
  };
}
