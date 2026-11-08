// Exact execution dates, not MACD signal dates. Missing data stays missing.
export function marketForDate(history, date) {
  const row = date ? history.get(date) : null;
  return row ? { volume: row.volumeLots / 1e6, turnover: row.turnover / 1e8 } : null;
}

export function tradeMarketCsv(history, trade) {
  const buy = marketForDate(history, trade.entryDate);
  const sell = marketForDate(history, trade.exitDate);
  return [buy?.volume, buy?.turnover, sell?.volume, sell?.turnover].map(value => value == null ? '' : value.toFixed(2));
}
