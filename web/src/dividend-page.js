import { computeDividendSeries, runDividendBacktest } from './dividend-strategy.js';
import { fetchDividendBasket, fetchEtfRawDaily } from './dividend-data.js';
import { buildTradeReport } from './dividend-report.js';
import { renderDividendCharts, bindDividendCharts } from './dividend-charts.js';
import { calculateEtfDividendYield, calculateDividendYieldChange, getSignalSchedule } from './dividend-status.js';

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const feeMoney = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

const TABS = [
  ['overview', '图表总览'],
  ['yearly', '年度收益'],
  ['trades', '调仓明细'],
  ['dividends', '分红记录']
];

// 仅用于展示，与 dividend-strategy.js 的档位阈值保持一致；不参与回测计算。
const NEXT_UP = { 0: [0.60, 25], 25: [0.70, 50], 50: [0.80, 75], 75: [0.90, 100] };
const NEXT_DOWN = { 25: [0.40, 0], 50: [0.50, 25], 75: [0.60, 50], 100: [0.70, 75] };

const state = {
  basket: null,
  etf: null,
  series: null,
  capital: 100000,
  feePct: 0.05,
  startDate: '',
  endDate: '',
  tab: 'overview',
  loading: false,
  loaded: false,
  error: '',
  etfError: '',
  source: '',
  formError: '',
  ranges: { etf: 'all', index: 'all' },
  netScale: 'log'
};

export async function mountDividendPage() {
  document.title = '红利低波股息率策略';
  const requestedTab = new URLSearchParams(location.search).get('tab');
  if (TABS.some(([key]) => key === requestedTab)) state.tab = requestedTab;
  if (!state.loaded && !state.loading) {
    await loadAll();
    return;
  }
  render();
}

async function loadAll() {
  state.loading = true;
  state.error = '';
  state.etfError = '';
  render();
  try {
    const [basket, etf] = await Promise.all([
      fetchDividendBasket(),
      fetchEtfRawDaily('563020', {
        onProgress(message) { state.source = message; }
      }).catch((error) => {
        state.etfError = error.message;
        return { rows: [], name: '红利低波ETF易方达', source: '' };
      })
    ]);
    state.basket = basket;
    state.etf = etf;
    state.series = computeDividendSeries(basket.priceIndex, basket.totalReturnIndex);
    const firstReady = state.series.find((row) => Number.isFinite(row.percentile))?.date;
    const firstIndexDate = basket.priceIndex[0]?.date ?? '';
    const lastIndexDate = basket.priceIndex.at(-1)?.date ?? '';
    const lastEtfDate = etf.rows.at(-1)?.date ?? '';
    const lastDate = [lastIndexDate, lastEtfDate].filter(Boolean).sort().at(-1) ?? lastIndexDate;
    if (!state.startDate) state.startDate = firstReady || firstIndexDate;
    if (!state.endDate) state.endDate = lastDate;
    state.loaded = true;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function computeResult() {
  if (!state.basket || !state.series) return null;
  return runDividendBacktest({
    series: state.series,
    etfRows: state.etf?.rows ?? [],
    dividends: state.basket.dividends ?? [],
    initialCapital: state.capital,
    feeRate: state.feePct / 100,
    startDate: state.startDate,
    endDate: state.endDate
  });
}

function render() {
  if (location.hash !== '#dividend') return;
  const app = document.querySelector('#app');
  if (!app) return;
  const scrollTop = app.querySelector('.dividend-workspace')?.scrollTop ?? 0;

  let result = null;
  let computeError = '';
  try {
    result = computeResult();
  } catch (error) {
    computeError = error.message;
  }
  app.innerHTML = shell(result, computeError);
  bindEvents(result);
  const workspace = app.querySelector('.dividend-workspace');
  if (workspace) workspace.scrollTop = scrollTop;
}

function shell(result, computeError) {
  return `
    <div class="app-shell dividend-shell">
      ${sidebarHtml()}
      <main class="workspace dividend-workspace">
        ${headerHtml(result)}
        ${filterHtml()}
        <p class="execution-note">${executionNote(result)}</p>
        ${bannersHtml(result, computeError)}
        ${result ? resultBody(result) : loadingPanel()}
      </main>
    </div>`;
}

function sidebarHtml() {
  const priceLast = state.basket?.priceIndex.at(-1)?.date ?? '—';
  const etfLast = state.etf?.rows?.at(-1)?.date ?? '—';
  const dataState = state.loading
    ? '正在加载…'
    : state.basket?.stale
      ? '使用本地缓存'
      : state.loaded
        ? '实时数据已更新'
        : '尚未加载';
  return `
    <aside class="etf-sidebar">
      <div class="sidebar-brand"><strong>ETF / 指数回测</strong><span>策略实验室</span></div>
      <div class="etf-group strategy-group">
        <h3>策略</h3>
        <a class="etf-item" href="#"><span>MACD 回测</span><b>零轴</b></a>
        <a class="etf-item active" href="#dividend" aria-current="page"><span>红利低波股息率</span><b>五档</b></a>
      </div>
      <div class="etf-group">
        <h3>策略标的</h3>
        <div class="etf-item static active"><span>红利低波ETF易方达</span><b>563020</b></div>
        <div class="etf-item static"><span>中证红利低波动</span><b>H30269</b></div>
        <div class="etf-item static"><span>全收益指数</span><b>H20269</b></div>
      </div>
      <div class="notifier-card">
        <strong>数据状态</strong>
        <span>中证指数：${priceLast}</span>
        <span>563020：${etfLast}</span>
        <span>${dataState}</span>
      </div>
      <div class="notifier-card">
        <strong>策略规则</strong>
        <span>五档仓位 0 / 25 / 50 / 75 / 100%，按当前档位重复检查触发条件，允许一次跨多档。</span>
        <span>月末最后一个交易日收盘计算，下一交易日收盘执行。</span>
      </div>
    </aside>`;
}

function headerHtml(result) {
  const range = result
    ? `${result.startDate} 至 ${result.endDate}`
    : state.basket
      ? `${state.basket.priceIndex[0]?.date ?? '—'} 至 ${state.basket.priceIndex.at(-1)?.date ?? '—'}`
      : '正在加载…';
  const source = state.etfError
    ? '563020 行情不可用 · 仅 H20269 指数模拟'
    : '中证指数官网 + 腾讯不复权日线';
  const loadState = state.loading ? '正在加载全量历史…' : state.error ? '数据加载失败' : '数据已更新';
  return `
    <header class="workspace-header">
      <div><span class="code-label">563020</span><h1>红利低波ETF · 股息率分位择时策略</h1><p>${range} · ${source} · 初始 ${formatMoney(state.capital)} · 单边成本 ${state.feePct.toFixed(2)}%</p></div>
      <span class="load-state">${loadState}</span>
    </header>`;
}

function filterHtml() {
  const priceIndex = state.basket?.priceIndex ?? [];
  const minDate = priceIndex[0]?.date ?? '';
  const indexDate = priceIndex.at(-1)?.date ?? '—';
  const etfDate = state.etf?.rows?.at(-1)?.date ?? '—';
  const maxDate = [indexDate, etfDate].filter(Boolean).sort().at(-1) ?? '';
  return `
    <form id="dividendForm" class="filter-bar dividend-filter">
      <label><span>初始资金（元）</span><input id="divCapital" type="number" min="1000" step="1000" value="${state.capital}" /></label>
      <label><span>单边成本（%）</span><input id="divFee" type="number" min="0" max="2" step="0.01" value="${state.feePct}" /></label>
      <label><span>开始日期</span><input id="divStart" type="date" value="${state.startDate}" min="${minDate}" max="${maxDate}" /></label>
      <label><span>结束日期</span><input id="divEnd" type="date" value="${state.endDate}" min="${minDate}" max="${maxDate}" /></label>
      <button type="submit">应用条件</button>
      <button type="button" class="secondary-button" id="divRefresh" ${state.loading ? 'disabled' : ''}>${state.loading ? '刷新中…' : '刷新数据'}</button>
    </form>
    <p class="date-hint">日期上限＝最新已发布数据日：H30269/H20269 ${indexDate}，563020 ${etfDate}。指数数据通常 15:30–16:00 更新（H20269 全收益可能更晚）；如果今天只能选到 ${indexDate}，说明指数当天数据还没发布，服务端缓存最多 30 分钟。</p>`;
}

function executionNote(result) {
  const fee = result ? (result.feeRate * 100).toFixed(2) : state.feePct.toFixed(2);
  const simulated = result?.etfStart && result.startDate < result.etfStart
    ? ` ${result.etfStart} 之前为 H20269 全收益指数模拟，不是 563020 实际成交；全收益指数已含分红，不再叠加现金分红。`
    : '';
  const indexOnly = result && result.nav.length && result.nav.every((row) => row.phase === 'index');
  return `月末最后一个交易日收盘计算信号，下一交易日收盘执行；未触发则继续持有。单边成本 ${fee}%。${indexOnly ? ' 本区间为 H20269 全收益指数模拟，已含分红。' : simulated}`;
}

function bannersHtml(result, computeError) {
  const banners = [];
  if (state.formError) banners.push(`<div class="banner error" role="alert">${escapeHtml(state.formError)}；下方保留上一次有效回测。</div>`);
  if (computeError) banners.push(`<div class="banner error" role="alert">回测失败：${escapeHtml(computeError)}</div>`);
  if (state.error) banners.push(`<div class="banner error" role="alert">${escapeHtml(state.error)}<button type="button" id="divRetry" class="link-button">重试</button></div>`);
  if (state.basket?.stale) banners.push(`<div class="banner warn">${escapeHtml(state.basket.warning || '实时数据获取失败，当前使用缓存。')}</div>`);
  if (state.etfError) banners.push(`<div class="banner warn">563020 行情获取失败（${escapeHtml(state.etfError)}），当前展示 H20269 全收益指数模拟。</div>`);
  if (result?.pendingSignal) {
    banners.push(`<div class="banner info">${result.pendingSignal.signalDate} 月末信号：仓位 ${result.pendingSignal.fromLevel}% → ${result.pendingSignal.toLevel}%，等待下一交易日收盘执行。</div>`);
  }
  return banners.join('');
}

function resultBody(result) {
  return `${signalStatusCard(result, state.series)}${summaryGrid(result)}${tabsHtml()}${resultPanel(result)}`;
}

function yieldChangeBlock(series, latestDate) {
  const change = calculateDividendYieldChange({ series, asOf: latestDate });
  if (!change) return '';
  const { prevDate, date, prevYield, latestYield, prevPct, latestPct, newPoint, removedPoint,
    newEffect, removedEffect, priceEffect, total, priceChange, dominantSource } = change;
  const signed = (value, digits = 3) => {
    const rounded = Number(value.toFixed(digits));
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(digits)}`;
  };

  let reason;
  if (Math.abs(total) > 0.00005 && dominantSource) {
    const source = {
      new: [newEffect >= 0 ? '新增分红' : '当日反推股息点修正', newEffect],
      removed: ['历史分红移出窗口', removedEffect],
      price: [priceChange < 0 ? '价格下跌' : '价格上涨摊薄', priceEffect]
    }[dominantSource];
    reason = `股息率${total > 0 ? '上升' : '下降'}，主要影响来自${source[0]}：${signed(source[1] * 100)}pp。`;
  } else {
    reason = '股息率净变化较小，三项贡献见上方拆解。';
  }

  const pctText = Number.isFinite(prevPct) && Number.isFinite(latestPct)
    ? `10 年分位 ${(prevPct * 100).toFixed(1)}% → ${(latestPct * 100).toFixed(1)}%`
    : '';

  return `
    <div class="signal-yield-change">
      <div class="signal-yield-head">
        <span>今日股息率为什么变化</span>
        <b>${prevDate} → ${date}：${(prevYield * 100).toFixed(2)}% → ${(latestYield * 100).toFixed(2)}% <em>${signed(total * 100)}pp</em></b>
      </div>
      <div class="signal-yield-parts">
        <span class="signal-yield-part signal-yield-part--new">新增分红 <b>${newPoint.toFixed(2)}</b> 点 <em>${signed(newEffect * 100)}pp</em></span>
        <span class="signal-yield-part signal-yield-part--price">H30269 <b>${signed(priceChange * 100, 2)}%</b> <em>${signed(priceEffect * 100)}pp</em></span>
        <span class="signal-yield-part signal-yield-part--remove">移出窗口 <b>${removedPoint.toFixed(2)}</b> 点 <em>${signed(removedEffect * 100)}pp</em></span>
      </div>
      <p class="signal-yield-note">${reason} ${pctText ? `<span>${pctText}</span>` : ''}</p>
      <p class="signal-yield-note">股息率用 H30269/H20269 反推，不使用 563020 的 ETF 价格。</p>
    </div>`;
}

function signalStatusCard(result, series = []) {
  const latest = result.latest ?? {};
  const level = Number.isFinite(result.level) ? result.level : 0;
  const target = Number.isFinite(result.targetLevel) ? result.targetLevel : level;
  const dy = Number.isFinite(latest.dividendYield) ? `${(latest.dividendYield * 100).toFixed(2)}%` : '—';
  const pct = Number.isFinite(latest.percentile) ? `${(latest.percentile * 100).toFixed(1)}%` : '—';
  const latestDate = latest.date ?? result.endDate ?? '';
  const schedule = getSignalSchedule({ asOf: latestDate, tradingDates: (state.series ?? []).map(row => row.date) });
  const isCheckDay = schedule.isCheckDay === true;
  const hasSignal = Number.isFinite(latest.percentile);
  const confirmed = isCheckDay && hasSignal;
  const dateText = (date, estimated) => date ? `${estimated ? '预计 ' : ''}${date}` : '待交易日历确认';
  const checkText = dateText(schedule.checkDate, schedule.checkEstimated);
  const executionText = dateText(schedule.executionDate, schedule.executionEstimated);
  const nextCheckText = dateText(schedule.nextCheckDate, schedule.nextCheckEstimated);
  const historical = latestDate < (state.series?.at(-1)?.date ?? latestDate);
  const statusTitle = historical ? '区间末策略状态' : '当前策略状态';
  const etfDividend = calculateEtfDividendYield({
    dividends: state.basket?.dividends ?? [], etfRows: state.etf?.rows ?? [], asOf: latestDate
  });
  const etfYieldText = Number.isFinite(etfDividend.yield) ? `${(etfDividend.yield * 100).toFixed(2)}%` : '—';
  const etfPriceNote = etfDividend.priceDate && etfDividend.priceDate !== latestDate
    ? `（价格截至 ${etfDividend.priceDate}）` : '';

  const tone = target > level ? 'add' : target < level ? (target === 0 ? 'clear' : 'reduce') : 'hold';
  const holdWord = level === 0 ? '保持空仓' : '继续持有';
  const actionWord = target > level ? '加仓' : target < level ? (target === 0 ? '清仓' : '减仓') : holdWord;
  const action = target > level ? `加仓至 ${target}%`
    : target < level ? (target === 0 ? '清仓' : `减仓至 ${target}%`)
      : `${holdWord}，无须买卖`;
  const actionText = !hasSignal ? '样本不足，暂不产生信号' : confirmed || tone === 'hold' ? action : `参考${action}`;
  const badge = !hasSignal ? '样本不足' : tone === 'hold' ? holdWord : confirmed ? actionWord : `参考${actionWord}`;
  const actionNote = confirmed
    ? (tone === 'hold' ? `月末检查 ${latestDate} 收盘，未触发调仓` : `月末检查 ${latestDate} 收盘；${executionText} 收盘执行`)
    : `参考状态；以 ${checkText} 月末检查收盘结果为准`;
  const targetNote = confirmed
    ? '月末检查目标'
    : (target === level ? '参考目标与当前一致' : '参考目标，月末检查后确认');

  const up = NEXT_UP[level];
  const down = NEXT_DOWN[level];
  const upText = up ? `分位 ≥ ${(up[0] * 100).toFixed(0)}% → 加仓至 ${up[1]}%` : '已满仓，暂无加仓档';
  const downText = down ? `分位 ≤ ${(down[0] * 100).toFixed(0)}% → ${down[1] === 0 ? '清仓' : `减仓至 ${down[1]}%`}` : '已空仓，暂无减仓档';
  const downLine = down ? `${(down[0] * 100).toFixed(0)}%` : '无';
  const referencePill = confirmed
    ? '<span class="signal-ref signal-ref--confirmed">月末检查日</span>'
    : `<span class="signal-ref">${schedule.isCheckDay === false ? '非月末' : '月末待确认'} · 参考状态</span>`;
  const calendarNote = schedule.estimated ? ' · 预计日期按工作日推算，实际以交易日历为准' : '';
  const footer = confirmed
    ? `本次检查 <b>${latestDate}</b> 收盘${tone === 'hold' ? ' · 未触发调仓' : ` · 执行 <b>${executionText}</b> 收盘`} · 下次检查 <b>${nextCheckText}</b> 收盘${calendarNote}`
    : `下一次检查 <b>${checkText}</b> 收盘 · 触发后执行 <b>${executionText}</b> 收盘${calendarNote}`;

  return `
    <section class="signal-card signal-card--${tone}" aria-label="${statusTitle}">
      <div class="signal-head">
        <div class="signal-title">
          <h2>红利低波 · ${statusTitle}</h2>
          <span class="signal-date">${latestDate}</span>
        </div>
        <div class="signal-head-right">${referencePill}<span class="signal-badge">${badge}</span></div>
      </div>
      <div class="signal-grid">
        <div class="signal-metric signal-percentile">
          <span>截至数据日 10 年股息率分位</span>
          <strong>${pct}</strong>
          <small>${latestDate} · 指数股息率 ${dy}<br>563020 近一年现金分红率 ${etfYieldText}${etfPriceNote}</small>
        </div>
        <div class="signal-metric signal-position">
          <span>区间末仓位 → 目标仓位</span>
          <strong>${level}% <i>→</i> ${target}%</strong>
          <small>${targetNote}</small>
        </div>
        <div class="signal-metric signal-action">
          <span>操作建议</span>
          <strong>${escapeHtml(actionText)}</strong>
          <small>${escapeHtml(actionNote)}</small>
        </div>
      </div>
      <div class="signal-triggers">
        <div class="signal-trigger signal-trigger--add">
          <span>下一档加仓</span>
          <b>${upText}</b>
        </div>
        <div class="signal-trigger signal-trigger--reduce ${down && down[1] === 0 ? 'signal-trigger--clear' : ''}">
          <span>下一档减仓</span>
          <b>${downText}</b>
        </div>
      </div>
      ${yieldChangeBlock(series, latestDate)}
      <div class="signal-note">0.10 缓冲：阈值按档位相差 10 个百分点逐档取值；当前 ${level}% 档的减仓线是 ${downLine}，不是统一的 70%。允许连续触发跨档，这里列的是下一档。</div>
      <div class="signal-subnote">策略仓位为回测档位记录，实际市值仓位随价格漂移；563020 近一年现金分红率 = 近一年每份现金分红合计 ÷ 截至数据日最近收盘价。</div>
      <div class="signal-footer">${footer}</div>
    </section>`;
}

function summaryGrid(result) {
  const stats = result.stats;
  const benchmark = result.benchmark.stats;
  const count = result.trades.filter((trade) => trade.type === 'rebalance').length;
  return `
    <div class="summary-grid">
      <div><span>策略累计收益</span><strong class="${signClass(stats.totalReturn)}">${percent(stats.totalReturn)}</strong><small>期末 ${formatMoney(stats.finalEquity)}</small></div>
      <div><span>年化收益</span><strong class="${signClass(stats.annualizedReturn)}">${percent(stats.annualizedReturn)}</strong></div>
      <div><span>最大回撤</span><strong class="down">${percent(stats.maxDrawdown)}</strong></div>
      <div><span>买入持有（累计 / 年化）</span><strong>${percent(benchmark?.totalReturn)}</strong><small>年化 ${percent(benchmark?.annualizedReturn)}</small></div>
      <div><span>调仓买卖次数</span><strong>${count} 笔</strong><small>分红再投、上市切换另列</small></div>
      <div><span>区间末仓位</span><strong>${result.level}%</strong><small>${result.endDate}</small></div>
    </div>`;
}

function tabsHtml() {
  return `<div class="tab-bar" role="tablist">${TABS.map(([key, label]) => `<button class="tab-button ${state.tab === key ? 'active' : ''}" data-div-tab="${key}" role="tab" aria-selected="${state.tab === key}">${label}</button>`).join('')}</div>`;
}

function resultPanel(result) {
  const info = tabInfo(result);
  const actions = state.tab === 'overview'
    ? ''
    : '<button id="divExport" class="secondary-button">导出 CSV</button>';
  return `
    <section class="result-panel">
      <div class="result-heading">
        <div><h2>${info.title}</h2><span>${info.meta}</span></div>
        ${actions}
      </div>
      <div class="result-body">${tabContent(result)}</div>
    </section>`;
}

function tabInfo(result) {
  if (state.tab === 'yearly') return { title: '年度收益', meta: `${result.yearly.length} 个年度 · 跨年连续` };
  if (state.tab === 'trades') return { title: '调仓明细', meta: `${result.trades.length} 笔 · 上市前为指数模拟` };
  if (state.tab === 'dividends') return { title: '分红到账与再投资', meta: `${result.dividends.length} 次 · 除息计应收，到账后再投资` };
  return { title: '行情、仓位与策略表现', meta: '悬停查看行情与每日资金 · 各图可独立切换显示范围' };
}

function tabContent(result) {
  if (state.tab === 'yearly') return `<div class="table-wrap">${yearlyTable(result)}</div>`;
  if (state.tab === 'trades') return `<div class="table-wrap">${tradesTable(result)}</div>${tradeReportNote()}`;
  if (state.tab === 'dividends') return `<div class="table-wrap">${dividendsTable(result)}</div>`;
  return overviewContent(result);
}

function overviewContent(result) {
  const count = result.trades.filter((trade) => trade.type === 'rebalance').length;
  return `
    ${renderDividendCharts({ result, series: state.series, etfRows: state.etf?.rows ?? [], ranges: state.ranges, netScale: state.netScale })}
    <section class="dividend-report-card">
      <div class="result-heading"><div><h2>④ 全部 ${count} 笔调仓</h2><span>按执行日排列 · 上市前为指数模拟，之后为 ETF 历史价格回测</span></div><button id="divExportRebalances" class="secondary-button">导出调仓 CSV</button></div>
      <div class="table-wrap">${tradesTable(result, { onlyRebalances: true })}</div>
      ${tradeReportNote()}
    </section>
    <section class="dividend-report-card">
      <div class="result-heading"><div><h2>策略与持有基准对比</h2><span>按同一区间比较收益与回撤</span></div></div>
      <div class="table-wrap">${comparisonTable(result)}</div>
      <p class="overview-note">${result.etfStart ? 'ETF 阶段两行起点资金不同，期末资金不可直接比较。' : '本区间为 H20269 全收益指数模拟，已包含分红。'} ETF 买卖按 100 份整数倍，单边 ${(result.feeRate * 100).toFixed(2)}% 计费。</p>
    </section>
    <details class="result-notes">
      <summary>策略说明与数据口径</summary>
      <div class="notes-grid">${notesItems(result)}</div>
    </details>`;
}

function comparisonTable(result) {
  const comparison = result.comparison;
  if (!comparison) return '';
  const strategyEtf = comparison.strategyEtfPhase;
  const benchmarkEtf = comparison.etfBenchmark;
  const phaseStart = result.nav.find((row) => row.phase === 'etf')?.date;
  const hasIndex = result.nav.some((row) => row.phase === 'index');
  const benchmarkLabel = phaseStart ? (hasIndex ? '上市前指数模拟、上市后 ETF 历史价格' : '563020 历史价格，分红再投资') : 'H20269 全收益指数，已含分红';
  const etfRows = phaseStart
    ? `<tr><td><strong>同期策略</strong><small>${phaseStart} 起，以当日策略权益为起点</small></td><td class="${signClass(strategyEtf?.totalReturn)}">${percent(strategyEtf?.totalReturn ?? 0)}</td><td class="${signClass(strategyEtf?.annualizedReturn)}">${percent(strategyEtf?.annualizedReturn ?? 0)}</td><td class="down">${percent(strategyEtf?.maxDrawdown ?? 0)}</td><td>${formatMoney(strategyEtf?.finalEquity ?? 0)}</td></tr>
      <tr><td><strong>563020 买入持有</strong><small>${phaseStart} 起，分红再投资</small></td><td class="${signClass(benchmarkEtf?.totalReturn)}">${percent(benchmarkEtf?.totalReturn ?? 0)}</td><td class="${signClass(benchmarkEtf?.annualizedReturn)}">${percent(benchmarkEtf?.annualizedReturn ?? 0)}</td><td class="down">${percent(benchmarkEtf?.maxDrawdown ?? 0)}</td><td>${formatMoney(benchmarkEtf?.finalEquity ?? 0)}</td></tr>`
    : '';
  return `
    <table class="comparison-table">
      <thead><tr><th>区间 / 指标</th><th>累计收益</th><th>年化收益</th><th>最大回撤</th><th>期末资金</th></tr></thead>
      <tbody>
        <tr><td><strong>策略全程</strong><small>${result.startDate} 至 ${result.endDate}</small></td><td class="${signClass(comparison.strategy.totalReturn)}">${percent(comparison.strategy.totalReturn)}</td><td class="${signClass(comparison.strategy.annualizedReturn)}">${percent(comparison.strategy.annualizedReturn)}</td><td class="down">${percent(comparison.strategy.maxDrawdown)}</td><td>${formatMoney(comparison.strategy.finalEquity)}</td></tr>
        <tr><td><strong>全程持有基准</strong><small>${benchmarkLabel}</small></td><td class="${signClass(result.benchmark.stats?.totalReturn)}">${percent(result.benchmark.stats?.totalReturn ?? 0)}</td><td class="${signClass(result.benchmark.stats?.annualizedReturn)}">${percent(result.benchmark.stats?.annualizedReturn ?? 0)}</td><td class="down">${percent(result.benchmark.stats?.maxDrawdown ?? 0)}</td><td>${formatMoney(result.benchmark.stats?.finalEquity ?? 0)}</td></tr>
        ${etfRows}
      </tbody>
    </table>`;
}

function notesItems(result) {
  return `
    <div><h3>股息率与分位</h3><p>F = H20269 / H30269；股息点 = P × (F<sub>t</sub>/F<sub>t−1</sub> − 1)；股息率 = 过去 252 个交易日股息点之和 ÷ P<sub>t</sub>。历史分位取过去最多 2520 个交易日中 ≤ 当前股息率的比例，有效样本少于 756 个时不产生信号。</p></div>
    <div><h3>五档仓位</h3><p>0/25/50/75/100%。按当前档位重复检查触发条件，允许一次跨多档（例如 100% + 分位 0.447 → 25%）。每月最后一个交易日收盘计算，下一交易日收盘执行；未触发则继续持有。</p></div>
    <div><h3>563020 上市前</h3><p>${result.etfStart ? `${result.etfStart} 之前` : '无 ETF 行情时'}使用 H20269 全收益指数模拟，已含分红，不再叠加现金分红；该阶段为指数模拟，不是实际成交记录，也不适用 100 份整数倍。</p></div>
    <div><h3>563020 上市后</h3><p>使用不复权日线 + 天天基金现金分红记录：登记日持仓定权、除息日计应收、发放日转为现金、发放日后下一交易日按 100 份整数倍再投资。单边成本 ${(result.feeRate * 100).toFixed(2)}%。</p></div>
    <div><h3>数据源</h3><p>H30269 / H20269：中证指数官网日线；563020：腾讯行情不复权日线；分红：天天基金分红送配。页面缓存 30 分钟，网络失败时回退到上次成功的本地缓存。</p></div>
    <div><h3>回测口径</h3><p>初始资金 ${formatMoney(result.initialCapital)}；回测起点从 0% 仓位开始，之后按首个月末信号建仓。策略仓位按上次信号状态记录，实际资金仓位允许随价格自然漂移。${state.etfError ? '当前 563020 行情不可用，仅展示指数模拟结果。' : ''}</p></div>`;
}

function yearlyTable(result) {
  return `
    <table>
      <thead><tr><th>年份</th><th>区间</th><th>策略收益</th><th>指数 H20269</th><th>ETF 563020</th><th>超额收益</th><th>年末仓位</th><th>调仓次数</th></tr></thead>
      <tbody>${result.yearly.length ? result.yearly.map((row) => `<tr>
        <td><strong>${row.year}</strong></td>
        <td>${row.startDate.slice(5)} 至 ${row.endDate.slice(5)}</td>
        <td class="${signClass(row.strategyReturn)}">${percent(row.strategyReturn)}</td>
        <td class="${signClass(row.indexReturn)}">${row.indexReturn === null ? '—' : percent(row.indexReturn)}</td>
        <td class="${signClass(row.etfReturn)}">${row.etfReturn === null ? '—' : `${percent(row.etfReturn)}<small>${row.etfPartial ? `${row.etfStartDate.slice(5)} 起` : '分红再投资'}</small>`}</td>
        <td class="${signClass(row.excessReturn)}" title="策略收益 − 当年实际持有基准（2023-12-14 前为 H20269 指数，之后为 563020）">${row.excessReturn === null ? '—' : percent(row.excessReturn)}</td>
        <td>${row.endLevel ?? '—'}%</td>
        <td>${row.rebalances}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无年度数据</td></tr>'}</tbody>
    </table>
    <p class="overview-note">指数 H20269 为全收益指数买入持有（已含分红），全程可比；ETF 563020 为上市后真实价格买入持有并分红再投资，2023-12-14 前没有数据；超额收益对应当年实际持有基准，2023 年为「上市前指数 + 上市后 ETF」的拼接口径。</p>`;
}

function tradesTable(result, { onlyRebalances = false } = {}) {
  const report = buildTradeReport(result).filter((trade) => !onlyRebalances || trade.type === 'rebalance');
  const trades = onlyRebalances ? report : report.slice().reverse();
  return `
    <table class="dividend-trades-table ${onlyRebalances ? 'rebalance-table' : ''}">
      <thead><tr><th>执行日</th><th>信号日</th><th>仓位变化</th><th>股息率<small>信号日</small></th><th>10 年分位<small>信号日</small></th><th>调仓金额</th><th>账户权益<small>执行日日终 / 较上次调仓</small></th><th title="本次卖出净盈利 ÷ 本次卖出份额成本">本次卖出收益率</th><th>口径</th>${onlyRebalances ? '' : '<th>价格 / 数量</th><th>手续费</th><th>本次已实现金额</th><th>说明</th>'}</tr></thead>
      <tbody>${trades.length ? trades.map((trade) => `<tr>
        <td>${trade.date}<small>${tradeTypeLabel(trade)}</small></td>
        <td>${trade.signalDate ?? '—'}</td>
        <td class="${trade.side === 'buy' ? 'trade-add' : trade.side === 'sell' ? 'trade-reduce' : ''}">${trade.fromLevel === trade.toLevel ? `${trade.toLevel}%（不变）` : `${trade.fromLevel}% → ${trade.toLevel}%`}</td>
        <td>${Number.isFinite(trade.signalDividendYield) ? `${(trade.signalDividendYield * 100).toFixed(2)}%` : '—'}</td>
        <td>${Number.isFinite(trade.signalPercentile) ? trade.signalPercentile.toFixed(3) : '—'}</td>
        <td>${signedMoney(trade.signedAmount)}${onlyRebalances ? `<small>手续费 ${feeMoney.format(trade.fee)}</small>` : ''}</td>
        <td>${formatMoney(trade.equity)}${Number.isFinite(trade.equityChange) ? `<small>较上次调仓 ${signedMoney(trade.equityChange)}（${percent(trade.equityChangePct)}）</small>` : ''}</td>
        <td class="${signClass(trade.sellReturn)}">${percent(trade.sellReturn)}</td>
        <td><span class="phase-badge">${escapeHtml(trade.phaseLabel)}</span></td>
        ${onlyRebalances ? '' : `<td>${trade.phase === 'index' ? number.format(trade.price) : trade.price.toFixed(3)}<small>${number.format(trade.quantity)} ${trade.phase === 'index' ? '指数单位' : '份'}</small></td><td>${feeMoney.format(trade.fee)}</td><td class="${signClass(trade.profit)}">${trade.profit === null ? '—' : signedMoney(trade.profit)}</td><td class="reason-cell">${escapeHtml(trade.reason)}</td>`}
      </tr>`).join('') : `<tr><td colspan="${onlyRebalances ? 9 : 13}" class="empty">该区间没有交易</td></tr>`}</tbody>
    </table>`;
}

function signedMoney(value) {
  return Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value))}` : '—';
}

function tradeReportNote() {
  return '<p class="overview-note">调仓金额按持仓方向显示：买入为正、卖出为负，手续费另列。账户权益为执行日全部操作完成后的日终值；下方“较上次调仓”＝相对上一次调仓（不含分红再投、上市切换）的权益变化，用来回答“这一段一共赚了多少”。“本次卖出收益率”＝本次卖出净盈利 ÷ 本次卖出份额成本，含买卖费用；买入、再投不计算。ETF 现金分红在分红记录单列，不计入该比例；指数阶段价格已包含分红。</p>';
}

function dividendsTable(result) {
  return `
    <table>
      <thead><tr><th>登记日</th><th>除息日</th><th>发放日</th><th>每份分红</th><th>登记份额</th><th>金额</th><th>状态</th><th>再投资</th></tr></thead>
      <tbody>${result.dividends.length ? result.dividends.map((row) => `<tr>
        <td>${row.registerDate}</td>
        <td>${row.exDate}</td>
        <td>${row.payDate}</td>
        <td>${row.cashPerShare.toFixed(4)} 元</td>
        <td>${number.format(row.shares)} 份</td>
        <td>${formatMoney(row.amount)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${row.reinvestDate ? `${row.reinvestDate} 买入 ${number.format(row.reinvestShares)} 份 @ ${row.reinvestPrice.toFixed(3)}` : '—'}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty">该区间没有现金分红</td></tr>'}</tbody>
    </table>`;
}

function bindEvents(result) {
  document.querySelector('#dividendForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const startDate = document.querySelector('#divStart').value;
    const endDate = document.querySelector('#divEnd').value;
    if (startDate && endDate && startDate > endDate) {
      state.formError = '开始日期不能晚于结束日期';
      render();
      return;
    }
    state.formError = '';
    state.capital = Math.max(1000, Number(document.querySelector('#divCapital').value) || 100000);
    state.feePct = Math.min(2, Math.max(0, Number(document.querySelector('#divFee').value) || 0));
    state.startDate = startDate;
    state.endDate = endDate;
    render();
  });
  document.querySelector('#divRefresh')?.addEventListener('click', async () => {
    state.loaded = false;
    state.basket = null;
    state.series = null;
    await loadAll();
  });
  document.querySelector('#divRetry')?.addEventListener('click', loadAll);
  document.querySelectorAll('[data-div-tab]').forEach((button) => button.addEventListener('click', () => {
    state.tab = button.dataset.divTab;
    render();
  }));
  document.querySelector('#divExport')?.addEventListener('click', () => exportCurrentTab(result));
  document.querySelector('#divExportRebalances')?.addEventListener('click', () => exportTradeReport(result, true));
  document.querySelectorAll('[data-chart-range]').forEach((button) => button.addEventListener('click', () => {
    state.ranges[button.dataset.chartRange] = button.dataset.range;
    render();
  }));
  document.querySelectorAll('[data-net-scale]').forEach((button) => button.addEventListener('click', () => {
    state.netScale = button.dataset.netScale;
    render();
  }));
  bindDividendCharts(document.querySelector('.dividend-workspace'));

}

function exportCurrentTab(result) {
  if (!result) return;
  if (state.tab === 'yearly') {
    downloadCsv('红利低波_年度收益.csv',
      ['年份', '区间', '策略收益', '指数 H20269', 'ETF 563020', '当年基准', '超额收益', '年末仓位', '调仓次数'],
      result.yearly.map((row) => [row.year, `${row.startDate} 至 ${row.endDate}`, csvPercent(row.strategyReturn), csvPercent(row.indexReturn), csvPercent(row.etfReturn), `${csvPercent(row.benchmarkReturn)} ${row.benchmarkLabel}`, csvPercent(row.excessReturn), row.endLevel ?? '', row.rebalances]));
    return;
  }
  if (state.tab === 'trades') {
    exportTradeReport(result);
    return;
  }
  if (state.tab === 'dividends') {
    downloadCsv('红利低波_分红记录.csv',
      ['登记日', '除息日', '发放日', '每份分红', '登记份额', '金额', '状态', '再投资日', '再投资份额', '再投资价格'],
      result.dividends.map((row) => [row.registerDate, row.exDate, row.payDate, row.cashPerShare, row.shares, row.amount.toFixed(2), row.status, row.reinvestDate ?? '', row.reinvestShares ?? '', row.reinvestPrice ?? '']));
  }
}

function exportTradeReport(result, onlyRebalances = false) {
  if (!result) return;
  const rows = buildTradeReport(result).filter((trade) => !onlyRebalances || trade.type === 'rebalance');
  downloadCsv(onlyRebalances ? '红利低波_全部调仓.csv' : '红利低波_调仓明细.csv',
    ['执行日', '信号日', '类型', '原仓位%', '目标仓位%', '信号日股息率', '信号日10年分位', '调仓金额(买正卖负)', '执行日日终权益', '较上次调仓权益变化(元)', '较上次调仓权益变化(%)', '本次卖出收益率', '口径', '价格', '数量', '手续费', '本次已实现盈利金额', '说明'],
    rows.map((trade) => [trade.date, trade.signalDate ?? '', tradeTypeLabel(trade), trade.fromLevel, trade.toLevel, csvPercent(trade.signalDividendYield), trade.signalPercentile ?? '', trade.signedAmount?.toFixed(2) ?? '', trade.equity?.toFixed(2) ?? '', trade.equityChange?.toFixed(2) ?? '', csvPercent(trade.equityChangePct), csvPercent(trade.sellReturn), trade.phaseLabel, trade.price, trade.quantity, trade.fee.toFixed(2), trade.profit?.toFixed(2) ?? '', trade.reason]));
}

function downloadCsv(filename, header, rows) {
  const csv = '\ufeff' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '';
}

function loadingPanel() {
  if (state.loading) {
    return `<section class="result-panel"><div class="result-body loading-panel"><span class="spinner"></span><p>正在获取中证指数与 563020 行情…</p></div></section>`;
  }
  return `<section class="result-panel"><div class="result-body loading-panel"><p>${state.error ? '数据加载失败，请点击“刷新数据”重试。' : '暂无可展示的回测结果。'}</p></div></section>`;
}

function tradeTypeLabel(trade) {
  if (trade.type === 'convert') return '切换建仓';
  if (trade.type === 'reinvest') return '分红再投';
  return trade.side === 'buy' ? '调仓买入' : '调仓卖出';
}

function percent(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

function formatMoney(value) {
  return Number.isFinite(value) ? money.format(value) : '—';
}

function signClass(value) {
  if (!Number.isFinite(value)) return '';
  return value >= 0 ? 'up' : 'down';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
