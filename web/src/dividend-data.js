const TENCENT_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

function shanghaiNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

/** 读取服务端聚合的中证指数双序列 + 563020 分红记录。 */
export async function fetchDividendBasket({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/dividend-basket', {
    cache: 'no-store',
    signal: AbortSignal.timeout(65_000)
  });
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!response.ok) throw new Error(`红利低波数据接口返回 ${response.status}`);
  if (!contentType.includes('application/json')) {
    throw new Error('未检测到红利低波数据接口，请使用 npm start 启动完整服务');
  }
  const payload = await response.json();
  if (!Array.isArray(payload.priceIndex) || !Array.isArray(payload.totalReturnIndex)) {
    throw new Error('红利低波数据格式异常');
  }
  return {
    ...payload,
    priceIndex: normalizePairs(payload.priceIndex),
    totalReturnIndex: normalizePairs(payload.totalReturnIndex),
    dividends: Array.isArray(payload.dividends) ? payload.dividends : []
  };
}

function normalizePairs(pairs) {
  return pairs
    .map(([date, close]) => ({ date: String(date), close: Number(close) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 563020 不复权日线（用于现金分红建模，不能使用前复权价）。
 * 与 MACD 页面一致的数据源：腾讯行情。
 */
export async function fetchEtfRawDaily(code = '563020', { fetchImpl = fetch, onProgress = () => {} } = {}) {
  const symbol = `sh${code}`;
  const all = [];
  let endDate = '2050-12-31';
  let previousEarliest = '';
  let meta = null;

  for (let page = 0; page < 20; page += 1) {
    const url = `${TENCENT_KLINE}?param=${symbol},day,1990-01-01,${endDate},640,day`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`563020 行情服务返回 ${response.status}`);
    const payload = await response.json();
    const quote = payload?.data?.[symbol];
    const rows = quote?.day;
    if (!Array.isArray(rows) || !rows.length) break;
    if (!meta) meta = quote;
    all.push(...rows);

    const earliest = rows[0][0];
    const unique = new Set(all.map((row) => row[0])).size;
    onProgress(`已获取 563020 不复权日线 ${unique} 条…`);
    if (rows.length < 640 || earliest === previousEarliest || earliest <= '1990-01-02') break;
    previousEarliest = earliest;
    const date = new Date(`${earliest}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    endDate = date.toISOString().slice(0, 10);
  }

  const rows = [...new Map(all
    .map((row) => ({
      date: String(row[0]),
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      // 腾讯 ETF 日线成交量单位已是手，与 qt 成交量字段一致。
      volumeLots: Number(row[5])
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.close) && row.close > 0)
    .map((row) => [row.date, row])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));

  // 盘中最后一根日 K 尚未收盘，不能作为月末信号执行价。
  const today = shanghaiNowParts();
  const timestamp = String(meta?.qt?.[symbol]?.[30] ?? '');
  const last = rows.at(-1);
  if (last && last.date === today.date && /^\d{14}$/.test(timestamp)) {
    const closed = timestamp.slice(8, 14) >= '150000';
    if (!closed || today.time < '15:00') rows.pop();
  }

  if (rows.length < 40) throw new Error('没有找到足够的 563020 日线数据');
  return {
    rows,
    name: meta?.qt?.[symbol]?.[1] || '红利低波ETF易方达',
    source: `563020 不复权日线 · ${rows.length} 条 · 腾讯行情`
  };
}
