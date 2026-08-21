/**
 * End-to-end integration test for UPSTREAM_MODE=local（路线 A 同机直连）:
 *   fake kimi web (HTTP + WS echo, verifies Authorization header)
 *     <- Gateway local 直连 <- test client
 * 不启动 Connector，不经过 TunnelHub。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createGateway, type Gateway } from '../src/app.js';
import type { GatewayConfig } from '../src/config.js';
import { hashPassword } from '../src/password.js';

const KIMI_TOKEN = 'local-kimi-token-456';
const ADMIN_PASSWORD = 'local-secret-password';

// ---------- fake kimi web ----------
let kimiServer: http.Server;
let kimiPort: number;
const kimiSockets = new Set<import('node:net').Socket>();

async function startFakeKimi(): Promise<void> {
  kimiServer = http.createServer((req, res) => {
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null }));
      return;
    }
    res.writeHead(404).end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  kimiServer.on('connection', (s) => { kimiSockets.add(s); s.on('close', () => kimiSockets.delete(s)); });
  kimiServer.on('upgrade', (req, socket, head) => {
    kimiSockets.add(socket); socket.on('close', () => kimiSockets.delete(socket));
    if (req.headers.authorization !== `Bearer ${KIMI_TOKEN}`) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
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
  assert.ok(m, 'page should embed csrf token');
  return m[1];
}

before(async () => {
  await startFakeKimi();
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    sessionSecret: 'local-session-secret',
    adminPasswordHash: await hashPassword(ADMIN_PASSWORD),
    kimiBearerToken: KIMI_TOKEN,
    connectorKey: '', // local 模式无需配对密钥
    totpSecret: null,
    dbPath: ':memory:',
    trustProxy: false,
    tunnelTimeoutMs: 10000,
    maxBodyBytes: 4 * 1024 * 1024,
    upstreamMode: 'local',
    localUpstream: `http://127.0.0.1:${kimiPort}`,
  };
  gw = createGateway(config);
  await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
  gwPort = gw.port();
});

after(async () => {
  await gw.close();
  await new Promise<void>((r) => {
    kimiServer.close(() => r());
    kimiServer.closeAllConnections();
    for (const s of kimiSockets) s.destroy();
  });
});

test('local 模式：未登录 302 / API 401', async () => {
  const page = await fetchGw('/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const api = await fetchGw('/api/hello', { headers: { accept: 'application/json' } });
  assert.equal(api.status, 401);
});

test('local 模式：登录（失败写审计，成功种会话）', async () => {
  let pageRes = await fetchGw('/login');
  let csrf = extractCsrf(await pageRes.text());
  const bad = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: 'nope-nope-nope' }),
  });
  assert.equal(bad.status, 401);

  pageRes = await fetchGw('/login');
  csrf = extractCsrf(await pageRes.text());
  const good = await fetchGw('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(good.status, 302);
  assert.ok(jar.has('kg_session'));
  const rows = gw.db.prepare("SELECT result FROM login_attempts").all() as Array<{ result: string }>;
  assert.ok(rows.some((r) => r.result === 'bad_password'));
  assert.ok(rows.some((r) => r.result === 'success'));
});

test('local 模式：HTTP 直连上游且注入 Authorization 头', async () => {
  const res = await fetchGw('/api/hello');
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; auth: string };
  assert.equal(body.ok, true);
  assert.equal(body.auth, `Bearer ${KIMI_TOKEN}`);
});

test('local 模式：WebSocket 直连 echo 成功', async () => {
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
      ws.send('local-ping-中文');
    });
    assert.equal(reply, 'local-ping-中文');
  } finally {
    ws.close();
  }
});

test('local 模式：/tunnel 端点拒绝 Connector 连接', async () => {
  const err = await new Promise<Error>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/tunnel`);
    ws.once('open', () => resolve(new Error('不应建立连接')));
    ws.once('error', (e) => resolve(e));
    ws.once('unexpected-response', (_req, res) => resolve(new Error(`unexpected-response ${res.statusCode}`)));
  });
  assert.match(err.message, /403/);
});

test('local 模式：管理台 status 报告 upstreamMode=local', async () => {
  const page = await fetchGw('/admin');
  const csrf = extractCsrf(await page.text());
  const verify = await fetchGw('/admin/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, password: ADMIN_PASSWORD }),
  });
  assert.equal(verify.status, 302);
  const res = await fetchGw('/admin/api/status');
  const s = await res.json() as { upstreamMode: string; tunnelOnline: boolean };
  assert.equal(s.upstreamMode, 'local');
  assert.equal(s.tunnelOnline, true);
});
