import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DIVIDEND_ETF_CODE = '563020';
export const PRICE_INDEX_CODE = 'H30269';
export const TOTAL_RETURN_INDEX_CODE = 'H20269';

const CSINDEX_BASE = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';
const ETF_DIVIDEND_PAGE = (code) => `https://fundf10.eastmoney.com/fhsp_${code}.html`;
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 中证指数官网返回的日线 JSON 解析为按日期升序的 [{ date, close }]。
 * 仅保留有效收盘点位，避免全收益指数早期空值污染股息点计算。
 */
export function parseCsindexHistory(payload) {
  if (payload?.code !== '200' || !Array.isArray(payload.data)) {
    throw new Error('中证指数行情格式异常');
  }
  const rows = payload.data
    .map((item) => {
      const rawDate = String(item?.tradeDate ?? '');
      const close = Number(item?.close);
      if (!/^\d{8}$/.test(rawDate) || !Number.isFinite(close) || close <= 0) return null;
      return { date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`, close };
    })
    .filter(Boolean);
  const unique = [...new Map(rows.map((row) => [row.date, row])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
  if (unique.length < 40) throw new Error('中证指数历史数据不足');
  return unique;
}

/**
 * 天天基金分红送配页面（不同节点可能返回 GBK 或 UTF-8）解析为每股现金分红记录。
 * 列顺序：年度、权益登记日、除息日、每10份派现金X元、分红发放日。
 */
export function parseEtfDividendHtml(html) {
  const rows = [];
  for (const row of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => cell[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+/g, ' ')
        .trim());
    const dates = cells.map((cell) => cell.match(/\d{4}-\d{2}-\d{2}/)?.[0]).filter(Boolean);
    if (dates.length < 2) continue;
    const cashText = cells.find((cell) => /每\s*10\s*份/.test(cell) && /元/.test(cell));
    const match = cashText?.match(/每\s*10\s*份[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*元/);
    if (!match) continue;
    const per10 = Number(match[1]);
    if (!Number.isFinite(per10) || per10 <= 0) continue;

    const registerDate = dates[0];
    const exDate = dates[1] ?? registerDate;
    const payDate = dates[2] ?? exDate;
    rows.push({
      registerDate,
      exDate,
      payDate: payDate < exDate ? exDate : payDate,
      cashPerShare: Number((per10 / 10).toFixed(6))
    });
  }
  return [...new Map(rows.map((row) => [`${row.registerDate}|${row.exDate}`, row])).values()]
    .sort((a, b) => a.registerDate.localeCompare(b.registerDate));
}

async function fetchBuffer(url, { fetchImpl, attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; macd-lab/1.0)',
          Referer: 'https://fundf10.eastmoney.com/'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers?.get?.('content-type') ?? '' };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 天天基金页面在不同节点可能返回 UTF-8 或 GBK，按内容探测后再解析。
 */
function decodeHtml({ buffer, contentType }) {
  const charset = (String(contentType).match(/charset=([\w-]+)/i)?.[1] ?? '').toLowerCase();
  const decoders = charset.includes('gb')
    ? ['gbk', 'utf-8']
    : ['utf-8', 'gbk'];
  for (const encoding of decoders) {
    try {
      const text = new TextDecoder(encoding).decode(buffer);
      if (text.includes('权益登记日') || text.includes('每10份') || text.includes('派现金')) return text;
    } catch {
      // 尝试下一种编码
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

export async function fetchCsindexHistory(code, { fetchImpl = fetch, now = new Date() } = {}) {
  const startDate = '20040101';
  const endDate = shanghaiToday(now).replaceAll('-', '');
  const url = `${CSINDEX_BASE}?indexCode=${encodeURIComponent(code)}&startDate=${startDate}&endDate=${endDate}`;
  const { buffer, contentType } = await fetchBuffer(url, { fetchImpl });
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? '';
  const text = new TextDecoder(charset.includes('gb') ? 'gbk' : 'utf-8').decode(buffer);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`中证指数 ${code} 行情解析失败`);
  }
  return parseCsindexHistory(payload);
}

export async function fetchEtfDividends(code = DIVIDEND_ETF_CODE, { fetchImpl = fetch } = {}) {
  const result = await fetchBuffer(ETF_DIVIDEND_PAGE(code), { fetchImpl });
  return parseEtfDividendHtml(decodeHtml(result));
}

function toPairs(rows) {
  return rows.map((row) => [row.date, row.close]);
}

function validPairs(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .map(([date, close]) => [String(date), Number(close)])
    .filter(([date, close]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function buildDividendBasket({ priceIndex, totalReturnIndex, dividends, now = new Date() }) {
  return {
    etfCode: DIVIDEND_ETF_CODE,
    priceIndexCode: PRICE_INDEX_CODE,
    totalReturnIndexCode: TOTAL_RETURN_INDEX_CODE,
    generatedAt: now.toISOString(),
    sources: {
      index: '中证指数官网',
      dividends: '天天基金分红送配'
    },
    priceIndex: toPairs(priceIndex),
    totalReturnIndex: toPairs(totalReturnIndex),
    dividends
  };
}

/**
 * 服务端数据聚合：中证指数双序列 + 563020 分红记录。
 * 优先内存缓存，其次磁盘缓存；网络失败时返回旧缓存并标记 stale。
 */
export function createDividendBasketLoader({
  fetchImpl = fetch,
  cacheFile = 'data/dividend-basket.json',
  ttlMs = CACHE_TTL_MS,
  now = () => new Date(),
  logger = console
} = {}) {
  let memory = null;
  let memoryAt = 0;

  async function readDiskCache() {
    try {
      const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
      const priceIndex = validPairs(saved.priceIndex);
      const totalReturnIndex = validPairs(saved.totalReturnIndex);
      if (!priceIndex.length || !totalReturnIndex.length) return null;
      return {
        etfCode: saved.etfCode ?? DIVIDEND_ETF_CODE,
        priceIndexCode: saved.priceIndexCode ?? PRICE_INDEX_CODE,
        totalReturnIndexCode: saved.totalReturnIndexCode ?? TOTAL_RETURN_INDEX_CODE,
        generatedAt: saved.generatedAt,
        sources: saved.sources,
        priceIndex,
        totalReturnIndex,
        dividends: Array.isArray(saved.dividends) ? saved.dividends : []
      };
    } catch {
      return null;
    }
  }

  return async function load() {
    const current = now();
    if (memory && current.getTime() - memoryAt < ttlMs) return memory;

    try {
      const [priceIndex, totalReturnIndex, dividends] = await Promise.all([
        fetchCsindexHistory(PRICE_INDEX_CODE, { fetchImpl, now: current }),
        fetchCsindexHistory(TOTAL_RETURN_INDEX_CODE, { fetchImpl, now: current }),
        fetchEtfDividends(DIVIDEND_ETF_CODE, { fetchImpl })
      ]);
      if (!priceIndex.length || !totalReturnIndex.length) throw new Error('指数数据为空');
      const basket = buildDividendBasket({ priceIndex, totalReturnIndex, dividends, now: current });
      memory = basket;
      memoryAt = current.getTime();
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, `${JSON.stringify(basket)}\n`, 'utf8');
      } catch (error) {
        logger.error?.(`[红利低波缓存写入失败] ${error.message}`);
      }
      return basket;
    } catch (error) {
      const cached = await readDiskCache();
      if (!cached) throw error;
      logger.error?.(`[红利低波数据获取失败，使用缓存] ${error.message}`);
      return { ...cached, stale: true, warning: `实时数据获取失败，使用 ${cached.generatedAt ?? '上次'} 的缓存` };
    }
  };
}
