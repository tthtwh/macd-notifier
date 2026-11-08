# -*- coding: utf-8 -*-
"""半导体指数当前状态 + 入场条件的历史胜率。"""
from pathlib import Path

import numpy as np
import pandas as pd

df = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
close = df['close']
ma20 = close.rolling(20).mean()
ma60 = close.rolling(60).mean()
ma120 = close.rolling(120).mean()
ma200 = close.rolling(200).mean()
hi252 = close.rolling(252).max()
dd = close / hi252 - 1

ema12 = close.ewm(span=12, adjust=False).mean()
ema30 = close.ewm(span=30, adjust=False).mean()
dif = ema12 - ema30
dea = dif.ewm(span=9, adjust=False).mean()
hist = dif - dea


def trailing_pct(s, win):
    out = np.full(len(s), np.nan)
    a = s.to_numpy()
    for i in range(len(a)):
        lo = max(0, i - win + 1)
        w = a[lo:i + 1]
        out[i] = np.mean(w <= a[i])
    return pd.Series(out, index=s.index)


pct3 = trailing_pct(close, 756)
pct5 = trailing_pct(close, 1260)
pct_all = trailing_pct(close, len(close))

buy_sig = (hist.shift(1) <= 0) & (hist > 0)
sell_sig = (hist.shift(1) >= 0) & (hist < 0)

# 构造交易
trades = []
i = 0
n = len(df)
pos = None
for k in range(n):
    if pos is None and k > 0 and buy_sig.iloc[k - 1]:
        pos = {'entry_i': k, 'entry': close.iloc[k]}
    elif pos is not None and sell_sig.iloc[k]:
        pos['exit_i'] = k
        pos['exit'] = close.iloc[k]
        pos['ret'] = pos['exit'] / pos['entry'] - 1
        trades.append(pos)
        pos = None
if pos is not None:
    pos['exit_i'] = n - 1
    pos['exit'] = close.iloc[-1]
    pos['ret'] = pos['exit'] / pos['entry'] - 1
    pos['open'] = True
    trades.append(pos)

for t in trades:
    k = t['entry_i']
    t['date'] = df.index[k]
    t['pct3'] = pct3.iloc[k]
    t['pct5'] = pct5.iloc[k]
    t['ma200_ratio'] = close.iloc[k] / ma200.iloc[k] - 1
    t['dd'] = dd.iloc[k]
    t['hold'] = (df.index[t['exit_i']] - df.index[k]).days

T = pd.DataFrame(trades)
print(f"交易 {len(T)} 笔，胜率 {(T['ret']>0).mean():.1%}，平均收益 {T['ret'].mean():+.1%}，"
      f"平均盈 {T.loc[T['ret']>0,'ret'].mean():+.1%}，平均亏 {T.loc[T['ret']<=0,'ret'].mean():+.1%}")

# 按入场时 3 年价格分位分组
T['pct3_bin'] = pd.cut(T['pct3'], [0, .2, .4, .6, .8, 1.0], labels=['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'])
print('\n按入场时 3 年价格分位:')
g = T.groupby('pct3_bin', observed=True).agg(笔数=('ret', 'size'), 胜率=('ret', lambda x: (x > 0).mean()), 平均收益=('ret', 'mean'), 最差=('ret', 'min'))
print(g.to_string(float_format=lambda x: f"{x:.2%}" if abs(x) < 10 else f"{x:.0f}"))

print('\n按入场时相对 MA200:')
T['ma_bin'] = pd.cut(T['ma200_ratio'], [-1, -0.15, -0.05, 0.05, 0.15, 1], labels=['<-15%', '-15~-5%', '±5%', '5~15%', '>15%'])
g2 = T.groupby('ma_bin', observed=True).agg(笔数=('ret', 'size'), 胜率=('ret', lambda x: (x > 0).mean()), 平均收益=('ret', 'mean'))
print(g2.to_string(float_format=lambda x: f"{x:.2%}" if abs(x) < 10 else f"{x:.0f}"))

# 买入信号后的前向收益
fwd = {}
for h in (20, 60, 120):
    fwd[h] = close.shift(-h) / close - 1
sig_idx = np.where(buy_sig.fillna(False).to_numpy())[0]
print(f"\n所有买入信号 {len(sig_idx)} 次，之后 N 日收益:")
for h in (20, 60, 120):
    r = fwd[h].iloc[sig_idx].dropna()
    print(f"  {h:3d}日: 平均 {r.mean():+.2%}  胜率 {(r>0).mean():.1%}")

# 当前状态
last = df.index[-1]
k = -1
print('\n' + '=' * 50)
print(f"当前状态 {last.date()}")
print(f"  收盘 {close.iloc[k]:.1f}")
print(f"  年内 {(close.iloc[k]/close.loc['2025-12-31']-1):+.1%}" if '2025-12-31' in close.index else '')
print(f"  距 252 日高点 {dd.iloc[k]:+.1%}")
print(f"  3 年价格分位 {pct3.iloc[k]:.1%}")
print(f"  5 年价格分位 {pct5.iloc[k]:.1%}")
print(f"  全历史分位 {pct_all.iloc[k]:.1%}")
print(f"  相对 MA200 {(close.iloc[k]/ma200.iloc[k]-1):+.1%}")
print(f"  相对 MA60  {(close.iloc[k]/ma60.iloc[k]-1):+.1%}")
print(f"  相对 MA20  {(close.iloc[k]/ma20.iloc[k]-1):+.1%}")
print(f"  DIF {dif.iloc[k]:.2f}  DEA {dea.iloc[k]:.2f}  Hist {hist.iloc[k]:.2f}")
print(f"  Hist 连续为正 {int((hist.iloc[k::-1] > 0).cumprod().sum())} 天" if hist.iloc[k] > 0 else
      f"  Hist 连续为负 {int((hist.iloc[k::-1] < 0).cumprod().sum())} 天")
print(f"  最后 5 日 Hist: {[round(x,2) for x in hist.iloc[-5:]]}")
print(f"  策略当前应为：{'持仓' if hist.iloc[k] > 0 else '空仓'}")
