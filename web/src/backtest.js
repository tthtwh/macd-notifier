export function runBacktest(rows, { slow = 26, signal = 9, feeRate = 0.0003, executionMode = 'sameClose' } = {}) {
  const offset = executionMode === 'nextOpen' ? 1 : 0;
  const trades = [];
  let entry = null;
  for (let i = slow + signal; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1];
    if (!entry && row.hist > 0 && previous.hist <= 0) {
      const fill = rows[i + offset];
      const price = offset ? fill?.open : fill?.close;
      if (Number.isFinite(price) && price > 0) entry = { index: i + offset, price, date: fill.date, signalDate: row.date };
    } else if (entry && previous.hist >= 0 && row.hist < 0) {
      const fill = rows[i + offset];
      const price = offset ? fill?.open : fill?.close;
      if (!Number.isFinite(price) || price <= 0) break;
      const grossReturn = price / entry.price - 1;
      const netReturn = grossReturn - feeRate * 2;
      // Next-open exits do not include prices later on the exit day.
      const closes = rows.slice(entry.index, i + offset).map(r => r.close);
      const low = Math.min(entry.price, price, ...closes);
      const risk = Math.max(0, (entry.price - low) / entry.price);
      trades.push({ entryDate: entry.date, exitDate: fill.date,
        entrySignalDate: entry.signalDate, exitSignalDate: row.date,
        entryPrice: entry.price, exitPrice: price, holdingDays: i + offset - entry.index,
        grossReturn, netReturn, risk, rMultiple: risk > 0.00001 ? netReturn / risk : null,
        reason: offset ? '绿柱首次出现，次日开盘卖出' : '绿柱首次出现' });
      entry = null;
    }
  }
  return trades;
}
