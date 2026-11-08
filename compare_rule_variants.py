# -*- coding: utf-8 -*-
"""对比几种仓位规则在 2016-10-27 ~ 2026-10-27 的表现。

规则：
  current    : 现行部署规则（加仓 60/70/80/90，减仓 70/60/50/40，级联）
  clear50    : 加仓同现行，但 50 分位直接清仓（减仓 70/60/50→0，级联）
  binary9050 : 分位>=90 满仓，<=50 清仓，中间不动（全有或全无）
  band_50_60_70_80 : 静态五档，<=50 清仓，>=80 满仓
  band_60_70_80_90 : 静态五档，<=60 清仓，>=90 满仓
  band_50_60_70_90 : 静态五档，<=50 清仓，>=90 满仓
  buyhold, fixed50, fixed75 : 参照
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
import analysis as A

START = pd.Timestamp('2016-10-27')
END = A.LAST
FEE, SLIP, FUND = 0.0005, 0.0005, 0.002


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
    """加仓阶梯不变；减仓时 50 分位直接清仓（跳过 25 档）。"""
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
        # 静态：直接按分位所在区间取档位
        for i, e in enumerate(edges):
            if p < e:
                return levels[i]
        return levels[-1]
    return rule


def build(rule, start=START, init_level=0, cascade_mode=True):
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
        target = cascade(rule, level, float(p)) if cascade_mode else rule(level, float(p))
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


def run(name, sigs, init_target=0):
    daily, m = A.run_index(sigs, START, END, fee=FEE, slip=SLIP, fund_fee=FUND,
                           init_target=init_target)
    return name, daily, m


def fmt(m):
    return (f"CAGR {m['cagr']*100:6.2f}%  MaxDD {m['maxdd']*100:7.2f}%  "
            f"Sharpe {m['sharpe']:5.2f}  Calmar {m['calmar']:5.2f}  "
            f"期末 {m['final']:>10,.0f}  交易 {m['trades']:2d}  空仓时间 {m['cash_time']*100:5.1f}%")


if __name__ == '__main__':
    print(f"data {A.df.index[0].date()} -> {A.df.index[-1].date()}  回测 {START.date()} -> {END.date()}")
    print()

    variants = []

    variants.append(run('current        ', build(step_current)))
    variants.append(run('clear50        ', build(step_clear50)))
    variants.append(run('binary90/50    ', build(rule_binary9050, cascade_mode=False)))

    for name, edges, levels in [
        ('band 50/60/70/80', [0.50, 0.60, 0.70, 0.80], [0, 25, 50, 75, 100]),
        ('band 60/70/80/90', [0.60, 0.70, 0.80, 0.90], [0, 25, 50, 75, 100]),
        ('band 50/60/70/90', [0.50, 0.60, 0.70, 0.90], [0, 25, 50, 75, 100]),
    ]:
        variants.append(run(name, build(band_rule(edges, levels), cascade_mode=False)))

    variants.append(run('buyhold        ', [], init_target=100))
    variants.append(run('fixed50        ', [], init_target=50))
    variants.append(run('fixed75        ', [], init_target=75))

    print(f"{'规则':<18}{'绩效'}")
    print('-' * 130)
    for name, daily, m in variants:
        print(f"{name:<18}{fmt(m)}")

    print()
    print('=== 2025-07-31 信号在各规则下的动作 ===')
    p = 0.447
    for label, fn in [('current', step_current), ('clear50', step_clear50),
                      ('binary90/50', rule_binary9050)]:
        lv = 100
        end = cascade(fn, lv, p)
        path = [lv]
        cur = lv
        for _ in range(8):
            nxt = cascade(fn, cur, p) if label != 'binary90/50' else fn(cur, p)
            if nxt == cur:
                break
            cur = nxt
            path.append(cur)
        print(f"  {label:<12} 100% + 分位 0.447 -> {end}%   ({' -> '.join(str(x) for x in path)})")
