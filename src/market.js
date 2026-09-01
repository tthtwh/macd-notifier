const ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const SYMBOL = '512760';

export async function fetchDailyKlines(fetchImpl = fetch) {
  const url = new URL(ENDPOINT);
  const params = {
    secid: `1.${SYMBOL}`,
    klt: '101',
    fqt: '1',
    lmt: '10000',
    end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56'
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);

  const payload = await response.json();
  if (payload?.rc !== 0 || !Array.isArray(payload?.data?.klines)) {
    throw new Error(`行情接口返回异常（rc=${payload?.rc ?? 'unknown'}）`);
  }

  return payload.data.klines.map(parseKline);
}

export function parseKline(line) {
  const [date, open, close, high, low, volume] = String(line).split(',');
  const bar = {
    date,
    open: Number(open),
    close: Number(close),
    high: Number(high),
    low: Number(low),
    volume: Number(volume)
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      [bar.open, bar.close, bar.high, bar.low, bar.volume].some((value) => !Number.isFinite(value))) {
    throw new Error(`无效日 K：${line}`);
  }
  return bar;
}
