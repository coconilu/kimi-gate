/**
 * End-to-end integration test:
 *   fake kimi web (HTTP + WS echo, verifies Authorization header)
 *     <- Connector <- ws tunnel <- Gateway <- test client
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createGateway, type Gateway } from '../src/app.js';
import type { GatewayConfig } from '../src/config.js';
import { hashPassword } from '../src/password.js';
import { issueCsrf } from '../src/csrf.js';
import { startConnector, type ConnectorHandle } from '../../connector/src/client.js';

const KIMI_TOKEN = 'test-kimi-token-123';
const ADMIN_PASSWORD = 'super-secret-password';
const silent = () => { /* keep test output clean */ };

// ---------- fake kimi web ----------
let kimiServer: http.Server;
let kimiPort: number;
const kimiSockets = new Set<import('node:net').Socket>();
const kimiSeen: { auth: string | null; wsAuth: string | null } = { auth: null, wsAuth: null };

async function startFakeKimi(): Promise<void> {
  kimiServer = http.createServer((req, res) => {
    kimiSeen.auth = req.headers.authorization ?? null;
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null }));
      return;
    }
    if (req.url === '/api/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(404).end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  kimiServer.on('connection', (s) => { kimiSockets.add(s); s.on('close', () => kimiSockets.delete(s)); });
  kimiServer.on('upgrade', (req, socket, head) => {
    kimiSockets.add(socket); socket.on('close', () => kimiSockets.delete(socket));
    kimiSeen.wsAuth = req.headers.authorization ?? null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  await new Promise<void>((r) => kimiServer.listen(0, '127.0.0.1', r));
  kimiPort = (kimiServer.address() as AddressInfo).port;
}

// ---------- system under test ----------
let gw: Gateway;
let gwPort: number;
let connector: ConnectorHandle;
const jar = new Map<string, string>();

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (v === '') jar.delete(k);
    else jar.set(k, v);
  }
}

async function fetchGw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar.size && !headers.has('cookie')) headers.set('cookie', cookieHeader());
  const res = await fetch(`http://127.0.0.1:${gwPort}${path}`, { ...init, headers, redirect: 'manual' });
  storeCookies(res);
  return res;
}

function extractCsrf(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(m, 'login page should embed csrf token');
  return m[1];
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timeout');
}

before(async () => {
  await startFakeKimi();

  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'test-session-secret',
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
    kimiBearerToken: KIMI_TOKEN,
    connectorKey: 'test-connector-key',
    totpSecret: null,
    dbPath: ':memory:',
    trustProxy: false,
    tunnelTimeoutMs: 10000,
    maxBodyBytes: 4 * 1024 * 1024,
    upstreamMode: 'tunnel',
    localUpstream: '',
  };
  gw = createGateway(config);
  await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
  gwPort = gw.port();

  connector = startConnector({
    gatewayUrl: `ws://127.0.0.1:${gwPort}`,
    connectorKey: 'test-connector-key',
    targetUrl: `http://127.0.0.1:${kimiPort}`,
    log: silent,
  });
  await waitFor(() => gw.hub?.online === true);
});

after(async () => {
  connector.close();
  await gw.close();
  await new Promise<void>((r) => {
    kimiServer.close(() => r());
    kimiServer.closeAllConnections();
    for (const s of kimiSockets) s.destroy();
  });
});

test('未登录访问页面被 302 到登录页', async () => {
  const res = await fetchGw('/', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('未登录访问 API 返回 401', async () => {
  const res = await fetchGw('/api/hello', { headers: { accept: 'application/json' } });
  assert.equal(res.status, 401);
});

test('错误密码登录失败并写入审计', async () => {
  const page = await fetchGw('/login');
  const csrf = extractCsrf(await page.text());
  const res = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
  const rows = gw.db.prepare("SELECT result FROM login_attempts WHERE result = 'bad_password'").all();
  assert.ok(rows.length >= 1, 'bad_password 应已写入 login_attempts');
});

test('正确密码登录成功', async () => {
  const page = await fetchGw('/login');
  const csrf = extractCsrf(await page.text());
  const res = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.ok(jar.has('kg_session'), '应种下会话 cookie');
});

test('禁用 Cookie 的浏览器可凭签名 token 登录（csrf 兼容回退）', async () => {
  const page = await fetchGw('/login', { headers: { cookie: '' } });
  const csrf = extractCsrf(await page.text());
  jar.delete('kg_csrf');
  const res = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
    body: new URLSearchParams({ csrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 302, '签名 token 有效但无 cookie 时应允许登录');
});

test('cookie 与表单 token 不一致仍拒绝登录', async () => {
  jar.delete('kg_session'); // 避免已登录状态被重定向到 /
  const p1 = await fetchGw('/login');
  const formCsrf = extractCsrf(await p1.text());
  // 伪造一个签名合法但与表单 token 不同的 cookie（模拟多标签/扩展导致的不一致）
  jar.set('kg_csrf', issueCsrf('test-session-secret'));
  const res = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: formCsrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 403, 'cookie 与表单 token 不一致时应拒绝');
  // 重新登录，恢复后续用例依赖的会话
  const p2 = await fetchGw('/login');
  const freshCsrf = extractCsrf(await p2.text());
  const relogin = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: freshCsrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(relogin.status, 302);
});

test('重复 GET /login 不再轮换已有 csrf token（真实浏览器多标签/扩展场景）', async () => {
  jar.delete('kg_session');
  const p1 = await fetchGw('/login');
  const first = extractCsrf(await p1.text());
  const p2 = await fetchGw('/login');
  const second = extractCsrf(await p2.text());
  assert.equal(second, first, '已有合法 token 时再次 GET 应复用而不是轮换');
  // 用第一次渲染的表单提交，应依然成功
  const res = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: first, password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 302);
});

test('HTTP 流量经隧道到达 kimi 且注入 Authorization 头', async () => {
  const res = await fetchGw('/api/hello');
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; auth: string };
  assert.equal(body.ok, true);
  assert.equal(body.auth, `Bearer ${KIMI_TOKEN}`, 'gateway 应向上游注入 bearer token');
});

test('POST body 经隧道透传', async () => {
  const payload = Buffer.from('hello-tunnel-POST-中文');
  const res = await fetchGw('/api/echo', { method: 'POST', body: payload });
  assert.equal(res.status, 200);
  const echoed = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(echoed, payload);
});

test('WebSocket 经隧道 echo 成功', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/chat`, {
    headers: { cookie: cookieHeader() },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('ws open timeout')), 5000);
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data: Buffer) => resolve(data.toString()));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('ws echo timeout')), 5000);
      ws.send('ping-over-tunnel');
    });
    assert.equal(reply, 'ping-over-tunnel');
  } finally {
    ws.close();
  }
  assert.equal(kimiSeen.wsAuth, `Bearer ${KIMI_TOKEN}`, 'WS 升级也应注入 bearer token');
});

test('未认证的 WebSocket 被拒绝', async () => {
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/chat`);
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected-response ${res.statusCode}`)));
    }),
    /401|unexpected/,
  );
});

test('管理台：未二次确认时 API 返回 403，确认后可查登录日志', async () => {
  const denied = await fetchGw('/admin/api/logs', { headers: { accept: 'application/json' } });
  assert.equal(denied.status, 403);

  const page = await fetchGw('/admin');
  const csrf = extractCsrf(await page.text());
  const verify = await fetchGw('/admin/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(verify.status, 302);

  const logs = await fetchGw('/admin/api/logs');
  assert.equal(logs.status, 200);
  const rows = await logs.json() as Array<{ result: string; ip: string }>;
  assert.ok(rows.some((r) => r.result === 'success'), '日志中应有成功登录记录');
  assert.ok(rows.some((r) => r.result === 'bad_password'), '日志中应有失败登录记录');

  const status = await fetchGw('/admin/api/status');
  const s = await status.json() as { tunnelOnline: boolean };
  assert.equal(s.tunnelOnline, true);
});

// 放在最后：会打断隧道连接，依赖 connector 自动重连恢复
test('connector 在 gateway 主动断开后自动重连', async () => {
  assert.ok(gw.hub, 'tunnel 模式应有 hub');
  assert.equal(gw.hub.online, true);
  // 模拟 gateway 重启/断线：主动关闭当前隧道连接
  gw.hub.close();
  await waitFor(() => gw.hub!.online === false);
  // connector 应在指数退避后自行重连（首次退避约 0.5–1s）
  await waitFor(() => gw.hub!.online === true, 15000);
});
