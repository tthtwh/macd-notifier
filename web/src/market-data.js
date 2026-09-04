const THS_BASE_URL = 'https://d.10jqka.com.cn';

export function normalizeInstrumentCode(value) {
  const code = String(value).toLowerCase().replace(/^(sh|sz)/, '').replace(/\.(ss|sz)$/, '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error('请输入 6 位 ETF 或指数代码，例如 510300、159915 或 881121');
  }

  if (/^88\d{4}$/.test(code)) {
    return { code, kind: 'index', provider: 'ths', symbol: `bk_${code}` };
  }

  const market = code.startsWith('5') || code.startsWith('6') ? 'sh' : 'sz';
  return { code, kind: 'etf', provider: 'tencent', market, symbol: `${market}${code}` };
}

export async function fetchInstrumentData(value, {
  fetchImpl = fetch,
  onProgress = () => {}
} = {}) {
  const instrument = typeof value === 'string' ? normalizeInstrumentCode(value) : value;
  return instrument.kind === 'index'
    ? fetchThsIndexData(instrument, { fetchImpl, onProgress })
    : fetchTencentEtfData(instrument, { fetchImpl, onProgress });
}

export function parseJsonp(text) {
  const source = String(text);
  const start = source.indexOf('(');
  const end = source.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('指数行情格式异常');
  try {
    return JSON.parse(source.slice(start + 1, end));
  } catch {
    throw new Error('指数行情解析失败');
  }
}

export function parseThsYearRows(text) {
  const payload = parseJsonp(text);
  if (typeof payload?.data !== 'string') return [];
  return payload.data.split(';').map((line) => {
    const [compactDate, , , , close] = line.split(',');
    return {
      date: /^\d{8}$/.test(compactDate)
        ? `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`
        : '',
      close: Number(close)
    };
  }).filter((row) => row.date && Number.isFinite(row.close) && row.close > 0);
}

async function fetchThsIndexData(instrument, { fetchImpl, onProgress }) {
  const metaResponse = await fetchImpl(`${THS_BASE_URL}/v6/line/${instrument.symbol}/01/all.js`);
  if (!metaResponse.ok) throw new Error(`指数行情服务返回 ${metaResponse.status}`);
  const meta = parseJsonp(await metaResponse.text());
  const years = Array.isArray(meta?.sortYear)
    ? [...new Set(meta.sortYear.map((item) => Number(item?.[0])).filter(Number.isInteger))]
    : [];
  if (!years.length) throw new Error('没有找到该指数的历史年份');

  onProgress(`已识别 ${meta.name || instrument.code}，正在获取 ${years.length} 年指数行情…`);
  const yearRows = await Promise.all(years.map(async (year) => {
    const response = await fetchImpl(`${THS_BASE_URL}/v4/line/${instrument.symbol}/01/${year}.js`);
    if (!response.ok) throw new Error(`${year} 年指数行情返回 ${response.status}`);
    return parseThsYearRows(await response.text());
  }));
  const rows = uniqueSortedRows(yearRows.flat());
  if (rows.length < 40) throw new Error('没有找到足够的指数日线数据，请确认指数代码');

  return {
    instrument,
    rows,
    name: meta.name || '指数',
    source: `完整历史 · 同花顺指数日线 · ${rows.length} 条`
  };
}

async function fetchTencentEtfData(instrument, { fetchImpl, onProgress }) {
  const allRows = [];
  let endDate = '2050-12-31';
  let previousEarliest = '';
  let latestQuote = null;

  for (let page = 0; page < 20; page += 1) {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${instrument.symbol},day,1990-01-01,${endDate},640,qfq`;
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`);
    const payload = await response.json();
    const quote = payload?.data?.[instrument.symbol];
    const rows = quote?.qfqday ?? quote?.day;
    if (!Array.isArray(rows) || !rows.length) break;
    if (!latestQuote) latestQuote = quote;

    allRows.push(...rows);
    const earliest = rows[0][0];
    const uniqueCount = new Set(allRows.map((row) => row[0])).size;
    onProgress(`已获取 ${uniqueCount} 条，正在向上市首日追溯…`);

    if (rows.length < 640 || earliest === previousEarliest || earliest <= '1990-01-02') break;
    previousEarliest = earliest;
    endDate = previousDate(earliest);
  }

  const historicalRows = uniqueSortedRows(allRows.map((row) => ({ date: row[0], close: Number(row[2]) })));
  const { rows, appended } = appendClosedRealtimeQuote(historicalRows, latestQuote, instrument.symbol);
  if (rows.length < 40) throw new Error('没有找到足够的日线数据，请确认代码是沪深 ETF 或 88 开头的同花顺指数');
  const name = latestQuote?.qt?.[instrument.symbol]?.[1] || 'ETF';
  return {
    instrument,
    rows,
    name,
    source: `上市至今 · 前复权日线${appended ? '（已补今日收盘）' : ''} · ${rows.length} 条`
  };
}

export function appendClosedRealtimeQuote(rows, quote, symbol) {
  const realtime = quote?.qt?.[symbol];
  const timestamp = String(realtime?.[30] ?? '');
  const close = Number(realtime?.[3]);

  if (!/^\d{14}$/.test(timestamp) || timestamp.slice(8, 14) < '150000' || !Number.isFinite(close) || close <= 0) {
    return { rows, appended: false };
  }

  const date = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
  if (rows.at(-1)?.date >= date) return { rows, appended: false };

  return {
    rows: uniqueSortedRows([...rows, { date, close }]),
    appended: true
  };
}

function uniqueSortedRows(rows) {
  return [...new Map(rows
    .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0)
    .map((row) => [row.date, row])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

function previousDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
