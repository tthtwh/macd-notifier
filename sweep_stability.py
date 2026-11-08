# -*- coding: utf-8 -*-
"""对候选变体做滚动 5 年稳定性检验，并生成报告。"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
sys.path.insert(0, str(Path('.').resolve()))
import analysis as A
import sweep_params as S

END = A.LAST

CANDIDATES = [
    ('现行五档（部署）', '阶梯 W10y(2520) up0.60/0.70/0.80/0.90 down0.70/0.60/0.50/0.40'),
    ('你的规则 90/50', '全有全无 W10y(2520) buy0.90/sell0.50'),
    ('买0.85 卖0.50 W10y', '全有全无 W10y(2520) buy0.85/sell0.50'),
    ('买0.80 卖0.50 W10y', '全有全无 W10y(2520) buy0.80/sell0.50'),
    ('买0.80 卖0.45 W7.5y', '全有全无 W7.5y(1890) buy0.80/sell0.45'),
    ('买0.90 卖0.45 W7.5y', '全有全无 W7.5y(1890) buy0.90/sell0.45'),
    ('买0.85 卖0.40 W5y', '全有全无 W5y(1260) buy0.85/sell0.40'),
    ('静态 50/60/70/80 W7.5y', '静态五档 W7.5y(1890) 0.50/0.60/0.70/0.80'),
    ('阶梯 50/60/70/80 慢卖 W7.5y', '阶梯 W7.5y(1890) up0.50/0.60/0.70/0.80 down0.70/0.60/0.50/0.50'),
    ('阶梯 60-90 快卖 W10y', '阶梯 W10y(2520) up0.60/0.70/0.80/0.90 down0.65/0.55/0.45/0.35'),
]

# 建立 name -> (W, resolve, fam)
lookup = {}
for (name, W, resolve, fam) in S.variants():
    lookup[name] = (W, resolve, fam)

PCT = {W: S.pct_series(W) for (_, W) in S.WINDOWS}


def rolling5(sigs, starts):
    out = []
    for start in starts:
        end = min(start + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (end - start).days < 1500:
            continue
        m, _ = S.evaluate(sigs, start, end)
        out.append(m['cagr'])
    return out


def buyhold_rolling(starts):
    out = []
    for start in starts:
        end = min(start + pd.DateOffset(years=5) - pd.Timedelta(days=1), END)
        if (end - start).days < 1500:
            continue
        _, m = A.run_index([], start, end, fee=S.FEE, slip=S.SLIP, fund_fee=S.FUND, init_target=100)
        out.append(m['cagr'])
    return out


starts = [pd.Timestamp(f'{y}-01-01') for y in range(2010, 2022)]
bh = buyhold_rolling(starts)

rows = []
for label, name in CANDIDATES:
    if name not in lookup:
        print('MISSING', name)
        continue
    W, resolve, fam = lookup[name]
    S.set_pct(PCT[W])
    sigs = S.build_signals(resolve, S.A.df)
    rets = np.array(rolling5(sigs, starts))
    rows.append({
        '策略': label,
        '变体名': name,
        '滚动5年均值': rets.mean(),
        '滚动5年最差': rets.min(),
        '滚动5年最好': rets.max(),
        '滚动5年标准差': rets.std(),
        '跑赢持有比例': float(np.mean(rets > np.array(bh))),
    })

bh_row = {
    '策略': '买入持有100%', '变体名': '-',
    '滚动5年均值': np.mean(bh), '滚动5年最差': np.min(bh), '滚动5年最好': np.max(bh),
    '滚动5年标准差': np.std(bh), '跑赢持有比例': float('nan'),
}
rows.append(bh_row)

df = pd.DataFrame(rows)
df = df.sort_values('滚动5年均值', ascending=False)
pd.set_option('display.width', 200)
print(df.to_string(index=False, float_format=lambda x: f"{x:.4f}"))

df.to_csv('work/dividend-strategy/param-stability.csv', index=False, encoding='utf-8-sig')

# 各滚动窗口明细
print('\n=== 每个 5 年窗口的 CAGR ===')
detail = []
for label, name in CANDIDATES:
    if name not in lookup:
        continue
    W, resolve, fam = lookup[name]
    S.set_pct(PCT[W])
    sigs = S.build_signals(resolve, S.A.df)
    rets = rolling5(sigs, starts)
    detail.append([label] + [f"{r*100:.2f}%" for r in rets])
detail.append(['买入持有'] + [f"{r*100:.2f}%" for r in bh])
years = [s.year for s in starts][:len(bh)]
print('窗口起点', years)
for row in detail:
    print(f"{row[0]:<28}", ' '.join(row[1:]))
