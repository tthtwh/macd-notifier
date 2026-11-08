# -*- coding: utf-8 -*-
"""Investigate why the dividend yield dropped from 6.67% to 4.41% in July 2025.
Was it price going up, or dividends going down?"""

import json
import numpy as np
import pandas as pd
from pathlib import Path

ROOT = Path('work/dividend-strategy/research')
DATA = json.loads((ROOT / 'data.json').read_text(encoding='utf-8'))

price = pd.DataFrame(DATA['priceIndex']).set_index('date').sort_index()
total = pd.DataFrame(DATA['totalReturnIndex']).set_index('date').sort_index()

df = price[['open', 'close']].join(total[['open', 'close']], lsuffix='_p', rsuffix='_t', how='inner')
df.index = pd.to_datetime(df.index)
df = df.sort_index()

df['F'] = df['close_t'] / df['close_p']
df['dp'] = df['close_p'] * (df['F'] / df['F'].shift(1) - 1)  # daily dividend points
df['dy'] = df['dp'].rolling(252, min_periods=252).sum() / df['close_p']
df['ttm_div'] = df['dp'].rolling(252, min_periods=252).sum()

# Zoom into 2025-06 and 2025-07 daily data
print("=" * 90)
print("Daily data: 2025-06-01 to 2025-08-01")
print("=" * 90)
print(f"{'Date':<12} {'Price':>10} {'TotalRet':>10} {'F':>8} {'DailyDiv':>10} {'TTM_Div':>10} {'DivYield':>10}")
print("-" * 90)

mask = (df.index >= '2025-06-01') & (df.index <= '2025-08-05')
for date, row in df[mask].iterrows():
    date_str = date.strftime('%Y-%m-%d')
    close_p = row['close_p']
    close_t = row['close_t']
    F = row['F']
    dp = row['dp']
    ttm = row['ttm_div']
    dy = row['dy']
    
    dp_str = f"{dp:.2f}" if np.isfinite(dp) else "N/A"
    ttm_str = f"{ttm:.2f}" if np.isfinite(ttm) else "N/A"
    dy_str = f"{dy:.2%}" if np.isfinite(dy) else "N/A"
    F_str = f"{F:.6f}" if np.isfinite(F) else "N/A"
    
    # Flag large daily dividend
    flag = ""
    if np.isfinite(dp) and dp > 0.5:
        flag = " <-- DIV DAY"
    if np.isfinite(dp) and abs(dp) > 5:
        flag = " <-- BIG DIV DAY"
    
    print(f"{date_str:<12} {close_p:>10.2f} {close_t:>10.2f} {F_str:>8} {dp_str:>10} {ttm_str:>10} {dy_str:>10}{flag}")

print()
print("=" * 90)
print("Key comparison: 2025-06-30 vs 2025-07-31")
print("=" * 90)

jun30 = df.loc['2025-06-30']
jul31 = df.loc['2025-07-31']

print(f"  Price:      {jun30['close_p']:.2f} -> {jul31['close_p']:.2f}  (change: {(jul31['close_p']/jun30['close_p']-1)*100:.2f}%)")
print(f"  TotalRet:   {jun30['close_t']:.2f} -> {jul31['close_t']:.2f}  (change: {(jul31['close_t']/jun30['close_t']-1)*100:.2f}%)")
print(f"  TTM Div:    {jun30['ttm_div']:.2f} -> {jul31['ttm_div']:.2f}  (change: {(jul31['ttm_div']/jun30['ttm_div']-1)*100:.2f}%)")
print(f"  DivYield:   {jun30['dy']:.2%} -> {jul31['dy']:.2%}  (change: {(jul31['dy']/jun30['dy']-1)*100:.2f}%)")
print()

# Decompose: how much of the yield drop is from price change vs dividend change?
# dy = ttm_div / price
# dy_new/dy_old = (ttm_div_new/ttm_div_old) * (price_old/price_new)
price_effect = jun30['close_p'] / jul31['close_p']
div_effect = jul31['ttm_div'] / jun30['ttm_div']
total_effect = price_effect * div_effect

print("=" * 90)
print("Decomposition: why did dividend yield drop?")
print("=" * 90)
print(f"  Yield ratio (new/old): {jul31['dy']/jun30['dy']:.4f}")
print(f"  Price effect (old/new): {price_effect:.4f}  -> price went {'up' if price_effect < 1 else 'down'} by {(1-price_effect)*100:.1f}%")
print(f"  Div effect (new/old):   {div_effect:.4f}  -> TTM div went {'up' if div_effect > 1 else 'down'} by {(1-div_effect)*100:.1f}%")
print(f"  Combined: {total_effect:.4f}")
print()

# Check: did a large dividend get added 252 trading days ago that just rolled off?
# Or did a large dividend get paid in July?
print("=" * 90)
print("Daily dividend points (dp) in July 2025 - looking for big ex-dividend days")
print("=" * 90)
july = df[(df.index >= '2025-07-01') & (df.index <= '2025-07-31')]
big_days = july[july['dp'].abs() > 0.1]
for date, row in big_days.iterrows():
    date_str = date.strftime('%Y-%m-%d')
    print(f"  {date_str}: dp={row['dp']:.2f}  price={row['close_p']:.2f}  F={row['F']:.6f}")

# Also check what rolled off (252 trading days before July 2025 = ~July 2024)
print()
print("=" * 90)
print("What happened ~252 trading days ago (July 2024) - dividends rolling off TTM?")
print("=" * 90)
jul2024 = df[(df.index >= '2024-06-01') & (df.index <= '2024-08-31')]
big_days_2024 = jul2024[jul2024['dp'].abs() > 0.1]
for date, row in big_days_2024.iterrows():
    date_str = date.strftime('%Y-%m-%d')
    print(f"  {date_str}: dp={row['dp']:.2f}  price={row['close_p']:.2f}")

# Check dividends data
if 'dividends' in DATA:
    divs = pd.DataFrame(DATA['dividends'])
    print()
    print("=" * 90)
    print("Raw dividend records around July 2025")
    print("=" * 90)
    if 'registerDate' in divs.columns:
        divs['registerDate'] = pd.to_datetime(divs['registerDate'])
        recent = divs[(divs['registerDate'] >= '2025-06-01') & (divs['registerDate'] <= '2025-08-31')]
        print(recent.to_string())
    else:
        print("Columns:", divs.columns.tolist())
        print(divs.head())

# Check total return index jump
print()
print("=" * 90)
print("Total Return Index daily changes in July 2025")
print("=" * 90)
for date, row in july.iterrows():
    date_str = date.strftime('%Y-%m-%d')
    tr_change = ""
    if date > july.index[0]:
        prev_tr = df.loc[date - pd.Timedelta(days=1):date]['close_t'].iloc[0]
    # just show F value
    F_str = f"{row['F']:.6f}" if np.isfinite(row['F']) else "N/A"
    dp_str = f"{row['dp']:.2f}" if np.isfinite(row['dp']) else "N/A"
    flag = " <-- BIG" if np.isfinite(row['dp']) and row['dp'] > 0.5 else ""
    print(f"  {date_str}: price={row['close_p']:.2f}  TR={row['close_t']:.2f}  F={F_str}  dp={dp_str}{flag}")
