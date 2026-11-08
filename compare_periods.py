# -*- coding: utf-8 -*-
"""多区间对比：现行规则 vs 50 分位清仓 vs 全有全无 vs 静态五档。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
import analysis as A

FEE, SLIP, FUND = 0.0005, 0.0005, 0.002
END = A.LAST


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


def step_clear50(level, p):
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


def rule_binary9050(level, p):
    if not np.isfinite(p):
        return level
    if p >= 0.90:
        return 100
    if p <= 0.50:
        return 0
    return level


def band_rule(edges, levels):
    def rule(level, p):
        if not np.isfinite(p):
            return level
        for i, e in enumerate(edges):
            if p < e:
                return levels[i]
        return levels[-1]
    return rule


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
            sigs.append({
                'signal_date': d, 'exec_date': A.df.index[ei], 'exec_i': ei,
                'pct': float(p), 'dy': float(A.df['dy'].iloc[i]),
                'from_level': int(level), 'to_level': int(target),
                'target_pct': float(target), 'from_pct': float(level),
            })
            level = target
    return sigs


def evaluate(name, sigs, start, end, init_target=0):
    daily, m = A.run_index(sigs, start, end, fee=FEE, slip=SLIP, fund_fee=FUND,
                           init_target=init_target)
    return {'name': name, 'cagr': m['cagr'], 'maxdd': m['maxdd'], 'sharpe': m['sharpe'],
            'calmar': m['calmar'], 'final': m['final'], 'trades': m['trades']}


RULES = {
    '现行(减仓70/60/50/40)': (step_current, True),
    '50分位清仓': (step_clear50, True),
    '90满/50清(全有全无)': (rule_binary9050, False),
    '静态50/60/70/80': (band_rule([0.50, 0.60, 0.70, 0.80], [0, 25, 50, 75, 100]), False),
    '静态50/60/70/90': (band_rule([0.50, 0.60, 0.70, 0.90], [0, 25, 50, 75, 100]), False),
}

PERIODS = [
    ('2008-01-02 ~ 2026-10-26', pd.Timestamp('2008-01-02')),
    ('2010-06-01 ~ 2026-10-26', pd.Timestamp('2010-06-01')),
    ('2016-10-27 ~ 2026-10-26', pd.Timestamp('2016-10-27')),
    ('2019-06-04 ~ 2025-08-01', pd.Timestamp('2019-06-04')),
    ('2021-10-27 ~ 2026-10-26', pd.Timestamp('2021-10-27')),
]
PERIOD_ENDS = {
    '2019-06-04 ~ 2025-08-01': pd.Timestamp('2025-08-01'),
}

for label, start in PERIODS:
    end = PERIOD_ENDS.get(label, END)
    print(f"\n{'='*112}")
    print(f"{label}")
    print('='*112)
    print(f"{'规则':<24}{'CAGR':>8}{'最大回撤':>10}{'Sharpe':>8}{'Calmar':>8}{'期末权益':>12}{'交易':>5}")
    rows = []
    for name, (rule, use_cascade) in RULES.items():
        sigs = build(rule, start, use_cascade=use_cascade)
        rows.append(evaluate(name, sigs, start, end))
    # buy & hold
    daily, m = A.run_index([], start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    rows.append({'name': '买入持有100%', 'cagr': m['cagr'], 'maxdd': m['maxdd'], 'sharpe': m['sharpe'],
                 'calmar': m['calmar'], 'final': m['final'], 'trades': m['trades']})
    best = max(rows, key=lambda r: r['cagr'])
    for r in rows:
        mark = '  <== 最高' if r is best else ''
        print(f"{r['name']:<24}{r['cagr']*100:7.2f}%{r['maxdd']*100:9.2f}%{r['sharpe']:8.2f}{r['calmar']:8.2f}{r['final']:12,.0f}{r['trades']:5d}{mark}")
