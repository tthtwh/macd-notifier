# -*- coding: utf-8 -*-
import csv

filepath = r'C:\Users\tangwenheng\Desktop\红利低波_全部调仓 (1).csv'

# Try different encodings
for enc in ['utf-8-sig', 'utf-8', 'gbk', 'gb18030']:
    try:
        with open(filepath, encoding=enc) as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        if rows and '执行日' in rows[0]:
            print(f'Encoding: {enc} - OK')
            break
    except Exception as e:
        print(f'Encoding {enc} failed: {e}')
        rows = []

if not rows:
    print('All encodings failed')
    exit(1)

headers = list(rows[0].keys())
print('Headers:', headers)
print('Total rows:', len(rows))
print()

# Print all rows with key fields
for i, r in enumerate(rows):
    d = r.get('执行日', '')
    typ = r.get('类型', '')
    orig = r.get('原仓位%', '')
    tgt = r.get('目标仓位%', '')
    div_rate = r.get('信号日股息率', '')
    pct = r.get('信号日10年分位', '')
    eq = r.get('执行日日终权益', '')
    chg_pct = r.get('较上次调仓权益变化(%)', '')
    
    # Truncate pct for display
    try:
        pct_short = f'{float(pct):.1%}'
    except:
        pct_short = pct
    
    print(f'{i+1}. {d} | {typ} | {orig}%->{tgt}% | 股息率:{div_rate} | 分位:{pct_short} | 权益:{eq} | 变化:{chg_pct}%')

print()
print('=== Summary ===')
print('初始权益:', rows[0].get('执行日日终权益', ''))
print('最终权益:', rows[-1].get('执行日日终权益', ''))
print('最后日期:', rows[-1].get('执行日', ''))
print('最终仓位:', rows[-1].get('目标仓位%', '') + '%')

# Find the 2019-2025 period
print()
print('=== 2019-2025 period rebalances ===')
for r in rows:
    d = r.get('执行日', '')
    if d >= '2019-01-01' and d <= '2025-12-31':
        print(f"  {d} | {r.get('类型','')} | {r.get('原仓位%','')}%->{r.get('目标仓位%','')}% | 股息率:{r.get('信号日股息率','')} | 权益:{r.get('执行日日终权益','')}")

# Calculate total return
try:
    initial = float(rows[0].get('执行日日终权益', 0))
    final = float(rows[-1].get('执行日日终权益', 0))
    print()
    print(f'总收益率: {(final/initial - 1)*100:.2f}%')
    print(f'初始权益: {initial:.2f}')
    print(f'最终权益: {final:.2f}')
except Exception as e:
    print(f'Return calc error: {e}')
