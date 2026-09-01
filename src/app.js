import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { calculateMacd, estimateZeroHistClose, getSignal, MACD_PARAMS } from './macd.js';
import { fetchDailyKlines } from './market.js';
import { sendServerChan } from './notifier.js';

export const MIN_BARS = MACD_PARAMS.long + MACD_PARAMS.signal;

export function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export async function runDailyCheck({
  now = new Date(),
  stateFile = 'data/state.json',
  sendKey = process.env.SERVERCHAN_SENDKEY,
  getBars = fetchDailyKlines,
  notify = sendServerChan,
  logger = console
} = {}) {
  const today = shanghaiDate(now);
  const checkTime = shanghaiTime(now);
  let state;

  try {
    state = await readState(stateFile);
    if (state.lastSentDate === today) {
      logger.info(`[${today}] ${state.lastSignal} 已成功发送，跳过重复通知`);
      return state.lastSignal === 'BUY' || state.lastSignal === 'SELL'
        ? state.lastSignal
        : 'NONE';
    }
  } catch (error) {
    logger.error(`[MACD检查失败] ${errorMessage(error)}`);
    return 'NONE';
  }

  let report;
  let signal = 'NONE';
  try {
    const bars = await getBars();
    if (bars.length < MIN_BARS) {
      throw new Error(`数据不足：仅 ${bars.length} 根日 K，需要至少 ${MIN_BARS} 根`);
    }

    const latest = bars.at(-1);
    if (latest.date !== today) {
      throw new Error(`最新日 K 为 ${latest.date}，不是今天`);
    }

    const closes = bars.map(({ close }) => close);
    const macd = calculateMacd(closes);
    const previousHist = macd.at(-2).hist;
    const currentHist = macd.at(-1).hist;
    signal = getSignal(previousHist, currentHist);
    const zeroHistClose = estimateZeroHistClose(closes);
    report = buildDailyReport({
      today,
      checkTime,
      latestClose: latest.close,
      previousHist,
      currentHist,
      zeroHistClose,
      signal
    });
  } catch (error) {
    const reason = errorMessage(error);
    logger.error(`[MACD检查失败] ${reason}`);
    report = buildFailureReport({ today, checkTime, reason });
  }

  try {
    await notify({ sendKey, ...report });
    const lastSignal = report.kind === 'ERROR' ? 'ERROR' : signal;
    await writeState(stateFile, { lastSentDate: today, lastSignal });
    logger.info(`[${today}] ${lastSignal} 每日报告发送成功`);
  } catch (error) {
    logger.error(`[通知发送失败] ${errorMessage(error)}`);
  }
  return signal;
}

export function buildDailyReport({
  today,
  checkTime,
  latestClose,
  previousHist,
  currentHist,
  zeroHistClose,
  signal
}) {
  const color = currentHist > 0 ? '红柱' : currentHist < 0 ? '绿柱' : '零轴';
  const title = signal === 'BUY'
    ? '512760 MACD翻红，可以买入'
    : signal === 'SELL'
      ? '512760 MACD翻绿，可以卖出'
      : `512760 每日 MACD：${color}`;
  const conclusion = signal === 'BUY'
    ? 'MACD 已由绿柱翻为红柱'
    : signal === 'SELL'
      ? 'MACD 已由红柱翻为绿柱'
      : `${color === '零轴' ? 'MACD 位于零轴' : `仍为${color}`}，暂未出现买卖信号`;

  return {
    kind: 'STATUS',
    title,
    description: [
      `日期：${today}`,
      `检查时间：${checkTime}`,
      `最新价格：${formatPrice(latestClose)}`,
      `昨日 MACD Hist：${formatHist(previousHist)}`,
      `今日 MACD Hist：${formatHist(currentHist)}`,
      `柱体变化：${describeHistChange(previousHist, currentHist)}`,
      ...describeThreshold(latestClose, currentHist, zeroHistClose),
      `今日信号：${signal}`,
      `结论：${conclusion}`,
      '说明：根据 14:55 行情估算，以最终收盘数据为准'
    ].join('\n\n')
  };
}

export function buildFailureReport({ today, checkTime, reason }) {
  return {
    kind: 'ERROR',
    title: '512760 MACD 今日检查失败',
    description: [
      `日期：${today}`,
      `检查时间：${checkTime}`,
      `原因：${reason}`,
      '结论：本次无法计算 MACD，请检查容器日志'
    ].join('\n\n')
  };
}

export async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`读取状态文件失败：${error.message}`);
  }
}

async function writeState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function formatHist(value) {
  return value.toFixed(6);
}

function formatPrice(value) {
  return Number(value).toFixed(4);
}

function shanghaiTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function describeHistChange(previousHist, currentHist) {
  if (previousHist <= 0 && currentHist > 0) return `由绿柱翻红，变化 ${formatHist(currentHist - previousHist)}`;
  if (previousHist >= 0 && currentHist < 0) return `由红柱翻绿，变化 ${formatHist(currentHist - previousHist)}`;

  const color = currentHist >= 0 ? '红柱' : '绿柱';
  const difference = Math.abs(currentHist) - Math.abs(previousHist);
  if (Math.abs(difference) < 0.0000005) return `${color}基本不变`;
  return `${color}${difference > 0 ? '变长' : '缩短'} ${formatHist(Math.abs(difference))}`;
}

function describeThreshold(latestClose, currentHist, zeroHistClose) {
  if (!Number.isFinite(zeroHistClose)) return ['预计临界价：无法估算'];
  if (currentHist === 0) {
    return [`预计临界价：${formatPrice(zeroHistClose)}`, '距离翻色：当前正处于零轴临界状态'];
  }

  const turningRed = currentHist < 0;
  const distance = turningRed ? zeroHistClose - latestClose : latestClose - zeroHistClose;
  const direction = turningRed ? '上涨' : '下跌';
  const targetColor = turningRed ? '翻红' : '翻绿';
  const percent = latestClose === 0 ? NaN : Math.abs(distance / latestClose) * 100;
  return [
    `预计${targetColor}临界价：${formatPrice(zeroHistClose)}`,
    `距离${targetColor}：还需${direction} ${formatPrice(Math.abs(distance))}（${Number.isFinite(percent) ? percent.toFixed(2) : '--'}%）`
  ];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
