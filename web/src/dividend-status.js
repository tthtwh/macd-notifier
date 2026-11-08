/**
 * ETF 自身近一年现金分红率，不依赖策略持仓或回测起点。
 * 上市前（asOf 及之前没有 ETF 价格）返回空值。
 */
export function calculateEtfDividendYield({ dividends = [], etfRows = [], asOf } = {}) {
  const empty = { yield: null, cashPerShare: 0, price: null, priceDate: null };
  if (!isValidDate(asOf)) return empty;
  let latestPrice = null;
  for (const row of etfRows) {
    const price = Number(row?.close);
    if (!isValidDate(row?.date) || row.date > asOf || !Number.isFinite(price) || price <= 0) continue;
    if (!latestPrice || row.date > latestPrice.date) latestPrice = { date: row.date, price };
  }
  if (!latestPrice) return empty;

  const cutoff = new Date(`${asOf}T00:00:00Z`);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  // 2 月 29 日向前一年按 2 月末计算，避免 JavaScript 溢出到 3 月 1 日。
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  let cashPerShare = 0;
  for (const row of dividends) {
    const cash = Number(row?.cashPerShare);
    if (isValidDate(row?.exDate) && row.exDate > cutoffDate && row.exDate <= asOf && Number.isFinite(cash) && cash > 0) {
      cashPerShare += cash;
    }
  }
  return { yield: cashPerShare / latestPrice.price, cashPerShare, price: latestPrice.price, priceDate: latestPrice.date };
}

/** 拆解截至 asOf 最近交易日的股息率变化；缺失原始数值不当作零。 */
export function calculateDividendYieldChange({ series = [], asOf } = {}) {
  if (!Array.isArray(series) || !isValidDate(asOf)) return null;
  const rows = series.filter(row => isValidDate(row?.date) && row.date <= asOf)
    .sort((left, right) => left.date.localeCompare(right.date));
  const index = rows.length - 1;
  if (index < 252) return null;
  const latest = rows[index];
  const prev = rows[index - 1];
  const removed = rows[index - 252];
  const prevYield = prev.dividendYield;
  const latestYield = latest.dividendYield;
  const prevPrice = prev.priceClose;
  const price = latest.priceClose;
  const newPoint = latest.dividendPoints;
  const removedPoint = removed.dividendPoints;
  if (![prevYield, latestYield, prevPrice, price, newPoint, removedPoint].every(Number.isFinite)
    || prevPrice <= 0 || price <= 0) return null;

  const prevSum = prevYield * prevPrice;
  const newEffect = newPoint / price;
  const removedEffect = -removedPoint / price;
  const priceEffect = prevSum / price - prevYield;
  const total = latestYield - prevYield;
  const priceChange = price / prevPrice - 1;
  if (![newEffect, removedEffect, priceEffect, total, priceChange].every(Number.isFinite)) return null;
  const dominant = total === 0 ? null : [
    { source: 'new', effect: newEffect },
    { source: 'removed', effect: removedEffect },
    { source: 'price', effect: priceEffect }
  ].filter(item => Math.sign(item.effect) === Math.sign(total))
    .reduce((largest, item) => !largest || Math.abs(item.effect) > Math.abs(largest.effect) ? item : largest, null);
  return {
    prevDate: prev.date,
    date: latest.date,
    prevYield,
    latestYield,
    prevPct: Number.isFinite(prev.percentile) ? prev.percentile : null,
    latestPct: Number.isFinite(latest.percentile) ? latest.percentile : null,
    priceChange,
    newPoint,
    removedPoint,
    newEffect,
    removedEffect,
    priceEffect,
    total,
    dominantSource: dominant?.source ?? null
  };
}

/**
 * 用完整已知交易日历确认历史月末。只有出现下个月的交易日，才确认前月最后交易日。
 * 缺少日历时返回工作日估算，并明确标记；isCheckDay=null 表示无法确认。
 * checkDate 是本次或接下来的检查日，executionDate 对应它；nextCheckDate 严格晚于 asOf。
 */
export function getSignalSchedule({ asOf, tradingDates = [] } = {}) {
  const empty = {
    isCheckDay: null, checkDate: null, executionDate: null, nextCheckDate: null,
    checkEstimated: true, executionEstimated: true, nextCheckEstimated: true, estimated: true
  };
  if (!isValidDate(asOf)) return empty;
  const dates = [...new Set(tradingDates.filter(isValidDate))].sort();
  const lastByMonth = new Map();
  for (const date of dates) lastByMonth.set(date.slice(0, 7), date);
  const lastKnownMonth = dates.at(-1)?.slice(0, 7) ?? '';
  const monthOf = date => date.slice(0, 7);
  const checkForMonth = month => {
    const knownLast = lastByMonth.get(month);
    if (knownLast && month < lastKnownMonth) return { date: knownLast, estimated: false };
    return { date: lastWeekdayOfMonth(month), estimated: true };
  };

  const currentMonth = monthOf(asOf);
  const current = checkForMonth(currentMonth);
  const isCheckDay = current.estimated
    ? (dates.some(date => date > asOf && monthOf(date) === currentMonth) ? false : null)
    : current.date === asOf;
  const check = current.date >= asOf ? current : checkForMonth(nextMonth(currentMonth));
  const nextCheck = check.date > asOf ? check : checkForMonth(nextMonth(monthOf(check.date)));
  const actualExecution = check.estimated ? null : dates.find(date => date > check.date);
  const executionDate = actualExecution ?? nextWeekday(check.date);
  return {
    isCheckDay,
    checkDate: check.date,
    executionDate,
    nextCheckDate: nextCheck.date,
    checkEstimated: check.estimated,
    executionEstimated: !actualExecution,
    nextCheckEstimated: nextCheck.estimated,
    estimated: check.estimated || !actualExecution || nextCheck.estimated
  };
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function lastWeekdayOfMonth(month) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number, 0));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function nextMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}

function nextWeekday(value) {
  const date = new Date(`${value}T00:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1); while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}
