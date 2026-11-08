# -*- coding: utf-8 -*-
"""ETF 实盘阶段（2023-12-14 ~ 2026-10-26）对比：现行五档 vs 90/50 全有全无。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
import analysis as A

ETF_START = pd.Timestamp('2023-12-14')
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


def rule_binary9050(level, p):
    if not np.isfinite(p):
        return level
    if p >= 0.90:
        return 100
    if p <= 0.50:
        return 0
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


def level_at(signals, date):
    lv = 0
    for s in signals:
        if s['signal_date'] <= date:
            lv = s['to_level']
        else:
            break
    return lv


if __name__ == '__main__':
    full_cur = build(step_current, pd.Timestamp('2010-06-01'))
    full_bin = build(rule_binary9050, pd.Timestamp('2010-06-01'), use_cascade=False)

    print(f"ETF {ETF_START.date()} -> {END.date()}")
    for name, full, rule, casc in [
        ('现行五档', full_cur, step_current, True),
        ('90/50 全有全无', full_bin, rule_binary9050, False),
    ]:
        lvl = level_at(full, ETF_START - pd.Timedelta(days=1))
        sig = build(rule, ETF_START, init_level=lvl, use_cascade=casc)
        daily, m = A.run_etf(sig, ETF_START, END, init_target=lvl)
        print(f"\n{name}: 期初 {lvl}%  期末权益 {m['final']:,.0f}  CAGR {m['cagr']*100:.2f}%  "
              f"MaxDD {m['maxdd']*100:.2f}%  交易 {m['trades']}")
        for s in sig:
            print(f"   {s['signal_date'].date()} pct={s['pct']:.3f}  {s['from_level']}% -> {s['to_level']}%")
        last = daily.iloc[-1]
        print(f"   当前仓位(市值占比) {last['position_value']/last['equity']*100:.1f}%  现金 {last['cash']:,.0f}")
