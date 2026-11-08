# -*- coding: utf-8 -*-
"""策略动物园：估值(绝对股息率/相对均线)、趋势(均线/动量)、回撤、波动率、混合。

输出 CSV + markdown，并按 5y / 10y / full / 滚动5年 评估。
"""
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

# ---------- 特征 ----------
d = S.base.copy()
d['pct'] = S.pct_series(2520)
ct = d['close_t']
d['ma60'] = ct.rolling(60).mean()
d['ma120'] = ct.rolling(120).mean()
d['ma200'] = ct.rolling(200).mean()
d['ma250'] = ct.rolling(250).mean()
d['mom12'] = ct / ct.shift(252) - 1.0
d['mom6'] = ct / ct.shift(126) - 1.0
d['dd252'] = ct / ct.rolling(252).max() - 1.0
d['vol60'] = ct.pct_change().rolling(60).std() * np.sqrt(252)
d['dy_ma252'] = d['dy'].rolling(252).mean()
d['dy_ratio'] = d['dy'] / d['dy_ma252']
d['dy_chg126'] = d['dy'] - d['dy'].shift(126)
d['ttm_div'] = d['dp'].rolling(252, min_periods=252).sum()
d['div_growth'] = d['ttm_div'] / d['ttm_div'].shift(252) - 1.0
A.df = d

ARR = {c: d[c].to_numpy(dtype=float) for c in
       ['pct', 'dy', 'ma60', 'ma200', 'ma250', 'mom12', 'mom6', 'dd252', 'vol60',
        'dy_ratio', 'dy_chg126', 'div_growth', 'close_t', 'open_t']}
CLOSE_T = ARR['close_t']


def is_monthend(i):
    return bool(d['is_month_end'].iat[i])


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


def build(rule):
    lv = 0.0
    sigs = []
    for i in range(len(d)):
        if not is_monthend(i):
            continue
        t = rule(lv, i)
        if not np.isfinite(t):
            continue
        if abs(t - lv) < 1e-9:
            continue
        if i + 1 >= len(d):
            continue
        sigs.append({'signal_date': d.index[i], 'exec_date': d.index[i + 1],
                     'pct': float(ARR['pct'][i]) if np.isfinite(ARR['pct'][i]) else np.nan,
                     'dy': float(ARR['dy'][i]) if np.isfinite(ARR['dy'][i]) else np.nan,
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


def rolling(sigs, starts):
    out = []
    for start in starts:
        end = min(start + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (end - start).days < 1500:
            continue
        out.append(ev(sigs, start, end)['cagr'])
    return np.array(out)


STARTS = [pd.Timestamp(f'{y}-01-01') for y in range(2010, 2022)]


# ---------- 策略 ----------
def static_feature(arr, edges, levels):
    def r(lv, i):
        v = arr[i]
        if not np.isfinite(v):
            return np.nan
        for k, e in enumerate(edges):
            if v < e:
                return levels[k]
        return levels[-1]
    return r


def ladder_filter(up, down, cond_arr):
    base = ladder(up, down)

    def r(lv, i):
        p = ARR['pct'][i]
        if not np.isfinite(p):
            return lv
        t = base(lv, p)
        if t > lv:  # 只限制加仓
            c = cond_arr[i]
            if not (np.isfinite(c) and c > 0):
                return lv
        return t
    return r


def vol_target(target):
    def r(lv, i):
        v = ARR['vol60'][i]
        if not np.isfinite(v) or v <= 0:
            return np.nan
        w = min(1.0, target / v)
        return round(w * 4) / 4 * 100
    return r


def linear_pct(a, b):
    def r(lv, i):
        p = ARR['pct'][i]
        if not np.isfinite(p):
            return np.nan
        w = min(1.0, max(0.0, (p - a) / (b - a)))
        return round(w * 4) / 4 * 100
    return r


CURRENT = ladder([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40])

STRATS = [
    ('A 绝对股息率 3.5/4.0/4.5/5.0', static_feature(ARR['dy'], [0.035, 0.040, 0.045, 0.050], [0, 25, 50, 75, 100])),
    ('A 绝对股息率 4.0/4.5/5.0/5.5', static_feature(ARR['dy'], [0.040, 0.045, 0.050, 0.055], [0, 25, 50, 75, 100])),
    ('A 绝对股息率 3.0/3.5/4.0/4.5', static_feature(ARR['dy'], [0.030, 0.035, 0.040, 0.045], [0, 25, 50, 75, 100])),
    ('B 股息率/均线 0.95/1.00/1.05/1.10', static_feature(ARR['dy_ratio'], [0.95, 1.00, 1.05, 1.10], [0, 25, 50, 75, 100])),
    ('B 股息率/均线 0.90/0.95/1.00/1.05', static_feature(ARR['dy_ratio'], [0.90, 0.95, 1.00, 1.05], [0, 25, 50, 75, 100])),
    ('C 分位阶梯 + MA200过滤', ladder_filter([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40],
                                          CLOSE_T - ARR['ma200'])),
    ('C 分位阶梯 + MA250过滤', ladder_filter([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40],
                                          CLOSE_T - ARR['ma250'])),
    ('C 分位阶梯 + 12月动量过滤', ladder_filter([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40],
                                            ARR['mom12'])),
    ('D 回撤五档 -5/-10/-15/-20', static_feature(ARR['dd252'], [-0.20, -0.15, -0.10, -0.05], [100, 75, 50, 25, 0])),
    ('E 动量12-1 >0 满仓否则空仓', lambda lv, i: 100.0 if (np.isfinite(ARR['mom12'][i]) and ARR['mom12'][i] > 0) else 0.0),
    ('F 双均线 50/200', lambda lv, i: (100.0 if ARR['ma60'][i] > ARR['ma200'][i] else 0.0)
     if np.isfinite(ARR['ma60'][i]) and np.isfinite(ARR['ma200'][i]) else np.nan),
    ('G 波动率目标 12%', vol_target(0.12)),
    ('G 波动率目标 15%', vol_target(0.15)),
    ('H 线性分位映射 0.45~0.90', linear_pct(0.45, 0.90)),
    ('H 线性分位映射 0.50~0.95', linear_pct(0.50, 0.95)),
    ('I 股息率变化126d >0 满仓', lambda lv, i: (100.0 if ARR['dy_chg126'][i] > 0 else 0.0)
     if np.isfinite(ARR['dy_chg126'][i]) else np.nan),
    ('J 分位阶梯（现行对照）', lambda lv, i: CURRENT(lv, float(ARR['pct'][i])) if np.isfinite(ARR['pct'][i]) else lv),
    ('J 全有全无 0.85/0.50（前次最优）', lambda lv, i: (100.0 if ARR['pct'][i] >= 0.85 else (0.0 if ARR['pct'][i] <= 0.50 else lv))
     if np.isfinite(ARR['pct'][i]) else lv),
]

rows = []
for name, rule in STRATS:
    sigs = build(rule)
    m5 = ev(sigs, P5)
    m10 = ev(sigs, P10)
    mf = ev(sigs, PALL)
    rr = rolling(sigs, STARTS)
    rows.append({
        '策略': name,
        '5y': m5['cagr'], '10y': m10['cagr'], 'full': mf['cagr'],
        'fullDD': mf['maxdd'], '5yDD': m5['maxdd'],
        'trades': mf['trades'], 'cash': mf['cash_time'],
        'roll_mean': rr.mean() if len(rr) else np.nan,
        'roll_worst': rr.min() if len(rr) else np.nan,
        'roll_std': rr.std() if len(rr) else np.nan,
        'roll_beat': float(np.mean(rr > BH)) if len(rr) and 'BH' in globals() else np.nan,
    })

# 买入持有滚动基准
bh = []
for start in STARTS:
    end = min(start + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
    if (end - start).days < 1500:
        continue
    _, m = A.run_index([], start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    bh.append(m['cagr'])
BH = np.array(bh)

for r in rows:
    rr = np.array([])  # 重算 beat 需要各策略滚动序列，这里用占位
    r['roll_beat'] = np.nan

# 重新计算 beat（需要各策略的滚动序列）
for r, (name, rule) in zip(rows, STRATS):
    rr = rolling(build(rule), STARTS)
    r['roll_beat'] = float(np.mean(rr > BH)) if len(rr) == len(BH) else np.nan

res = pd.DataFrame(rows).sort_values('full', ascending=False)
res.to_csv('work/dividend-strategy/strategy-zoo.csv', index=False, encoding='utf-8-sig')


def f(x):
    return f"{x*100:.2f}%"


print(f"{'策略':<34}{'5y':>8}{'10y':>8}{'full':>8}{'fullDD':>9}{'tr':>5}{'roll均值':>9}{'最差':>8}{'std':>7}{'beat':>6}")
for _, r in res.iterrows():
    print(f"{r['策略']:<34}{f(r['5y']):>8}{f(r['10y']):>8}{f(r['full']):>8}{f(r['fullDD']):>9}"
          f"{int(r['trades']):>5}{f(r['roll_mean']):>9}{f(r['roll_worst']):>8}{f(r['roll_std']):>7}"
          f"{(r['roll_beat']*100 if np.isfinite(r['roll_beat']) else 0):>5.0f}%")
print('\nBH rolling', f(np.mean(BH)), f(np.min(BH)), f(np.std(BH)))
