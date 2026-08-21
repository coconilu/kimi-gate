// 冒烟测试用的假 kimi web：HTTP 路由 + WebSocket echo，校验 Authorization 头。
// 用法: node scripts/fake-kimi.mjs <port> <expected-token>
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 58901);
const token = process.argv[3] ?? 'smoke-token';

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? null;
  if (req.url === '/api/hello') {
    res.writeHead(auth === `Bearer ${token}` ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: auth === `Bearer ${token}`, auth }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>fake kimi web</h1>');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[fake-kimi] listening on 127.0.0.1:${port}`));
