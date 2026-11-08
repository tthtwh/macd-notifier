# -*- coding: utf-8 -*-
"""深跌入场后的“早买代价”：最大不利偏移与前瞻收益。"""
import numpy as np
import pandas as pd

df = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
c = df['close']
ma200 = c.rolling(200).mean()
hi252 = c.rolling(252).max()
dd = c / hi252 - 1

e12 = c.ewm(span=12, adjust=False).mean()
e30 = c.ewm(span=30, adjust=False).mean()
dif = e12 - e30
dea = dif.ewm(span=9, adjust=False).mean()
h = dif - dea
buy = (h.shift(1) <= 0) & (h > 0)
sell = (h.shift(1) >= 0) & (h < 0)

pos = None
tr = []
for k in range(len(df)):
    if pos is None and k > 0 and buy.iloc[k - 1]:
        pos = {'i': k, 'p': c.iloc[k]}
    elif pos is not None and sell.iloc[k]:
        pos['r'] = c.iloc[k] / pos['p'] - 1
        pos['exit_i'] = k
        tr.append(pos)
        pos = None
T = pd.DataFrame(tr)
T['date'] = df.index[T['i']]
T['ma'] = c.iloc[T['i']].to_numpy() / ma200.iloc[T['i']].to_numpy() - 1
T['dd'] = dd.iloc[T['i']].to_numpy()
T['hold'] = T['exit_i'] - T['i']

deep = T[(T['ma'] <= -.10) & (T['dd'] <= -.30)].copy()
arr = c.to_numpy()
rows = []
for _, t in deep.iterrows():
    i = int(t['i'])
    entry = t['p']
    path = arr[i:i + 250]
    mae = path.min() / entry - 1
    f60 = arr[min(i + 60, len(arr) - 1)] / entry - 1
    f120 = arr[min(i + 120, len(arr) - 1)] / entry - 1
    f250 = arr[min(i + 250, len(arr) - 1)] / entry - 1
    rows.append({'日期': t['date'].date(), '交易收益': t['r'], '持有天': int(t['hold']),
                 '期间最大回撤': mae, '60日': f60, '120日': f120, '250日': f250})
R = pd.DataFrame(rows)
print(R.to_string(index=False, float_format=lambda x: f"{x:+.0%}"))
print()
print(f"平均：交易 {R['交易收益'].mean():+.1%}  60日 {R['60日'].mean():+.1%}  "
      f"120日 {R['120日'].mean():+.1%}  250日 {R['250日'].mean():+.1%}")
print(f"60日为正比例 {(R['60日']>0).mean():.0%}  120日 {(R['120日']>0).mean():.0%}  250日 {(R['250日']>0).mean():.0%}")
print(f"平均最大不利偏移 {R['期间最大回撤'].mean():+.1%}  最深 {R['期间最大回撤'].min():+.1%}")

# 大级别熊市：从高点跌超 30% 到见底、再到收复前高
print('\n--- 主要熊市与修复 ---')
peak_i = 0
episodes = []
for i in range(1, len(arr)):
    if arr[i] > arr[peak_i]:
        peak_i = i
    dd_now = arr[i] / arr[peak_i] - 1
    if dd_now <= -0.30:
        trough_i = i
        j = i
        while j < len(arr) - 1 and arr[j + 1] < arr[peak_i]:
            j += 1
        recover = j + 1 if arr[j + 1] >= arr[peak_i] else None
        episodes.append((df.index[peak_i].date(), df.index[trough_i].date(), arr[trough_i] / arr[peak_i] - 1,
                         None if recover is None else df.index[recover].date(),
                         (df.index[trough_i] - df.index[peak_i]).days,
                         None if recover is None else (df.index[recover] - df.index[trough_i]).days))
        peak_i = i
see = set()
for e in episodes:
    key = e[0]
    if key in see:
        continue
    see.add(key)
    print(f"  高点 {e[0]} -> 低点 {e[1]} (跌 {e[2]:.0%}，{e[4]} 天) -> 收复前高 {e[3]}"
          f"{'' if e[5] is None else f'（低点起 {e[5]} 天）'}")
