# -*- coding: utf-8 -*-
"""最终统计表：所有候选策略的统一口径指标。"""
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
MA = d['ma200'].to_numpy(float)
CLOSE = ct.to_numpy(float)
DY = d['dy'].to_numpy(float)


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
                     'pct': float(PCT[i]), 'dy': float(DY[i]),
                     'from_level': int(round(lv)), 'to_level': int(round(t)),
                     'target_pct': float(t), 'from_pct': float(lv)})
        lv = float(t)
    return sigs


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


CURRENT = ladder([0.60, 0.70, 0.80, 0.90], [0.70, 0.60, 0.50, 0.40])


def r_current(lv, i):
    return CURRENT(lv, float(PCT[i])) if np.isfinite(PCT[i]) else lv


def r_bin(lv, i):
    if not np.isfinite(PCT[i]):
        return lv
    if PCT[i] >= 0.85:
        return 100.0
    if PCT[i] <= 0.50:
        return 0.0
    return float(lv)


def r_lin(lv, i):
    if not np.isfinite(PCT[i]):
        return lv
    w = min(1.0, max(0.0, (PCT[i] - 0.45) / 0.45))
    return round(w * 4) / 4 * 100


def r_abs(lv, i):
    if not np.isfinite(DY[i]):
        return lv
    for k, e in enumerate([0.035, 0.040, 0.045, 0.050]):
        if DY[i] < e:
            return float([0, 25, 50, 75][k])
    return 100.0


def r_ladder_ma(lv, i):
    if not np.isfinite(PCT[i]):
        return lv
    t = CURRENT(lv, float(PCT[i]))
    if t > lv and np.isfinite(MA[i]) and CLOSE[i] <= MA[i]:
        return lv
    return t


def run(rule):
    sigs = build(rule)
    daily, m = A.run_index(sigs, PALL, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=0)
    return sigs, daily['equity'], m


def blend(scale):
    _, e1, _ = run(r_bin)
    _, e2, _ = run(r_lin)
    r = 0.5 * e1.pct_change().fillna(0) + 0.5 * e2.pct_change().fillna(0)
    rr = scale * r + (1 - scale) * (0.02 / 252)
    return 100000 * (1 + rr).cumprod()


def stat(eq, start):
    sub = eq.loc[start:]
    y = max((sub.index[-1] - sub.index[0]).days / 365.25, 1e-9)
    c = (sub.iloc[-1] / sub.iloc[0]) ** (1 / y) - 1
    dd = (sub / sub.cummax() - 1).min()
    ret = sub.pct_change().dropna()
    sh = ret.mean() / ret.std() * np.sqrt(252) if ret.std() > 0 else np.nan
    return c, dd, sh


STARTS = [pd.Timestamp(f'{y}-01-01') for y in range(2010, 2022)]
BH = []
for s0 in STARTS:
    e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
    if (e0 - s0).days < 1500:
        continue
    _, m = A.run_index([], s0, e0, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
    BH.append(m['cagr'])
BH = np.array(BH)


def roll(sigs=None, eq=None):
    out = []
    for s0 in STARTS:
        e0 = min(s0 + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (e0 - s0).days < 1500:
            continue
        if sigs is not None:
            lv = 0
            for s in sigs:
                if s['signal_date'] <= s0:
                    lv = s['to_level']
                else:
                    break
            _, m = A.run_index(sigs, s0, e0, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=lv)
            out.append(m['cagr'])
        else:
            sub = eq.loc[s0:e0]
            y = max((sub.index[-1] - sub.index[0]).days / 365.25, 1e-9)
            out.append((sub.iloc[-1] / sub.iloc[0]) ** (1 / y) - 1)
    return np.array(out)


rows = []


def add(name, sigs=None, eq=None, m=None, trades=None, cash=None):
    if eq is None:
        sigs, eq, m = run_by_rule[name]
    c, dd, sh = stat(eq, PALL)
    c5, dd5, _ = stat(eq, P5)
    c10, dd10, _ = stat(eq, P10)
    rr = roll(sigs=sigs) if sigs is not None else roll(eq=eq)
    rows.append({
        '策略': name,
        '全样本年化': c, '全样本回撤': dd, 'Calmar': c / abs(dd),
        'Sharpe': sh,
        '近10年年化': c10, '近10年回撤': dd10,
        '近5年年化': c5, '近5年回撤': dd5,
        '交易次数': trades if trades is not None else (m['trades'] if m else np.nan),
        '空仓占比': cash if cash is not None else (m['cash_time'] if m else np.nan),
        '滚动5年均值': rr.mean(), '滚动5年最差': rr.min(), '滚动5年标准差': rr.std(),
        '跑赢持有': float(np.mean(rr > BH)),
    })


run_by_rule = {}

for name, rule in [
    ('现行五档（你的）', r_current),
    ('全有全无 0.85/0.50', r_bin),
    ('线性分位 0.45~0.90', r_lin),
    ('绝对股息率 3.5~5.0', r_abs),
    ('分位阶梯+MA200加仓过滤', r_ladder_ma),
]:
    run_by_rule[name] = run(rule)
    sigs, eq, m = run_by_rule[name]
    add(name, sigs=sigs, eq=eq, m=m)

# 组合与缩放
add('双引擎 50/50（100%）', eq=blend(1.0))
add('双引擎 × 0.85 + 短债', eq=blend(0.85))
add('双引擎 × 0.80 + 短债', eq=blend(0.80))

# 买入持有
_, m = A.run_index([], PALL, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
eq_bh = m  # 需要 equity
daily_bh, m_bh = A.run_index([], PALL, END, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=100)
add('买入持有 100%', eq=daily_bh['equity'], m=m_bh)

res = pd.DataFrame(rows)
res.to_csv('work/dividend-strategy/final-stats.csv', index=False, encoding='utf-8-sig')


def p(x):
    return f"{x*100:.2f}%"


print(f"{'策略':<22}{'全样本':>8}{'回撤':>9}{'Calmar':>7}{'Sharpe':>7}{'10年':>8}{'10年DD':>8}{'5年':>8}{'5年DD':>8}{'交易':>5}{'滚动均值':>9}{'最差':>8}{'std':>7}{'胜率':>6}")
for _, r in res.iterrows():
    tr = '—' if pd.isna(r['交易次数']) else str(int(r['交易次数']))
    print(f"{r['策略']:<22}{p(r['全样本年化']):>8}{p(r['全样本回撤']):>9}{r['Calmar']:>7.2f}{r['Sharpe']:>7.2f}"
          f"{p(r['近10年年化']):>8}{p(r['近10年回撤']):>8}{p(r['近5年年化']):>8}{p(r['近5年回撤']):>8}{tr:>5}"
          f"{p(r['滚动5年均值']):>9}{p(r['滚动5年最差']):>8}{p(r['滚动5年标准差']):>7}{r['跑赢持有']*100:>5.0f}%")
print('买入持有滚动基准', p(BH.mean()), p(BH.min()), p(BH.std()))
