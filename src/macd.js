export const MACD_PARAMS = Object.freeze({ short: 12, long: 26, signal: 9 });

export function calculateMacd(closes, params = MACD_PARAMS) {
  if (!Array.isArray(closes) || closes.length === 0) {
    throw new Error('MACD 需要至少一个收盘价');
  }

  const values = closes.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('收盘价包含无效数值');
  }

  const shortAlpha = 2 / (params.short + 1);
  const longAlpha = 2 / (params.long + 1);
  const signalAlpha = 2 / (params.signal + 1);
  let shortEma = values[0];
  let longEma = values[0];
  let dea = 0;

  return values.map((close, index) => {
    if (index > 0) {
      shortEma = close * shortAlpha + shortEma * (1 - shortAlpha);
      longEma = close * longAlpha + longEma * (1 - longAlpha);
    }

    const dif = shortEma - longEma;
    dea = index === 0 ? dif : dif * signalAlpha + dea * (1 - signalAlpha);
    return { dif, dea, hist: 2 * (dif - dea) };
  });
}

export function getSignal(previousHist, currentHist) {
  if (previousHist <= 0 && currentHist > 0) return 'BUY';
  if (previousHist >= 0 && currentHist < 0) return 'SELL';
  return 'NONE';
}

export function estimateZeroHistClose(closes, params = MACD_PARAMS) {
  if (!Array.isArray(closes) || closes.length < 2) {
    throw new Error('估算 MACD 临界价需要至少两个收盘价');
  }

  const history = closes.slice(0, -1);
  const histAtZero = calculateMacd([...history, 0], params).at(-1).hist;
  const histAtOne = calculateMacd([...history, 1], params).at(-1).hist;
  const slope = histAtOne - histAtZero;
  if (!Number.isFinite(slope) || Math.abs(slope) < Number.EPSILON) {
    throw new Error('无法估算 MACD 临界价');
  }

  return -histAtZero / slope;
}
