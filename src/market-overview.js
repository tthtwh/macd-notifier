const SYMBOLS = ['sh000001', 'sz399001'];

export function parseMarketQuote(payload, symbol) {
  const quote = payload?.data?.[symbol]?.qt?.[symbol];
  const timestamp = String(quote?.[30] ?? '');
  // Tencent quote field 35: price / volume in lots / turnover in yuan.
  const parts = String(quote?.[35] ?? '').split('/');
  const volumeLots = Number(parts[1]);
  const turnover = Number(parts[2]);
  if (!/^\d{14}$/.test(timestamp) || parts.length !== 3 ||
      parts.slice(1).some(value => !value.trim()) ||
      !Number.isFinite(volumeLots) || volumeLots < 0 ||
      !Number.isFinite(turnover) || turnover < 0) {
    throw new Error('大盘成交行情缺失或格式异常');
  }
  return {
    symbol, name: symbol === 'sh000001' ? '沪市' : '深市',
    date: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
    time: `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`,
    turnover, volumeLots,
  };
}

export async function fetchMarketOverview({ fetchImpl = fetch } = {}) {
  const markets = await Promise.all(SYMBOLS.map(async symbol => {
    const response = await fetchImpl(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,2,qfq`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`大盘行情 HTTP ${response.status}`);
    return parseMarketQuote(await response.json(), symbol);
  }));
  if (markets[0].date !== markets[1].date) throw new Error('沪深行情日期不一致，暂不合计');
  return {
    date: markets[0].date,
    time: markets.map(market => market.time).sort()[0],
    turnover: markets.reduce((sum, market) => sum + market.turnover, 0),
    volumeLots: markets.reduce((sum, market) => sum + market.volumeLots, 0),
    markets, source: '腾讯行情 · 沪市与深市指数行情汇总（不含北交所）',
  };
}

export function createMarketOverviewLoader({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  let expires = 0;
  let pending;
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending) {
      pending = fetchMarketOverview({ fetchImpl }).then(result => {
        cached = result;
        expires = now() + 30000;
        return result;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}
