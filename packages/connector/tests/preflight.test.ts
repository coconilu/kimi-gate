/**
 * preflight 自检测试：本地 kimi web 可达性 + Gateway 握手认证。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from 'kimi-gate-shared';
import { checkTarget, checkGateway } from '../src/preflight.js';

let httpServer: http.Server;
let httpPort: number;
let wss: WebSocketServer;
let wsPort: number;

const GOOD_KEY = 'test-key-123';

before(async () => {
  httpServer = http.createServer((_req, res) => {
    res.writeHead(401).end('unauthorized'); // 任意状态码都算存活
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  httpPort = (httpServer.address() as AddressInfo).port;

  // 模拟 Gateway 的 /tunnel 握手
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', r));
  wsPort = (wss.address() as AddressInfo).port;
  wss.on('connection', (ws) => {
    ws.once('message', (data: Buffer) => {
      const frame = decodeFrame(data.toString());
      if (frame?.type === 'auth' && frame.key === GOOD_KEY && frame.version === PROTOCOL_VERSION) {
        ws.send(encodeFrame({ type: 'auth_ok' }));
      } else {
        ws.send(encodeFrame({ type: 'auth_err', reason: 'invalid connector key or protocol version' }));
        ws.close(4003, 'auth failed');
      }
    });
  });
});

after(async () => {
  httpServer.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

test('checkTarget：本地服务存活时通过', async () => {
  const r = await checkTarget(`http://127.0.0.1:${httpPort}`);
  assert.equal(r.ok, true);
});

test('checkTarget：端口未监听时给出修复引导', async () => {
  const r = await checkTarget('http://127.0.0.1:59999', 3000);
  assert.equal(r.ok, false);
  assert.match(r.detail, /未检测到本地 kimi web/);
  assert.match(r.detail, /kimi web --port 58627/);
  assert.match(r.detail, /--target/);
});

test('checkGateway：正确密钥握手通过', async () => {
  const r = await checkGateway(`ws://127.0.0.1:${wsPort}`, GOOD_KEY);
  assert.equal(r.ok, true);
});

test('checkGateway：错误密钥提示去管理台复制', async () => {
  const r = await checkGateway(`ws://127.0.0.1:${wsPort}`, 'wrong-key');
  assert.equal(r.ok, false);
  assert.match(r.detail, /配对密钥/);
  assert.match(r.detail, /管理台/);
});

test('checkGateway：服务器不可达时给出排查指引', async () => {
  const r = await checkGateway('ws://127.0.0.1:59998', GOOD_KEY, 3000);
  assert.equal(r.ok, false);
  assert.match(r.detail, /无法连接 Gateway/);
  assert.match(r.detail, /Gateway 是否运行|ECONNREFUSED|拒绝/);
});
