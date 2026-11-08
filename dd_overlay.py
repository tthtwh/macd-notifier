# -*- coding: utf-8 -*-
"""回撤约束下的防御型叠加测试：仓位上限 / 趋势闸门 / 组合。"""
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
d['ma200'] = ct.rolling(200).mean()
A.df = d
PCT = d['pct'].to_numpy(float)
MA200 = d['ma200'].to_numpy(float)
CLOSE = ct.to_numpy(float)


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


def lin(p, a=0.45, b=0.90):
    return round(min(1.0, max(0.0, (p - a) / (b - a))) * 4) / 4 * 100


def with_cap(fn, cap):
    return lambda lv, i: min(cap, fn(lv, i)) if np.isfinite(fn(lv, i)) else np.nan


def lin_base(lv, i):
    return lin(PCT[i]) if np.isfinite(PCT[i]) else np.nan


def trend_gate(lv, i, cap):
    if not np.isfinite(PCT[i]):
        return np.nan
    t = lin(PCT[i])
    if np.isfinite(MA200[i]) and CLOSE[i] < MA200[i]:
        t = min(t, cap)
    return t


def dd_brake(lv, i, cap):
    """回撤超过 12% 时把仓位压到 cap。"""
    if not np.isfinite(PCT[i]):
        return np.nan
    t = lin(PCT[i])
    w = d['close_t'].iloc[max(0, i - 251):i + 1]
    dd = CLOSE[i] / w.max() - 1 if len(w) else 0
    if dd < -0.12:
        t = min(t, cap)
    return t


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


CASES = [
    ('线性 0.45~0.90（无上限）', lin_base),
    ('线性 + 仓位上限 75%', with_cap(lin_base, 75)),
    ('线性 + 仓位上限 50%', with_cap(lin_base, 50)),
    ('线性 + MA200闸门(跌破压到50)', lambda lv, i: trend_gate(lv, i, 50)),
    ('线性 + MA200闸门(跌破压到25)', lambda lv, i: trend_gate(lv, i, 25)),
    ('线性 + 回撤刹车(-12%压到50)', lambda lv, i: dd_brake(lv, i, 50)),
    ('线性 + 回撤刹车(-12%压到25)', lambda lv, i: dd_brake(lv, i, 25)),
]

rows = []
for name, rule in CASES:
    sigs = build(rule)
    m5, m10, mf = ev(sigs, P5), ev(sigs, P10), ev(sigs, PALL)
    rr = rolling(sigs)
    rows.append({'策略': name, '5y': m5['cagr'], '10y': m10['cagr'], 'full': mf['cagr'],
                 'fullDD': mf['maxdd'], '10yDD': m10['maxdd'], '5yDD': m5['maxdd'],
                 'trades': mf['trades'], 'worst': rr.min(), 'std': rr.std(),
                 'beat': float(np.mean(rr > BH))})

res = pd.DataFrame(rows).sort_values('full', ascending=False)
res.to_csv('work/dividend-strategy/strategy-dd-overlay.csv', index=False, encoding='utf-8-sig')


def f(x):
    return f"{x*100:.2f}%"


print(f"{'策略':<32}{'5y':>8}{'10y':>8}{'full':>8}{'fullDD':>9}{'10yDD':>9}{'tr':>5}{'最差':>8}{'std':>7}{'beat':>6}")
for _, r in res.iterrows():
    print(f"{r['策略']:<32}{f(r['5y']):>8}{f(r['10y']):>8}{f(r['full']):>8}{f(r['fullDD']):>9}"
          f"{f(r['10yDD']):>9}{int(r['trades']):>5}{f(r['worst']):>8}{f(r['std']):>7}{r['beat']*100:>5.0f}%")
