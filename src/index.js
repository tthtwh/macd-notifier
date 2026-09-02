import { runDailyCheck } from './app.js';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGET_HOUR = 14;
const TARGET_MINUTE = 55;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

export function nextRunTime(now = new Date()) {
  const parts = shanghaiParts(now);
  let candidate = new Date(`${parts.date}T${pad(TARGET_HOUR)}:${pad(TARGET_MINUTE)}:00+08:00`);

  if (candidate <= now || isWeekend(candidate)) candidate = nextWeekday(candidate);
  return candidate;
}

export function startScheduler({ now = () => new Date(), run = runDailyCheck, logger = console } = {}) {
  const schedule = () => {
    const current = now();
    const next = nextRunTime(current);
    logger.info(`下次检查：${next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
    setTimeout(async () => {
      await run({ now: now() });
      schedule();
    }, next.getTime() - current.getTime());
  };
  schedule();
}

export function startWebServer({
  port = Number(process.env.PORT ?? 8080),
  host = '0.0.0.0',
  root = DEFAULT_WEB_ROOT,
  dataDir = process.env.DATA_DIR ?? 'data',
  logger = console
} = {}) {
  const webRoot = resolve(root);
  const queryHistoryFile = join(resolve(dataDir), 'query-history.json');
  const server = createServer((request, response) => {
    serveRequest(request, response, webRoot, queryHistoryFile).catch((error) => {
      logger.error(`[页面服务失败] ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
    });
  });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    logger.info(`回测页面已启动：http://0.0.0.0:${actualPort}`);
  });
  return server;
}

export async function loadPersistentEnv({
  file = join(process.env.DATA_DIR ?? 'data', '.env'),
  env = process.env,
  logger = console
} = {}) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    logger.error(`[持久化配置读取失败] ${error.message}`);
    return false;
  }

  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!env[key]) env[key] = value;
  }
  logger.info(`已加载持久化配置：${file}`);
  return true;
}

export async function checkPersistentStorage({
  dataDir = process.env.DATA_DIR ?? 'data',
  logger = console
} = {}) {
  const directory = resolve(dataDir);
  const probe = join(directory, `.write-test-${process.pid}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    logger.info(`持久化目录可写：${directory}`);
    return true;
  } catch (error) {
    logger.error(`[持久化目录不可写] ${directory}：${error.message}`);
    return false;
  }
}

async function serveRequest(request, response, webRoot, queryHistoryFile) {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api/query-history') {
    await serveQueryHistory(request, response, queryHistoryFile);
    return;
  }
  await serveStatic(request, response, webRoot);
}

async function serveQueryHistory(request, response, queryHistoryFile) {
  if (request.method === 'GET') {
    let history = [];
    try {
      const saved = JSON.parse(await readFile(queryHistoryFile, 'utf8'));
      if (Array.isArray(saved)) history = saved;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    sendJson(response, 200, history);
    return;
  }

  if (request.method === 'POST') {
    try {
      const history = validateQueryHistory(await readJsonBody(request));
      await mkdir(dirname(queryHistoryFile), { recursive: true });
      await writeFile(queryHistoryFile, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
      sendJson(response, 200, { ok: true });
    } catch (error) {
      if (!error?.statusCode) throw error;
      sendJson(response, error.statusCode, { error: error.message });
    }
    return;
  }

  response.writeHead(405, { allow: 'GET, POST' });
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) {
      const error = new Error('查询记录过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw requestError('查询记录格式无效');
  }
}

function validateQueryHistory(value) {
  if (!Array.isArray(value)) throw requestError('查询记录必须是数组');
  return value.slice(0, 8).map((item) => {
    if (!item || !/^\d{6}$/.test(String(item.code ?? ''))) throw requestError('查询记录代码无效');
    return {
      code: String(item.code),
      name: String(item.name ?? '').slice(0, 100),
      start: validDateOrEmpty(item.start),
      end: validDateOrEmpty(item.end),
      queriedAt: String(item.queriedAt ?? '').slice(0, 50)
    };
  });
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validDateOrEmpty(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(request, response, webRoot) {
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = resolve(webRoot, requested);
  const pathFromRoot = relative(webRoot, filePath);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT' || extname(requested)) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      response.end();
      return;
    }
    filePath = resolve(webRoot, 'index.html');
    fileStat = await stat(filePath);
  }

  if (!fileStat.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=86400'
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return { date: `${value.year}-${value.month}-${value.day}` };
}

function isWeekend(date) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short'
  }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

function nextWeekday(date) {
  let next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  while (isWeekend(next)) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await loadPersistentEnv();
  await checkPersistentStorage();
  console.info('512760 MACD 通知服务已启动（Asia/Shanghai，工作日 14:55）');
  startScheduler();
  startWebServer();
}
