const WIDTH = 1200;
const LEFT = 76;
const RIGHT = 30;
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 });
const numeric = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (date) => new Date(`${date}T00:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);
const valid = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function bucket(date, period) {
  if (period === 'day') return { bucketStart: date, bucketEnd: date };
  const start = day(date);
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  else start.setUTCDate(1);
  const end = new Date(start);
  if (period === 'week') end.setUTCDate(end.getUTCDate() + 6);
  else { end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); }
  return { bucketStart: iso(start), bucketEnd: iso(end) };
}

/** Pure daily OHLC / Monday-to-Sunday weekly OHLC / calendar-month close-synthetic OHLC aggregation. */
export function aggregateCandles(rows = [], { period = 'week', synthetic = false, closeField } = {}) {
  if (!['day', 'week', 'month'].includes(period)) throw new TypeError('period must be day, week or month');
  const unique = new Map();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date ?? '') || Number.isNaN(day(row.date).getTime())) continue;
    const close = Number(row[closeField ?? (synthetic && row.priceClose !== undefined ? 'priceClose' : 'close')]);
    const open = synthetic ? close : Number(row.open);
    const high = synthetic ? close : Number(row.high);
    const low = synthetic ? close : Number(row.low);
    if (![open, high, low, close].every(valid) || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    unique.set(row.date, { ...row, open, high, low, close });
  }
  const grouped = new Map();
  for (const row of [...unique.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const bounds = bucket(row.date, period);
    let candle = grouped.get(bounds.bucketStart);
    if (!candle) {
      candle = { key: bounds.bucketStart, date: row.date, startDate: row.date, endDate: row.date, ...bounds,
        open: row.open, high: row.high, low: row.low, close: row.close, volumeLots: 0, hasVolume: false, volumeComplete: true, count: 0 };
      grouped.set(bounds.bucketStart, candle);
    }
    candle.endDate = row.date;
    candle.high = Math.max(candle.high, row.high);
    candle.low = Math.min(candle.low, row.low);
    candle.close = row.close;
    if (Number.isFinite(row.volumeLots) && row.volumeLots >= 0) {
      candle.volumeLots += row.volumeLots;
      candle.hasVolume = true;
    } else candle.volumeComplete = false;
    candle.count += 1;
  }
  return [...grouped.values()];
}

function rangeStart(endDate, range) {
  if (range === 'all' || !/^\d+y$/.test(range)) return '';
  const end = day(endDate);
  const year = end.getUTCFullYear() - Number(range.slice(0, -1));
  const last = new Date(Date.UTC(year, end.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(year, end.getUTCMonth(), Math.min(last, end.getUTCDate()))));
}

function controls(kind, selected, options) {
  return `<div class="dc-actions" aria-label="${kind === 'etf' ? 'ETF' : '指数'}图表显示范围">${options.map(([key, label]) => `<button type="button" class="dc-range-button ${selected === key ? 'active' : ''}" data-chart-range="${kind}" data-range="${key}" aria-pressed="${selected === key}">${label}</button>`).join('')}</div>`;
}

function card(kind, title, subtitle, action, content, caption) {
  return `<section class="card dc-card dc-${kind}-card"><header class="dc-heading"><div class="dc-title"><h2>${title}</h2><p class="dc-subtitle">${subtitle}</p></div>${action}</header>${content}<p class="dc-caption">${caption}</p></section>`;
}

function empty(message) { return `<div class="dc-empty">${message}</div>`; }
function json(value) { return JSON.stringify(value).replaceAll('<', '\\u003c'); }
function plot(kind, height, svg, data) {
  return `<div class="dc-plot" data-dc-chart="${kind}"><svg class="dc-svg" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escape(data.title)}">${svg}<g data-dc-hover visibility="hidden"><line class="dc-hover-line" x1="0" x2="0" y1="26" y2="${height - 32}"/><circle class="dc-hover-dot" r="4"/></g><rect data-dc-hit x="${LEFT}" y="20" width="${WIDTH - LEFT - RIGHT}" height="${height - 48}" fill="transparent" pointer-events="all"/></svg><div class="dc-tooltip" hidden></div><script type="application/json" class="dc-chart-data">${json(data)}</script></div>`;
}

function axes(min, max, top, bottom, xLabels, format = (n) => numeric.format(n), inverse = (n) => n) {
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = bottom - ratio * (bottom - top);
    const value = inverse(min + ratio * (max - min));
    return `<line class="dc-grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${y}" y2="${y}"/><text class="dc-tick" x="${LEFT - 12}" y="${y + 4}" text-anchor="end">${escape(format(value))}</text>`;
  }).join('');
  return grid + xLabels;
}

function labels(points, x, y) {
  const indexes = [...new Set(Array.from({ length: Math.min(7, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(7, points.length) - 1))))];
  return indexes.map((index, i) => `<text class="dc-tick" x="${x(index)}" y="${y}" text-anchor="${i === 0 ? 'start' : i === indexes.length - 1 ? 'end' : 'middle'}">${escape((points[index].date ?? points[index].startDate).slice(0, 7))}</text>`).join('');
}

function tradeLabel(trade) {
  if (trade.toLevel === 0) return '清仓';
  return `${trade.side === 'buy' ? '加至' : '减至'}${trade.toLevel}%`;
}

function placeTradeLabel(x, preferredY, text, side, top, bottom, placed) {
  // Estimate the 11px SVG text plus its white outline. Check the final position,
  // after clamping: different provisional lanes can otherwise collapse together.
  const halfWidth = (Array.from(text).reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 11 : 7), 0) + 6) / 2;
  const minY = side === 'sell' ? 15 : top + 14;
  const maxY = side === 'sell' ? bottom - 14 : bottom + 63;
  const candidates = [preferredY];
  for (let y = minY; y <= maxY; y += 18) candidates.push(y);
  candidates.sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY));
  const overlaps = (candidateX, candidateY) => placed.some((label) => Math.abs(candidateX - label.x) < halfWidth + label.halfWidth + 5 && Math.abs(candidateY - label.y) < 15);
  let labelX = x;
  let labelY = candidates.find((y) => !overlaps(labelX, y));
  // Preserve every label even in an unusually crowded bucket; a short horizontal
  // leader is preferable to discarding a trade when all vertical slots are taken.
  if (labelY === undefined) {
    for (let offset = 18; offset < WIDTH && labelY === undefined; offset += 18) {
      for (const direction of [-1, 1]) {
        const candidateX = x + direction * offset;
        if (candidateX < LEFT + halfWidth || candidateX > WIDTH - RIGHT - halfWidth) continue;
        const candidateY = candidates.find((y) => !overlaps(candidateX, y));
        if (candidateY !== undefined) { labelX = candidateX; labelY = candidateY; break; }
      }
    }
  }
  labelY ??= preferredY;
  placed.push({ x: labelX, y: labelY, halfWidth });
  return { labelX, labelY };
}

function tradingData(result, kind, candles, series) {
  const priceRows = [...(series ?? [])].filter((row) => valid(row.priceClose)).sort((a, b) => a.date.localeCompare(b.date));
  const trades = (result.trades ?? []).filter((trade) => trade.type === 'rebalance' && (!result.startDate || trade.date >= result.startDate) && (!result.endDate || trade.date <= result.endDate) && (kind !== 'etf' || trade.phase === 'etf'));
  return candles.map((candle) => trades.filter((trade) => trade.date >= candle.bucketStart && trade.date <= candle.bucketEnd).map((trade) => {
    let price = null;
    if (kind === 'index') {
      for (let i = priceRows.length - 1; i >= 0; i--) {
        if (priceRows[i].date <= trade.date) { price = priceRows[i].priceClose; break; }
      }
    }
    return { date: trade.date, side: trade.side, fromLevel: trade.fromLevel, toLevel: trade.toLevel,
      phase: trade.phase, price: trade.price, chartPrice: kind === 'etf' ? trade.price : price, label: tradeLabel(trade) };
  }));
}

function candleChart(kind, result, rows, series, range) {
  const period = kind === 'etf' ? 'day' : 'month';
  const endDate = result.endDate || rows.at(-1)?.date || '';
  const cutoff = rangeStart(endDate, range);
  const candles = aggregateCandles(rows.filter((row) => (!result.startDate || row.date >= result.startDate) && row.date <= endDate), { period, synthetic: kind === 'index', closeField: kind === 'index' ? 'priceClose' : 'close' })
    .filter((candle) => !cutoff || candle.endDate >= cutoff);
  if (candles.length < 2) return empty(kind === 'etf' ? '暂无足够的 ETF 日线行情，请刷新数据或扩大显示范围。' : '暂无足够的指数月线数据，请扩大显示范围。');
  const height = kind === 'etf' ? 500 : 530;
  const top = 70;
  const bottom = kind === 'etf' ? 340 : 360;
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  const padding = Math.max((high - low) * .07, high * .005);
  const min = Math.max(0, low - padding);
  const max = high + padding;
  const step = (WIDTH - LEFT - RIGHT) / candles.length;
  const x = (index) => LEFT + (index + .5) * step;
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  const tradeSets = tradingData(result, kind, candles, series);
  const bodyWidth = Math.max(1, Math.min(11, step * .65));
  const bars = candles.map((c, i) => {
    const direction = c.close >= c.open ? 'up' : 'down';
    return `<g class="dc-candle ${direction}" data-candle-start="${c.startDate}" data-candle-end="${c.endDate}"><line x1="${x(i)}" x2="${x(i)}" y1="${y(c.high)}" y2="${y(c.low)}"/><rect x="${x(i) - bodyWidth / 2}" y="${Math.min(y(c.open), y(c.close))}" width="${bodyWidth}" height="${Math.max(1.3, Math.abs(y(c.close) - y(c.open)))}"/></g>`;
  }).join('');
  const lastByLane = { buy: [], sell: [] };
  const placedLabels = { buy: [], sell: [] };
  const marks = tradeSets.flatMap((trades, i) => trades.map((trade) => {
    const side = trade.side === 'buy' ? 'buy' : 'sell';
    const lanes = lastByLane[side];
    let lane = lanes.findIndex((last) => x(i) - last >= 82);
    if (lane < 0) lane = lanes.length;
    lane %= 4;
    lanes[lane] = x(i);
    const anchor = side === 'buy' ? y(candles[i].low) + 7 : y(candles[i].high) - 7;
    const preferredY = side === 'buy' ? Math.min(bottom + 63, anchor + 17 + lane * 18) : Math.max(15, anchor - 13 - lane * 18);
    const preferredX = Math.max(LEFT + 35, Math.min(WIDTH - RIGHT - 35, x(i)));
    const { labelX, labelY } = placeTradeLabel(preferredX, preferredY, trade.label, side, top, bottom, placedLabels[side]);
    return `<g class="dc-trade ${side}" data-trade-date="${trade.date}"><line x1="${x(i)}" x2="${labelX}" y1="${anchor}" y2="${labelY - (side === 'buy' ? 10 : -4)}"/><circle cx="${x(i)}" cy="${anchor}" r="3"/><text x="${labelX}" y="${labelY}" text-anchor="middle">${escape(trade.label)}</text></g>`;
  })).join('');
  let lower;
  if (kind === 'etf') {
    const volumeMax = Math.max(1, ...candles.map((c) => c.volumeLots));
    lower = `<text class="dc-tick" x="${LEFT}" y="418">日成交量（手）</text><line class="dc-grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="470" y2="470"/>` + candles.map((c, i) => `<rect class="dc-volume ${c.close >= c.open ? 'up' : 'down'}" x="${x(i) - bodyWidth / 2}" y="${470 - c.volumeLots / volumeMax * 42}" width="${bodyWidth}" height="${c.volumeLots / volumeMax * 42}"/>`).join('') + `<text class="dc-tick" x="${LEFT - 12}" y="434" text-anchor="end">${numeric.format(volumeMax)}</text>`;
  } else {
    lower = positionBand(result.nav ?? [], candles, step);
  }
  const ticks = labels(candles, x, height - 12);
  const svg = axes(min, max, top, bottom, ticks) + bars + marks + lower;
  const navRows = [...(result.nav ?? [])].filter((row) => row.date <= endDate && Number.isFinite(row.level)).sort((a, b) => a.date.localeCompare(b.date));
  const levelAt = (date) => {
    let level = null;
    for (const row of navRows) {
      if (row.date <= date) level = row.level;
      else break;
    }
    return level;
  };
  const seriesRows = [...(series ?? [])].filter((row) => row.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
  const seriesAt = (date) => {
    let found = null;
    for (const row of seriesRows) {
      if (row.date <= date) found = row;
      else break;
    }
    return found;
  };
  const points = candles.map((c, i) => {
    const prevClose = i > 0 ? candles[i - 1].close : c.open;
    const seriesPoint = seriesAt(c.endDate);
    return {
      ...c,
      x: x(i),
      y: y(c.close),
      trades: tradeSets[i],
      prevClose,
      changePct: prevClose ? c.close / prevClose - 1 : null,
      amplitude: prevClose ? (c.high - c.low) / prevClose : null,
      level: levelAt(c.endDate),
      dy: Number.isFinite(seriesPoint?.dividendYield) ? seriesPoint.dividendYield : null,
      pct: Number.isFinite(seriesPoint?.percentile) ? seriesPoint.percentile : null,
    };
  });
  return plot(kind, height, svg, { kind, title: kind === 'etf' ? '563020 真实日K及成交量' : 'H30269 日收盘合成月K及策略仓位', left: LEFT, right: RIGHT, width: WIDTH, top, bottom, min, max,
    points });
}

function positionBand(nav, candles, step) {
  const start = candles[0].bucketStart;
  const end = candles.at(-1).bucketEnd;
  const rows = [...nav].filter((row) => row.date <= end && Number.isFinite(row.level)).sort((a, b) => a.date.localeCompare(b.date));
  let current = 0;
  for (const row of rows) if (row.date < start) current = row.level;
  const xDate = (date) => {
    const i = candles.findIndex((c) => date >= c.bucketStart && date <= c.bucketEnd);
    if (i < 0) return date < start ? LEFT : WIDTH - RIGHT;
    const fraction = (day(date) - day(candles[i].bucketStart)) / (day(candles[i].bucketEnd) - day(candles[i].bucketStart) + 86400000);
    return LEFT + (i + fraction) * step;
  };
  const y = (level) => 510 - level / 100 * 56;
  let path = `M${LEFT},${y(current)}`;
  for (const row of rows) {
    if (row.date < start || row.level === current) continue;
    path += `H${xDate(row.date)}V${y(row.level)}`;
    current = row.level;
  }
  path += `H${WIDTH - RIGHT}`;
  const fill = `${path}V510H${LEFT}Z`;
  return `<text class="dc-tick" x="${LEFT}" y="438">策略仓位 · 按实际执行日变更</text><line class="dc-grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="510" y2="510"/><text class="dc-tick" x="${LEFT - 12}" y="461" text-anchor="end">100%</text><text class="dc-tick" x="${LEFT - 12}" y="513" text-anchor="end">0%</text><path class="dc-position-fill" d="${fill}"/><path class="dc-position-line" d="${path}"/>`;
}

function sampleNetPoints(points, limit = 900) {
  if (points.length <= limit) return points;
  // Each bucket can contribute its endpoints plus both curves' minima and maxima.
  // Sampling changes only the polyline; all daily points remain available to hover.
  const stride = Math.ceil(points.length / Math.max(1, Math.floor(limit / 6)));
  const indexes = new Set([0, points.length - 1]);
  for (let start = 0; start < points.length; start += stride) {
    const end = Math.min(points.length, start + stride);
    indexes.add(start);
    indexes.add(end - 1);
    for (const field of ['equity', 'benchmarkEquity']) {
      let low = -1;
      let high = -1;
      for (let i = start; i < end; i++) {
        if (!Number.isFinite(points[i][field])) continue;
        if (low < 0 || points[i][field] < points[low][field]) low = i;
        if (high < 0 || points[i][field] > points[high][field]) high = i;
      }
      if (low >= 0) indexes.add(low);
      if (high >= 0) indexes.add(high);
    }
    for (let i = start; i < end; i++) if (points[i].trades.length) indexes.add(i);
  }
  return [...indexes].sort((a, b) => a - b).map((index) => points[index]);
}

function netChart(result, netScale) {
  const benchmark = new Map((result.benchmark?.nav ?? []).map((row) => [row.date, row.equity]));
  const trades = new Map();
  for (const trade of result.trades ?? []) {
    if (trade.type !== 'rebalance') continue;
    if (!trades.has(trade.date)) trades.set(trade.date, []);
    trades.get(trade.date).push({ ...trade, label: tradeLabel(trade) });
  }
  const nav = (result.nav ?? []).filter((row) => Number.isFinite(row.equity) && (!result.startDate || row.date >= result.startDate) && (!result.endDate || row.date <= result.endDate));
  if (nav.length < 2) return empty('暂无足够的每日权益数据。');
  const values = nav.flatMap((row) => [row.equity, benchmark.get(row.date)].filter(Number.isFinite));
  const logarithmic = netScale === 'log' && values.every((value) => value > 0);
  const transform = logarithmic ? Math.log : (value) => value;
  const inverse = logarithmic ? Math.exp : (value) => value;
  const transformed = values.map(transform);
  const lo = Math.min(...transformed);
  const hi = Math.max(...transformed);
  const padding = Math.max((hi - lo) * .07, logarithmic ? .01 : 1);
  const min = lo - padding;
  const max = hi + padding;
  const top = 28;
  const bottom = 258;
  const x = (i) => LEFT + i / (nav.length - 1) * (WIDTH - LEFT - RIGHT);
  const y = (value) => bottom - (transform(value) - min) / (max - min) * (bottom - top);
  const points = nav.map((row, i) => ({ date: row.date, equity: row.equity, benchmarkEquity: benchmark.get(row.date) ?? null,
    level: row.level, phase: row.phase, price: row.price, x: x(i), y: y(row.equity), trades: trades.get(row.date) ?? [] }));
  const sampled = sampleNetPoints(points);
  const line = (key) => sampled.map((p) => Number.isFinite(p[key]) ? `${p.x},${y(p[key])}` : null).filter(Boolean).join(' ');
  const marks = points.filter((p) => p.trades.length).map((p) => `<circle class="dc-net-trade" data-trade-date="${p.date}" cx="${p.x}" cy="${p.y}" r="3"/>`).join('');
  const legend = `<g class="dc-svg-legend"><line class="dc-net strategy" x1="${WIDTH - 252}" x2="${WIDTH - 230}" y1="15" y2="15"/><text class="dc-tick" x="${WIDTH - 224}" y="19">策略</text><line class="dc-net benchmark" x1="${WIDTH - 160}" x2="${WIDTH - 138}" y1="15" y2="15"/><text class="dc-tick" x="${WIDTH - 132}" y="19">持有基准</text></g>`;
  const svg = legend + axes(min, max, top, bottom, labels(points, (i) => points[i].x, 290), (value) => numeric.format(value), inverse)
    + `<polyline class="dc-net benchmark" points="${line('benchmarkEquity')}"/><polyline class="dc-net strategy" points="${line('equity')}"/>${marks}`;
  return plot('net', 300, svg, { kind: 'net', title: '策略与持有基准每日资金权益', width: WIDTH, left: LEFT, right: RIGHT, top, bottom, scale: logarithmic ? 'log' : 'linear', points });
}

export function renderDividendCharts({ result, series = [], etfRows = [], ranges = { etf: 'all', index: 'all' }, netScale = 'log' } = {}) {
  result ??= { nav: [], trades: [], benchmark: { nav: [] }, endDate: '' };
  netScale = netScale === 'linear' ? 'linear' : 'log';
  const nonPositive = [...(result.nav ?? []), ...(result.benchmark?.nav ?? [])].some((row) => (!result.startDate || row.date >= result.startDate) && (!result.endDate || row.date <= result.endDate) && Number.isFinite(row.equity) && row.equity <= 0);
  const fallback = netScale === 'log' && nonPositive;
  if (fallback) netScale = 'linear';
  const etfRange = ['all', '2y', '1y'].includes(ranges.etf) ? ranges.etf : 'all';
  const indexRange = ['all', '10y', '5y'].includes(ranges.index) ? ranges.index : 'all';
  const netActions = `<div class="dc-actions" aria-label="资金权益纵轴刻度">${[['log', '对数'], ['linear', '线性']].map(([key, label]) => `<button type="button" class="dc-range-button ${netScale === key ? 'active' : ''}" data-net-scale="${key}" aria-pressed="${netScale === key}">${label}</button>`).join('')}</div>`;
  return `<div class="dc-charts">${card('etf', '① 563020 日K线', '真实日线 OHLC · 红涨绿跌 · 日成交量', controls('etf', etfRange, [['all', '全部'], ['2y', '近2年'], ['1y', '近1年']]), candleChart('etf', result, etfRows, series, etfRange), '仅展示回测区间。标记为 ETF 阶段的全部调仓；加至 / 减至表示调仓后的目标档位。价格为不复权行情。')}${card('index', '② H30269 月K线与仓位', '日收盘合成，非盘中高低 · 包含指数与 ETF 阶段调仓', controls('index', indexRange, [['all', '全部'], ['10y', '近10年'], ['5y', '近5年']]), candleChart('index', result, series, series, indexRange), '仅展示回测区间，首尾月可能未完整。月K：开盘=首日收盘，最高/最低=当月日收盘极值，收盘=末日收盘；成交价格与指数价分别列于提示中。仓位按每日已执行档位绘制。')}${card('net', '③ 策略与持有基准资金曲线', '纵轴为资金（元） · 策略 / 持有基准 · 可逐日查看', netActions, netChart(result, netScale), `${fallback ? '权益含非正数，已使用线性刻度。' : ''}横轴为回测交易日；对数刻度用于比较相对增长。全部日期参与悬停查询，绘制抽样保留策略与基准的峰谷及全部调仓日。`)}</div>`;
}

function tipRow(label, value) { return `<div class="dc-tooltip-row"><span>${escape(label)}</span><b>${escape(value)}</b></div>`; }
function priceText(value, etf = false) { return valid(value) ? etf ? Number(value).toFixed(3) : numeric.format(value) : '—'; }
function tooltip(point, data) {
  const pointDate = data.kind === 'net' || point.startDate === point.endDate
    ? point.date ?? point.startDate
    : `${point.startDate} — ${point.endDate}`;
  let html = `<div class="dc-tooltip-date">${escape(pointDate)}</div>`;
  if (data.kind === 'net') {
    html += tipRow('策略权益', currency.format(point.equity)) + tipRow('持有基准', Number.isFinite(point.benchmarkEquity) ? currency.format(point.benchmarkEquity) : '—') + tipRow('策略仓位', `${point.level ?? '—'}%`);
    if (valid(point.price)) html += tipRow(point.phase === 'etf' ? 'ETF 收盘价' : '全收益指数收盘', priceText(point.price, point.phase === 'etf'));
  } else {
    html += tipRow('开 / 收', `${priceText(point.open, data.kind === 'etf')} / ${priceText(point.close, data.kind === 'etf')}`) + tipRow('高 / 低', `${priceText(point.high, data.kind === 'etf')} / ${priceText(point.low, data.kind === 'etf')}`);
    html += tipRow(data.kind === 'etf' ? '昨收' : '上月收', priceText(point.prevClose, data.kind === 'etf'));
    html += tipRow(data.kind === 'etf' ? '涨跌幅' : '月涨跌幅', Number.isFinite(point.changePct) ? `${point.changePct >= 0 ? '+' : ''}${(point.changePct * 100).toFixed(2)}%` : '—');
    html += tipRow('振幅', Number.isFinite(point.amplitude) ? `${(point.amplitude * 100).toFixed(2)}%` : '—');
    if (data.kind === 'etf') html += tipRow('日成交量', point.hasVolume ? `${numeric.format(point.volumeLots)} 手${point.volumeComplete ? '' : '（部分日期）'}` : '—');
    else html += tipRow('合成口径', '日收盘合成，非盘中高低');
    if (Number.isFinite(point.level)) html += tipRow('策略仓位', `${point.level}%`);
    if (Number.isFinite(point.dy)) html += tipRow('指数股息率', `${(point.dy * 100).toFixed(2)}%`);
    if (Number.isFinite(point.pct)) html += tipRow('10年分位', `${(point.pct * 100).toFixed(1)}%`);
  }
  for (const trade of point.trades) {
    html += `<div class="dc-tooltip-trade">${tipRow(`${trade.date} ${trade.side === 'buy' ? '买入' : '卖出'}`, `${trade.fromLevel}% → ${trade.toLevel}%`)}${tipRow(trade.phase === 'etf' ? 'ETF 成交价' : '模拟成交价', priceText(trade.price, trade.phase === 'etf'))}${data.kind === 'index' ? tipRow('执行日指数收盘', priceText(trade.chartPrice)) : ''}</div>`;
  }
  return html;
}

export function bindDividendCharts(root = document) {
  root.querySelectorAll('[data-dc-chart]').forEach((container) => {
    if (container.dataset.dcBound) return;
    const svg = container.querySelector('svg');
    const hit = container.querySelector('[data-dc-hit]');
    const tip = container.querySelector('.dc-tooltip');
    const hover = container.querySelector('[data-dc-hover]');
    const source = container.querySelector('.dc-chart-data');
    if (!svg || !hit || !tip || !hover || !source) return;
    const data = JSON.parse(source.textContent);
    container.dataset.dcBound = 'true';
    const hide = () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); };
    const show = (event) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !data.points.length) return;
      const px = (event.clientX - rect.left) / rect.width * data.width;
      let index;
      if (data.kind === 'net') index = Math.round(Math.max(0, Math.min(1, (px - data.left) / (data.width - data.left - data.right))) * (data.points.length - 1));
      else index = Math.floor(Math.max(0, Math.min(.999999, (px - data.left) / (data.width - data.left - data.right))) * data.points.length);
      const point = data.points[index];
      hover.setAttribute('visibility', 'visible');
      const guide = hover.querySelector('line');
      guide.setAttribute('x1', point.x); guide.setAttribute('x2', point.x);
      const dot = hover.querySelector('circle');
      dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y);
      tip.innerHTML = tooltip(point, data);
      tip.hidden = false;
      const box = container.getBoundingClientRect();
      let left = event.clientX - box.left + 14;
      if (left + tip.offsetWidth > box.width - 8) left = event.clientX - box.left - tip.offsetWidth - 14;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${Math.max(8, Math.min(event.clientY - box.top + 12, box.height - tip.offsetHeight - 8))}px`;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('pointercancel', hide);
  });
}
