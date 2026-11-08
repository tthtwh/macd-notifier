# -*- coding: utf-8 -*-
"""空仓时长 vs 下一次买入的盈利概率。"""
import numpy as np
import pandas as pd

df = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
c = df['close']
e12 = c.ewm(span=12, adjust=False).mean()
e30 = c.ewm(span=30, adjust=False).mean()
dif = e12 - e30
dea = dif.ewm(span=9, adjust=False).mean()
h = dif - dea
buy = (h.shift(1) <= 0) & (h > 0)
sell = (h.shift(1) >= 0) & (h < 0)

pos = None
tr = []
last_exit = None
for k in range(len(df)):
    if pos is None and k > 0 and buy.iloc[k - 1]:
        pos = {'i': k, 'p': c.iloc[k], 'gap': None if last_exit is None else (df.index[k] - last_exit).days}
    elif pos is not None and sell.iloc[k]:
        pos['r'] = c.iloc[k] / pos['p'] - 1
        pos['d'] = df.index[k]
        tr.append(pos)
        last_exit = df.index[k]
        pos = None
T = pd.DataFrame(tr)
T['date'] = df.index[T['i']]

print(f'交易 {len(T)} 笔，整体胜率 {(T["r"]>0).mean():.0%}，平均 {T["r"].mean():+.1%}')
print(f'空仓天数：中位数 {T["gap"].median():.0f} 天，平均 {T["gap"].mean():.0f} 天\n')

bins = [-1, 10, 30, 60, 120, 250, 10000]
labels = ['≤10天', '11-30天', '31-60天', '61-120天', '121-250天', '>250天']
T['bucket'] = pd.cut(T['gap'], bins, labels=labels)
g = T.groupby('bucket', observed=True).agg(
    笔数=('r', 'size'), 胜率=('r', lambda x: (x > 0).mean()),
    平均收益=('r', 'mean'), 中位=('r', 'median'), 最好=('r', 'max'), 最差=('r', 'min'))
print(g.to_string(float_format=lambda x: f'{x:.1%}' if abs(x) <= 1 else f'{x:.0f}'))

print('\n相关系数（空仓天数 vs 收益）:', round(T['gap'].corr(T['r']), 3))

print('\n空仓 >250 天的入场明细:')
for _, t in T[T['gap'] > 250].iterrows():
    print(f'  {t["date"].date()}  空仓 {int(t["gap"])} 天  →  {t["r"]:+.1%}')
