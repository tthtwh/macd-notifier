# -*- coding: utf-8 -*-
"""每年 20 万新增资金的投放方式对比（现行五档策略）。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import sweep_params as S

FEE = 0.0010          # 5bp + 5bp
CASH_M = (1.02) ** (1 / 12) - 1
START = pd.Timestamp('2010-06-01')
END = pd.Timestamp('2026-10-26')
CONTRIB = 200_000.0

d = S.base.copy()
d['pct'] = S.pct_series(2520)
d = d.loc[(d.index >= START) & (d.index <= END)]
me = d[d['is_month_end']]
dates = list(me.index)
pct = me['pct'].to_numpy(float)
me_ret = d['close_t'].loc[dates].pct_change().fillna(0).to_numpy(float)


def ladder(level, p):
    if not np.isfinite(p):
        return level
    up = [0.60, 0.70, 0.80, 0.90]
    down = [0.40, 0.50, 0.60, 0.70]
    if level == 0:
        return 25 if p >= up[0] else 0
    if level == 25:
        if p >= up[1]:
            return 50
        if p <= down[3]:
            return 0
        return 25
    if level == 50:
        if p >= up[2]:
            return 75
        if p <= down[2]:
            return 25
        return 50
    if level == 75:
        if p >= up[3]:
            return 100
        if p <= down[1]:
            return 50
        return 75
    if level == 100:
        return 75 if p <= down[0] else 100
    return level


def simulate(policy):
    cash = 0.0
    units = 0.0
    level = 0
    eq_list, nav_list, cash_ratio = [], [], []
    flows = []
    fund_units = 0.0
    nav = 1.0
    for i, dt in enumerate(dates):
        cash *= (1 + CASH_M)
        price = float(d.loc[dt, 'close_t'])

        add = 0.0
        if policy == 'A' and dt.month == 1:
            add = CONTRIB
        elif policy == 'B':
            add = CONTRIB / 12
        elif policy == 'C' and dt.month == 1:
            add = CONTRIB
        elif policy == 'D' and dt.month == 1:
            add = CONTRIB
        if add:
            if fund_units == 0:
                fund_units = add
                nav = 1.0
            else:
                fund_units += add / nav
            cash += add
            flows.append((dt, add))

        level = ladder(level, pct[i])
        target = 1.0 if policy == 'D' else level / 100.0
        if policy == 'C':
            if not (np.isfinite(pct[i]) and pct[i] >= 0.75):
                target = min(target, (units * price) / (cash + units * price)) if (cash + units * price) > 0 else 0.0

        total = cash + units * price
        delta = target * total - units * price
        if abs(delta) > 1.0:
            cost = abs(delta) * FEE
            cash -= delta + cost
            units += delta / price

        eq = cash + units * price
        if fund_units > 0:
            nav = eq / fund_units
        eq_list.append(eq)
        nav_list.append(nav if fund_units > 0 else 1.0)
        cash_ratio.append(cash / eq if eq > 0 else 0.0)
    return (pd.Series(eq_list, index=dates), pd.Series(nav_list, index=dates),
            np.array(cash_ratio), flows)


def irr(flows, final, end):
    dates = [f[0] for f in flows] + [end]
    amts = [-f[1] for f in flows] + [final]
    t0 = dates[0]

    def npv(r):
        return sum(c / (1 + r) ** ((dt - t0).days / 365.25) for dt, c in zip(dates, amts))

    lo, hi = -0.95, 1.5
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


names = {
    'A': 'A 每年1月按目标仓位投入',
    'B': 'B 全年12个月均匀投入',
    'C': 'C 攒到分位≥75%才投入',
    'D': 'D 每年1月无视信号满仓',
}

print(f"{'方案':<24}{'期末资产':>13}{'投入':>11}{'IRR':>8}{'NAV最大回撤':>12}{'平均现金':>9}")
rows = []
for k in ['A', 'B', 'C', 'D']:
    eq, nav, cr, flows = simulate(k)
    dd = (nav / nav.cummax() - 1).min()
    contributed = sum(f[1] for f in flows)
    rows.append({'方案': names[k], '期末资产': eq.iloc[-1], '投入': contributed,
                 'IRR': irr(flows, eq.iloc[-1], eq.index[-1]), '最大回撤': dd, '平均现金': cr.mean()})
    print(f"{names[k]:<24}{eq.iloc[-1]:>13,.0f}{contributed:>11,.0f}{rows[-1]['IRR']*100:>7.2f}%"
          f"{dd*100:>11.2f}%{cr.mean()*100:>8.1f}%")

pd.DataFrame(rows).to_csv('work/dividend-strategy/contribution-timing.csv', index=False, encoding='utf-8-sig')
