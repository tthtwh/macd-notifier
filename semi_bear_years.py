# -*- coding: utf-8 -*-
"""牛市顶峰大跌 → 收复前高（下一波启动）期间，MACD 策略每年盈亏。"""
import numpy as np
import pandas as pd

px = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
eq = pd.read_csv('work/macd-verify/equity.csv', parse_dates=[0]).set_index('date').iloc[:, 0]
c = px['close']
n = len(c)
a = c.to_numpy()

episodes = []
peak_i = 0
i = 0
while i < n:
    if a[i] > a[peak_i]:
        peak_i = i
    if a[i] <= a[peak_i] * 0.7:
        k = i
        trough_i = i
        while k < n and a[k] < a[peak_i]:
            if a[k] < a[trough_i]:
                trough_i = k
            k += 1
        rec_i = k if k < n else None
        episodes.append((peak_i, trough_i, rec_i))
        i = (rec_i + 1) if rec_i is not None else n
        peak_i = rec_i if rec_i is not None else peak_i
    else:
        i += 1

print(f'共识别 {len(episodes)} 轮「跌超 30% 后等待收复前高」的周期\n')
tot = []
for idx, (p, t, r) in enumerate(episodes, 1):
    pdte, tdate = c.index[p], c.index[t]
    rdate = c.index[r] if r is not None else c.index[-1]
    drop = a[t] / a[p] - 1
    label = '（至今未收复）' if r is None else ''
    print(f'=== 第 {idx} 轮：高点 {pdte.date()} → 低点 {tdate.date()}（{drop:.0%}）→ 收复 {rdate.date()} {label}')
    e = eq.loc[pdte:rdate]
    seg = e.pct_change().fillna(0)
    yearly = e.groupby(e.index.year).apply(lambda s: s.iloc[-1] / s.iloc[0] - 1)
    # 首尾年份按实际区间
    for y, v in yearly.items():
        start = max(pd.Timestamp(f'{y}-01-01'), pdte)
        end = min(pd.Timestamp(f'{y}-12-31'), rdate)
        sub = e.loc[start:end]
        rr = sub.iloc[-1] / sub.iloc[0] - 1 if len(sub) > 1 else 0.0
        idx_ret = c.loc[start:end]
        ir = idx_ret.iloc[-1] / idx_ret.iloc[0] - 1 if len(idx_ret) > 1 else 0.0
        print(f'   {y}: 策略 {rr:+7.1%}   指数 {ir:+7.1%}   （{start.date()} ~ {end.date()}）')
    total = e.iloc[-1] / e.iloc[0] - 1
    itot = c.loc[pdte:rdate].iloc[-1] / c.loc[pdte:rdate].iloc[0] - 1
    print(f'   区间合计：策略 {total:+.1%}   指数 {itot:+.1%}   用时 {(rdate - pdte).days / 365:.1f} 年\n')
    tot.append((idx, total, itot, (rdate - pdte).days / 365))

print('汇总：')
for idx, t_, i_, y in tot:
    print(f'  第 {idx} 轮：策略 {t_:+.1%}  指数 {i_:+.1%}  用时 {y:.1f} 年')
