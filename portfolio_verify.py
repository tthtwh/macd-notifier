# -*- coding: utf-8 -*-
"""红利策略 + 半导体 MACD 的组合回测（2010-06 ~ 2026-10）。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import analysis as A
import sweep_params as S

FEE = 0.0005
END = pd.Timestamp('2026-10-30')
START = pd.Timestamp('2010-06-01')

# ---------- 红利权益 ----------
d = S.base.copy()
d['pct'] = S.pct_series(2520)
A.df = d
P = d['pct'].to_numpy(float)


def ladder(lv, p):
    up = [0.60, 0.70, 0.80, 0.90]
    down = [0.40, 0.50, 0.60, 0.70]
    if not np.isfinite(p):
        return lv
    if lv == 0:
        return 25 if p >= up[0] else 0
    if lv == 25:
        if p >= up[1]:
            return 50
        if p <= down[0]:
            return 0
        return 25
    if lv == 50:
        if p >= up[2]:
            return 75
        if p <= down[1]:
            return 25
        return 50
    if lv == 75:
        if p >= up[3]:
            return 100
        if p <= down[2]:
            return 50
        return 75
    if lv == 100:
        return 75 if p <= down[3] else 100
    return lv


def resolve(lv, p):
    for _ in range(6):
        nx = ladder(lv, p)
        if nx == lv:
            return lv
        lv = nx
    return lv


lv = 0
sigs = []
for i in range(len(d)):
    if not bool(d['is_month_end'].iat[i]) or not np.isfinite(P[i]):
        continue
    t = resolve(lv, float(P[i]))
    if t != lv and i + 1 < len(d):
        sigs.append({'signal_date': d.index[i], 'exec_date': d.index[i + 1], 'pct': float(P[i]),
                     'dy': float(d['dy'].iat[i]), 'from_level': lv, 'to_level': int(t),
                     'target_pct': float(t), 'from_pct': float(lv)})
        lv = int(t)

daily, m = A.run_index(sigs, START, END, fee=FEE, slip=FEE, fund_fee=0.002, init_target=0)
div_eq = daily['equity']

# ---------- MACD 权益 ----------
macd_eq = pd.read_csv('work/macd-verify/equity.csv', parse_dates=['date']).set_index('date')['equity'] \
    if 'equity' in pd.read_csv('work/macd-verify/equity.csv', nrows=1).columns else None
if macd_eq is None:
    raw = pd.read_csv('work/macd-verify/equity.csv', parse_dates=[0]).set_index('date').iloc[:, 0]
    macd_eq = raw

common = div_eq.index.intersection(macd_eq.index)
div_eq, macd_eq = div_eq.loc[common], macd_eq.loc[common]
rd, rm = div_eq.pct_change().fillna(0), macd_eq.pct_change().fillna(0)


def portfolio(w):
    cap_d = cap_m = 1.0
    vals = []
    prev_m = None
    for dt in common:
        cap_d *= (1 + rd.loc[dt])
        cap_m *= (1 + rm.loc[dt])
        total = cap_d + cap_m
        vals.append(total)
        cur = dt.to_period('M')
        if prev_m is not None and cur != prev_m:
            cap_d, cap_m = (1 - w) * total, w * total
        prev_m = cur
    return pd.Series(vals, index=common)


def stat(eq):
    y = (eq.index[-1] - eq.index[0]).days / 365.25
    c = (eq.iloc[-1] / eq.iloc[0]) ** (1 / y) - 1
    dd = (eq / eq.cummax() - 1).min()
    r = eq.pct_change().dropna()
    return c, dd, r.std() * np.sqrt(252), r.mean() / r.std() * np.sqrt(252)


print(f"区间 {common[0].date()} ~ {common[-1].date()}  相关性 {rd.corr(rm):.3f}")
print(f"{'配置(红利/MACD)':<18}{'年化':>8}{'最大回撤':>10}{'波动':>8}{'Sharpe':>8}{'期末倍数':>9}")
for w, name in [(0.0, '100/0'), (0.2, '80/20'), (0.3, '70/30'), (0.4, '60/40'), (0.5, '50/50'), (0.6, '40/60'), (1.0, '0/100')]:
    eq = portfolio(w)
    c, dd, vol, sh = stat(eq)
    print(f"{name:<18}{c*100:>7.2f}%{dd*100:>9.2f}%{vol*100:>7.1f}%{sh:>8.2f}{eq.iloc[-1]:>9.1f}x")
