# -*- coding: utf-8 -*-
"""Simulate the step_level rule for 2019-2025 to explain the 100% -> 25% jump."""

# The rule from analysis.py step_level():
# up thresholds:   [0.60, 0.70, 0.80, 0.90]
# down thresholds: [0.40, 0.50, 0.60, 0.70]
#
# Level transitions:
# 0%   -> 25%  if pct >= 0.60
# 25%  -> 50%  if pct >= 0.70;  25% -> 0%  if pct <= 0.40
# 50%  -> 75%  if pct >= 0.80;  50% -> 25% if pct <= 0.50
# 75%  -> 100% if pct >= 0.90;  75% -> 50% if pct <= 0.60
# 100% -> 75%  if pct <= 0.70

# Key: resolve_level applies step_level repeatedly (up to 7 times) until stable.
# This means if the pct drops far enough in one month, it can cascade through
# multiple levels in a single signal!

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
    steps = [level]
    for _ in range(7):
        nxt = step_level(level, p)
        if nxt == level:
            break
        level = nxt
        steps.append(level)
    return level, steps

# Now simulate the 2019-2025 period
# From CSV: 2019-06-03 entered 100%, held until 2025-08-01 when it dropped to 25%
# The signal on 2025-07-31 had pct = 0.447

# Let's trace what resolve_level does with level=100 and pct=0.447
print("=" * 60)
print("Simulating: level=100%, pct=0.447 (2025-07-31 signal)")
print("=" * 60)
final, steps = resolve_level(100, 0.447)
print(f"Steps: {' -> '.join(str(s) for s in steps)}")
print(f"Final level: {final}%")
print()

# Explain each step
print("Step-by-step explanation:")
print(f"  Start: level=100%, pct=0.447")
print(f"  Step 1: level=100, pct=0.447 <= 0.70 (down[3])? YES -> drop to 75%")
print(f"  Step 2: level=75,  pct=0.447 <= 0.60 (down[2])? YES -> drop to 50%")
print(f"  Step 3: level=50,  pct=0.447 <= 0.50 (down[1])? YES -> drop to 25%")
print(f"  Step 4: level=25,  pct=0.447 <= 0.40 (down[0])? NO  -> stay at 25%")
print(f"  Result: 100% -> 75% -> 50% -> 25% (cascaded in ONE signal!)")
print()

# Now let's check: what about the intermediate months between 2019-06 and 2025-08?
# The CSV shows NO rebalances during this period, meaning pct stayed in the
# "hold zone" for level 100 (pct > 0.70) the entire time

print("=" * 60)
print("Why no rebalance between 2019-06 and 2025-08?")
print("=" * 60)
print("At level 100%, the ONLY trigger to change is:")
print("  - SELL if pct <= 0.70 (down[3]) -> would go to 75%")
print("  - Otherwise HOLD at 100%")
print()
print("So as long as monthly pct stayed > 0.70, position stayed at 100%.")
print("The moment pct dropped to 0.447 (below 0.40 down[0] would be 0%,")
print("but 0.447 is between 0.40 and 0.50, so it cascades to 25%).")
print()

# What if pct was, say, 0.65 in some intermediate month?
print("=" * 60)
print("What if pct had been 0.65 in an intermediate month?")
print("=" * 60)
final2, steps2 = resolve_level(100, 0.65)
print(f"  level=100, pct=0.65: {' -> '.join(str(s) for s in steps2)}")
print(f"  0.65 <= 0.70? YES -> drop to 75%")
print(f"  0.65 <= 0.60? NO -> stay at 75%")
print(f"  Result: would have gone to 75%, not 100%")
print()

# What if pct was 0.72?
final3, steps3 = resolve_level(100, 0.72)
print(f"  level=100, pct=0.72: {' -> '.join(str(s) for s in steps3)}")
print(f"  0.72 <= 0.70? NO -> stay at 100%")
print()

# Summary of the cascade zones from 100%
print("=" * 60)
print("From 100% position, where does one signal take you?")
print("=" * 60)
for pct_test in [0.75, 0.70, 0.69, 0.65, 0.60, 0.55, 0.50, 0.45, 0.40, 0.35, 0.30, 0.25]:
    f, s = resolve_level(100, pct_test)
    cascade = ' -> '.join(str(x) for x in s) if len(s) > 1 else f'stay at {s[0]}'
    print(f"  pct={pct_test:.2f}: {cascade}")

print()
print("=" * 60)
print("KEY INSIGHT: The cascade mechanism")
print("=" * 60)
print("""
resolve_level() applies step_level() REPEATEDLY (up to 7 times) until 
the level stabilizes. This means:

If pct drops sharply in one month (e.g., from >0.90 to 0.447),
the system cascades through MULTIPLE levels in a SINGLE signal:

  100% -> 75% (pct <= 0.70)
  75%  -> 50% (pct <= 0.60)  
  50%  -> 25% (pct <= 0.50)
  25%  stays  (pct > 0.40)

So 100% -> 25% in one jump is BY DESIGN, not a bug.
The rule says: if it's cheap enough to warrant 100%, and suddenly
the percentile drops to a level that only warrants 25%, sell directly
to 25% -- don't waste time at 75% and 50% intermediate steps.

This makes sense because:
1. Monthly rebalancing means you don't want to lag
2. If the signal says 25% is the right level, why stop at 75%?
3. The cascade ensures your position always matches the current
   valuation, not some historical intermediate state
""")
