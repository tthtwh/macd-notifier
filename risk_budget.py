# -*- coding: utf-8 -*-
"""风险预算：组合策略按 85%/80%/100% 缩放，剩余配短债(2%)。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import analysis as A
import sweep_params as S

END = A.LAST
P5 = pd.Timestamp('2021-10-27')
P10 = pd.Timestamp('2016-10-27')
PALL = pd.Timestamp('2010-06-01')
d = S.base.copy()
d['pct'] = S.pct_series(2520)
A.df = d
PCT = d['pct'].to_numpy(float)


def is_me(i):
    return bool(d['is_month_end'].iat[i])


def build(rule):
    lv = 0.0
    sigs = []
    for i in range(len(d)):
        if not is_me(i):
            continue
        t = rule(lv, i)
        if not np.isfinite(t) or abs(t - lv) < 1e-9 or i + 1 >= len(d):
            continue
        sigs.append({'signal_date': d.index[i], 'exec_date': d.index[i + 1],
                     'pct': float(PCT[i]), 'dy': float(d['dy'].iat[i]),
                     'from_level': int(round(lv)), 'to_level': int(round(t)),
                     'target_pct': float(t), 'from_pct': float(lv)})
        lv = float(t)
    return sigs


def bin_rule(buy, sell):
    def r(lv, i):
        if not np.isfinite(PCT[i]):
            return np.nan
        if PCT[i] >= buy:
            return 100.0
        if PCT[i] <= sell:
            return 0.0
        return float(lv)
    return r


def lin(lv, i):
    if not np.isfinite(PCT[i]):
        return np.nan
    w = min(1.0, max(0.0, (PCT[i] - 0.45) / 0.45))
    return round(w * 4) / 4 * 100


e_bin = A.run_index(build(bin_rule(0.85, 0.50)), PALL, END, fee=0.0005, slip=0.0005, fund_fee=0.002, init_target=0)[0]['equity']
e_lin = A.run_index(build(lin), PALL, END, fee=0.0005, slip=0.0005, fund_fee=0.002, init_target=0)[0]['equity']
r = 0.5 * e_bin.pct_change().fillna(0) + 0.5 * e_lin.pct_change().fillna(0)
CASH = 0.02 / 252


def sim(scale):
    rr = scale * r + (1 - scale) * CASH
    return 100000 * (1 + rr).cumprod()


def stat(eq, start):
    sub = eq.loc[start:]
    years = max((sub.index[-1] - sub.index[0]).days / 365.25, 1e-9)
    return ((sub.iloc[-1] / sub.iloc[0]) ** (1 / years) - 1,
            (sub / sub.cummax() - 1).min(),
            sub.pct_change().dropna().mean() / sub.pct_change().dropna().std() * np.sqrt(252))


print(f"{'仓位系数':<10}{'5y':>8}{'5yDD':>9}{'10y':>8}{'10yDD':>9}{'full':>8}{'fullDD':>9}{'sharpe':>8}")
for scale in [1.0, 0.90, 0.85, 0.80, 0.75]:
    eq = sim(scale)
    c5, dd5, _ = stat(eq, P5)
    c10, dd10, _ = stat(eq, P10)
    c, ddf, sh = stat(eq, PALL)
    print(f"{scale:<10.2f}{c5*100:>7.2f}%{dd5*100:>8.2f}%{c10*100:>7.2f}%{dd10*100:>8.2f}%{c*100:>7.2f}%{ddf*100:>8.2f}%{sh:>8.2f}")
