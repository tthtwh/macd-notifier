import { runDailyCheck } from './app.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
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
  logger = console
} = {}) {
  const webRoot = resolve(root);
  const server = createServer((request, response) => {
    serveStatic(request, response, webRoot).catch((error) => {
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
  console.info('512760 MACD 通知服务已启动（Asia/Shanghai，工作日 14:55）');
  startScheduler();
  startWebServer();
}
