/**
 * Connector: outbound-only WSS client to the Gateway. Multiplexes proxied
 * HTTP requests and relayed WebSocket sessions to local `kimi web`.
 * Reconnects with exponential backoff + jitter; application-level heartbeat.
 */
import WebSocket from 'ws';
import {
  decodeFrame, encodeFrame, PROTOCOL_VERSION,
  type Frame, type HeaderMap, type HttpReqFrame, type WsOpenFrame,
} from '@kimi-gate/shared';
import type { ConnectorConfig } from './config.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'upgrade', 'host', 'content-length',
]);

export interface ConnectorHandle {
  close: () => void;
  isConnected: () => boolean;
}

export function startConnector(config: ConnectorConfig): ConnectorHandle {
  const tunnelUrl = `${config.gatewayUrl}/tunnel`;
  let ws: WebSocket | null = null;
  let authed = false;
  let stopped = false;
  let attempts = 0;
  let heartbeat: NodeJS.Timeout | null = null;
  let lastSeen = 0;
  const localWs = new Map<string, WebSocket>();
  const pendingWs = new Map<string, Array<{ data: string; binary: boolean }>>();

  const send = (frame: Frame): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(encodeFrame(frame)); } catch { /* ignore */ }
    }
  };

  function cleanupLocal(): void {
    for (const [, l] of localWs) {
      try { l.close(1001, 'tunnel reconnecting'); } catch { /* ignore */ }
    }
    localWs.clear();
    pendingWs.clear();
  }

  async function handleHttpReq(frame: HttpReqFrame): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(frame.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      const body = frame.body ? Buffer.from(frame.body, 'base64') : undefined;
      const res = await fetch(config.targetUrl + frame.path, {
        method: frame.method,
        headers,
        body,
        duplex: body ? 'half' : undefined,
        redirect: 'manual',
      });
      const outHeaders: HeaderMap = {};
      res.headers.forEach((v, k) => { outHeaders[k] = v; });
      const setCookies = res.headers.getSetCookie();
      if (setCookies.length) outHeaders['set-cookie'] = setCookies;
      const buf = Buffer.from(await res.arrayBuffer());
      send({ type: 'http_res', id: frame.id, status: res.status, headers: outHeaders, body: buf.toString('base64') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      config.log(`http_req ${frame.id} failed: ${msg}`);
      send({
        type: 'http_res', id: frame.id, status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from(`本地 kimi web 不可达: ${msg}`).toString('base64'),
      });
    }
  }

  function handleWsOpen(frame: WsOpenFrame): void {
    const wsUrl = config.targetUrl.replace(/^http/, 'ws') + frame.path;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk.startsWith('sec-websocket-')) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    let local: WebSocket;
    try {
      local = new WebSocket(wsUrl, { headers, handshakeTimeout: 15000 });
    } catch (err) {
      send({ type: 'ws_error', id: frame.id, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    localWs.set(frame.id, local);
    const pending: Array<{ data: string; binary: boolean }> = [];
    pendingWs.set(frame.id, pending);

    local.on('open', () => {
      pendingWs.delete(frame.id);
      for (const m of pending) {
        const payload = Buffer.from(m.data, 'base64');
        local.send(m.binary ? payload : payload.toString('utf8'), { binary: m.binary });
      }
      send({ type: 'ws_opened', id: frame.id });
    });
    local.on('message', (data: Buffer, isBinary: boolean) => {
      send({ type: 'ws_msg', id: frame.id, data: data.toString('base64'), binary: isBinary });
    });
    local.on('close', (code: number, reason: Buffer) => {
      pendingWs.delete(frame.id);
      if (localWs.delete(frame.id)) {
        send({ type: 'ws_close', id: frame.id, code, reason: reason.toString() });
      }
    });
    local.on('error', (err: Error) => {
      pendingWs.delete(frame.id);
      if (localWs.delete(frame.id)) {
        send({ type: 'ws_error', id: frame.id, message: err.message });
      }
    });
  }

  function onFrame(data: Buffer): void {
    lastSeen = Date.now();
    const frame = decodeFrame(data.toString());
    if (!frame) return;
    switch (frame.type) {
      case 'auth_ok':
        authed = true;
        attempts = 0;
        config.log(`已连接 gateway: ${config.gatewayUrl}`);
        break;
      case 'auth_err':
        config.log(`认证失败: ${frame.reason}`);
        break;
      case 'http_req':
        void handleHttpReq(frame);
        break;
      case 'ws_open':
        handleWsOpen(frame);
        break;
      case 'ws_msg': {
        const local = localWs.get(frame.id);
        if (!local) break;
        if (local.readyState === WebSocket.OPEN) {
          const payload = Buffer.from(frame.data, 'base64');
          local.send(frame.binary ? payload : payload.toString('utf8'), { binary: frame.binary });
        } else if (local.readyState === WebSocket.CONNECTING) {
          // 本地连接尚未打开：排队，open 时按序冲刷
          pendingWs.get(frame.id)?.push({ data: frame.data, binary: frame.binary });
        }
        break;
      }
      case 'ws_close': {
        const local = localWs.get(frame.id);
        pendingWs.delete(frame.id);
        if (localWs.delete(frame.id) && local) {
          try { local.close(frame.code ?? 1000, frame.reason ?? ''); } catch { /* ignore */ }
        }
        break;
      }
      case 'ping':
        send({ type: 'pong', ts: frame.ts });
        break;
      default:
        break;
    }
  }

  function connect(): void {
    if (stopped) return;
    config.log(`连接 ${tunnelUrl} …`);
    ws = new WebSocket(tunnelUrl, { handshakeTimeout: 15000 });
    lastSeen = Date.now();

    ws.on('open', () => {
      send({ type: 'auth', version: PROTOCOL_VERSION, key: config.connectorKey });
      heartbeat = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastSeen > 75000) {
          config.log('心跳超时，主动重连');
          ws.terminate();
          return;
        }
        try {
          ws.ping();
          send({ type: 'ping', ts: Date.now() });
        } catch { /* ignore */ }
      }, 25000);
      heartbeat.unref();
    });
    ws.on('message', onFrame);
    ws.on('pong', () => { lastSeen = Date.now(); });
    ws.on('error', (err: Error) => {
      config.log(`连接错误: ${err.message}`);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      const wasAuthed = authed;
      authed = false;
      cleanupLocal();
      if (stopped) return;
      if (code === 4003) {
        config.log('配对密钥被 gateway 拒绝，请检查 CONNECTOR_KEY。30 秒后重试。');
      } else if (wasAuthed) {
        config.log(`连接断开 (${code} ${reason.toString()})`);
      }
      attempts += 1;
      const base = Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5));
      const delay = Math.round(base * (0.5 + Math.random() * 0.5));
      config.log(`${Math.round(delay / 1000)} 秒后重连…`);
      setTimeout(connect, delay).unref();
    });
  }

  connect();

  return {
    close: () => {
      stopped = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      cleanupLocal();
      if (ws) {
        try { ws.close(1000, 'connector shutdown'); } catch { /* ignore */ }
        // 兜底销毁，避免 TCP 半开导致进程无法退出
        try { ws.terminate(); } catch { /* ignore */ }
      }
    },
    isConnected: () => authed && ws !== null && ws.readyState === WebSocket.OPEN,
  };
}
