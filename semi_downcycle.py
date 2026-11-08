# -*- coding: utf-8 -*-
"""牛市顶点 → 下跌周期结束（下一波主升浪启动）期间，策略每年盈亏。
主升浪启动定义：低点反弹 20%（另给 30% 版本作对照）。"""
import numpy as np
import pandas as pd

px = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
eq = pd.read_csv('work/macd-verify/equity.csv', parse_dates=[0]).set_index('date').iloc[:, 0]
c = px['close']
a = c.to_numpy()
n = len(a)

episodes = []
peak_i = 0
i = 0
while i < n:
    if a[i] > a[peak_i]:
        peak_i = i
    if a[i] <= a[peak_i] * 0.7:
        k = i
        trough_i = i
        while k < n:
            if a[k] < a[trough_i]:
                trough_i = k
            # 反弹够就结束这一轮下跌
            if a[trough_i] > 0 and a[k] >= a[trough_i] * 1.20 and k > trough_i + 5:
                break
            k += 1
        episodes.append((peak_i, trough_i, min(k, n - 1)))
        i = k + 1
        peak_i = min(k, n - 1)
    else:
        i += 1


def show(thr):
    print(f'\n=== 以「低点反弹 {thr:.0%}」作为下一波主升浪启动 ===')
    rows = []
    for idx, (p, t, nb) in enumerate(episodes, 1):
        pdte, tdate, ndate = c.index[p], c.index[t], c.index[nb]
        e = eq.loc[pdte:ndate]
        if len(e) < 2:
            continue
        yrs = (ndate - pdte).days / 365
        tot = e.iloc[-1] / e.iloc[0] - 1
        itot = c.loc[pdte:ndate].iloc[-1] / c.loc[pdte:ndate].iloc[0] - 1
        print(f'第 {idx} 轮：高点 {pdte.date()} → 低点 {tdate.date()}（{a[t]/a[p]-1:.0%}）'
              f' → 主升浪 {ndate.date()}  共 {yrs:.1f} 年')
        for y in sorted(set(e.loc[pdte:ndate].index.year)):
            start = max(pd.Timestamp(f'{y}-01-01'), pdte)
            end = min(pd.Timestamp(f'{y}-12-31'), ndate)
            sub = e.loc[start:end]
            if len(sub) < 2:
                continue
            rr = sub.iloc[-1] / sub.iloc[0] - 1
            ic = c.loc[start:end]
            ir = ic.iloc[-1] / ic.iloc[0] - 1 if len(ic) > 1 else 0
            print(f'   {y}: 策略 {rr:+7.1%}   指数 {ir:+7.1%}')
        print(f'   合计：策略 {tot:+.1%}   指数 {itot:+.1%}   （{yrs:.1f} 年）')
        rows.append((idx, pdte, tdate, ndate, yrs, tot, itot, a[t] / a[p] - 1))
        print()
    return rows


rows = show(0.20)
print('=' * 70)
print('汇总（顶点 → 主升浪启动）')
for idx, p, t, nb, yrs, tot, itot, drop in rows:
    print(f'  第 {idx} 轮：跌 {drop:.0%}  用时 {yrs:.1f} 年  策略 {tot:+.1%}  指数 {itot:+.1%}')
