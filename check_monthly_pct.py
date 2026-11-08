# -*- coding: utf-8 -*-
"""Check the monthly percentile trajectory from 2019 to 2025
to see if pct dropped gradually or suddenly from >0.70 to 0.447"""

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
df['ym'] = df.index.strftime('%Y-%m')
next_ym = df['ym'].shift(-1)
df['is_month_end'] = (df['ym'] != next_ym) & next_ym.notna()

df['F'] = df['close_t'] / df['close_p']
df['dp'] = df['close_p'] * (df['F'] / df['F'].shift(1) - 1)
df['dy'] = df['dp'].rolling(252, min_periods=252).sum() / df['close_p']

dy = df['dy'].to_numpy()
pct = np.full(len(df), np.nan)
for i in range(len(df)):
    if not np.isfinite(dy[i]):
        continue
    start = max(0, i - 2519)
    hist = dy[start:i + 1]
    hist = hist[np.isfinite(hist)]
    if len(hist) < 756:
        continue
    pct[i] = float(np.mean(hist <= dy[i]))
df['pct'] = pct

# Also load latest data
latest_path = ROOT / 'latest-index.json'
if latest_path.exists():
    latest = json.loads(latest_path.read_text(encoding='utf-8'))
    # Try to extend with latest data if available
    for key in ['h30269', 'h20269']:
        if key in latest:
            for row in latest[key]:
                d = row['date']
                if d not in df.index:
                    if key == 'h30269':
                        df.loc[d, ['open_p', 'close_p']] = [row['open'], row['close']]
                    elif key == 'h20269':
                        df.loc[d, ['open_t', 'close_t']] = [row['open'], row['close']]

# Get month-end rows from 2019 to 2025
month_ends = df[df['is_month_end'] & (df.index >= '2019-01-01') & (df.index <= '2025-12-31')]

print("=" * 80)
print("Monthly percentile from 2019 to 2025 (month-end signal dates)")
print("=" * 80)
print(f"{'Signal Date':<14} {'Div Yield':>10} {'Percentile':>12} {'Position*':>10} {'Action':>8}")
print("-" * 80)

# Simulate the position based on the rule
def step_level(level, p):
    up = [0.60, 0.70, 0.80, 0.90]
    down = [0.40, 0.50, 0.60, 0.70]
    if level == 0:
        return 25 if p >= up[0] else 0
    if level == 25:
        if p >= up[1]: return 50
        if p <= down[0]: return 0
        return 25
    if level == 50:
        if p >= up[2]: return 75
        if p <= down[1]: return 25
        return 50
    if level == 75:
        if p >= up[3]: return 100
        if p <= down[2]: return 50
        return 75
    if level == 100:
        return 75 if p <= down[3] else 100
    return level

def resolve_level(level, p):
    for _ in range(7):
        nxt = step_level(level, p)
        if nxt == level:
            return level
        level = nxt
    return level

# Start from the known position: 2019-06-03 was 100%
# So the 2019-05-31 signal put us at 100%
level = 100  # after 2019-05-31 signal

for date, row in month_ends.iterrows():
    p = row['pct']
    dy_val = row['dy']
    if not np.isfinite(p):
        continue
    
    old_level = level
    new_level = resolve_level(level, p)
    
    if new_level != old_level:
        action = f"{old_level}->{new_level}"
        # Apply the change
        level = new_level
    else:
        action = "HOLD"
    
    # Only print months where action changes, or key months
    date_str = date.strftime('%Y-%m-%d')
    pct_str = f"{p:.1%}"
    dy_str = f"{dy_val:.2%}" if np.isfinite(dy_val) else "N/A"
    
    if action != "HOLD":
        print(f"{date_str:<14} {dy_str:>10} {pct_str:>12} {old_level:>9}% {action:>8}")
    else:
        print(f"{date_str:<14} {dy_str:>10} {pct_str:>12} {level:>9}% {action:>8}")

print()
print("* Position is the level AFTER applying the signal on that date")
print()

# Also show: what was the percentile trajectory in the months leading up to 2025-08?
print("=" * 80)
print("Zoom in: 2025-01 to 2025-08 (the months around the big drop)")
print("=" * 80)
zoom = df[df['is_month_end'] & (df.index >= '2025-01-01') & (df.index <= '2025-08-31')]
for date, row in zoom.iterrows():
    p = row['pct']
    dy_val = row['dy']
    close = row['close_p']
    date_str = date.strftime('%Y-%m-%d')
    pct_str = f"{p:.1%}" if np.isfinite(p) else "N/A"
    dy_str = f"{dy_val:.2%}" if np.isfinite(dy_val) else "N/A"
    print(f"  {date_str} | close={close:>8.2f} | div_yield={dy_str:>8} | percentile={pct_str:>8}")
