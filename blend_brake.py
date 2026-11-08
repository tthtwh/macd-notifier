# -*- coding: utf-8 -*-
"""组合 + 回撤刹车：在 50/50 组合上叠加动态减仓。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import analysis as A
import sweep_params as S

FEE, SLIP, FUND = 0.0005, 0.0005, 0.002
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
    w = min(1.0, max(0.0, (PCT[i] - 0.45) / (0.90 - 0.45)))
    return round(w * 4) / 4 * 100


e_bin = A.run_index(build(bin_rule(0.85, 0.50)), PALL, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=0)[0]['equity']
e_lin = A.run_index(build(lin), PALL, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=0)[0]['equity']
r = 0.5 * e_bin.pct_change().fillna(0) + 0.5 * e_lin.pct_change().fillna(0)


def simulate(mult_fn, start=PALL):
    sub = r.loc[start:]
    eq = 100000.0
    out = []
    hist = []
    for date, ret in sub.items():
        hist.append(eq)
        peak = max(hist[-252:]) if len(hist) >= 1 else eq
        dd = eq / peak - 1
        m = mult_fn(dd)
        eq *= (1 + m * ret)
        out.append(eq)
    return pd.Series(out, index=sub.index)


def stat(eq):
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1
    dd = (eq / eq.cummax() - 1).min()
    sharpe = eq.pct_change().dropna().mean() / eq.pct_change().dropna().std() * np.sqrt(252)
    return cagr, dd, sharpe


def sub_stat(eq, start):
    sub = eq.loc[start:]
    years = max((sub.index[-1] - sub.index[0]).days / 365.25, 1e-9)
    return (sub.iloc[-1] / sub.iloc[0]) ** (1 / years) - 1, (sub / sub.cummax() - 1).min()


cases = [
    ('组合50/50 无刹车', lambda dd: 1.0),
    ('组合 + 刹车(-12%→50%)', lambda dd: 0.5 if dd < -0.12 else 1.0),
    ('组合 + 刹车(-12%→50%,-20%→25%)', lambda dd: 0.25 if dd < -0.20 else (0.5 if dd < -0.12 else 1.0)),
    ('组合 + 刹车(-15%→50%)', lambda dd: 0.5 if dd < -0.15 else 1.0),
]

print(f"{'方案':<38}{'5y':>8}{'10y':>8}{'full':>8}{'fullDD':>9}{'10yDD':>9}{'sharpe':>8}")
rows = []
for name, fn in cases:
    eq = simulate(fn)
    c, dd, sh = stat(eq)
    c5, dd5 = sub_stat(eq, P5)
    c10, dd10 = sub_stat(eq, P10)
    rows.append({'方案': name, '5y': c5, '10y': c10, 'full': c, 'fullDD': dd, '10yDD': dd10, 'sharpe': sh})
    print(f"{name:<38}{c5*100:>7.2f}%{c10*100:>7.2f}%{c*100:>7.2f}%{dd*100:>8.2f}%{dd10*100:>8.2f}%{sh:>8.2f}")

pd.DataFrame(rows).to_csv('work/dividend-strategy/strategy-blend-brake.csv', index=False, encoding='utf-8-sig')
