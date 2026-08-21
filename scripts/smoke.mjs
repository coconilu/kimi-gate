// 端到端冒烟：真实启动 fake-kimi + gateway(dist) + connector(dist) 三个进程并验证全链路。
// 前置: npm run build。用法: node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const KIMI_PORT = 58901;
const GW_PORT = 58902;
const TOKEN = 'smoke-kimi-token';
const PASSWORD = 'smoke-password-123';
const CONNECTOR_KEY = 'smoke-connector-key';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const { hashPassword } = await import(pathToFileURL(path.join(root, 'packages/gateway/dist/password.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-gate-smoke-'));
const gwEnvPath = path.join(tmp, 'gateway.env');
fs.writeFileSync(gwEnvPath, [
  `PORT=${GW_PORT}`,
  'HOST=127.0.0.1',
  `DB_PATH=${path.join(tmp, 'smoke.db')}`,
  'SESSION_SECRET=smoke-session-secret-0123456789abcdef',
  `ADMIN_PASSWORD_HASH=${await hashPassword(PASSWORD)}`,
  `KIMI_BEARER_TOKEN=${TOKEN}`,
  `CONNECTOR_KEY=${CONNECTOR_KEY}`,
  'TRUST_PROXY=false',
  '',
].join('\n'));
const connEnvPath = path.join(tmp, 'connector.env');
fs.writeFileSync(connEnvPath, [
  `GATEWAY_URL=ws://127.0.0.1:${GW_PORT}`,
  `CONNECTOR_KEY=${CONNECTOR_KEY}`,
  `KIMI_LOCAL_URL=http://127.0.0.1:${KIMI_PORT}`,
  '',
].join('\n'));

const children = [];
function start(name, args, env, readyPattern) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`[${name}:err] ${d}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} 启动超时`)), 20000);
    child.stdout.on('data', (d) => {
      process.stdout.write(`[${name}] ${d}`);
      if (readyPattern.test(String(d))) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${name} 退出 code=${code}`)); });
  });
}

// cookie jar
const jar = new Map();
function storeCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq).trim(), v = pair.slice(eq + 1).trim();
    if (v) jar.set(k, v); else jar.delete(k);
  }
}
async function gw(pathname, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size && !headers.has('cookie')) {
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const res = await fetch(`http://127.0.0.1:${GW_PORT}${pathname}`, { ...init, headers, redirect: 'manual' });
  storeCookies(res);
  return res;
}
async function login(password) {
  const page = await gw('/login');
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  return gw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password }),
  });
}

let exitCode = 0;
try {
  await start('fake-kimi', [path.join(root, 'scripts/fake-kimi.mjs'), String(KIMI_PORT), TOKEN], {}, /listening/);
  await start('gateway', [path.join(root, 'packages/gateway/dist/index.js')], { GATEWAY_CONFIG: gwEnvPath }, /listening/);
  await start('connector', [path.join(root, 'packages/connector/dist/index.js')], { CONNECTOR_CONFIG: connEnvPath }, /已连接/);
  // 等 gateway 侧也确认隧道在线
  await new Promise((r) => setTimeout(r, 300));

  const r1 = await gw('/', { headers: { accept: 'text/html' } });
  check('未登录访问 → 302 /login', r1.status === 302 && r1.headers.get('location') === '/login');

  const r2 = await gw('/api/hello', { headers: { accept: 'application/json' } });
  check('未登录 API → 401', r2.status === 401);

  const r3 = await login('wrong-password');
  check('错误密码 → 401', r3.status === 401);

  const r4 = await login(PASSWORD);
  check('正确密码 → 302 + 会话 cookie', r4.status === 302 && jar.has('kg_session'));

  const r5 = await gw('/api/hello');
  const j5 = r5.status === 200 ? await r5.json() : {};
  check('HTTP 经隧道到达 kimi 且注入 Authorization', r5.status === 200 && j5.auth === `Bearer ${TOKEN}`);

  const echo = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/ws/chat`, {
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    const timer = setTimeout(() => reject(new Error('ws 超时')), 8000);
    ws.on('open', () => ws.send('smoke-ping-中文'));
    ws.on('message', (d) => { clearTimeout(timer); ws.close(); resolve(String(d)); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  check('WebSocket 经隧道 echo', echo === 'smoke-ping-中文', echo);

  // 管理台：二次确认后查日志
  const rDenied = await gw('/admin/api/logs', { headers: { accept: 'application/json' } });
  check('管理台未二次确认 → 403', rDenied.status === 403);
  const adminPage = await gw('/admin');
  const adminCsrf = /name="csrf" value="([^"]+)"/.exec(await adminPage.text())[1];
  const rVerify = await gw('/admin/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: adminCsrf, password: PASSWORD }),
  });
  const rLogs = await gw('/admin/api/logs');
  const logs = rLogs.status === 200 ? await rLogs.json() : [];
  check('管理台确认后可查登录日志',
    rVerify.status === 302 && logs.some((l) => l.result === 'success') && logs.some((l) => l.result === 'bad_password'),
    `${logs.length} 条记录`);

  const rStatus = await gw('/admin/api/status');
  const st = await rStatus.json();
  check('隧道状态在线', st.tunnelOnline === true);
} catch (err) {
  check(`冒烟执行异常: ${err.message}`, false);
} finally {
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
  // 等子进程释放 SQLite 文件句柄后再清理临时目录（Windows 上立即删会 EPERM）
  await Promise.all(children.map((c) => new Promise((r) => {
    if (c.exitCode !== null) return r(null);
    c.once('exit', () => r(null));
    setTimeout(() => r(null), 5000);
  })));
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn(`(临时目录清理失败，可手动删除: ${tmp})`);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n冒烟结果: ${results.length - failed}/${results.length} 通过`);
exitCode = failed ? 1 : 0;
process.exit(exitCode);
