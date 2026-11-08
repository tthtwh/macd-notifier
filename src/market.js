const EASTMONEY_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TENCENT_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const DEFAULT_SYMBOL = '512760';
const DEFAULT_RETRY_DELAYS = [1_500, 3_500];

export function normalizeSymbol(value) {
  const code = String(value ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('标的代码必须是 6 位数字');
  return code;
}

function exchangeOf(symbol) {
  return /^[56]/.test(symbol) ? 'sh' : 'sz';
}

export async function fetchDailyKlines(fetchImpl = fetch, {
  symbol = DEFAULT_SYMBOL,
  timeoutMs = 15_000,
  retryDelays = DEFAULT_RETRY_DELAYS,
  sleep = wait,
  logger = console
} = {}) {
  const code = normalizeSymbol(symbol);
  const eastmoney = await trySource({
    name: '东方财富',
    load: () => fetchEastmoneyDailyKlines(fetchImpl, timeoutMs, code),
    retryDelays,
    sleep,
    logger
  });
  if (eastmoney.ok) return eastmoney.bars;

  logger.warn(`[行情源切换] 东方财富连续失败，改用腾讯行情：${eastmoney.error.message}`);
  const tencent = await trySource({
    name: '腾讯行情',
    load: () => fetchTencentDailyKlines(fetchImpl, timeoutMs, code),
    retryDelays,
    sleep,
    logger
  });
  if (tencent.ok) {
    logger.warn('[行情源切换] 已使用腾讯前复权日线完成本次检查');
    return tencent.bars;
  }

  throw new Error(`所有行情源均不可用：东方财富 ${eastmoney.error.message}；腾讯行情 ${tencent.error.message}`);
}

async function fetchEastmoneyDailyKlines(fetchImpl, timeoutMs, symbol) {
  const url = new URL(EASTMONEY_ENDPOINT);
  const params = {
    secid: `${exchangeOf(symbol) === 'sh' ? 1 : 0}.${symbol}`,
    klt: '101',
    fqt: '1',
    lmt: '10000',
    end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56'
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  if (payload?.rc !== 0 || !Array.isArray(payload?.data?.klines)) {
    throw new Error(`返回异常（rc=${payload?.rc ?? 'unknown'}）`);
  }

  return payload.data.klines.map(parseKline);
}

async function fetchTencentDailyKlines(fetchImpl, timeoutMs, symbol) {
  const market = `${exchangeOf(symbol)}${symbol}`;
  const url = new URL(TENCENT_ENDPOINT);
  url.searchParams.set('param', `${market},day,,,640,qfq`);

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const payload = await response.json();
  const quote = payload?.data?.[market];
  const rows = quote?.qfqday ?? quote?.day;
  if (payload?.code !== 0 || !Array.isArray(rows) || rows.length === 0) {
    throw new Error(`返回异常（code=${payload?.code ?? 'unknown'}）`);
  }
  const bars = rows.map(parseTencentKline);
  const realtimeQuote = quote?.qt?.[market];
  const preciseLatest = parseTencentQuote(realtimeQuote);
  if (bars.at(-1).date !== preciseLatest.date) {
    throw new Error(`日 K 与精确报价日期不一致（${bars.at(-1).date}/${preciseLatest.date}）`);
  }
  bars[bars.length - 1] = preciseLatest;
  return bars;
}

async function trySource({ name, load, retryDelays, sleep, logger }) {
  const attempts = retryDelays.length + 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, bars: await load() };
    } catch (error) {
      lastError = normalizeError(error);
      logger.warn(`[${name}] 第 ${attempt}/${attempts} 次请求失败：${lastError.message}`);
      if (attempt < attempts) await sleep(retryDelays[attempt - 1]);
    }
  }
  return { ok: false, error: lastError };
}

function parseTencentKline(row) {
  if (!Array.isArray(row) || row.length < 6) throw new Error(`无效腾讯日 K：${JSON.stringify(row)}`);
  return parseKline(row.slice(0, 6).join(','));
}

function parseTencentQuote(quote) {
  if (!Array.isArray(quote) || !/^\d{14}$/.test(String(quote[30] ?? ''))) {
    throw new Error('精确实时报价缺失');
  }
  const stamp = String(quote[30]);
  return parseKline([
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
    quote[5],
    quote[3],
    quote[33],
    quote[34],
    quote[6]
  ].join(','));
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
