# -*- coding: utf-8 -*-
"""红利策略 + 512760 MACD 组合的回测（2019-06 ~ 2026-10）。"""
import sys
import json
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import analysis as A
import sweep_params as S

START = pd.Timestamp('2019-06-12')
END = pd.Timestamp('2026-10-26')
FEE = 0.0005

# ---------- 红利策略权益 ----------
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


lv = 0
sigs = []
for i in range(len(d)):
    if not bool(d['is_month_end'].iat[i]) or not np.isfinite(P[i]):
        continue
    t = ladder(lv, float(P[i]))
    if t != lv and i + 1 < len(d):
        sigs.append({'signal_date': d.index[i], 'exec_date': d.index[i + 1], 'pct': float(P[i]),
                     'dy': float(d['dy'].iat[i]), 'from_level': lv, 'to_level': int(t),
                     'target_pct': float(t), 'from_pct': float(lv)})
        lv = int(t)

daily, m = A.run_index(sigs, pd.Timestamp('2010-06-01'), END, fee=FEE, slip=FEE, fund_fee=0.002, init_target=0)
div_eq = daily['equity'].loc[START:END]

# ---------- MACD 权益 ----------
px = pd.read_csv('work/trin-market-20261026/index-512760.csv', parse_dates=['date']).set_index('date').sort_index()
close = px['close']
base = json.loads(Path('outputs/512760_MACD_12309_vs_12269_稳定性分析_20261008.json').read_text(encoding='utf-8'))['baseline']
trades = base['trades']
open_pos = base.get('openPosition')
dates = close.loc[START:END].index

cap = 100000.0
holding = None
equity = {}
ti = 0
pending = sorted(trades, key=lambda t: t['entryDate'])
for dt in dates:
    ds = dt.strftime('%Y-%m-%d')
    if holding is not None and ds >= holding['exitDate']:
        cap = holding['cap'] * holding['exitPrice'] / holding['entryPrice']
        holding = None
    if holding is None and ti < len(pending) and pending[ti]['entryDate'] == ds:
        holding = dict(pending[ti]); holding['cap'] = cap; ti += 1
    equity[dt] = cap if holding is None else holding['cap'] * close[dt] / holding['entryPrice']

macd_eq = pd.Series(equity).sort_index()

# 未平仓
if holding is not None:
    pass

common = div_eq.index.intersection(macd_eq.index)
div_eq = div_eq.loc[common]
macd_eq = macd_eq.loc[common]
rd = div_eq.pct_change().fillna(0)
rm = macd_eq.pct_change().fillna(0)

# 月度再平衡的组合
month = pd.Series(common, index=common).dt.to_period('M')


def portfolio(w):
    vals = []
    cap_d, cap_m = 1.0, 1.0
    prev_month = None
    for dt in common:
        r_d, r_m = rd.loc[dt], rm.loc[dt]
        cap_d *= (1 + r_d)
        cap_m *= (1 + r_m)
        total = w * cap_m + (1 - w) * cap_d
        vals.append(total)
        cur_month = dt.to_period('M')
        if prev_month is not None and cur_month != prev_month:
            # 月度再平衡
            cap_d = (1 - w) * total
            cap_m = w * total
        prev_month = cur_month
    return pd.Series(vals, index=common)


def stat(eq):
    y = (eq.index[-1] - eq.index[0]).days / 365.25
    c = (eq.iloc[-1] / eq.iloc[0]) ** (1 / y) - 1
    dd = (eq / eq.cummax() - 1).min()
    r = eq.pct_change().dropna()
    return c, dd, r.std() * np.sqrt(252), r.mean() / r.std() * np.sqrt(252)


print(f"区间 {common[0].date()} ~ {common[-1].date()}")
print(f"日收益相关：{rd.corr(rm):.3f}")
print()
print(f"{'配置':<18}{'年化':>8}{'最大回撤':>10}{'波动率':>8}{'Sharpe':>8}")
for w, name in [(0.0, '100% 红利'), (0.2, '80/20'), (0.3, '70/30'), (0.4, '60/40'), (0.5, '50/50'), (0.7, '30/70'), (1.0, '100% MACD')]:
    eq = portfolio(w)
    c, dd, vol, sh = stat(eq)
    print(f"{name:<18}{c*100:>7.2f}%{dd*100:>9.2f}%{vol*100:>7.1f}%{sh:>8.2f}")

c, dd, vol, sh = stat(macd_eq)
print(f"\nMACD 单独: 年化 {c*100:.2f}% 回撤 {dd*100:.2f}% 波动 {vol*100:.1f}%")
c, dd, vol, sh = stat(div_eq)
print(f"红利 单独: 年化 {c*100:.2f}% 回撤 {dd*100:.2f}% 波动 {vol*100:.1f}%")
