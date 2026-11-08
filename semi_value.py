# -*- coding: utf-8 -*-
"""MACD 信号的「性价比」打分：什么状态下加仓历史期望更高。"""
import numpy as np
import pandas as pd

df = pd.read_csv('work/macd-verify/prices.csv', parse_dates=['date']).set_index('date').sort_index()
c = df['close']
ma20, ma60, ma120, ma200 = (c.rolling(n).mean() for n in (20, 60, 120, 200))
hi252 = c.rolling(252).max()
dd = c / hi252 - 1
vol60 = c.pct_change().rolling(60).std() * np.sqrt(252)

e12 = c.ewm(span=12, adjust=False).mean()
e30 = c.ewm(span=30, adjust=False).mean()
dif = e12 - e30
dea = dif.ewm(span=9, adjust=False).mean()
h = dif - dea
buy = (h.shift(1) <= 0) & (h > 0)
sell = (h.shift(1) >= 0) & (h < 0)

a = c.to_numpy()


def tpct(win):
    return pd.Series([np.mean(a[max(0, i - win + 1):i + 1] <= a[i]) for i in range(len(a))], index=c.index)


pct3, pct5 = tpct(756), tpct(1260)

pos = None
tr = []
for k in range(len(df)):
    if pos is None and k > 0 and buy.iloc[k - 1]:
        pos = {'i': k, 'p': c.iloc[k]}
    elif pos is not None and sell.iloc[k]:
        pos['r'] = c.iloc[k] / pos['p'] - 1
        tr.append(pos)
        pos = None
T = pd.DataFrame(tr)
T['date'] = df.index[T['i']]
T['pct3'] = pct3.iloc[T['i']].to_numpy()
T['pct5'] = pct5.iloc[T['i']].to_numpy()
T['ma200'] = (c.iloc[T['i']].to_numpy() / ma200.iloc[T['i']].to_numpy() - 1)
T['dd'] = dd.iloc[T['i']].to_numpy()
T['vol'] = vol60.iloc[T['i']].to_numpy()

print(f"样本 {len(T)} 笔，整体胜率 {(T['r']>0).mean():.0%}，平均 {T['r'].mean():+.1%}，"
      f"期望 {T['r'].mean():+.2%}\n")


def bucket(name, col, edges, labels):
    T['b'] = pd.cut(T[col], edges, labels=labels)
    g = T.groupby('b', observed=True).agg(笔数=('r', 'size'), 胜率=('r', lambda x: (x > 0).mean()),
                                          平均=('r', 'mean'), 最差=('r', 'min'), 平均持有=('i', lambda x: 0))
    print(f'--- {name}')
    print(g[['笔数', '胜率', '平均', '最差']].to_string(float_format=lambda x: f"{x:.0%}" if abs(x) <= 1 else f"{x:.0f}"))
    print()


bucket('入场时 3年价格分位', 'pct3', [0, .2, .4, .6, .8, 1.0], ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'])
bucket('入场时 相对MA200', 'ma200', [-1, -.2, -.1, 0, .1, .2, 1], ['<-20%', '-20~-10%', '-10~0', '0~10%', '10~20%', '>20%'])
bucket('入场时 距252日高点', 'dd', [-1, -.4, -.3, -.2, -.1, 0], ['<-40%', '-40~-30%', '-30~-20%', '-20~-10%', '>-10%'])
bucket('入场时 60日波动率', 'vol', [0, .3, .4, .5, .6, 5], ['<30%', '30-40%', '40-50%', '50-60%', '>60%'])

# 组合打分：便宜(3Y分位低) + 深跌(跌破MA200或距高点远)
T['cheap'] = ((T['pct3'] <= .40).astype(int) + (T['ma200'] <= -.10).astype(int) + (T['dd'] <= -.30).astype(int))
print('--- 性价比打分（0-3 分）')
g = T.groupby('cheap').agg(笔数=('r', 'size'), 胜率=('r', lambda x: (x > 0).mean()), 平均=('r', 'mean'), 最差=('r', 'min'))
print(g.to_string(float_format=lambda x: f"{x:.0%}" if abs(x) <= 1 else f"{x:.0f}"))

# 当前打分
k = len(c) - 1
score = int(c.iloc[k] / c.iloc[max(0, k - 755):k + 1].to_numpy().max() <= 1) * 0
score = ((pct3.iloc[k] <= .40) + (c.iloc[k] / ma200.iloc[k] - 1 <= -.10) + (dd.iloc[k] <= -.30))
print(f"\n当前：3Y分位 {pct3.iloc[k]:.0%}  MA200 {c.iloc[k]/ma200.iloc[k]-1:+.0%}  距高点 {dd.iloc[k]:+.0%}  波动 {vol60.iloc[k]:.0%}")
print(f"当前性价比打分：{score} / 3")

# 分档回测：基准仓位 60%，打分>=2 时提到 100%
cap = 1.0
units = 0.0
equity = []
w = 0.6
pos = None
for k in range(len(df)):
    if pos is None and k > 0 and buy.iloc[k - 1]:
        # 打分（用入场日的前一交易日特征）
        j = k - 1
        sc = ((pct3.iloc[j] <= .40) + (c.iloc[j] / ma200.iloc[j] - 1 <= -.10) + (dd.iloc[j] <= -.30))
        w = 1.0 if sc >= 2 else 0.6
        px = c.iloc[k]
        units = cap * w / px
        cash = cap * (1 - w)
        pos = {}
    if pos:
        val = units * c.iloc[k] + cash
    else:
        val = cap
    equity.append(val)
    if pos and sell.iloc[k]:
        cap = units * c.iloc[k] + cash
        units = 0
        pos = None
        cash = cap

eq = pd.Series(equity, index=df.index)
years = (eq.index[-1] - eq.index[0]).days / 365.25
cagr = (eq.iloc[-1] / 1.0) ** (1 / years) - 1
ddmax = (eq / eq.cummax() - 1).min()
print(f"\n动态仓位(60%基准,评分>=2加到100%): 年化 {cagr:.1%} 回撤 {ddmax:.1%} 期末 {eq.iloc[-1]:.1f}x")
