# -*- coding: utf-8 -*-
"""验证：同花顺半导体指数 881121，2007-2026，MACD(12,30,9) 趋势策略。"""
import json
import re
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

BASE = 'https://d.10jqka.com.cn'
SYMBOL = 'bk_881121'
CACHE = Path('work/macd-verify')
CACHE.mkdir(parents=True, exist_ok=True)


def get(url):
    import subprocess
    out = subprocess.run(['curl', '-s', '--max-time', '30', '-H', 'Referer: https://d.10jqka.com.cn/',
                          '-H', 'User-Agent: Mozilla/5.0', url], capture_output=True)
    return out.stdout.decode('utf-8', 'ignore')


def jsonp(text):
    s = text.find('(')
    e = text.rfind(')')
    return json.loads(text[s + 1:e])


meta = jsonp(get(f'{BASE}/v6/line/{SYMBOL}/01/all.js'))
years = sorted({int(y[0]) for y in meta['sortYear']})
print('years', years[0], '->', years[-1], 'bars', meta['total'], 'start', meta['start'])

rows = []
for y in years:
    fp = CACHE / f'{y}.js'
    if fp.exists() and fp.stat().st_size > 100:
        txt = fp.read_text(encoding='utf-8')
    else:
        txt = get(f'{BASE}/v6/line/{SYMBOL}/01/{y}.js')
        fp.write_text(txt, encoding='utf-8')
    payload = jsonp(txt)
    data = payload.get('data') or ''
    for line in data.split(';'):
        parts = line.split(',')
        if len(parts) < 6:
            continue
        d, o, _h, _l, c, v = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
        if not re.fullmatch(r'\d{8}', d):
            continue
        rows.append({'date': pd.Timestamp(f'{d[:4]}-{d[4:6]}-{d[6:]}'),
                     'open': float(o), 'close': float(c), 'volume': float(v or 0)})

df = pd.DataFrame(rows).drop_duplicates('date').sort_values('date').reset_index(drop=True)
print('rows', len(df), df['date'].iloc[0].date(), '->', df['date'].iloc[-1].date())

# MACD(12,30,9)
close = df['close']
ema_fast = close.ewm(span=12, adjust=False).mean()
ema_slow = close.ewm(span=30, adjust=False).mean()
dif = ema_fast - ema_slow
dea = dif.ewm(span=9, adjust=False).mean()
hist = dif - dea

# 信号：hist 上穿 0 买入（次日开盘），下穿 0 卖出（当日收盘）
buy_sig = (hist.shift(1) <= 0) & (hist > 0)
sell_sig = (hist.shift(1) >= 0) & (hist < 0)

CASH = 100000.0
BUY_COST = 0.0003
SELL_COST = 0.0006
cap = CASH
units = 0.0
entry = None
trades = []
equity = []
for i in range(len(df)):
    if units == 0 and i > 0 and buy_sig.iloc[i - 1]:
        # 前一日收盘出现买入信号 → 今日开盘买入
        p = df['open'].iloc[i]
        units = cap * (1 - BUY_COST) / p
        cap = 0.0
        entry = {'entry_date': df['date'].iloc[i], 'entry_price': p}
    if units > 0 and sell_sig.iloc[i]:
        p = df['close'].iloc[i]
        cap = units * p * (1 - SELL_COST)
        units = 0.0
        if entry:
            entry['exit_date'] = df['date'].iloc[i]
            entry['exit_price'] = p
            entry['ret'] = p / entry['entry_price'] - 1 - 0.0009
            trades.append(entry)
            entry = None
    equity.append(cap + units * df['close'].iloc[i])

eq = pd.Series(equity, index=df['date'])
years_span = (eq.index[-1] - eq.index[0]).days / 365.25
cagr = (eq.iloc[-1] / CASH) ** (1 / years_span) - 1
dd = (eq / eq.cummax() - 1)
maxdd = dd.min()
yearly = eq.groupby(eq.index.year).apply(lambda s: s.iloc[-1] / s.iloc[0] - 1)

# 分年回撤（年内最大回撤）
yd = eq.groupby(eq.index.year).apply(lambda s: (s / s.cummax() - 1).min())

print(f"\n总收益 {eq.iloc[-1]/CASH-1:+.1%}  年化 {cagr:.2%}  最大回撤 {maxdd:.2%}  交易 {len(trades)} 笔")
print(f"胜率 {np.mean([t['ret']>0 for t in trades]):.1%}")
print('\n分年收益 / 年内最大回撤:')
for y in yearly.index:
    print(f"  {y}: {yearly[y]:+7.1%}   回撤 {yd[y]:7.1%}")

print('\n2008 与 2015 分段:')
for y0, y1 in [(2007, 2009), (2015, 2016)]:
    sub = eq.loc[f'{y0}':f'{y1}']
    print(f"  {y0}-{y1}: 期末/期初 {sub.iloc[-1]/sub.iloc[0]-1:+.1%}  区间最大回撤 {(sub/sub.cummax()-1).min():.1%}")

eq.to_csv(CACHE / 'equity.csv')
df.to_csv(CACHE / 'prices.csv', index=False)
print('\nsaved', CACHE)
