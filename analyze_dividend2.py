# -*- coding: utf-8 -*-
import csv

filepath = r'C:\Users\tangwenheng\Desktop\红利低波_全部调仓 (1).csv'

with open(filepath, encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))

# Key analysis: 2019-2025 "buy and hold" vs active rebalancing
# From the CSV, the key rows for 2019-2025:
# Row 22 (index 21): 2019-06-03, buy 75%->100%, div yield 4.16%, pct 92.3%, equity 322243.54
# Row 23 (index 22): 2025-08-01, sell 100%->25%, div yield 4.41%, pct 44.7%, equity 622500.90

# The strategy entered 100% position on 2019-06-03 and held until 2025-08-01
# That's about 6 years and 2 months of full position

entry_date = '2019-06-03'
entry_equity = 322243.54
exit_date = '2025-08-01'
exit_equity = 622500.90

hold_return = (exit_equity / entry_equity - 1) * 100
years = 6 + 2/12  # ~6.17 years
annual_return = ((exit_equity / entry_equity) ** (1/years) - 1) * 100

print('='*60)
print('2019-2025 Full Position Hold Analysis')
print('='*60)
print(f'Entry date: {entry_date}')
print(f'Entry equity: {entry_equity:,.2f}')
print(f'Exit date: {exit_date}')
print(f'Exit equity: {exit_equity:,.2f}')
print(f'Total return: {hold_return:.2f}%')
print(f'Years: {years:.2f}')
print(f'Annualized return: {annual_return:.2f}%')
print()

# What if different position sizes from 2019 entry?
print('='*60)
print('If entered at 2019-06-03 with different position sizes')
print('(100% hold to 2025-08-01, no rebalancing)')
print('='*60)
base_capital = 322243.54  # This was the equity at 100% position
final_value = 622500.90   # This was the equity when starting to sell

for pct in [25, 50, 75, 100]:
    invested = base_capital * pct / 100
    # The invested portion grows by the same ratio
    grown = invested * (final_value / base_capital)
    total_return_pct = (grown / invested - 1) * 100 if invested > 0 else 0
    print(f'  {pct}% position: invested {invested:,.0f} -> final {grown:,.0f} | return: {total_return_pct:.1f}%')

print()
print('='*60)
print('Full strategy performance (2010-2026)')
print('='*60)
initial = 99975.00
final = 651461.31
total_return = (final/initial - 1) * 100
total_years = 16 + 3/12  # 2010-06 to 2026-09
ann_return = ((final/initial) ** (1/total_years) - 1) * 100
print(f'Initial: {initial:,.2f}')
print(f'Final: {final:,.2f}')
print(f'Total return: {total_return:.2f}%')
print(f'Years: {total_years:.2f}')
print(f'Annualized: {ann_return:.2f}%')

# Count rebalances
buys = sum(1 for r in rows if '买入' in r.get('类型', ''))
sells = sum(1 for r in rows if '卖出' in r.get('类型', ''))
print(f'Total rebalances: {len(rows)} (buys: {buys}, sells: {sells})')

# The strategy's position transitions
print()
print('='*60)
print('All position transitions')
print('='*60)
for r in rows:
    d = r.get('执行日', '')
    typ = r.get('类型', '')
    orig = r.get('原仓位%', '')
    tgt = r.get('目标仓位%', '')
    div = r.get('信号日股息率', '')
    pct = r.get('信号日10年分位', '')
    eq = r.get('执行日日终权益', '')
    try:
        pct_f = float(pct)
        pct_s = f'{pct_f:.1%}'
    except:
        pct_s = pct
    print(f'  {d} | {orig}% -> {tgt}% | div:{div} | pct:{pct_s} | eq:{eq}')
