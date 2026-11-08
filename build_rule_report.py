# -*- coding: utf-8 -*-
"""生成规则对比报告（分年份 + 全部调仓记录），输出 markdown + csv。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
import analysis as A

FEE, SLIP, FUND = 0.0005, 0.0005, 0.002
START = pd.Timestamp('2010-06-01')
SCAN_START = pd.Timestamp('2010-05-01')  # 包含 2010-05-31 的信号，复现 CSV 首笔 2010-06-01 建仓
END = A.LAST
ETF_START = pd.Timestamp('2023-12-14')
OUT = Path('work/dividend-strategy')


def cascade(step, level, p):
    for _ in range(8):
        nxt = step(level, p)
        if nxt == level:
            return level
        level = nxt
    return level


def step_current(level, p):
    up = [0.60, 0.70, 0.80, 0.90]
    down = [0.40, 0.50, 0.60, 0.70]
    if not np.isfinite(p):
        return level
    if level == 0:
        return 25 if p >= up[0] else 0
    if level == 25:
        if p >= up[1]:
            return 50
        if p <= down[0]:
            return 0
        return 25
    if level == 50:
        if p >= up[2]:
            return 75
        if p <= down[1]:
            return 25
        return 50
    if level == 75:
        if p >= up[3]:
            return 100
        if p <= down[2]:
            return 50
        return 75
    if level == 100:
        return 75 if p <= down[3] else 100
    return level


def rule_binary9050(level, p):
    if not np.isfinite(p):
        return level
    if p >= 0.90:
        return 100
    if p <= 0.50:
        return 0
    return level


def step_clear50(level, p):
    """五档保留，只把清仓线从 40 改到 50。"""
    if not np.isfinite(p):
        return level
    if level == 0:
        return 25 if p >= 0.60 else 0
    if level == 25:
        if p >= 0.70:
            return 50
        if p <= 0.50:
            return 0
        return 25
    if level == 50:
        if p >= 0.80:
            return 75
        if p <= 0.50:
            return 0
        return 50
    if level == 75:
        if p >= 0.90:
            return 100
        if p <= 0.60:
            return 50
        return 75
    if level == 100:
        return 75 if p <= 0.70 else 100
    return level


def build(rule, start, init_level=0, use_cascade=True):
    level = init_level
    sigs = []
    for i in range(len(A.df)):
        d = A.df.index[i]
        if d < start:
            continue
        if not A.df['is_month_end'].iloc[i]:
            continue
        p = A.df['pct'].iloc[i]
        if not np.isfinite(p):
            continue
        target = cascade(rule, level, float(p)) if use_cascade else rule(level, float(p))
        if target != level:
            ei = i + 1
            if ei >= len(A.df):
                continue
            sigs.append({'signal_date': d, 'exec_date': A.df.index[ei], 'exec_i': ei,
                         'pct': float(p), 'dy': float(A.df['dy'].iloc[i]),
                         'from_level': int(level), 'to_level': int(target),
                         'target_pct': float(target), 'from_pct': float(level)})
            level = target
    return sigs


def pct_fmt(x):
    return f"{x*100:.1f}%"


def run(rule, use_cascade):
    sigs = build(rule, SCAN_START, use_cascade=use_cascade)
    daily, m = A.run_index(sigs, START, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=0)
    return sigs, daily, m


def rebalance_rows(sigs, daily, rule_name):
    rows = []
    prev_eq = 100000.0
    for s in sigs:
        d = daily.loc[s['exec_date']] if s['exec_date'] in daily.index else None
        eq = float(d['equity']) if d is not None else np.nan
        chg = eq - prev_eq
        rows.append({
            '信号日': s['signal_date'].strftime('%Y-%m-%d'),
            '执行日': s['exec_date'].strftime('%Y-%m-%d'),
            '股息率': f"{s['dy']*100:.2f}%",
            '10年分位': pct_fmt(s['pct']),
            '仓位变化': f"{s['from_level']}% → {s['to_level']}%",
            '权益(执行日日终)': f"{eq:,.0f}",
            '较上次变化': f"{chg:+,.0f}",
            '方向': '加仓' if s['to_level'] > s['from_level'] else '减仓',
        })
        prev_eq = eq
    return rows


def yearly_table(m1, m2):
    y1 = m1.get('yearly', {})
    y2 = m2.get('yearly', {})
    years = sorted(set(y1) | set(y2))
    rows = []
    for y in years:
        a = y1.get(y)
        b = y2.get(y)
        diff = (b - a) if (a is not None and b is not None) else None
        rows.append({
            '年份': str(y),
            '现行五档': f"{a*100:+.2f}%" if a is not None else '—',
            '90/50 全有全无': f"{b*100:+.2f}%" if b is not None else '—',
            '差值': f"{diff*100:+.2f}pp" if diff is not None else '—',
        })
    return rows


cur_sigs, cur_daily, cur_m = run(step_current, True)
bin_sigs, bin_daily, bin_m = run(rule_binary9050, False)


def run_period(rule, use_cascade, start, end):
    """在子区间内回测；起始仓位取该规则在开始日前一交易日的档位。"""
    full = build(rule, SCAN_START, use_cascade=use_cascade)
    lvl = 0
    for s in full:
        if s['signal_date'] <= start:
            lvl = s['to_level']
        else:
            break
    sigs = build(rule, start - pd.Timedelta(days=45), init_level=lvl, use_cascade=use_cascade)
    sigs = [s for s in sigs if s['exec_date'] >= start]
    daily, m = A.run_index(sigs, start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=lvl)
    return m


PERIODS = [
    ('2010-06 起（全样本）', pd.Timestamp('2010-06-01')),
    ('2016-10 起（近10年）', pd.Timestamp('2016-10-27')),
    ('2021-10 起（近5年）', pd.Timestamp('2021-10-27')),
]
period_rows = []
for label, start in PERIODS:
    mc = run_period(step_current, True, start, END)
    m50 = run_period(step_clear50, True, start, END)
    mb = run_period(rule_binary9050, False, start, END)
    bh, bhm = A.run_index([], start, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    period_rows.append({
        '区间': label,
        '现行五档': f"{mc['cagr']*100:.2f}%",
        '五档+50清仓': f"{m50['cagr']*100:.2f}%",
        '90/50 全有全无': f"{mb['cagr']*100:.2f}%",
        '买入持有': f"{bhm['cagr']*100:.2f}%",
    })

cur_rows = rebalance_rows(cur_sigs, cur_daily, '现行五档')
bin_rows = rebalance_rows(bin_sigs, bin_daily, '90/50')

# ETF 阶段
def etf_run(full_sigs, rule, use_cascade):
    lvl = 0
    for s in full_sigs:
        if s['signal_date'] <= ETF_START - pd.Timedelta(days=1):
            lvl = s['to_level']
        else:
            break
    sig = build(rule, ETF_START, init_level=lvl, use_cascade=use_cascade)
    daily, m = A.run_etf(sig, ETF_START, END, init_target=lvl)
    return sig, daily, m, lvl


cur_e_sig, cur_e_daily, cur_e_m, cur_lvl = etf_run(cur_sigs, step_current, True)
bin_e_sig, bin_e_daily, bin_e_m, bin_lvl = etf_run(bin_sigs, rule_binary9050, False)

cur_last = cur_e_daily.iloc[-1]
bin_last = bin_e_daily.iloc[-1]
cur_pos = cur_last['position_value'] / cur_last['equity'] * 100
bin_pos = bin_last['position_value'] / bin_last['equity'] * 100

def md_table(headers, rows):
    out = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join(['---'] * len(headers)) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(str(r.get(h, '')) for h in headers) + ' |')
    return '\n'.join(out)


def pos_pct(m):
    return f"{m['cash_time']*100:.1f}%"


lines = []
w = lines.append

w('# 红利低波仓位规则对比报告')
w('')
w(f"- 数据区间：{START.date()} → {END.date()}（指数全收益，管理费 0.2%/年，单边成本 5bp+5bp）")
w(f"- ETF 实盘区间：{ETF_START.date()} → {END.date()}（563020 不复权价 + 实际现金分红 + 100 份整数倍）")
w('- 生成时间：2026-10-30')
w('')
w('## 一、两套规则的定义')
w('')
w('### 现行五档（部署版本）')
w('')
w('| 当前仓位 | 加仓条件 | 减仓条件 |')
w('|---|---|---|')
w('| 0% | 分位 ≥ 60% → 25% | — |')
w('| 25% | 分位 ≥ 70% → 50% | 分位 ≤ 40% → 0% |')
w('| 50% | 分位 ≥ 80% → 75% | 分位 ≤ 50% → 25% |')
w('| 75% | 分位 ≥ 90% → 100% | 分位 ≤ 60% → 50% |')
w('| 100% | — | 分位 ≤ 70% → 75% |')
w('')
w('允许一次跨多档（级联）：100% + 分位 44.7% → 75% → 50% → 25%。')
w('')
w('### 90/50 全有全无')
w('')
w('| 条件 | 目标仓位 |')
w('|---|---|')
w('| 分位 ≥ 90% | 100% |')
w('| 分位 ≤ 50% | 0% |')
w('| 其余 | 不动 |')
w('')
w('## 二、全区间绩效（2010-06 → 2026-10）')
w('')
w(md_table(['指标', '现行五档', '90/50 全有全无'], [
    {'指标': '年化收益 CAGR', '现行五档': f"{cur_m['cagr']*100:.2f}%", '90/50 全有全无': f"{bin_m['cagr']*100:.2f}%"},
    {'指标': '最大回撤', '现行五档': f"{cur_m['maxdd']*100:.2f}%", '90/50 全有全无': f"{bin_m['maxdd']*100:.2f}%"},
    {'指标': 'Sharpe', '现行五档': f"{cur_m['sharpe']:.2f}", '90/50 全有全无': f"{bin_m['sharpe']:.2f}"},
    {'指标': 'Calmar', '现行五档': f"{cur_m['calmar']:.2f}", '90/50 全有全无': f"{bin_m['calmar']:.2f}"},
    {'指标': '最长回撤天数', '现行五档': f"{cur_m['dd_days']}", '90/50 全有全无': f"{bin_m['dd_days']}"},
    {'指标': '期末权益', '现行五档': f"{cur_m['final']:,.0f}", '90/50 全有全无': f"{bin_m['final']:,.0f}"},
    {'指标': '交易次数', '现行五档': f"{cur_m['trades']}", '90/50 全有全无': f"{bin_m['trades']}"},
    {'指标': '空仓时间占比', '现行五档': pos_pct(cur_m), '90/50 全有全无': pos_pct(bin_m)},
]))
w('')
w('### 不同起点的年化收益')
w('')
w(md_table(['区间', '现行五档', '五档+50清仓', '90/50 全有全无', '买入持有'], period_rows))
w('')
w('## 三、分年份收益对比')
w('')
w(md_table(['年份', '现行五档', '90/50 全有全无', '差值'], yearly_table(cur_m, bin_m)))
w('')
w('## 四、现行五档 · 全部调仓记录')
w('')
w(md_table(['信号日', '执行日', '股息率', '10年分位', '仓位变化', '权益(执行日日终)', '较上次变化'], cur_rows))
w('')
w('## 五、90/50 全有全无 · 全部调仓记录')
w('')
w(md_table(['信号日', '执行日', '股息率', '10年分位', '仓位变化', '权益(执行日日终)', '较上次变化'], bin_rows))
w('')
w('## 六、ETF 实盘阶段（2023-12 起）')
w('')
w(md_table(['指标', '现行五档', '90/50 全有全无'], [
    {'指标': '期初档位', '现行五档': f'{cur_lvl}%', '90/50 全有全无': f'{bin_lvl}%'},
    {'指标': '期末权益', '现行五档': f"{cur_e_m['final']:,.0f}", '90/50 全有全无': f"{bin_e_m['final']:,.0f}"},
    {'指标': 'CAGR', '现行五档': f"{cur_e_m['cagr']*100:.2f}%", '90/50 全有全无': f"{bin_e_m['cagr']*100:.2f}%"},
    {'指标': '最大回撤', '现行五档': f"{cur_e_m['maxdd']*100:.2f}%", '90/50 全有全无': f"{bin_e_m['maxdd']*100:.2f}%"},
    {'指标': '当前仓位', '现行五档': f'{cur_pos:.1f}%', '90/50 全有全无': f'{bin_pos:.1f}%'},
    {'指标': '当前现金', '现行五档': f"{cur_last['cash']:,.0f}", '90/50 全有全无': f"{bin_last['cash']:,.0f}"},
]))
w('')
w('## 七、结论')
w('')
w(f"1. 全样本（2010 起）里，90/50 全有全无收益更高：{bin_m['cagr']*100:.2f}% vs {cur_m['cagr']*100:.2f}%，回撤更小（{bin_m['maxdd']*100:.2f}% vs {cur_m['maxdd']*100:.2f}%），交易更少（{bin_m['trades']} vs {cur_m['trades']} 次），但空仓时间从 {cur_m['cash_time']*100:.1f}% 升到 {bin_m['cash_time']*100:.1f}%。")
w('2. 优势高度集中在 2015 年（+28.65pp，熊市前清仓）；2016 年后优势消失，2026 年反转为 -5.19pp（长期空仓错过反弹）。')
w('3. 近 10 年、近 5 年都是现行五档领先：10.51% vs 9.98%、10.33% vs 9.21%。')
w(f"4. ETF 实盘阶段现行规则领先：{cur_e_m['cagr']*100:.2f}% vs {bin_e_m['cagr']*100:.2f}%；90/50 规则自 2025-08 清仓后至今仍为空仓（{bin_pos:.1f}%），因为分位最高只到 88.7%，未触发 90% 的再入场。")
w('5. 「只把清仓线从 40 改到 50」差异很小且不稳定：全样本 -0.22pp、近 10 年 -0.09pp、近 5 年 +0.15pp，没有稳定优势。')
w('')
w('> 说明：本报告为历史回测，不构成投资建议。规则对样本区间高度敏感，结论随起止年份翻转；指数模拟部分含 5bp 滑点，与实盘流水存在小幅差异。')

text = '\n'.join(lines)
path = OUT / 'rule-comparison-report.md'
path.write_text(text, encoding='utf-8')

# CSV 附件
pd.DataFrame(cur_rows).to_csv(OUT / 'rule-current-rebalances.csv', index=False, encoding='utf-8-sig')
pd.DataFrame(bin_rows).to_csv(OUT / 'rule-9050-rebalances.csv', index=False, encoding='utf-8-sig')

print('written', path)
print('current', cur_m['cagr'], cur_m['maxdd'], cur_m['trades'], cur_m['final'])
print('binary ', bin_m['cagr'], bin_m['maxdd'], bin_m['trades'], bin_m['final'])
print('etf current', cur_e_m['cagr'], cur_e_m['final'], 'pos', cur_pos)
print('etf binary ', bin_e_m['cagr'], bin_e_m['final'], 'pos', bin_pos)
