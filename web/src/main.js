import './style.css';
import { fetchInstrumentData, normalizeInstrumentCode } from './market-data.js';
import { applyTradeCapital, valueOpenPosition } from './trade-capital.js';
import { marketForDate, tradeMarketCsv } from './trade-market.js';
import { DEFAULT_EXECUTION_MODE, pricePositionMetrics, runBacktest, runBacktestDetails } from './backtest.js';
import { createHistoryCsv } from './history-export.js';
import { anchorScale, scaleMoneyView } from './money-anchor.js';
import { mountDividendPage } from './dividend-page.js';

const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const executionModes = {
  nextOpenBuySameCloseSell: {
    label: '当天卖出、次日集合竞价买入',
    note: '买入信号确认后，下一交易日按开盘价模拟集合竞价买入；卖出信号当天按收盘价模拟卖出。当天收盘卖出属于理想化回测，集合竞价不保证实际成交；无下一交易日开盘价时不买入。已按 T+1 处理：当天买入的份额最早次日开盘卖出，卖出信号落在买入当天时顺延，不会出现当天买当天卖。',
  },
  sameClose: {
    label: '当天收盘',
    note: '按信号当天最终收盘价模拟成交，属于理想化回测，不等同于 14:59 实际成交。',
  },
  nextOpen: {
    label: '次日开盘（集合竞价模拟）',
    note: '收盘确认翻色，下一交易日按开盘价模拟成交；尚无下一交易日价格的交易不计入已完成交易。',
  },
};

const state = {
  code: '512760',
  symbol: '512760 芯片ETF国泰',
  fast: 12,
  slow: 26,
  signal: 9,
  capital: 100000,
  anchorValue: 0,
  primaryCode: '512760',
  executionMode: DEFAULT_EXECUTION_MODE,
  feeRate: 0.0003,
  data: [],
  latestQuote: null,
  marketHistory: new Map(),
  marketPartialDate: null,
  marketLoadedAt: 0,
  marketError: '',
  marketLoading: false,
  source: '正在连接在线行情…',
  loading: false,
  error: '',
  startDate: '',
  endDate: '',
  historyPage: 1,
  historyPageSize: 100,
  queryHistory: [],
  storageError: '',
  activeTab: 'annual',
};

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const result = [];
  let previous = values[0];
  for (let i = 0; i < values.length; i += 1) {
    previous = i === 0 ? values[i] : values[i] * multiplier + previous * (1 - multiplier);
    result.push(previous);
  }
  return result;
}

function calculateMacd(rows) {
  if (!rows.length) return [];
  const closes = rows.map((row) => row.close);
  const fast = ema(closes, state.fast);
  const slow = ema(closes, state.slow);
  const dif = fast.map((value, i) => value - slow[i]);
  const dea = ema(dif, state.signal);
  return rows.map((row, i) => ({ ...row, dif: dif[i], dea: dea[i], hist: (dif[i] - dea[i]) * 2 }));
}

function backtest(rows) {
  return runBacktest(rows, state);
}

function summarize(trades) {
  const wins = trades.filter((trade) => trade.profit > 0);
  const losses = trades.filter((trade) => trade.profit <= 0);
  const totalReturn = trades.reduce((equity, trade) => equity * (1 + trade.netReturn), 1) - 1;
  const avgWin = wins.length ? wins.reduce((sum, trade) => sum + trade.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((sum, trade) => sum + trade.netReturn, 0) / losses.length) : 0;
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  trades.forEach((trade) => {
    equity *= 1 + trade.netReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity - peak) / peak);
  });
  return {
    count: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalReturn,
    pnlRatio: avgLoss ? avgWin / avgLoss : null,
    maxDrawdown,
    finalCapital: state.capital * (1 + totalReturn),
  };
}

function summarizeByYear(rows, trades) {
  const years = [...new Set(rows.map((row) => row.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  return years.map((year) => {
    const yearRows = rows.filter((row) => row.date.startsWith(year));
    const yearTrades = trades.filter((trade) => trade.exitDate.startsWith(year));
    const wins = yearTrades.filter((trade) => trade.netReturn > 0);
    const losses = yearTrades.filter((trade) => trade.netReturn <= 0);
    const strategyReturn = yearTrades.reduce((equity, trade) => equity * (1 + trade.netReturn), 1) - 1;
    const etfReturn = yearRows.length > 1 ? yearRows.at(-1).close / yearRows[0].close - 1 : 0;
    const avgWin = wins.length ? wins.reduce((sum, trade) => sum + trade.netReturn, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((sum, trade) => sum + trade.netReturn, 0) / losses.length) : 0;
    return {
      year,
      range: `${yearRows[0]?.date.slice(5) ?? '—'} 至 ${yearRows.at(-1)?.date.slice(5) ?? '—'}`,
      strategyReturn,
      etfReturn,
      excessReturn: strategyReturn - etfReturn,
      count: yearTrades.length,
      winRate: yearTrades.length ? wins.length / yearTrades.length : 0,
      pnlRatio: avgLoss ? avgWin / avgLoss : null,
    };
  });
}

function percent(value, digits = 2) {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

function formatPct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';
}

function priceText(value) {
  const abs = Math.abs(value);
  return abs >= 100 ? value.toFixed(1) : abs >= 10 ? value.toFixed(2) : value.toFixed(3);
}

function chartSvg(rows, trades) {
  const sample = rows.slice(-310);
  if (!sample.length) return '';
  const width = 1000;
  const height = 340;
  const left = 64;
  const right = 18;
  const top = 16;
  const priceBottom = 246;
  const volTop = 262;
  const volBottom = 314;

  const bars = sample.map((row) => {
    const close = row.close;
    const open = Number.isFinite(row.open) ? row.open : close;
    const high = Number.isFinite(row.high) ? Math.max(row.high, open, close) : Math.max(open, close);
    const low = Number.isFinite(row.low) ? Math.min(row.low, open, close) : Math.min(open, close);
    return { date: row.date, open, close, high, low, volume: Number.isFinite(row.volumeLots) ? row.volumeLots : 0 };
  });
  const lowest = Math.min(...bars.map((bar) => bar.low));
  const highest = Math.max(...bars.map((bar) => bar.high));
  const padding = Math.max((highest - lowest) * 0.06, 1e-6);
  const priceMin = lowest - padding;
  const priceMax = highest + padding;
  const slot = (width - left - right) / bars.length;
  const bodyWidth = Math.max(1, Math.min(9, slot * 0.62));
  const x = (index) => left + slot * (index + 0.5);
  const y = (value) => priceBottom - ((value - priceMin) / (priceMax - priceMin)) * (priceBottom - top);
  const maxVolume = Math.max(1, ...bars.map((bar) => bar.volume));
  const vy = (value) => volBottom - (value / maxVolume) * (volBottom - volTop);

  const tradeByDate = new Map();
  for (const trade of trades) {
    if (trade.entryDate) tradeByDate.set(trade.entryDate, { side: 'buy', price: trade.entryPrice });
    if (trade.exitDate) tradeByDate.set(trade.exitDate, { side: 'sell', price: trade.exitPrice });
  }

  const priceGrid = Array.from({ length: 5 }, (_, k) => priceMin + ((priceMax - priceMin) * k) / 4).map((value) => {
    const gy = y(value).toFixed(1);
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${gy}" y2="${gy}"/>`
      + `<text class="chart-tick" x="${left - 8}" y="${(Number(gy) + 3).toFixed(1)}" text-anchor="end">${priceText(value)}</text>`;
  }).join('');

  const candles = bars.map((bar, index) => {
    const cx = x(index);
    const up = bar.close >= bar.open;
    const bodyTop = y(Math.max(bar.open, bar.close));
    const bodyHeight = Math.max(1, y(Math.min(bar.open, bar.close)) - bodyTop);
    return `<g class="candle ${up ? 'up' : 'down'}">`
      + `<line class="candle-wick" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(bar.high).toFixed(1)}" y2="${y(bar.low).toFixed(1)}"/>`
      + `<rect class="candle-body" x="${(cx - bodyWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${bodyHeight.toFixed(1)}"/></g>`;
  }).join('');

  const volumes = bars.map((bar, index) => {
    const up = bar.close >= bar.open;
    const barTop = vy(bar.volume);
    return `<rect class="volume-bar ${up ? 'up' : 'down'}" x="${(x(index) - bodyWidth / 2).toFixed(1)}" y="${barTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${Math.max(0.5, volBottom - barTop).toFixed(1)}"/>`;
  }).join('');

  const marks = [];
  bars.forEach((bar, index) => {
    const trade = tradeByDate.get(bar.date);
    if (!trade) return;
    const cx = x(index);
    if (trade.side === 'buy') {
      const anchor = Math.min(y(bar.low) + 9, priceBottom - 4);
      marks.push(`<g class="chart-buy"><path d="M${cx.toFixed(1)},${(anchor - 10).toFixed(1)} l5,10 h-10 z"/></g>`);
    } else {
      const anchor = Math.max(y(bar.high) - 9, top + 4);
      marks.push(`<g class="chart-sell"><path d="M${cx.toFixed(1)},${(anchor + 10).toFixed(1)} l5,-10 h-10 z"/></g>`);
    }
  });

  const dateLabels = [0, Math.floor(bars.length / 2), bars.length - 1].map((index, position) =>
    `<text class="chart-tick" x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="${position === 0 ? 'start' : position === 2 ? 'end' : 'middle'}">${bars[index].date}</text>`
  ).join('');

  let previousClose = null;
  const points = bars.map((bar, index) => {
    const change = previousClose ? bar.close / previousClose - 1 : null;
    previousClose = bar.close;
    return {
      date: bar.date, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      volume: bar.volume, change, trade: tradeByDate.get(bar.date) ?? null, x: x(index),
    };
  });
  const chartData = { width, left, right, top, volTop, volBottom, slot, points };

  return `<div class="kline-chart" data-kline-chart>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="最近 310 个交易日的 K 线与买卖点">
      ${priceGrid}
      <line class="chart-grid" x1="${left}" x2="${width - right}" y1="${volTop.toFixed(1)}" y2="${volTop.toFixed(1)}"/>
      <text class="chart-tick" x="${left - 8}" y="${(volTop + 4).toFixed(1)}" text-anchor="end">成交量</text>
      ${candles}${volumes}${marks}
      <g data-kline-hover visibility="hidden"><rect class="kline-hover-band" x="0" y="${top}" width="${slot.toFixed(2)}" height="${volBottom - top}"/><line class="chart-hover-line" x1="0" x2="0" y1="${top}" y2="${volBottom}"/></g>
      <rect data-kline-hit x="${left}" y="${top}" width="${width - left - right}" height="${volBottom - top}" fill="transparent" pointer-events="all"/>
      ${dateLabels}
    </svg>
    <div class="chart-tooltip" hidden></div>
    <script type="application/json" data-kline-data>${JSON.stringify(chartData).replaceAll('<', '\\u003c')}</script>
  </div>`;
}

function buildEquitySeries(rows, trades, position, initialCapital) {
  if (!rows.length) return [];
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const firstClose = rows[0].close;
  return rows.map((row) => {
    const active = sorted.find((trade) => row.date >= trade.entryDate && row.date <= trade.exitDate);
    let strategy;
    let holding = false;
    let trade = null;
    if (active) {
      strategy = row.date === active.exitDate
        ? active.currentCapital
        : active.capitalBefore * (row.close / active.entryPrice);
      holding = true;
      trade = { entryDate: active.entryDate, exitDate: active.exitDate, entryPrice: active.entryPrice, exitPrice: active.exitPrice, netReturn: active.netReturn, reason: active.reason };
    } else if (position && row.date >= position.entryDate) {
      strategy = row.date === position.latestDate
        ? position.equity
        : position.capitalBefore * (row.close / position.entryPrice);
      holding = true;
    } else {
      let cash = initialCapital;
      for (const item of sorted) {
        if (item.exitDate < row.date) cash = item.currentCapital;
        else break;
      }
      strategy = cash;
    }
    return {
      date: row.date,
      strategy,
      benchmark: initialCapital * (row.close / firstClose),
      holding,
      trade,
    };
  });
}

function equityChartSvg(series, meta = {}) {
  if (!series || series.length < 2) return '';
  const width = 1000;
  const height = 230;
  const left = 74;
  const right = 18;
  const top = 14;
  const bottom = 28;
  const values = series.flatMap((point) => [point.strategy, point.benchmark]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = Math.max((max - min) * 0.08, max * 0.004, 1);
  min = Math.max(0, min - pad);
  max += pad;
  const x = (index) => left + (index / Math.max(1, series.length - 1)) * (width - left - right);
  const y = (value) => height - bottom - ((value - min) / Math.max(1e-9, max - min)) * (height - top - bottom);
  const line = (key) => series.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  const ticks = [min, (min + max) / 2, max];
  const tickHtml = ticks.map((value) => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text class="chart-tick" x="${left - 8}" y="${(y(value) + 3).toFixed(1)}" text-anchor="end">${money.format(value)}</text>`).join('');
  const dateIndexes = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  const dateHtml = dateIndexes.map((index, position) => `<text class="chart-tick" x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="${position === 0 ? 'start' : position === 2 ? 'end' : 'middle'}">${series[index].date}</text>`).join('');
  const last = series.at(-1);
  const points = series.map((point, index) => ({
    date: point.date,
    strategy: point.strategy,
    benchmark: point.benchmark,
    holding: Boolean(point.holding),
    trade: point.trade ?? null,
    x: x(index),
    y: y(point.strategy),
    benchmarkY: y(point.benchmark),
  }));
  const chartData = { width, left, right, initialCapital: meta.initialCapital ?? series[0].strategy, range: meta.range ?? '', points };
  return `<div class="equity-chart" data-equity-chart>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="策略与买入持有资金曲线">
      ${tickHtml}
      <path class="chart-line benchmark" d="${line('benchmark')}"/>
      <path class="chart-line strategy" d="${line('strategy')}"/>
      <circle class="chart-line-dot strategy" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.strategy).toFixed(1)}" r="3"/>
      <circle class="chart-line-dot benchmark" cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.benchmark).toFixed(1)}" r="3"/>
      <g data-equity-hover visibility="hidden"><line class="chart-hover-line" x1="0" x2="0" y1="${top}" y2="${height - bottom}"/><circle class="chart-hover-dot strategy" r="3.5"/><circle class="chart-hover-dot benchmark" r="3.5"/></g>
      <rect data-equity-hit x="${left}" y="${top}" width="${width - left - right}" height="${height - top - bottom}" fill="transparent" pointer-events="all"/>
      ${dateHtml}
    </svg>
    <div class="chart-tooltip" hidden></div>
    <script type="application/json" data-equity-data>${JSON.stringify(chartData).replaceAll('<', '\\u003c')}</script>
  </div>`;
}

function bindEquityChart() {
  const container = document.querySelector('[data-equity-chart]');
  if (!container) return;
  const svg = container.querySelector('svg');
  const hit = container.querySelector('[data-equity-hit]');
  const tip = container.querySelector('.chart-tooltip');
  const hover = container.querySelector('[data-equity-hover]');
  const source = container.querySelector('[data-equity-data]');
  if (!svg || !hit || !tip || !hover || !source) return;
  const data = JSON.parse(source.textContent);
  const hide = () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); };
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !data.points.length) return;
    const px = (event.clientX - rect.left) / rect.width * data.width;
    const index = Math.round(Math.max(0, Math.min(1, (px - data.left) / (data.width - data.left - data.right))) * (data.points.length - 1));
    const point = data.points[index];
    hover.setAttribute('visibility', 'visible');
    const guide = hover.querySelector('line');
    guide.setAttribute('x1', point.x); guide.setAttribute('x2', point.x);
    const dots = hover.querySelectorAll('circle');
    dots[0].setAttribute('cx', point.x); dots[0].setAttribute('cy', point.y);
    dots[1].setAttribute('cx', point.x); dots[1].setAttribute('cy', point.benchmarkY);
    const strategyReturn = point.strategy / data.initialCapital - 1;
    const benchmarkReturn = point.benchmark / data.initialCapital - 1;
    const excess = point.strategy - point.benchmark;
    const excessPct = strategyReturn - benchmarkReturn;
    tip.innerHTML = `<div class="tip-date">${escapeHtml(point.date)}</div>
      <div class="tip-row"><span>策略资金</span><b>${money.format(point.strategy)}</b></div>
      <div class="tip-row"><span>买入持有</span><b>${money.format(point.benchmark)}</b></div>
      <div class="tip-row"><span>策略收益</span><b class="${strategyReturn >= 0 ? 'up' : 'down'}">${percent(strategyReturn)}</b></div>
      <div class="tip-row"><span>基准收益</span><b class="${benchmarkReturn >= 0 ? 'up' : 'down'}">${percent(benchmarkReturn)}</b></div>
      <div class="tip-row"><span>超额</span><b class="${excess >= 0 ? 'up' : 'down'}">${excess >= 0 ? '+' : ''}${money.format(excess)} / ${(excessPct * 100).toFixed(2)}pp</b></div>
      <div class="tip-row"><span>状态</span><b>${point.holding ? '持仓中' : '空仓'}</b></div>
      ${point.trade ? `<div class="tip-row"><span>本笔</span><b>${escapeHtml(point.trade.entryDate)} → ${escapeHtml(point.trade.exitDate)}</b></div>` : ''}`;
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
}

function bindKlineChart() {
  const container = document.querySelector('[data-kline-chart]');
  if (!container) return;
  const svg = container.querySelector('svg');
  const hit = container.querySelector('[data-kline-hit]');
  const tip = container.querySelector('.chart-tooltip');
  const hover = container.querySelector('[data-kline-hover]');
  const source = container.querySelector('[data-kline-data]');
  if (!svg || !hit || !tip || !hover || !source) return;
  const data = JSON.parse(source.textContent);
  const hide = () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); };
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !data.points.length) return;
    const px = ((event.clientX - rect.left) / rect.width) * data.width;
    const raw = Math.floor((px - data.left) / data.slot);
    const index = Math.max(0, Math.min(data.points.length - 1, raw));
    const point = data.points[index];
    hover.setAttribute('visibility', 'visible');
    hover.querySelector('line').setAttribute('x1', point.x);
    hover.querySelector('line').setAttribute('x2', point.x);
    hover.querySelector('rect').setAttribute('x', (point.x - data.slot / 2).toFixed(1));
    const change = Number.isFinite(point.change) ? point.change : null;
    const trendClass = change === null ? '' : change >= 0 ? 'up' : 'down';
    tip.innerHTML = `<div class="tip-date">${escapeHtml(point.date)}</div>
      <div class="tip-row"><span>开盘</span><b>${priceText(point.open)}</b></div>
      <div class="tip-row"><span>最高</span><b>${priceText(point.high)}</b></div>
      <div class="tip-row"><span>最低</span><b>${priceText(point.low)}</b></div>
      <div class="tip-row"><span>收盘</span><b>${priceText(point.close)}</b></div>
      <div class="tip-row"><span>涨跌</span><b class="${trendClass}">${change === null ? '—' : `${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}%`}</b></div>
      <div class="tip-row"><span>成交量</span><b>${point.volume ? `${(point.volume / 10000).toFixed(2)} 万手` : '—'}</b></div>
      ${point.trade ? `<div class="tip-row"><span>${point.trade.side === 'buy' ? '买入' : '卖出'}</span><b class="${point.trade.side === 'buy' ? 'up' : 'down'}">${priceText(point.trade.price)}</b></div>` : ''}`;
    tip.hidden = false;
    const box = container.getBoundingClientRect();
    let tipLeft = event.clientX - box.left + 14;
    if (tipLeft + tip.offsetWidth > box.width - 8) tipLeft = event.clientX - box.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(8, tipLeft)}px`;
    tip.style.top = `${Math.max(8, Math.min(event.clientY - box.top + 12, box.height - tip.offsetHeight - 8))}px`;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);
}

function renderLegacy() {
  const macdRows = calculateMacd(state.data);
  const trades = applyTradeCapital(backtest(macdRows), state.capital);
  const stats = summarize(trades);
  const annualRows = summarizeByYear(state.data, trades);
  const latest = state.data.at(-1);
  document.querySelector('#app').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#" aria-label="MACD 策略实验室首页"><span class="brand-mark">M</span><span>MACD <b>策略实验室</b></span></a>
      <div class="header-meta"><span class="status-dot"></span> 在线行情 <span class="market-badge">前复权日线</span></div>
    </header>
    <main>
      <section class="hero">
        <div>
          <div class="eyebrow">ETF STRATEGY BACKTEST</div>
          <h1>用红柱，读懂每一次<br><em>买入与离场</em></h1>
          <p>输入沪深 ETF 或 88 开头的指数代码，自动获取历史行情。MACD 柱由负转正时买入，由正转负时卖出。</p>
        </div>
        <div class="hero-note"><span>策略规则</span><strong>负柱转正 → 买入<br>正柱转负 → 卖出</strong><small>红柱缩短不卖 · 双边手续费 ${(state.feeRate * 100).toFixed(2)}%</small></div>
      </section>

      <form class="control-panel" id="backtestForm" aria-label="ETF / 指数回测参数">
        <label class="symbol-field"><span>ETF / 指数代码</span><div class="code-input"><i>${state.code.startsWith('88') ? 'IDX' : state.code.startsWith('5') || state.code.startsWith('6') ? 'SH' : 'SZ'}</i><input id="code" value="${state.code}" inputmode="numeric" maxlength="6" placeholder="如 512760 或 881121" autocomplete="off" /></div></label>
        <label><span>初始资金</span><div class="input-unit"><i>¥</i><input id="capital" type="number" min="1000" step="1000" value="${state.capital}" /></div></label>
        <label><span>MACD 参数</span><div class="macd-inputs"><input id="fast" type="number" value="${state.fast}" aria-label="快线周期"/><b>/</b><input id="slow" type="number" value="${state.slow}" aria-label="慢线周期"/><b>/</b><input id="signal" type="number" value="${state.signal}" aria-label="信号周期"/></div></label>
        <button id="runBtn" class="primary-btn" type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? '<span class="spinner"></span> 正在拉取' : '拉取并回测 <span>↗</span>'}</button>
      </form>

      ${state.error ? `<div class="error-banner" role="alert"><strong>未能获取行情</strong><span>${state.error}</span></div>` : ''}

      <div class="context-row"><div><strong>${state.symbol}</strong><span>${state.data[0]?.date ?? '—'} — ${latest?.date ?? '—'}</span></div><span class="data-source">${state.source}</span></div>

      <section class="metrics">
        <article><span>累计收益</span><strong class="${stats.totalReturn >= 0 ? 'positive' : 'negative'}">${percent(stats.totalReturn)}</strong><small>期末 ${money.format(stats.finalCapital)}</small></article>
        <article><span>胜率</span><strong>${(stats.winRate * 100).toFixed(1)}%</strong><small>${trades.filter((t) => t.profit > 0).length} 盈 / ${trades.filter((t) => t.profit <= 0).length} 亏</small></article>
        <article><span>盈亏比</span><strong>${stats.pnlRatio ? stats.pnlRatio.toFixed(2) : '—'}</strong><small>平均盈利 / 平均亏损</small></article>
        <article><span>最大回撤</span><strong class="negative">${percent(stats.maxDrawdown)}</strong><small>按逐笔权益计算</small></article>
        <article><span>交易次数</span><strong>${stats.count}</strong><small>已完成交易</small></article>
      </section>

      <section class="chart-card">
        <div class="section-heading"><div><span>价格走势</span><h2>近期信号概览</h2></div><div class="legend"><span><i class="dot buy"></i>买入</span><span><i class="dot sell"></i>卖出</span><span>最近 310 个交易日</span></div></div>
        <div class="chart">${chartSvg(macdRows, trades)}</div>
      </section>

      <section class="annual-card">
        <div class="section-heading"><div><span>ANNUAL RETURNS</span><h2>年度收益统计</h2></div><div class="annual-note">跨年持仓计入卖出年份</div></div>
        <div class="table-wrap">
          <table class="annual-table">
            <thead><tr><th>年份</th><th>行情区间</th><th>策略收益</th><th>标的涨跌</th><th>超额收益</th><th>交易次数</th><th>胜率</th><th>盈亏比</th></tr></thead>
            <tbody>${annualRows.map((year) => `<tr>
              <td><strong>${year.year}</strong></td><td>${year.range}</td>
              <td class="${year.strategyReturn >= 0 ? 'positive' : 'negative'}">${percent(year.strategyReturn)}</td>
              <td class="${year.etfReturn >= 0 ? 'positive' : 'negative'}">${percent(year.etfReturn)}</td>
              <td class="${year.excessReturn >= 0 ? 'positive' : 'negative'}">${percent(year.excessReturn)}</td>
              <td>${year.count}</td><td>${(year.winRate * 100).toFixed(1)}%</td><td>${year.pnlRatio === null ? '—' : year.pnlRatio.toFixed(2)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="table-note"><span>年度策略收益按当年已完成交易复利计算</span><span>首年与当前年份可能不是完整自然年</span></div>
      </section>

      <section class="trades-card">
        <div class="section-heading"><div><span>TRADE LEDGER</span><h2>逐笔交易明细</h2></div><button id="exportBtn" class="text-btn">导出结果 ↗</button></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>买入日期</th><th>卖出日期</th><th>买入价</th><th>卖出价</th><th>持有</th><th>净收益</th><th>收益金额</th><th>当前资金</th><th>R 倍数</th><th>离场原因</th></tr></thead>
            <tbody>${trades.slice().reverse().map((trade, index) => `<tr>
              <td>${String(trades.length - index).padStart(2, '0')}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td><td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays} 天</td>
              <td><span class="pill ${trade.netReturn >= 0 ? 'gain' : 'loss'}">${percent(trade.netReturn)}</span></td><td class="${trade.profit >= 0 ? 'positive' : 'negative'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td><strong>${money.format(trade.currentCapital)}</strong></td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="table-note"><span>R 倍数 = 单笔净收益率 ÷ 持有期最大不利波动</span><span>结果仅供策略研究，不构成投资建议</span></div>
      </section>
    </main>
    <footer>MACD LAB · 让策略保持透明</footer>
  `;
  bindEvents(trades);
}

function bindEventsLegacy(trades) {
  document.querySelector('#backtestForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.capital = Math.max(1000, Number(document.querySelector('#capital').value) || 100000);
    state.fast = Math.max(2, Number(document.querySelector('#fast').value) || 12);
    state.slow = Math.max(state.fast + 1, Number(document.querySelector('#slow').value) || 26);
    state.signal = Math.max(2, Number(document.querySelector('#signal').value) || 9);
    loadInstrumentData(document.querySelector('#code').value);
  });
  document.querySelector('#code').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
    const market = event.target.value.startsWith('5') || event.target.value.startsWith('6') ? 'SH' : 'SZ';
    event.target.previousElementSibling.textContent = market;
  });
  document.querySelector('#exportBtn').addEventListener('click', () => exportTrades(trades));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function withinPeriod(date) {
  return (!state.startDate || date >= state.startDate) && (!state.endDate || date <= state.endDate);
}

function renderLong() {
  const allMacdRows = calculateMacd(state.data);
  const filteredRows = allMacdRows.filter((row) => withinPeriod(row.date));
  const trades = applyTradeCapital(
    backtest(allMacdRows).filter((trade) => withinPeriod(trade.entryDate) && withinPeriod(trade.exitDate)),
    state.capital,
  );
  const stats = summarize(trades);
  const annualRows = summarizeByYear(filteredRows, trades);
  const historyRows = filteredRows.slice().reverse();
  const totalPages = Math.max(1, Math.ceil(historyRows.length / state.historyPageSize));
  state.historyPage = Math.min(Math.max(1, state.historyPage), totalPages);
  const pageStart = (state.historyPage - 1) * state.historyPageSize;
  const pageRows = historyRows.slice(pageStart, pageStart + state.historyPageSize);
  const indexByDate = new Map(allMacdRows.map((row, index) => [row.date, index]));
  const loadedStart = state.data[0]?.date ?? '—';
  const loadedEnd = state.data.at(-1)?.date ?? '—';

  document.querySelector('#app').innerHTML = `
    <header class="simple-header">
      <div><h1>ETF MACD 回测</h1><p>负柱转正买入，正柱转负卖出；红柱缩短不卖。</p></div>
      <span class="status">${state.loading ? '正在获取数据…' : '在线行情 · 前复权日线'}</span>
    </header>
    <main class="data-page">
      <section class="panel query-panel">
        <h2>查询条件</h2>
        <form id="backtestForm" class="query-form">
          <label><span>ETF / 指数代码</span><input id="code" value="${escapeHtml(state.code)}" inputmode="numeric" maxlength="6" placeholder="512760 或 881121" /></label>
          <label><span>开始日期</span><input id="startDate" type="date" value="${state.startDate}" min="${state.data[0]?.date ?? ''}" max="${state.data.at(-1)?.date ?? ''}" /></label>
          <label><span>结束日期</span><input id="endDate" type="date" value="${state.endDate}" min="${state.data[0]?.date ?? ''}" max="${state.data.at(-1)?.date ?? ''}" /></label>
          <label><span>初始资金</span><input id="capital" type="number" min="1000" step="1000" value="${state.capital}" /></label>
          <label><span>MACD 快/慢/信号</span><div class="triple-input"><input id="fast" type="number" value="${state.fast}" aria-label="快线周期"/><input id="slow" type="number" value="${state.slow}" aria-label="慢线周期"/><input id="signal" type="number" value="${state.signal}" aria-label="信号周期"/></div></label>
          <button type="submit" ${state.loading ? 'disabled' : ''}>${state.loading ? '正在查询…' : '查询并回测'}</button>
        </form>
        ${state.error ? `<div class="message error" role="alert">${escapeHtml(state.error)}</div>` : ''}
        <div class="source-line"><strong>${escapeHtml(state.symbol)}</strong><span>完整行情：${loadedStart} 至 ${loadedEnd}</span><span>${escapeHtml(state.source)}</span></div>
      </section>

      <section class="panel">
        <div class="section-title"><h2>最近查询</h2><span>持久化保存在挂载目录</span></div>
        <div class="table-wrap"><table class="compact-table">
          <thead><tr><th>ETF</th><th>查询区间</th><th>查询时间</th><th>操作</th></tr></thead>
          <tbody>${state.queryHistory.length ? state.queryHistory.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.start || '上市日'} 至 ${item.end || '最新'}</td><td>${escapeHtml(item.queriedAt)}</td><td><button class="link-button replay-query" data-code="${item.code}" data-start="${item.start || ''}" data-end="${item.end || ''}">重新查询</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">暂无查询记录</td></tr>'}</tbody>
        </table></div>
      </section>

      <section class="panel">
        <h2>回测汇总</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>统计区间</th><th>累计收益</th><th>期末资金</th><th>胜率</th><th>盈亏比</th><th>最大回撤</th><th>交易次数</th></tr></thead>
          <tbody><tr><td>${state.startDate || loadedStart} 至 ${state.endDate || loadedEnd}</td><td class="${stats.totalReturn >= 0 ? 'up' : 'down'}">${percent(stats.totalReturn)}</td><td>${money.format(stats.finalCapital)}</td><td>${(stats.winRate * 100).toFixed(1)}%</td><td>${stats.pnlRatio === null ? '—' : stats.pnlRatio.toFixed(2)}</td><td class="down">${percent(stats.maxDrawdown)}</td><td>${stats.count}</td></tr></tbody>
        </table></div>
      </section>

      <section class="panel">
        <div class="section-title"><h2>年度收益</h2><span>跨年交易计入卖出年份</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>年份</th><th>行情区间</th><th>策略收益</th><th>标的涨跌</th><th>超额收益</th><th>交易次数</th><th>胜率</th><th>盈亏比</th></tr></thead>
          <tbody>${annualRows.length ? annualRows.map((year) => `<tr><td><strong>${year.year}</strong></td><td>${year.range}</td><td class="${year.strategyReturn >= 0 ? 'up' : 'down'}">${percent(year.strategyReturn)}</td><td class="${year.etfReturn >= 0 ? 'up' : 'down'}">${percent(year.etfReturn)}</td><td class="${year.excessReturn >= 0 ? 'up' : 'down'}">${percent(year.excessReturn)}</td><td>${year.count}</td><td>${(year.winRate * 100).toFixed(1)}%</td><td>${year.pnlRatio === null ? '—' : year.pnlRatio.toFixed(2)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">暂无数据</td></tr>'}</tbody>
        </table></div>
      </section>

      <section class="panel">
        <div class="section-title"><h2>逐笔交易</h2><button id="exportBtn" class="secondary-button">导出交易 CSV</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>买入日期</th><th>卖出日期</th><th>买入价</th><th>卖出价</th><th>持有天数</th><th>净收益</th><th>收益金额</th><th>当前资金</th><th>R 倍数</th><th>离场原因</th></tr></thead>
          <tbody>${trades.length ? trades.slice().reverse().map((trade, index) => `<tr><td>${trades.length - index}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td><td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays}</td><td class="${trade.netReturn >= 0 ? 'up' : 'down'}">${percent(trade.netReturn)}</td><td class="${trade.profit >= 0 ? 'up' : 'down'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td><strong>${money.format(trade.currentCapital)}</strong></td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td></tr>`).join('') : '<tr><td colspan="11" class="empty">该区间没有已完成交易</td></tr>'}</tbody>
        </table></div>
      </section>

      <section class="panel">
        <div class="section-title"><div><h2>历史行情</h2><span>共 ${historyRows.length} 个交易日，每页 ${state.historyPageSize} 条</span></div><button id="exportHistoryBtn" class="secondary-button">导出历史 CSV</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>日期</th><th>收盘价</th><th>DIF</th><th>DEA</th><th>Histogram</th><th>信号</th></tr></thead>
          <tbody>${pageRows.length ? pageRows.map((row) => { const index = indexByDate.get(row.date); const previous = allMacdRows[index - 1]; const action = previous && previous.hist <= 0 && row.hist > 0 ? '买入' : previous && previous.hist >= 0 && row.hist < 0 ? '卖出' : ''; return `<tr><td>${row.date}</td><td>${row.close.toFixed(3)}</td><td>${row.dif.toFixed(4)}</td><td>${row.dea.toFixed(4)}</td><td class="${row.hist >= 0 ? 'up' : 'down'}">${row.hist.toFixed(4)}</td><td>${action}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">暂无历史行情</td></tr>'}</tbody>
        </table></div>
        <div class="pagination"><button id="prevPage" ${state.historyPage <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${state.historyPage} / ${totalPages} 页</span><button id="nextPage" ${state.historyPage >= totalPages ? 'disabled' : ''}>下一页</button></div>
      </section>
      <p class="disclaimer">结果仅供策略研究，不构成投资建议。</p>
    </main>`;

  bindEvents(trades, filteredRows);
}

function bindEventsLong(trades, filteredRows) {
  document.querySelector('#backtestForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.startDate = document.querySelector('#startDate').value;
    state.endDate = document.querySelector('#endDate').value;
    if (state.startDate && state.endDate && state.startDate > state.endDate) {
      state.error = '开始日期不能晚于结束日期';
      render();
      return;
    }
    state.capital = Math.max(1000, Number(document.querySelector('#capital').value) || 100000);
    state.fast = Math.max(2, Number(document.querySelector('#fast').value) || 12);
    state.slow = Math.max(state.fast + 1, Number(document.querySelector('#slow').value) || 26);
    state.signal = Math.max(2, Number(document.querySelector('#signal').value) || 9);
    state.historyPage = 1;
    loadInstrumentData(document.querySelector('#code').value);
  });
  document.querySelector('#code').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  document.querySelector('#exportBtn').addEventListener('click', () => exportTrades(trades));
  document.querySelector('#exportHistoryBtn').addEventListener('click', () => exportHistory(filteredRows));
  document.querySelector('#prevPage').addEventListener('click', () => { state.historyPage -= 1; render(); });
  document.querySelector('#nextPage').addEventListener('click', () => { state.historyPage += 1; render(); });
  document.querySelectorAll('.replay-query').forEach((button) => button.addEventListener('click', () => {
    state.startDate = button.dataset.start;
    state.endDate = button.dataset.end;
    state.historyPage = 1;
    loadInstrumentData(button.dataset.code);
  }));
}

const commonInstruments = [
  ['512760', '芯片ETF'],
  ['510300', '沪深300'],
  ['510500', '中证500'],
  ['159915', '创业板'],
  ['588000', '科创50'],
  ['512100', '中证1000'],
  ['512880', '证券'],
  ['512690', '酒'],
  ['159941', '纳指'],
  ['881121', '半导体指数'],
];

function render() {
  if (location.hash === '#dividend') return;
  document.title = 'ETF MACD 回测';
  const allMacdRows = calculateMacd(state.data);
  const filteredRows = allMacdRows.filter((row) => withinPeriod(row.date));
  const backtestRows = allMacdRows.filter(row => !state.endDate || row.date <= state.endDate);
  const result = runBacktestDetails(backtestRows, {
    ...state,
    latestQuote: state.latestQuote && (!state.endDate || state.latestQuote.date <= state.endDate) ? state.latestQuote : null,
  });
  let trades = applyTradeCapital(
    result.trades.filter((trade) => withinPeriod(trade.entryDate) && withinPeriod(trade.exitDate)),
    state.capital,
  );
  let stats = summarize(trades);
  let position = valueOpenPosition(result.openPosition && withinPeriod(result.openPosition.entryDate) ? result.openPosition : null, stats.finalCapital);
  const anchorFactor = anchorScale(state.anchorValue, position ? position.capitalBefore : stats.finalCapital);
  if (anchorFactor !== 1) {
    const view = scaleMoneyView({ trades, position, stats, capital: state.capital }, anchorFactor);
    trades = view.trades;
    stats = view.stats;
    position = view.position;
  }
  const displayCapital = state.capital * anchorFactor;
  const pendingEntry = result.pendingEntry && withinPeriod(result.pendingEntry.signalDate) ? result.pendingEntry : null;
  const annualRows = summarizeByYear(filteredRows, trades);
  const historyRows = filteredRows.slice().reverse();
  const totalPages = Math.max(1, Math.ceil(historyRows.length / state.historyPageSize));
  state.historyPage = Math.min(Math.max(1, state.historyPage), totalPages);
  const pageStart = (state.historyPage - 1) * state.historyPageSize;
  const pageRows = historyRows.slice(pageStart, pageStart + state.historyPageSize);
  const indexByDate = new Map(allMacdRows.map((row, index) => [row.date, index]));
  const loadedStart = state.data[0]?.date ?? '—';
  const loadedEnd = state.data.at(-1)?.date ?? '—';
  const recentCodes = state.queryHistory.filter((item, index, list) => list.findIndex((other) => other.code === item.code) === index).slice(0, 6);
  const equitySeries = buildEquitySeries(filteredRows, trades, position, displayCapital);
  const equityFinal = position ? position.equity : stats.finalCapital;
  const totalReturn = displayCapital > 0 ? equityFinal / displayCapital - 1 : stats.totalReturn;
  const benchmarkFinal = equitySeries.at(-1)?.benchmark ?? displayCapital;
  const equityRange = `${filteredRows[0]?.date ?? '—'} 至 ${filteredRows.at(-1)?.date ?? '—'}`;
  const positionStats = pricePositionMetrics(backtestRows);

  let tableTitle = '年度收益';
  let tableMeta = `${annualRows.length} 个年度`;
  let tableActions = '';
  let tableHtml = `<table><thead><tr><th>年份</th><th>行情区间</th><th>策略收益</th><th>标的涨跌</th><th>超额收益</th><th>交易次数</th><th>胜率</th><th>盈亏比</th></tr></thead><tbody>${annualRows.length ? annualRows.map((year) => `<tr><td><strong>${year.year}</strong></td><td>${year.range}</td><td class="${year.strategyReturn >= 0 ? 'up' : 'down'}">${percent(year.strategyReturn)}</td><td class="${year.etfReturn >= 0 ? 'up' : 'down'}">${percent(year.etfReturn)}</td><td class="${year.excessReturn >= 0 ? 'up' : 'down'}">${percent(year.excessReturn)}</td><td>${year.count}</td><td>${(year.winRate * 100).toFixed(1)}%</td><td>${year.pnlRatio === null ? '—' : year.pnlRatio.toFixed(2)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">暂无数据</td></tr>'}</tbody></table>`;
  let paginationHtml = '';

  if (state.activeTab === 'trades') {
    tableTitle = '逐笔交易';
    tableMeta = `${trades.length} 笔已完成交易${position ? ' · 1 笔持仓中（浮盈亏不计入已实现统计）' : ''}${pendingEntry ? ' · 买入待成交' : ''}`;
    tableActions = '<div><button id="refreshMarket" class="secondary-button">刷新成交量</button><button id="exportBtn" class="secondary-button">导出 CSV</button></div>';
    tableHtml = `<table><thead><tr><th>#</th><th>买入日期</th><th>卖出日期 / 状态</th><th>大 A 成交量 / 成交额<small>沪深合计 · 买入日 / 卖出日</small></th><th>买入价</th><th>卖出价 / 最新价</th><th>持有天数</th><th>净收益 / 浮动收益</th><th>收益金额 / 浮动金额</th><th>当前资金 / 持仓估值</th><th>R 倍数</th><th>离场原因 / 持仓状态</th></tr></thead><tbody>${position ? `<tr class="open-position-row"><td>${trades.length + 1}</td><td>${position.entryDate}</td><td><span class="position-badge">持仓中</span></td>${tradeMarketCell(position)}<td>${position.entryPrice.toFixed(3)}</td><td>${position.latestPrice.toFixed(3)}<small>${position.latestDate} 最新价</small></td><td>${position.holdingDays}</td><td class="${position.unrealizedReturn >= 0 ? 'up' : 'down'}">${percent(position.unrealizedReturn)}<small>浮动收益</small></td><td class="${position.unrealizedProfit >= 0 ? 'up' : 'down'}">${money.format(position.unrealizedProfit)}</td><td><strong>${money.format(position.equity)}</strong><small>未卖出估值</small></td><td>—</td><td>${position.reason}</td></tr>` : ''}${trades.length ? trades.slice().reverse().map((trade, index) => `<tr><td>${trades.length - index}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td>${tradeMarketCell(trade)}<td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays}</td><td class="${trade.netReturn >= 0 ? 'up' : 'down'}">${percent(trade.netReturn)}</td><td class="${trade.profit >= 0 ? 'up' : 'down'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td><strong>${money.format(trade.currentCapital)}</strong></td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td></tr>`).join('') : position ? '' : '<tr><td colspan="12" class="empty">该区间没有已完成交易</td></tr>'}</tbody></table>`;
  }

  if (state.activeTab === 'history') {
    tableTitle = '历史行情';
    tableMeta = `${historyRows.length} 个交易日`;
    tableActions = '<button id="exportHistoryBtn" class="secondary-button">导出 CSV</button>';
    tableHtml = `<table><thead><tr><th>日期</th><th>收盘价</th><th>DIF</th><th>DEA</th><th>Histogram</th><th>信号</th></tr></thead><tbody>${pageRows.length ? pageRows.map((row) => { const index = indexByDate.get(row.date); const previous = allMacdRows[index - 1]; const action = previous && previous.hist <= 0 && row.hist > 0 ? '买入' : previous && previous.hist >= 0 && row.hist < 0 ? '卖出' : ''; return `<tr><td>${row.date}</td><td>${row.close.toFixed(3)}</td><td>${row.dif.toFixed(4)}</td><td>${row.dea.toFixed(4)}</td><td class="${row.hist >= 0 ? 'up' : 'down'}">${row.hist.toFixed(4)}</td><td>${action}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">暂无历史行情</td></tr>'}</tbody></table>`;
    paginationHtml = `<div class="pagination"><button id="prevPage" ${state.historyPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.historyPage} / ${totalPages}</span><button id="nextPage" ${state.historyPage >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
  }

  if (state.activeTab === 'equity') {
    tableTitle = '策略收益曲线';
    tableMeta = `${equityRange} · 红=策略，蓝=买入持有`;
    tableActions = '';
    tableHtml = `<div class="equity-tab"><section class="chart-card"><div class="section-heading"><div><span>价格走势</span><h2>近期 K 线与买卖点</h2></div><div class="legend"><span><i class="dot buy"></i>买入</span><span><i class="dot sell"></i>卖出</span><span>最近 310 个交易日 · 悬停查看 OHLC 与成交量</span></div></div><div class="chart">${chartSvg(filteredRows, trades)}</div></section>${equityChartSvg(equitySeries, { initialCapital: displayCapital, strategyFinal: equityFinal, benchmarkFinal, range: equityRange })}<div class="equity-foot"><span>策略期末${position ? '（含当前持仓）' : '（已实现）'} <b>${money.format(equityFinal)}</b><i class="${totalReturn >= 0 ? 'up' : 'down'}">${percent(totalReturn)}</i></span><span>买入持有期末 <b>${money.format(benchmarkFinal)}</b></span>${position ? `<span>已实现 ${money.format(stats.finalCapital)} · 持仓浮盈 ${money.format(position.unrealizedProfit)}</span>` : ''}</div></div>`;
  }

  document.querySelector('#app').innerHTML = `
    <div class="app-shell">
      <aside class="etf-sidebar">
        <div class="sidebar-brand"><strong>ETF / 指数回测</strong><span>策略实验室</span></div>
        <div class="etf-group strategy-group">
          <h3>策略</h3>
          <a class="etf-item active" href="#" aria-current="page"><span>MACD 回测</span><b>零轴</b></a>
          <a class="etf-item" href="#dividend"><span>红利低波股息率</span><b>五档</b></a>
        </div>
        <div class="etf-group selector-group">
          <h3>回测标的</h3>
          <form id="selectorForm" class="selector-form"><input id="selectorCode" value="${escapeHtml(state.code)}" inputmode="numeric" maxlength="6" placeholder="输入 ETF / 指数代码"/><button type="submit" ${state.loading ? 'disabled' : ''}>查询</button></form>
        </div>
        <div class="notifier-card">
          <strong>${state.primaryCode} 微信通知</strong>
          <span>固定 MACD 12 / 26 / 9 · Server酱</span>
          <span>工作日 14:55 自动检查</span>
          ${state.primaryCode === state.code
            ? '<span class="primary-tag">当前标的就是主策略</span>'
            : `<button id="setPrimary" class="primary-button" type="button">把 ${state.code} 设为主策略</button>`}
        </div>
        <div class="etf-group"><h3>常用 ETF / 指数</h3>${commonInstruments.map(([code, name]) => `<button class="etf-item ${state.code === code ? 'active' : ''}" data-etf-code="${code}" data-start="" data-end=""><span>${name}</span><b>${code}</b></button>`).join('')}</div>
        <div class="etf-group recent-group"><h3>最近查询</h3>${state.storageError ? `<p class="sidebar-empty">${escapeHtml(state.storageError)}</p>` : ''}${recentCodes.length ? recentCodes.map((item) => `<button class="etf-item ${state.code === item.code ? 'active' : ''}" data-etf-code="${item.code}" data-start="${item.start || ''}" data-end="${item.end || ''}"><span>${escapeHtml(item.name.replace(item.code, '').trim() || '标的')}</span><b>${item.code}</b></button>`).join('') : '<p class="sidebar-empty">暂无记录</p>'}</div>
      </aside>

      <main class="workspace">
        <header class="workspace-header">
          <div><span class="code-label">${state.code}</span><h1>${escapeHtml(state.symbol.replace(state.code, '').trim() || '标的')}</h1><p>${loadedStart} 至 ${loadedEnd} · ${escapeHtml(state.source)}</p></div>
          <span class="load-state">${state.loading ? '正在加载全量历史…' : '数据已更新'}</span>
        </header>


        <form id="filterForm" class="filter-bar">
          <label><span>成交方式</span><select id="executionMode">${Object.entries(executionModes).map(([value, mode]) => `<option value="${value}" ${state.executionMode === value ? 'selected' : ''}>${mode.label}</option>`).join('')}</select></label>
          <label><span>开始</span><input id="startDate" type="date" value="${state.startDate}" /></label>
          <label><span>结束</span><input id="endDate" type="date" value="${state.endDate}" /></label>
          <label><span>起始资金</span><input id="capital" type="number" min="1000" step="1000" value="${state.capital}" /></label>
          <label title="填入这次买入实际投入的钱（不是今天的市值），页面所有金额按此折算到你的规模；收益率、回撤和买卖信号不变。留空则按起始资金原样显示。"><span>持仓本金</span><input id="anchorValue" type="number" min="0" step="1000" value="${state.anchorValue > 0 ? state.anchorValue : ''}" placeholder="选填，如 150000" /></label>
          <label><span>MACD</span><div class="triple-input"><input id="fast" type="number" value="${state.fast}"/><input id="slow" type="number" value="${state.slow}"/><input id="signal" type="number" value="${state.signal}"/></div></label>
          <button type="submit">应用条件</button>
        </form>
        <p class="execution-note">${executionModes[state.executionMode].note} 日期筛选按实际买卖日期，年度交易收益计入卖出年份。${state.anchorValue > 0 && anchorFactor !== 1 ? `<span class="anchor-note">金额按持仓本金 ${money.format(state.anchorValue)} 折算${position ? `（今天持仓 ${money.format(position.equity)}）` : ''}，等效起始资金 ${money.format(displayCapital)}，收益率与信号不变</span>` : ''}</p>
        ${state.error ? `<div class="workspace-error">${escapeHtml(state.error)}</div>` : ''}

        <div class="summary-grid">
          <div><span>总收益（含持仓）<i>已实现 ${percent(stats.totalReturn)}</i></span><strong class="${totalReturn >= 0 ? 'up' : 'down'}">${percent(totalReturn)}</strong></div>
          <div><span>胜率</span><strong>${(stats.winRate * 100).toFixed(1)}%</strong></div>
          <div><span>盈亏比</span><strong>${stats.pnlRatio === null ? '—' : stats.pnlRatio.toFixed(2)}</strong></div>
          <div><span>最大回撤</span><strong class="down">${percent(stats.maxDrawdown)}</strong></div>
          <div><span>交易次数</span><strong>${stats.count}</strong></div>
          <div title="按最新收盘价把当前持仓的市值一并算进来；卖出后这笔浮盈就变成已实现资金。"><span>当前总资金${position ? '（含持仓）' : ''}${position ? `<i>已实现 ${money.format(stats.finalCapital)}</i>` : ''}</span><strong>${money.format(equityFinal)}</strong></div>
        </div>
        ${positionStats ? `<section class="position-strip" title="分数越高，历史上该位置入场后的平均收益越高；只作为仓位参考，不改变 MACD 买卖信号。基于全部已加载历史。">
          <span class="position-strip-label">标的当前所处位置</span>
          <div class="position-strip-metrics">
            <div><span>3 年分位</span><b>${formatPct(positionStats.pct3)}</b></div>
            <div><span>5 年分位</span><b>${formatPct(positionStats.pct5)}</b></div>
            <div><span>全历史</span><b>${formatPct(positionStats.pctAll)}</b></div>
            <div><span>距 252 日高</span><b class="down">${formatPct(positionStats.drawdown)}</b></div>
            <div><span>相对 MA200</span><b class="${positionStats.ma200 >= 0 ? 'up' : 'down'}">${formatPct(positionStats.ma200)}</b></div>
            <div title="跌破 MA200≥10% 得 1 分，距高点≥30% 得 1 分"><span>深跌打分</span><b>${positionStats.score} / 2</b></div>
          </div>
          <span class="position-strip-note">截至 ${positionStats.date}</span>
        </section>` : ''}
        ${position ? `<div class="position-summary"><strong>当前持仓</strong><span>${position.entryDate} 买入 · 买入价 ${position.entryPrice.toFixed(3)}</span><span class="${position.unrealizedReturn >= 0 ? 'up' : 'down'}">浮动收益 ${percent(position.unrealizedReturn)}（${money.format(position.unrealizedProfit)}）</span><span>持仓估值 ${money.format(position.equity)} · 截至 ${position.latestDate}</span><small>仅扣买入手续费，未计卖出费；不计入已实现收益、胜率和年度交易收益。</small></div>` : ''}
        ${pendingEntry ? `<div class="position-summary">${pendingEntry.signalDate} 已出现买入信号，等待下一交易日开盘价，尚未买入。</div>` : ''}

        <div class="tab-bar" role="tablist">
          <button class="tab-button ${state.activeTab === 'annual' ? 'active' : ''}" data-tab="annual">年度收益</button>
          <button class="tab-button ${state.activeTab === 'trades' ? 'active' : ''}" data-tab="trades">逐笔交易</button>
          <button class="tab-button ${state.activeTab === 'history' ? 'active' : ''}" data-tab="history">历史行情</button>
          <button class="tab-button ${state.activeTab === 'equity' ? 'active' : ''}" data-tab="equity">收益曲线</button>
        </div>

        <section class="result-panel">
          <div class="result-heading"><div><h2>${tableTitle}</h2><span>${tableMeta}</span></div>${tableActions}</div>
          ${state.activeTab === 'trades' ? '<p id="marketHistoryStatus" class="market-history-note" aria-live="polite"></p>' : ''}
          <div class="result-table">${tableHtml}</div>
          ${paginationHtml}
        </section>
      </main>
    </div>`;

  bindEvents(trades, filteredRows, position);
  updateTradeMarket();
}

function bindEvents(trades, filteredRows, position) {
  document.querySelector('#executionMode').addEventListener('change', (event) => {
    state.executionMode = event.target.value;
    document.querySelector('#filterForm').requestSubmit();
  });
  document.querySelector('#selectorForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.startDate = '';
    state.endDate = '';
    state.historyPage = 1;
    loadInstrumentData(document.querySelector('#selectorCode').value);
  });
  document.querySelector('#selectorCode').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  document.querySelectorAll('.etf-item[data-etf-code]').forEach((button) => button.addEventListener('click', () => {
    state.startDate = button.dataset.start;
    state.endDate = button.dataset.end;
    state.historyPage = 1;
    loadInstrumentData(button.dataset.etfCode);
  }));
  document.querySelector('#filterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.startDate = document.querySelector('#startDate').value;
    state.endDate = document.querySelector('#endDate').value;
    if (state.startDate && state.endDate && state.startDate > state.endDate) { state.error = '开始日期不能晚于结束日期'; render(); return; }
    state.error = '';
    state.capital = Math.max(1000, Number(document.querySelector('#capital').value) || 100000);
    state.anchorValue = Math.max(0, Math.round(Number(document.querySelector('#anchorValue').value) || 0));
    try { localStorage.setItem('macd-anchor-value', String(state.anchorValue)); } catch { /* 浏览器禁用存储时忽略 */ }
    state.fast = Math.max(2, Number(document.querySelector('#fast').value) || 12);
    state.slow = Math.max(state.fast + 1, Number(document.querySelector('#slow').value) || 26);
    state.signal = Math.max(2, Number(document.querySelector('#signal').value) || 9);
    state.historyPage = 1;
    rememberQuery();
    render();
  });
  document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; render(); if (state.activeTab === 'trades' && Date.now() - state.marketLoadedAt > 60000) void loadMarketHistory(); }));
  document.querySelector('#exportBtn')?.addEventListener('click', () => exportTrades(trades, position));
  document.querySelector('#refreshMarket')?.addEventListener('click', loadMarketHistory);
  document.querySelector('#setPrimary')?.addEventListener('click', () => { void setPrimaryStrategy(); });
  document.querySelector('#exportHistoryBtn')?.addEventListener('click', () => exportHistory(filteredRows));
  document.querySelector('#prevPage')?.addEventListener('click', () => { state.historyPage -= 1; render(); });
  document.querySelector('#nextPage')?.addEventListener('click', () => { state.historyPage += 1; render(); });
  bindEquityChart();
  bindKlineChart();
}

async function loadInstrumentData(value) {
  let normalized;
  try {
    normalized = normalizeInstrumentCode(value);
  } catch (error) {
    state.error = error.message;
    render();
    return;
  }

  state.code = normalized.code;
  state.loading = true;
  state.data = [];
  state.latestQuote = null;
  state.error = '';
  state.source = normalized.kind === 'index' ? '正在获取指数日线行情…' : '正在获取前复权日线行情…';
  render();

  try {
    const result = await fetchInstrumentData(normalized, {
      onProgress(message) {
        state.source = message;
        const sourceLabel = document.querySelector('.load-state');
        if (sourceLabel) sourceLabel.textContent = message;
      }
    });
    state.data = result.rows;
    state.latestQuote = result.latestQuote ?? null;
    state.symbol = `${normalized.code} ${result.name}`;
    state.source = result.source;
    rememberQuery();
  } catch (error) {
    state.data = [];
    state.symbol = `${normalized.code} ${normalized.kind === 'index' ? '指数' : 'ETF'}`;
    state.source = '行情获取失败';
    state.error = `${error.message}。请稍后重试。`;
  } finally {
    state.loading = false;
    render();
  }
}

function exportTrades(trades, position) {
  const header = ['序号', '买入日期', '卖出日期', '买入价', '卖出价', '持有天数', '净收益率', '收益金额', '当前资金', 'R倍数', '离场原因', '成交方式', '买入信号日期', '卖出信号日期', '状态', '估值日期', '最新价', '浮动收益率', '浮动收益金额', '持仓估值', '买入日沪深成交量(亿股)', '买入日沪深成交额(亿元)', '卖出日沪深成交量(亿股)', '卖出日沪深成交额(亿元)', '买入日成交数据状态', '卖出日成交数据状态'];
  const rows = trades.map((trade, index) => [index + 1, trade.entryDate, trade.exitDate, trade.entryPrice, trade.exitPrice, trade.holdingDays, `${(trade.netReturn * 100).toFixed(2)}%`, trade.profit.toFixed(2), trade.currentCapital.toFixed(2), trade.rMultiple?.toFixed(2) ?? '', trade.reason, executionModes[state.executionMode].label, trade.entrySignalDate, trade.exitSignalDate]);
  rows.forEach(row => row.push('已卖出', '', '', '', '', ''));
  if (position) rows.push([trades.length + 1, position.entryDate, '', position.entryPrice, '', position.holdingDays, '', '', '', '', position.reason, executionModes[state.executionMode].label, position.entrySignalDate, position.exitSignalDate ?? '', '持仓中', position.latestDate, position.latestPrice, `${(position.unrealizedReturn * 100).toFixed(2)}%`, position.unrealizedProfit.toFixed(2), position.equity.toFixed(2)]);
  rows.forEach((row, index) => {
    const trade = trades[index] ?? position;
    row.push(...tradeMarketCsv(state.marketHistory, trade), marketDateStatus(trade.entryDate), marketDateStatus(trade.exitDate));
  });
  const csv = '\ufeff' + [header, ...rows].map((row) => row.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${state.symbol.replace(/\s/g, '_')}_MACD交易明细.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

function exportHistory(rows) {
  const csv = createHistoryCsv(rows);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${state.code}_历史行情.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

function rememberQuery() {
  const record = {
    code: state.code,
    name: state.symbol,
    start: state.startDate,
    end: state.endDate,
    queriedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
  state.queryHistory = [record, ...state.queryHistory.filter((item) => !(item.code === record.code && item.start === record.start && item.end === record.end))].slice(0, 8);
  try { localStorage.setItem('macd-query-history', JSON.stringify(state.queryHistory)); } catch { /* 浏览器禁用存储时忽略 */ }
  void persistQueryHistory();
}

function restoreAnchorValue() {
  try {
    state.anchorValue = Math.max(0, Math.round(Number(localStorage.getItem('macd-anchor-value')) || 0));
  } catch { /* 浏览器禁用存储时忽略 */ }
}

async function persistQueryHistory() {
  try {
    const response = await fetch('/api/query-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.queryHistory)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.storageError = '';
  } catch {
    state.storageError = '挂载目录写入失败，记录暂存在当前浏览器';
    render();
  }
}

async function restoreQueryHistory() {
  let localHistory = [];
  try {
    const saved = JSON.parse(localStorage.getItem('macd-query-history') || '[]');
    if (Array.isArray(saved)) localHistory = saved;
  } catch { /* 忽略损坏的浏览器本地记录 */ }

  try {
    const response = await fetch('/api/query-history', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const persisted = await response.json();
    state.queryHistory = Array.isArray(persisted) && persisted.length ? persisted : localHistory;
    if (!persisted.length && localHistory.length) await persistQueryHistory();
  } catch {
    state.queryHistory = localHistory;
  }
}

function marketDateStatus(date) {
  if (!date) return '';
  if (!state.marketHistory.has(date)) return '暂无数据';
  return date === state.marketPartialDate ? '盘中' : '日线';
}

function marketDateContent(date) {
  if (!date) return '—';
  const data = marketForDate(state.marketHistory, date);
  if (!data) return state.marketLoading ? '加载中…' : '—';
  return fmt.format(data.volume) + ' 亿股 / ' + fmt.format(data.turnover) + ' 亿元' + (date === state.marketPartialDate ? '（盘中）' : '');
}

function tradeMarketCell(trade) {
  return '<td class="trade-market"><div>买入日 <span data-market-date="' + trade.entryDate + '">' + marketDateContent(trade.entryDate) + '</span></div><div>卖出日 <span data-market-date="' + (trade.exitDate ?? '') + '">' + marketDateContent(trade.exitDate) + '</span></div></td>';
}

function updateTradeMarket() {
  document.querySelectorAll('[data-market-date]').forEach(element => {
    element.textContent = marketDateContent(element.dataset.marketDate);
  });
  const note = document.querySelector('#marketHistoryStatus');
  if (note) note.textContent = '按实际买入 / 卖出日期匹配当日沪深合计，不含北交所；成交量为亿股，成交额为亿元。缺失显示 —。' + (state.marketError ? ' ' + state.marketError : state.marketLoading ? ' 正在加载历史成交数据…' : ' 数据来源：东方财富。');
  const button = document.querySelector('#refreshMarket');
  if (button) { button.disabled = state.marketLoading; button.textContent = state.marketLoading ? '加载中…' : '刷新成交量'; }
}

async function loadMarketHistory() {
  if (state.marketLoading) return;
  state.marketLoading = true;
  state.marketError = '';
  updateTradeMarket();
  try {
    const response = await fetch('/api/market-history', { cache: 'no-store', signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('历史成交数据暂时不可用');
    const data = await response.json();
    if (!Array.isArray(data.rows)) throw new Error('历史成交数据格式错误');
    state.marketHistory = new Map(data.rows.map(row => [row.date, row]));
    state.marketPartialDate = data.partialDate;
    state.marketLoadedAt = Date.now();
  } catch {
    state.marketError = '历史成交数据加载失败，请点击“刷新成交量”重试。' + (state.marketHistory.size ? ' 已有数值为上次成功数据。' : '');
  } finally {
    state.marketLoading = false;
    updateTradeMarket();
  }
}

let macdBooted = false;

async function bootMacd() {
  if (!macdBooted) {
    macdBooted = true;
    restoreAnchorValue();
    await restoreStrategyConfig();
    await restoreQueryHistory();
    render();
    loadInstrumentData(state.primaryCode);
    void loadMarketHistory();
    return;
  }
  render();
}

// 主策略：页面默认打开的标的，也是每天 14:55 微信通知检查的标的。
async function restoreStrategyConfig() {
  try {
    const response = await fetch('/api/strategy-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    const code = String(config?.primaryCode ?? '');
    if (!/^\d{6}$/.test(code)) return;
    state.primaryCode = code;
    state.code = code;
    state.symbol = code;
  } catch {
    /* 接口不可用时保持默认标的 */
  }
}

async function setPrimaryStrategy() {
  try {
    const response = await fetch('/api/strategy-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ primaryCode: state.code })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    state.primaryCode = config.primaryCode;
    state.error = '';
    render();
  } catch {
    state.error = '主策略保存失败，请稍后重试';
    render();
  }
}

async function route() {
  if (location.hash === '#dividend') {
    await mountDividendPage();
    return;
  }
  await bootMacd();
}

window.addEventListener('hashchange', () => { void route(); });
await route();
