const MARKET_IDS = ['1.000001', '0.399001'];

export function parseMarketHistory(payload) {
  const lines = payload?.data?.klines;
  if (!Array.isArray(lines) || !lines.length) throw new Error('大盘历史成交数据缺失');
  return lines.map(line => {
    const fields = String(line).split(',');
    const [date] = fields;
    const volumeLots = Number(fields[5]);
    const turnover = Number(fields[6]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !fields[5]?.trim() || !fields[6]?.trim() ||
        !Number.isFinite(volumeLots) || volumeLots < 0 || !Number.isFinite(turnover) || turnover < 0) {
      throw new Error('大盘历史成交数据格式异常');
    }
    // Eastmoney daily fields f56 / f57 are volume in lots / turnover in yuan.
    return { date, volumeLots, turnover };
  });
}

export function combineMarketHistory(shanghai, shenzhen) {
  const byDate = new Map(shenzhen.map(row => [row.date, row]));
  return shanghai.flatMap(row => {
    const other = byDate.get(row.date);
    // Never substitute a nearby day or report a one-market value as a total.
    return other ? [{ date: row.date, volumeLots: row.volumeLots + other.volumeLots, turnover: row.turnover + other.turnover }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchMarketHistory({ fetchImpl = fetch, now = Date.now } = {}) {
  const markets = await Promise.all(MARKET_IDS.map(async secid => {
    const response = await fetchImpl(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=10000&beg=19900101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`历史成交数据 HTTP ${response.status}`);
    return parseMarketHistory(await response.json());
  }));
  const rows = combineMarketHistory(...markets);
  if (!rows.length) throw new Error('沪深历史成交数据没有共同日期');
  const asOf = new Date(now()).toISOString();
  const chinaTime = new Date(new Date(asOf).getTime() + 8 * 3600000).toISOString();
  return {
    rows, asOf,
    partialDate: chinaTime.slice(11, 16) < '15:10' ? chinaTime.slice(0, 10) : null,
    source: '东方财富 · 沪深合计（不含北交所）',
  };
}

export function createMarketHistoryLoader({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  let expires = 0;
  let pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending) {
      pending = fetchMarketHistory({ fetchImpl, now }).then(result => {
        cached = result;
        expires = now() + 60000;
        return result;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}
