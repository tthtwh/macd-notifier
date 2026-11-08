# -*- coding: utf-8 -*-
"""第二批：线性分位网格、混合方案、季度调仓、延迟执行、分红增长过滤。"""
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
ct = d['close_t']
d['ttm_div'] = d['dp'].rolling(252, min_periods=252).sum()
d['div_growth'] = d['ttm_div'] / d['ttm_div'].shift(252) - 1.0
A.df = d

PCT = d['pct'].to_numpy(float)
DY = d['dy'].to_numpy(float)
GROW = d['div_growth'].to_numpy(float)


def is_me(i):
    return bool(d['is_month_end'].iat[i])


def is_qe(i):
    return is_me(i) and d.index[i].month in (3, 6, 9, 12)


def ladder(up, down):
    def step(lv, p):
        if not np.isfinite(p):
            return lv
        if lv == 0:
            return 25 if p >= up[0] else 0
        if lv == 25:
            if p >= up[1]:
                return 50
            if p <= down[3]:
                return 0
            return 25
        if lv == 50:
            if p >= up[2]:
                return 75
            if p <= down[2]:
                return 25
            return 50
        if lv == 75:
            if p >= up[3]:
                return 100
            if p <= down[1]:
                return 50
            return 75
        if lv == 100:
            return 75 if p <= down[0] else 100
        return lv

    def resolve(lv, p):
        for _ in range(6):
            nx = step(lv, p)
            if nx == lv:
                return lv
            lv = nx
        return lv
    return resolve


def lin(p, a, b):
    w = min(1.0, max(0.0, (p - a) / (b - a)))
    return round(w * 4) / 4 * 100


def dy_band(y):
    edges = [0.035, 0.040, 0.045, 0.050]
    levels = [0, 25, 50, 75, 100]
    for k, e in enumerate(edges):
        if y < e:
            return levels[k]
    return levels[-1]


def build(rule, freq='M', delay=1):
    lv = 0.0
    sigs = []
    for i in range(len(d)):
        ok = is_qe(i) if freq == 'Q' else is_me(i)
        if not ok:
            continue
        t = rule(lv, i)
        if not np.isfinite(t):
            continue
        if abs(t - lv) < 1e-9:
            continue
        j = i + delay
        if j >= len(d):
            continue
        sigs.append({'signal_date': d.index[i], 'exec_date': d.index[j],
                     'pct': float(PCT[i]) if np.isfinite(PCT[i]) else np.nan,
                     'dy': float(DY[i]) if np.isfinite(DY[i]) else np.nan,
                     'from_level': int(round(lv)), 'to_level': int(round(t)),
                     'target_pct': float(t), 'from_pct': float(lv)})
        lv = float(t)
    return sigs


def ev(sigs, start, end=None):
    end = end or END
    lv = 0
    for s in sigs:
        if s['signal_date'] <= start:
            lv = s['to_level']
        else:
            break
    daily, m = A.run_index(sigs, start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=lv)
    return m


STARTS = [pd.Timestamp(f'{y}-01-01') for y in range(2010, 2022)]
BH = []
for s0 in STARTS:
    e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
    if (e0 - s0).days < 1500:
        continue
    _, m = A.run_index([], s0, e0, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    BH.append(m['cagr'])
BH = np.array(BH)


def rolling(sigs):
    out = []
    for s0 in STARTS:
        e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (e0 - s0).days < 1500:
            continue
        out.append(ev(sigs, s0, e0)['cagr'])
    return np.array(out)


def lin_rule(a, b):
    return lambda lv, i: lin(PCT[i], a, b) if np.isfinite(PCT[i]) else np.nan


def hybrid_rule(a, b):
    def r(lv, i):
        if not np.isfinite(PCT[i]) or not np.isfinite(DY[i]):
            return np.nan
        return min(lin(PCT[i], a, b), dy_band(DY[i]))
    return r


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


def ladder_grow(up, down):
    base = ladder(up, down)

    def r(lv, i):
        if not np.isfinite(PCT[i]):
            return lv
        t = base(lv, float(PCT[i]))
        if t > lv and np.isfinite(GROW[i]) and GROW[i] < -0.10:
            return lv
        return t
    return r


CASES = []
for a, b in [(0.35, 0.80), (0.40, 0.85), (0.40, 0.90), (0.45, 0.90), (0.50, 0.90), (0.50, 0.95), (0.55, 0.95)]:
    CASES.append((f'H 线性分位 {a:.2f}~{b:.2f}', lin_rule(a, b), 'M', 1))
CASES += [
    ('H 线性 0.45~0.90（季调）', lin_rule(0.45, 0.90), 'Q', 1),
    ('H 线性 0.45~0.90（延1日）', lin_rule(0.45, 0.90), 'M', 2),
    ('M 混合 线性∩绝对股息率 0.45~0.90', hybrid_rule(0.45, 0.90), 'M', 1),
    ('M 混合 线性∩绝对股息率 0.40~0.85', hybrid_rule(0.40, 0.85), 'M', 1),
    ('J 全有全无 0.85/0.50（季调）', bin_rule(0.85, 0.50), 'Q', 1),
    ('J 全有全无 0.85/0.50（延1日）', bin_rule(0.85, 0.50), 'M', 2),
    ('J 全有全无 0.85/0.50（对照）', bin_rule(0.85, 0.50), 'M', 1),
    ('K 分位阶梯+分红增长过滤', ladder_grow([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40]), 'M', 1),
    ('K 分位阶梯（现行对照）', lambda lv, i: ladder([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40])(lv, float(PCT[i])) if np.isfinite(PCT[i]) else lv, 'M', 1),
]

rows = []
for name, rule, freq, delay in CASES:
    sigs = build(rule, freq, delay)
    m5 = ev(sigs, P5)
    m10 = ev(sigs, P10)
    mf = ev(sigs, PALL)
    rr = rolling(sigs)
    rows.append({'策略': name, '5y': m5['cagr'], '10y': m10['cagr'], 'full': mf['cagr'],
                 'fullDD': mf['maxdd'], 'trades': mf['trades'],
                 'roll_mean': rr.mean(), 'roll_worst': rr.min(), 'roll_std': rr.std(),
                 'beat': float(np.mean(rr > BH))})

res = pd.DataFrame(rows).sort_values('full', ascending=False)
res.to_csv('work/dividend-strategy/strategy-zoo2.csv', index=False, encoding='utf-8-sig')


def f(x):
    return f"{x*100:.2f}%"


print(f"{'策略':<40}{'5y':>8}{'10y':>8}{'full':>8}{'fullDD':>9}{'tr':>5}{'roll均值':>9}{'最差':>8}{'std':>7}{'beat':>6}")
for _, r in res.iterrows():
    print(f"{r['策略']:<40}{f(r['5y']):>8}{f(r['10y']):>8}{f(r['full']):>8}{f(r['fullDD']):>9}"
          f"{int(r['trades']):>5}{f(r['roll_mean']):>9}{f(r['roll_worst']):>8}{f(r['roll_std']):>7}{r['beat']*100:>5.0f}%")
print('BH', f(BH.mean()), f(BH.min()), f(BH.std()))
