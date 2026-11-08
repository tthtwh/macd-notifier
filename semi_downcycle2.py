# -*- coding: utf-8 -*-
"""顶点 → 下跌周期结束（下一波主升浪启动）：
主升浪启动 = 低点后首次「收盘较低点 +30% 且站上 200 日均线」。"""
import numpy as np
import pandas as pd

px = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
eq = pd.read_csv('work/macd-verify/equity.csv', parse_dates=[0]).set_index('date').iloc[:, 0]
c = px['close']
ma200 = c.rolling(200).mean()
a = c.to_numpy()
m = ma200.to_numpy()
n = len(a)

# 找所有「跌超 30%」的熊市段落
bears = []
peak_i = 0
i = 0
while i < n:
    if a[i] > a[peak_i]:
        peak_i = i
    if a[i] <= a[peak_i] * 0.7:
        # 找真正的低点：直到收复前高
        k = i
        trough_i = i
        while k < n and a[k] < a[peak_i]:
            if a[k] < a[trough_i]:
                trough_i = k
            k += 1
        rec_i = k if k < n else None
        bears.append((peak_i, trough_i))
        i = (rec_i + 1) if rec_i is not None else n
        peak_i = rec_i if rec_i is not None else peak_i
    else:
        i += 1

rows = []
print('顶点 → 下跌周期结束（低点 +30% 且站上 MA200）\n')
for idx, (p, t) in enumerate(bears, 1):
    nb = None
    for k in range(t + 1, n):
        if a[k] >= a[t] * 1.30 and np.isfinite(m[k]) and a[k] > m[k]:
            nb = k
            break
    if nb is None:
        nb = n - 1
        note = '（主升浪尚未确认，统计至今）'
    else:
        note = ''
    pdte, tdate, ndate = c.index[p], c.index[t], c.index[nb]
    e = eq.loc[pdte:ndate]
    itot = c.loc[pdte:ndate].iloc[-1] / c.loc[pdte:ndate].iloc[0] - 1
    tot = e.iloc[-1] / e.iloc[0] - 1
    yrs = (ndate - pdte).days / 365
    print(f'第 {idx} 轮：顶点 {pdte.date()} → 低点 {tdate.date()}（{a[t]/a[p]-1:.0%}）'
          f' → 主升浪启动 {ndate.date()}，共 {yrs:.1f} 年 {note}')
    for y in sorted(set(e.loc[pdte:ndate].index.year)):
        s0 = max(pd.Timestamp(f'{y}-01-01'), pdte)
        s1 = min(pd.Timestamp(f'{y}-12-31'), ndate)
        sub = e.loc[s0:s1]
        ic = c.loc[s0:s1]
        if len(sub) < 2:
            continue
        print(f'   {y}: 策略 {sub.iloc[-1]/sub.iloc[0]-1:+7.1%}   指数 {ic.iloc[-1]/ic.iloc[0]-1:+7.1%}')
    print(f'   合计：策略 {tot:+.1%}   指数 {itot:+.1%}\n')
    rows.append((idx, yrs, tot, itot, a[t] / a[p] - 1))

print('=' * 72)
print('汇总')
for idx, yrs, tot, itot, drop in rows:
    print(f'  第 {idx} 轮：跌 {drop:.0%}  {yrs:4.1f} 年  策略 {tot:+8.1%}  指数 {itot:+8.1%}')
