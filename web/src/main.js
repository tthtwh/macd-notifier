import './style.css';
import { fetchInstrumentData, normalizeInstrumentCode } from './market-data.js';

const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 0 });

const state = {
  code: '510300',
  symbol: '510300 沪深300ETF华泰柏瑞',
  fast: 12,
  slow: 26,
  signal: 9,
  capital: 100000,
  feeRate: 0.0003,
  data: [],
  source: '正在连接在线行情…',
  loading: false,
  error: '',
  startDate: '',
  endDate: '',
  historyPage: 1,
  historyPageSize: 100,
  queryHistory: [],
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
  const trades = [];
  let entry = null;
  for (let i = state.slow + state.signal; i < rows.length; i += 1) {
    const row = rows[i];
    const previous = rows[i - 1];
    const buySignal = !entry && row.hist > 0 && previous.hist <= 0;
    const sellSignal = entry && previous.hist >= 0 && row.hist < 0;
    if (buySignal) entry = { ...row, index: i };
    if (sellSignal) {
      const grossReturn = (row.close - entry.close) / entry.close;
      const netReturn = grossReturn - state.feeRate * 2;
      const slice = rows.slice(entry.index, i + 1);
      const low = Math.min(...slice.map((item) => item.close));
      const risk = Math.max(0, (entry.close - low) / entry.close);
      trades.push({
        entryDate: entry.date,
        exitDate: row.date,
        entryPrice: entry.close,
        exitPrice: row.close,
        holdingDays: i - entry.index,
        grossReturn,
        netReturn,
        profit: state.capital * netReturn,
        risk,
        rMultiple: risk > 0.00001 ? netReturn / risk : null,
        reason: '绿柱首次出现',
      });
      entry = null;
    }
  }
  return trades;
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

function chartSvg(rows, trades) {
  const sample = rows.slice(-310);
  if (!sample.length) return '';
  const width = 1000;
  const height = 230;
  const pad = 12;
  const min = Math.min(...sample.map((row) => row.close));
  const max = Math.max(...sample.map((row) => row.close));
  const x = (index) => pad + (index / Math.max(1, sample.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / Math.max(0.001, max - min)) * (height - pad * 2);
  const points = sample.map((row, index) => `${x(index).toFixed(1)},${y(row.close).toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${points} ${width - pad},${height - pad}`;
  const markers = trades.filter((trade) => trade.entryDate >= sample[0].date).map((trade) => {
    const buyIndex = sample.findIndex((row) => row.date === trade.entryDate);
    const sellIndex = sample.findIndex((row) => row.date === trade.exitDate);
    return `${buyIndex >= 0 ? `<circle cx="${x(buyIndex)}" cy="${y(trade.entryPrice)}" r="5" class="buy-dot"/>` : ''}${sellIndex >= 0 ? `<circle cx="${x(sellIndex)}" cy="${y(trade.exitPrice)}" r="5" class="sell-dot"/>` : ''}`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="最近310个交易日的收盘价曲线">
    <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#da4b37" stop-opacity=".25"/><stop offset="1" stop-color="#da4b37" stop-opacity="0"/></linearGradient></defs>
    <line x1="${pad}" y1="${height * .5}" x2="${width - pad}" y2="${height * .5}" class="grid-line"/>
    <polygon points="${area}" fill="url(#area)"/><polyline points="${points}" class="price-line"/>${markers}
  </svg>`;
}

function renderLegacy() {
  const macdRows = calculateMacd(state.data);
  const trades = backtest(macdRows);
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
        <label class="symbol-field"><span>ETF / 指数代码</span><div class="code-input"><i>${state.code.startsWith('88') ? 'IDX' : state.code.startsWith('5') || state.code.startsWith('6') ? 'SH' : 'SZ'}</i><input id="code" value="${state.code}" inputmode="numeric" maxlength="6" placeholder="如 510300 或 881121" autocomplete="off" /></div></label>
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
            <thead><tr><th>#</th><th>买入日期</th><th>卖出日期</th><th>买入价</th><th>卖出价</th><th>持有</th><th>净收益</th><th>收益金额</th><th>R 倍数</th><th>离场原因</th></tr></thead>
            <tbody>${trades.slice().reverse().map((trade, index) => `<tr>
              <td>${String(trades.length - index).padStart(2, '0')}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td><td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays} 天</td>
              <td><span class="pill ${trade.netReturn >= 0 ? 'gain' : 'loss'}">${percent(trade.netReturn)}</span></td><td class="${trade.profit >= 0 ? 'positive' : 'negative'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td>
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
  const trades = backtest(allMacdRows).filter((trade) => withinPeriod(trade.entryDate) && withinPeriod(trade.exitDate));
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
          <label><span>ETF / 指数代码</span><input id="code" value="${escapeHtml(state.code)}" inputmode="numeric" maxlength="6" placeholder="510300 或 881121" /></label>
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
        <div class="section-title"><h2>最近查询</h2><span>保存在当前浏览器</span></div>
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
          <thead><tr><th>#</th><th>买入日期</th><th>卖出日期</th><th>买入价</th><th>卖出价</th><th>持有天数</th><th>净收益</th><th>收益金额</th><th>R 倍数</th><th>离场原因</th></tr></thead>
          <tbody>${trades.length ? trades.slice().reverse().map((trade, index) => `<tr><td>${trades.length - index}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td><td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays}</td><td class="${trade.netReturn >= 0 ? 'up' : 'down'}">${percent(trade.netReturn)}</td><td class="${trade.profit >= 0 ? 'up' : 'down'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td></tr>`).join('') : '<tr><td colspan="10" class="empty">该区间没有已完成交易</td></tr>'}</tbody>
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
  const allMacdRows = calculateMacd(state.data);
  const filteredRows = allMacdRows.filter((row) => withinPeriod(row.date));
  const trades = backtest(allMacdRows).filter((trade) => withinPeriod(trade.entryDate) && withinPeriod(trade.exitDate));
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
  const recentCodes = state.queryHistory.filter((item, index, list) => list.findIndex((other) => other.code === item.code) === index).slice(0, 6);

  let tableTitle = '年度收益';
  let tableMeta = `${annualRows.length} 个年度`;
  let tableActions = '';
  let tableHtml = `<table><thead><tr><th>年份</th><th>行情区间</th><th>策略收益</th><th>标的涨跌</th><th>超额收益</th><th>交易次数</th><th>胜率</th><th>盈亏比</th></tr></thead><tbody>${annualRows.length ? annualRows.map((year) => `<tr><td><strong>${year.year}</strong></td><td>${year.range}</td><td class="${year.strategyReturn >= 0 ? 'up' : 'down'}">${percent(year.strategyReturn)}</td><td class="${year.etfReturn >= 0 ? 'up' : 'down'}">${percent(year.etfReturn)}</td><td class="${year.excessReturn >= 0 ? 'up' : 'down'}">${percent(year.excessReturn)}</td><td>${year.count}</td><td>${(year.winRate * 100).toFixed(1)}%</td><td>${year.pnlRatio === null ? '—' : year.pnlRatio.toFixed(2)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">暂无数据</td></tr>'}</tbody></table>`;
  let paginationHtml = '';

  if (state.activeTab === 'trades') {
    tableTitle = '逐笔交易';
    tableMeta = `${trades.length} 笔已完成交易`;
    tableActions = '<button id="exportBtn" class="secondary-button">导出 CSV</button>';
    tableHtml = `<table><thead><tr><th>#</th><th>买入日期</th><th>卖出日期</th><th>买入价</th><th>卖出价</th><th>持有天数</th><th>净收益</th><th>收益金额</th><th>R 倍数</th><th>离场原因</th></tr></thead><tbody>${trades.length ? trades.slice().reverse().map((trade, index) => `<tr><td>${trades.length - index}</td><td>${trade.entryDate}</td><td>${trade.exitDate}</td><td>${trade.entryPrice.toFixed(3)}</td><td>${trade.exitPrice.toFixed(3)}</td><td>${trade.holdingDays}</td><td class="${trade.netReturn >= 0 ? 'up' : 'down'}">${percent(trade.netReturn)}</td><td class="${trade.profit >= 0 ? 'up' : 'down'}">${trade.profit >= 0 ? '+' : ''}${money.format(trade.profit)}</td><td>${trade.rMultiple === null ? '—' : trade.rMultiple.toFixed(2)}</td><td>${trade.reason}</td></tr>`).join('') : '<tr><td colspan="10" class="empty">该区间没有已完成交易</td></tr>'}</tbody></table>`;
  }

  if (state.activeTab === 'history') {
    tableTitle = '历史行情';
    tableMeta = `${historyRows.length} 个交易日`;
    tableActions = '<button id="exportHistoryBtn" class="secondary-button">导出 CSV</button>';
    tableHtml = `<table><thead><tr><th>日期</th><th>收盘价</th><th>DIF</th><th>DEA</th><th>Histogram</th><th>信号</th></tr></thead><tbody>${pageRows.length ? pageRows.map((row) => { const index = indexByDate.get(row.date); const previous = allMacdRows[index - 1]; const action = previous && previous.hist <= 0 && row.hist > 0 ? '买入' : previous && previous.hist >= 0 && row.hist < 0 ? '卖出' : ''; return `<tr><td>${row.date}</td><td>${row.close.toFixed(3)}</td><td>${row.dif.toFixed(4)}</td><td>${row.dea.toFixed(4)}</td><td class="${row.hist >= 0 ? 'up' : 'down'}">${row.hist.toFixed(4)}</td><td>${action}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">暂无历史行情</td></tr>'}</tbody></table>`;
    paginationHtml = `<div class="pagination"><button id="prevPage" ${state.historyPage <= 1 ? 'disabled' : ''}>上一页</button><span>${state.historyPage} / ${totalPages}</span><button id="nextPage" ${state.historyPage >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
  }

  document.querySelector('#app').innerHTML = `
    <div class="app-shell">
      <aside class="etf-sidebar">
        <div class="sidebar-brand"><strong>ETF / 指数回测</strong><span>MACD 零轴策略</span></div>
        <form id="selectorForm" class="selector-form"><input id="selectorCode" value="${escapeHtml(state.code)}" inputmode="numeric" maxlength="6" placeholder="输入 ETF / 指数代码"/><button type="submit" ${state.loading ? 'disabled' : ''}>查询</button></form>
        <div class="notifier-card"><strong>512760 自动通知</strong><span>固定 MACD 12 / 26 / 9</span><span>工作日 14:55 · Server酱</span></div>
        <div class="etf-group"><h3>常用 ETF / 指数</h3>${commonInstruments.map(([code, name]) => `<button class="etf-item ${state.code === code ? 'active' : ''}" data-etf-code="${code}" data-start="" data-end=""><span>${name}</span><b>${code}</b></button>`).join('')}</div>
        <div class="etf-group recent-group"><h3>最近查询</h3>${recentCodes.length ? recentCodes.map((item) => `<button class="etf-item ${state.code === item.code ? 'active' : ''}" data-etf-code="${item.code}" data-start="${item.start || ''}" data-end="${item.end || ''}"><span>${escapeHtml(item.name.replace(item.code, '').trim() || '标的')}</span><b>${item.code}</b></button>`).join('') : '<p class="sidebar-empty">暂无记录</p>'}</div>
      </aside>

      <main class="workspace">
        <header class="workspace-header">
          <div><span class="code-label">${state.code}</span><h1>${escapeHtml(state.symbol.replace(state.code, '').trim() || '标的')}</h1><p>${loadedStart} 至 ${loadedEnd} · ${escapeHtml(state.source)}</p></div>
          <span class="load-state">${state.loading ? '正在加载全量历史…' : '数据已更新'}</span>
        </header>

        <form id="filterForm" class="filter-bar">
          <label><span>开始</span><input id="startDate" type="date" value="${state.startDate}" /></label>
          <label><span>结束</span><input id="endDate" type="date" value="${state.endDate}" /></label>
          <label><span>资金</span><input id="capital" type="number" min="1000" step="1000" value="${state.capital}" /></label>
          <label><span>MACD</span><div class="triple-input"><input id="fast" type="number" value="${state.fast}"/><input id="slow" type="number" value="${state.slow}"/><input id="signal" type="number" value="${state.signal}"/></div></label>
          <button type="submit">应用条件</button>
        </form>
        ${state.error ? `<div class="workspace-error">${escapeHtml(state.error)}</div>` : ''}

        <div class="summary-grid">
          <div><span>累计收益</span><strong class="${stats.totalReturn >= 0 ? 'up' : 'down'}">${percent(stats.totalReturn)}</strong></div>
          <div><span>胜率</span><strong>${(stats.winRate * 100).toFixed(1)}%</strong></div>
          <div><span>盈亏比</span><strong>${stats.pnlRatio === null ? '—' : stats.pnlRatio.toFixed(2)}</strong></div>
          <div><span>最大回撤</span><strong class="down">${percent(stats.maxDrawdown)}</strong></div>
          <div><span>交易次数</span><strong>${stats.count}</strong></div>
          <div><span>期末资金</span><strong>${money.format(stats.finalCapital)}</strong></div>
        </div>

        <div class="tab-bar" role="tablist">
          <button class="tab-button ${state.activeTab === 'annual' ? 'active' : ''}" data-tab="annual">年度收益</button>
          <button class="tab-button ${state.activeTab === 'trades' ? 'active' : ''}" data-tab="trades">逐笔交易</button>
          <button class="tab-button ${state.activeTab === 'history' ? 'active' : ''}" data-tab="history">历史行情</button>
        </div>

        <section class="result-panel">
          <div class="result-heading"><div><h2>${tableTitle}</h2><span>${tableMeta}</span></div>${tableActions}</div>
          <div class="result-table">${tableHtml}</div>
          ${paginationHtml}
        </section>
      </main>
    </div>`;

  bindEvents(trades, filteredRows);
}

function bindEvents(trades, filteredRows) {
  document.querySelector('#selectorForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.startDate = '';
    state.endDate = '';
    state.historyPage = 1;
    loadInstrumentData(document.querySelector('#selectorCode').value);
  });
  document.querySelector('#selectorCode').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  document.querySelectorAll('.etf-item').forEach((button) => button.addEventListener('click', () => {
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
    state.fast = Math.max(2, Number(document.querySelector('#fast').value) || 12);
    state.slow = Math.max(state.fast + 1, Number(document.querySelector('#slow').value) || 26);
    state.signal = Math.max(2, Number(document.querySelector('#signal').value) || 9);
    state.historyPage = 1;
    rememberQuery();
    render();
  });
  document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; render(); }));
  document.querySelector('#exportBtn')?.addEventListener('click', () => exportTrades(trades));
  document.querySelector('#exportHistoryBtn')?.addEventListener('click', () => exportHistory(filteredRows));
  document.querySelector('#prevPage')?.addEventListener('click', () => { state.historyPage -= 1; render(); });
  document.querySelector('#nextPage')?.addEventListener('click', () => { state.historyPage += 1; render(); });
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

function exportTrades(trades) {
  const header = ['序号', '买入日期', '卖出日期', '买入价', '卖出价', '持有天数', '净收益率', '收益金额', 'R倍数', '离场原因'];
  const rows = trades.map((trade, index) => [index + 1, trade.entryDate, trade.exitDate, trade.entryPrice, trade.exitPrice, trade.holdingDays, (trade.netReturn * 100).toFixed(2) + '%', trade.profit.toFixed(2), trade.rMultiple?.toFixed(2) ?? '', trade.reason]);
  const csv = '\ufeff' + [header, ...rows].map((row) => row.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${state.symbol.replace(/\s/g, '_')}_MACD交易明细.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

function exportHistory(rows) {
  const header = ['日期', '收盘价', 'DIF', 'DEA', 'Histogram'];
  const data = rows.map((row) => [row.date, row.close.toFixed(3), row.dif.toFixed(6), row.dea.toFixed(6), row.hist.toFixed(6)]);
  const csv = '\ufeff' + [header, ...data].map((row) => row.join(',')).join('\n');
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
}

try { state.queryHistory = JSON.parse(localStorage.getItem('macd-query-history') || '[]'); } catch { state.queryHistory = []; }
render();
loadInstrumentData(state.code);
