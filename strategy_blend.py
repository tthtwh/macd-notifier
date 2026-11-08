# -*- coding: utf-8 -*-
"""组合测试：全有全无 + 线性分位 的 50/50 组合。"""
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


def lin(a, b):
    def r(lv, i):
        if not np.isfinite(PCT[i]):
            return np.nan
        w = min(1.0, max(0.0, (PCT[i] - a) / (b - a)))
        return round(w * 4) / 4 * 100
    return r


def equity(sigs, start=PALL, end=END):
    daily, _ = A.run_index(sigs, start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=0)
    return daily['equity']


def stat(eq):
    ret = eq.pct_change().dropna()
    years = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1
    dd = (eq / eq.cummax() - 1).min()
    sharpe = ret.mean() / ret.std() * np.sqrt(252) if ret.std() > 0 else np.nan
    return cagr, dd, sharpe


def roll(eq, starts):
    out = []
    for s0 in starts:
        e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (e0 - s0).days < 1500:
            continue
        sub = eq.loc[s0:e0]
        y = (sub.index[-1] - sub.index[0]).days / 365.25
        out.append((sub.iloc[-1] / sub.iloc[0]) ** (1 / y) - 1)
    return np.array(out)


starts = [pd.Timestamp(f'{y}-01-01') for y in range(2010, 2022)]
bh = []
for s0 in starts:
    e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
    if (e0 - s0).days < 1500:
        continue
    daily, _ = A.run_index([], s0, e0, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    eq = daily['equity']
    y = (eq.index[-1] - eq.index[0]).days / 365.25
    bh.append((eq.iloc[-1] / eq.iloc[0]) ** (1 / y) - 1)
BH = np.array(bh)

e1 = equity(build(bin_rule(0.85, 0.50)))
e2 = equity(build(lin(0.45, 0.90)))
r1 = e1.pct_change().fillna(0)
r2 = e2.pct_change().fillna(0)


def blend(w):
    r = w * r1 + (1 - w) * r2
    return 100000 * (1 + r).cumprod()


rows = []
for name, eq in [('全有全无 0.85/0.50', e1), ('线性 0.45~0.90', e2),
                 ('组合 50/50', blend(0.5)), ('组合 70/30', blend(0.7)), ('组合 30/70', blend(0.3))]:
    c, dd, sh = stat(eq)
    sub5 = eq.loc[P5:]
    sub10 = eq.loc[P10:]
    c5 = (sub5.iloc[-1] / sub5.iloc[0]) ** (365.25 / max((sub5.index[-1] - sub5.index[0]).days, 1)) - 1
    c10 = (sub10.iloc[-1] / sub10.iloc[0]) ** (365.25 / max((sub10.index[-1] - sub10.index[0]).days, 1)) - 1
    rr = roll(eq, starts)
    rows.append({'策略': name, '5y': c5, '10y': c10, 'full': c, 'fullDD': dd, 'sharpe': sh,
                 'roll_mean': rr.mean(), 'roll_worst': rr.min(), 'roll_std': rr.std(),
                 'beat': float(np.mean(rr > BH))})

res = pd.DataFrame(rows)
res.to_csv('work/dividend-strategy/strategy-blend.csv', index=False, encoding='utf-8-sig')


def f(x):
    return f"{x*100:.2f}%"


print(f"{'策略':<20}{'5y':>8}{'10y':>8}{'full':>8}{'fullDD':>9}{'sharpe':>8}{'roll均值':>9}{'最差':>8}{'std':>7}{'beat':>6}")
for _, r in res.iterrows():
    print(f"{r['策略']:<20}{f(r['5y']):>8}{f(r['10y']):>8}{f(r['full']):>8}{f(r['fullDD']):>9}{r['sharpe']:>8.2f}"
          f"{f(r['roll_mean']):>9}{f(r['roll_worst']):>8}{f(r['roll_std']):>7}{r['beat']*100:>5.0f}%")
print('BH', f(BH.mean()), f(BH.min()), f(BH.std()))
