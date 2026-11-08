export function applyTradeCapital(trades, initialCapital) {
  let currentCapital = Number(initialCapital);

  if (!Number.isFinite(currentCapital) || currentCapital < 0) {
    throw new TypeError('初始资金必须是非负数字');
  }

  return trades.map((trade) => {
    const capitalBefore = currentCapital;
    const profit = capitalBefore * trade.netReturn;
    currentCapital = capitalBefore + profit;

    return {
      ...trade,
      capitalBefore,
      profit,
      currentCapital,
    };
  });
}

export function valueOpenPosition(position, capitalBefore) {
  if (!position) return null;
  const unrealizedProfit = capitalBefore * position.unrealizedReturn;
  return { ...position, capitalBefore, unrealizedProfit, equity: capitalBefore + unrealizedProfit };
}
