# -*- coding: utf-8 -*-
"""把参数扫描结果整理成 markdown 报告。"""
from pathlib import Path

import pandas as pd

ROOT = Path('work/dividend-strategy')
sweep = pd.read_csv(ROOT / 'param-sweep-all.csv')
stab = pd.read_csv(ROOT / 'param-stability.csv')

BASE = '阶梯 W10y(2520) up0.60/0.70/0.80/0.90 down0.70/0.60/0.50/0.40'


def f(x):
    return f"{x*100:.2f}%"


def table(df, cols):
    head = '| ' + ' | '.join(cols) + ' |'
    sep = '|' + '|'.join(['---'] * len(cols)) + '|'
    out = [head, sep]
    for _, r in df.iterrows():
        out.append('| ' + ' | '.join(str(r[c]) for c in cols) + ' |')
    return '\n'.join(out)


def fmt_rows(df):
    d = df.copy()
    d['5y'] = d['5y_cagr'].map(f)
    d['10y'] = d['10y_cagr'].map(f)
    d['full'] = d['full_cagr'].map(f)
    d['5yDD'] = d['5y_mdd'].map(f)
    d['fullDD'] = d['full_mdd'].map(f)
    d['交易'] = d['full_trades'].astype(int)
    d['变体'] = d['变体'].str.replace('(2520)', '', regex=False).str.replace('(1890)', '', regex=False) \
                         .str.replace('(1260)', '', regex=False).str.replace('(3780)', '', regex=False) \
                         .str.replace('(756)', '', regex=False)
    return d


lines = []
w = lines.append

w('# 红利低波策略参数扫描报告')
w('')
w(f"- 参数空间：5 个分位窗口 × 46 组规则 = **230 个变体**")
w('- 分位窗口：3 年(756) / 5 年(1260) / 7.5 年(1890) / **10 年(2520)** / 15 年(3780) 交易日')
w('- 规则族：五档阶梯（25 组阈值）、全有全无（16 组买卖线）、静态五档（5 组边界）')
w('- 数据：H30269/H20269 指数全收益，管理费 0.2%/年，单边成本 5bp+5bp')
w(f"- 区间：5年 2021-10-27 起；10年 2016-10-27 起；全样本 2010-06-01 起；截止 {pd.Timestamp('2026-10-26').date()}")
w('')

w('## 一、近 5 年（2021-10 → 2026-10）收益前 15')
w('')
top5 = fmt_rows(sweep.sort_values('5y_cagr', ascending=False).head(15))
w(table(top5, ['变体', '5y', '10y', 'full', '5yDD', 'fullDD', '交易']))
w('')

w('## 二、近 10 年（2016-10 → 2026-10）收益前 12')
w('')
top10 = fmt_rows(sweep.sort_values('10y_cagr', ascending=False).head(12))
w(table(top10, ['变体', '10y', '5y', 'full', '5yDD', 'fullDD', '交易']))
w('')

w('## 三、全样本（2010-06 → 2026-10）收益前 12')
w('')
topf = fmt_rows(sweep.sort_values('full_cagr', ascending=False).head(12))
w(table(topf, ['变体', 'full', '10y', '5y', 'fullDD', '交易']))
w('')

w('## 四、三个区间都进前 25% 的变体')
w('')
q5 = sweep['5y_cagr'].quantile(0.75)
q10 = sweep['10y_cagr'].quantile(0.75)
qf = sweep['full_cagr'].quantile(0.75)
cons = sweep[(sweep['5y_cagr'] >= q5) & (sweep['10y_cagr'] >= q10) & (sweep['full_cagr'] >= qf)]
cons = cons.sort_values('full_cagr', ascending=False).head(12)
w(table(fmt_rows(cons), ['变体', '5y', '10y', 'full', '交易']))
w('')

w('## 五、稳健性：12 个滚动 5 年窗口')
w('')
w('每个窗口起点为 2010~2021 年的 1 月 1 日，各独立回测 5 年（起始仓位按规则历史档位）。')
w('')
st = stab.copy()
st['均值'] = st['滚动5年均值'].map(f)
st['最差'] = st['滚动5年最差'].map(f)
st['最好'] = st['滚动5年最好'].map(f)
st['标准差'] = st['滚动5年标准差'].map(lambda x: f"{x*100:.2f}pp")
st['跑赢持有'] = st['跑赢持有比例'].map(lambda x: '—' if pd.isna(x) else f"{x*100:.0f}%")
w(table(st, ['策略', '均值', '最差', '最好', '标准差', '跑赢持有']))
w('')

w('## 六、平台还是孤峰：全有全无 W10y 的相邻参数')
w('')
plateau = sweep[sweep['变体'].str.startswith('全有全无 W10y(2520)')].copy()
plateau = plateau[plateau['变体'].str.contains(r'buy0\.[89]|buy0\.85', regex=True)]
plateau['买线'] = plateau['变体'].str.extract(r'buy(0\.\d+)')[0]
plateau['卖线'] = plateau['变体'].str.extract(r'sell(0\.\d+)')[0]
plateau = plateau.sort_values(['买线', '卖线'])
p = fmt_rows(plateau)
p['买/卖'] = plateau['买线'].values + ' / ' + plateau['卖线'].values
w(table(p, ['买/卖', '5y', '10y', 'full', 'fullDD', '交易']))
w('')
w('相邻参数表现接近说明是「平台」，可迁移性较好；只有单点突出、邻居明显变差的是「孤峰」，多为过拟合。')
w('')

base_row = sweep[sweep['变体'] == BASE].iloc[0]
w('## 七、结论')
w('')
w(f"**基准（当前部署的五档）**：近5年 {f(base_row['5y_cagr'])}、近10年 {f(base_row['10y_cagr'])}、全样本 {f(base_row['full_cagr'])}，全样本交易 {int(base_row['full_trades'])} 次。")
w('')
w('1. **近 5 年最强的参数集中在「全有全无 + 买线 0.80~0.85」**，而不是你记忆中的 0.90。买线 0.90 在 2026 年因分位最高只到 88.7% 而长期空仓，5 年只有 9.21%。')
w('2. **买线 0.80~0.85 / 卖线 0.45~0.55（10 年窗口）是一整片平台**：全样本 12.3%~13.0%、近10年 10.9%~11.3%、近5年 11.8%，相邻参数几乎同分，不是孤峰。')
w('3. **三个区间同时进前 25% 的几乎都是全有全无**（买 0.80~0.85、卖 0.40~0.55），外加两组阶梯变体；当前五档不在其中。')
w('4. **滚动 5 年稳定性**：所有候选都跑赢买入持有 75%~83% 的窗口；当前五档标准差最小（约 4.1pp）、跑赢比例最高（83%），但均值最低（13.4%）。全有全无买 0.85 卖 0.50 均值 14.1%、最差 7.6pp、标准差 4.7pp。')
w('5. **缩短分位窗口（3 年 / 5 年）没有稳定优势**：更短的窗口让分位更躁动，5 年窗口里只有个别组合靠前，但 10 年窗口整体更稳。')
w('')
w('**建议（如果目标是「稳定 + 收益」）**：把规则从「五档阶梯」换成「全有全无，买 0.85 / 卖 0.50，10 年窗口」。理由：三个区间全面优于现行五档（11.83% / 11.30% / 12.99% vs 10.33% / 10.51% / 11.98%），交易次数 9 次 vs 26 次，且在参数平台上不孤立。')
w('')
w('## 八、风险提示')
w('')
w('- 「近 5 年」只有一个 regime，5 年窗口内的最优参数很容易过拟合；本报告主要依据「三区间同时靠前 + 相邻参数平台 + 滚动窗口」三重检验。')
w('- 全有全无意味着 0% 或 100% 的仓位跳变，单次判断错误的代价远大于五档；实际执行还要考虑税费、滑点和心理承受。')
w('- 结果基于指数全收益模拟，不含 ETF 折溢价、分红再投时点差异。')
w('')
w('> 历史回测不构成投资建议。')

path = ROOT / 'param-sweep-report.md'
path.write_text('\n'.join(lines), encoding='utf-8')
print('written', path)
print('baseline', BASE, f(base_row['5y_cagr']), f(base_row['10y_cagr']), f(base_row['full_cagr']))
