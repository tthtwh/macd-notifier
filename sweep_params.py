# -*- coding: utf-8 -*-
"""红利低波策略参数扫描：分位窗口 x 规则族 x 阈值。

评估区间：近5年(2021-10-27~)、近10年(2016-10-27~)、全样本(2010-06-01~)。
稳定性：滚动 5 年窗口的年化收益均值 / 最差 / 标准差。
"""
import sys
import itertools
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path('work/dividend-strategy/research').resolve()))
import analysis as A

FEE, SLIP, FUND = 0.0005, 0.0005, 0.002
END = A.LAST
P5 = pd.Timestamp('2021-10-27')
P10 = pd.Timestamp('2016-10-27')
PALL = pd.Timestamp('2010-06-01')
MIN_HIST = 756

# ---------- 基础数据 ----------
base = A.price[['open', 'close']].join(A.total[['open', 'close']], lsuffix='_p', rsuffix='_t', how='inner')
base.index = pd.to_datetime(base.index)
base = base.sort_index()
base['ym'] = base.index.strftime('%Y-%m')
nxt = base['ym'].shift(-1)
base['is_month_end'] = (base['ym'] != nxt) & nxt.notna()
base['F'] = base['close_t'] / base['close_p']
base['dp'] = base['close_p'] * (base['F'] / base['F'].shift(1) - 1)
base['dy'] = base['dp'].rolling(252, min_periods=252).sum() / base['close_p']
DY = base['dy'].to_numpy(dtype=float)
DATES = base.index


def pct_series(window):
    n = len(DY)
    out = np.full(n, np.nan)
    for i in range(n):
        v = DY[i]
        if not np.isfinite(v):
            continue
        s = max(0, i - window + 1)
        h = DY[s:i + 1]
        h = h[np.isfinite(h)]
        if len(h) < MIN_HIST:
            continue
        out[i] = float(np.mean(h <= v))
    return out


def set_pct(pct):
    d = base.copy()
    d['pct'] = pct
    A.df = d
    return d


# ---------- 规则 ----------
def ladder_resolver(up, down):
    def step(lv, p):
        if not np.isfinite(p):
            return lv
        if lv == 0:
            return 25 if p >= up[0] else 0
        if lv == 25:
            if p >= up[1]:
                return 50
            if p <= down[3]:
                return 0
            return 25
        if lv == 50:
            if p >= up[2]:
                return 75
            if p <= down[2]:
                return 25
            return 50
        if lv == 75:
            if p >= up[3]:
                return 100
            if p <= down[1]:
                return 50
            return 75
        if lv == 100:
            return 75 if p <= down[0] else 100
        return lv

    def resolve(lv, p):
        for _ in range(6):
            nx = step(lv, p)
            if nx == lv:
                return lv
            lv = nx
        return lv

    return resolve


def binary_resolver(buy, sell):
    def resolve(lv, p):
        if not np.isfinite(p):
            return lv
        if p >= buy:
            return 100
        if p <= sell:
            return 0
        return lv
    return resolve


def static_resolver(edges, levels):
    def resolve(lv, p):
        if not np.isfinite(p):
            return lv
        for i, e in enumerate(edges):
            if p < e:
                return levels[i]
        return levels[-1]
    return resolve


def build_signals(resolve, d):
    lv = 0
    sigs = []
    for i in range(len(d)):
        if not d['is_month_end'].iat[i]:
            continue
        p = d['pct'].iat[i]
        if not np.isfinite(p):
            continue
        tgt = resolve(lv, float(p))
        if tgt != lv:
            if i + 1 >= len(d):
                continue
            sigs.append({'signal_date': d.index[i], 'exec_date': d.index[i + 1],
                         'pct': float(p), 'dy': float(d['dy'].iat[i]) if np.isfinite(d['dy'].iat[i]) else np.nan,
                         'from_level': int(lv), 'to_level': int(tgt),
                         'target_pct': float(tgt), 'from_pct': float(lv)})
            lv = tgt
    return sigs


def level_at(sigs, start):
    lv = 0
    for s in sigs:
        if s['signal_date'] <= start:
            lv = s['to_level']
        else:
            break
    return lv


def evaluate(sigs, start, end):
    lv = level_at(sigs, start)
    daily, m = A.run_index(sigs, start, end, fee=FEE, slip=SLIP, fund_fee=FUND, init_target=lv)
    return m, lv


# ---------- 变体定义 ----------
WINDOWS = [
    ('3y(756)', 756), ('5y(1260)', 1260), ('7.5y(1890)', 1890),
    ('10y(2520)', 2520), ('15y(3780)', 3780),
]
UP_GRID = [
    [0.55, 0.65, 0.75, 0.85],
    [0.60, 0.70, 0.80, 0.90],
    [0.65, 0.75, 0.85, 0.95],
    [0.50, 0.60, 0.70, 0.80],
    [0.60, 0.70, 0.80, 0.85],
]
DOWN_GRID = [
    [0.70, 0.60, 0.50, 0.40],
    [0.75, 0.65, 0.55, 0.45],
    [0.65, 0.55, 0.45, 0.35],
    [0.70, 0.60, 0.50, 0.50],
    [0.60, 0.50, 0.40, 0.30],
]
BIN_GRID = list(itertools.product([0.80, 0.85, 0.90, 0.95], [0.40, 0.45, 0.50, 0.55]))
STATIC_GRID = [
    [0.50, 0.60, 0.70, 0.80],
    [0.55, 0.65, 0.75, 0.85],
    [0.60, 0.70, 0.80, 0.90],
    [0.50, 0.60, 0.70, 0.90],
    [0.40, 0.50, 0.60, 0.70],
]


def variants():
    for (wname, W) in WINDOWS:
        for (u, dn) in itertools.product(UP_GRID, DOWN_GRID):
            yield (f'阶梯 W{wname} up{u[0]:.2f}/{u[1]:.2f}/{u[2]:.2f}/{u[3]:.2f} '
                   f'down{dn[0]:.2f}/{dn[1]:.2f}/{dn[2]:.2f}/{dn[3]:.2f}',
                   W, ladder_resolver(u, dn), 'ladder')
        for (b, s) in BIN_GRID:
            yield f'全有全无 W{wname} buy{b:.2f}/sell{s:.2f}', W, binary_resolver(b, s), 'binary'
        for e in STATIC_GRID:
            yield (f'静态五档 W{wname} {e[0]:.2f}/{e[1]:.2f}/{e[2]:.2f}/{e[3]:.2f}',
                   W, static_resolver(e, [0, 25, 50, 75, 100]), 'static')


if __name__ == '__main__':
    # 预算各窗口的 pct
    PCT = {}
    for (wname, W) in WINDOWS:
        PCT[W] = pct_series(W)
        print('pct done', wname, flush=True)

    rows = []
    n = 0
    for (name, W, resolve, fam) in variants():
        set_pct(PCT[W])
        sigs = build_signals(resolve, A.df)
        r = {'变体': name, '规则族': fam, '窗口': W}
        for tag, start in [('5y', P5), ('10y', P10), ('full', PALL)]:
            m, lv = evaluate(sigs, start, END)
            r[f'{tag}_cagr'] = m['cagr']
            r[f'{tag}_mdd'] = m['maxdd']
            r[f'{tag}_sharpe'] = m['sharpe']
            r[f'{tag}_calmar'] = m['calmar']
            r[f'{tag}_trades'] = m['trades']
            r[f'{tag}_cash'] = m['cash_time']
        rows.append(r)
        n += 1
        if n % 50 == 0:
            print('done', n, flush=True)

    res = pd.DataFrame(rows)
    res.to_csv('work/dividend-strategy/param-sweep-all.csv', index=False, encoding='utf-8-sig')

    # 基准
    print('\n===== 近5年 CAGR 前 20 =====')
    top5 = res.sort_values('5y_cagr', ascending=False).head(20)
    for _, r in top5.iterrows():
        print(f"{r['变体'][:78]:<78} 5y {r['5y_cagr']*100:6.2f}% 10y {r['10y_cagr']*100:6.2f}% "
              f"full {r['full_cagr']*100:6.2f}%  5yDD {r['5y_mdd']*100:6.2f}%  tr {int(r['5y_trades'])}")

    print('\n===== 全样本 CAGR 前 15 =====')
    for _, r in res.sort_values('full_cagr', ascending=False).head(15).iterrows():
        print(f"{r['变体'][:78]:<78} full {r['full_cagr']*100:6.2f}% 10y {r['10y_cagr']*100:6.2f}% "
              f"5y {r['5y_cagr']*100:6.2f}%  fDD {r['full_mdd']*100:6.2f}%  tr {int(r['full_trades'])}")

    print('\n===== 三个区间都进前 25% =====')
    q5 = res['5y_cagr'].quantile(0.75)
    q10 = res['10y_cagr'].quantile(0.75)
    qf = res['full_cagr'].quantile(0.75)
    cons = res[(res['5y_cagr'] >= q5) & (res['10y_cagr'] >= q10) & (res['full_cagr'] >= qf)]
    cons = cons.sort_values('full_cagr', ascending=False)
    for _, r in cons.head(20).iterrows():
        print(f"{r['变体'][:78]:<78} 5y {r['5y_cagr']*100:6.2f}% 10y {r['10y_cagr']*100:6.2f}% "
              f"full {r['full_cagr']*100:6.2f}%  tr {int(r['full_trades'])}")
    print('consistent count', len(cons))
    res.attrs['q'] = (q5, q10, qf)
    print('\nthresholds', q5, q10, qf)
