import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_PRIMARY_CODE = '512760';

export function normalizePrimaryCode(value) {
  const code = String(value ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('主策略代码必须是 6 位数字');
  return code;
}

/** 读取主策略配置；文件缺失或损坏时回落到默认标的。 */
export async function readStrategyConfig(file = 'data/strategy-config.json') {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const primaryCode = /^\d{6}$/.test(String(saved?.primaryCode ?? ''))
      ? String(saved.primaryCode)
      : DEFAULT_PRIMARY_CODE;
    return saved?.updatedAt ? { primaryCode, updatedAt: String(saved.updatedAt) } : { primaryCode };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { primaryCode: DEFAULT_PRIMARY_CODE };
    throw error;
  }
}

/** 写入主策略配置；页面「设为主策略」与后台通知共用这一份配置。 */
export async function writeStrategyConfig(updates, file = 'data/strategy-config.json') {
  const primaryCode = normalizePrimaryCode(updates?.primaryCode);
  const config = { primaryCode, updatedAt: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}
