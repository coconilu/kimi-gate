/**
 * TunnelHub: owns the single WSS connection from the Connector and
 * multiplexes proxied HTTP requests and relayed WebSocket sessions over it.
 */
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  decodeFrame, encodeFrame, newId, PROTOCOL_VERSION,
  type Frame, type HeaderMap,
} from '@kimi-gate/shared';

export interface ProxiedResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}

interface PendingHttp {
  resolve: (r: ProxiedResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class TunnelHub {
  private socket: WebSocket | null = null;
  private pendingHttp = new Map<string, PendingHttp>();
  private browserSockets = new Map<string, WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private rttMs = 0;

  constructor(private readonly opts: { connectorKey: string; timeoutMs: number }) {}

  get online(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN;
  }

  get stats(): { online: boolean; rttMs: number; pendingHttp: number; activeWs: number } {
    return { online: this.online, rttMs: this.rttMs, pendingHttp: this.pendingHttp.size, activeWs: this.browserSockets.size };
  }

  /** Try to bind a freshly upgraded /tunnel socket. First frame must be auth. */
  attach(ws: WebSocket): void {
    const authTimer = setTimeout(() => {
      ws.close(4001, 'auth timeout');
    }, 10000);

    ws.once('message', (data: Buffer) => {
      clearTimeout(authTimer);
      const frame = decodeFrame(data.toString());
      if (!frame || frame.type !== 'auth') {
        ws.send(encodeFrame({ type: 'auth_err', reason: 'first frame must be auth' }));
        ws.close(4002, 'bad handshake');
        return;
      }
      const a = Buffer.from(frame.key);
      const b = Buffer.from(this.opts.connectorKey);
      if (frame.version !== PROTOCOL_VERSION || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        ws.send(encodeFrame({ type: 'auth_err', reason: 'invalid connector key or protocol version' }));
        ws.close(4003, 'auth failed');
        return;
      }
      // replace any stale connector connection
      if (this.socket && this.socket !== ws) {
        try { this.socket.close(4000, 'replaced by new connector'); } catch { /* ignore */ }
      }
      this.socket = ws;
      this.lastSeen = Date.now();
      ws.send(encodeFrame({ type: 'auth_ok' }));
      this.startHeartbeat(ws);

      ws.on('message', (d: Buffer) => this.onFrame(d));
      ws.on('pong', () => { this.lastSeen = Date.now(); });
      ws.on('close', () => this.onClose(ws));
      ws.on('error', () => { /* close event follows */ });
    });

    ws.on('error', () => { /* handled post-auth */ });
  }

  private startHeartbeat(ws: WebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== ws) { clearInterval(this.heartbeatTimer!); return; }
      if (Date.now() - this.lastSeen > 75000) {
        ws.terminate();
        return;
      }
      const ts = Date.now();
      try {
        ws.ping();
        ws.send(encodeFrame({ type: 'ping', ts }));
      } catch { /* ignore */ }
    }, 30000);
    this.heartbeatTimer.unref();
  }

  private onFrame(data: Buffer): void {
    this.lastSeen = Date.now();
    const frame = decodeFrame(data.toString());
    if (!frame) return;
    switch (frame.type) {
      case 'pong': {
        this.rttMs = Date.now() - frame.ts;
        break;
      }
      case 'ping': {
        this.send({ type: 'pong', ts: frame.ts });
        break;
      }
      case 'http_res': {
        const p = this.pendingHttp.get(frame.id);
        if (!p) return;
        this.pendingHttp.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ status: frame.status, headers: frame.headers, body: Buffer.from(frame.body, 'base64') });
        break;
      }
      case 'ws_opened': {
        // connector 已连上本地 kimi web（connector 侧会缓冲期间到达的消息）
        break;
      }
      case 'ws_msg': {
        const browser = this.browserSockets.get(frame.id);
        if (!browser) return;
        const payload = Buffer.from(frame.data, 'base64');
        browser.send(frame.binary ? payload : payload.toString('utf8'), { binary: frame.binary });
        break;
      }
      case 'ws_close': {
        const browser = this.browserSockets.get(frame.id);
        this.browserSockets.delete(frame.id);
        if (browser) {
          try { browser.close(frame.code ?? 1000, frame.reason ?? ''); } catch { /* ignore */ }
        }
        break;
      }
      case 'ws_error': {
        const browser = this.browserSockets.get(frame.id);
        this.browserSockets.delete(frame.id);
        if (browser) {
          try { browser.close(1011, frame.message.slice(0, 120)); } catch { /* ignore */ }
        }
        break;
      }
      default:
        break;
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    const err = new Error('tunnel disconnected');
    for (const [, p] of this.pendingHttp) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingHttp.clear();
    for (const [, browser] of this.browserSockets) {
      try { browser.close(1013, 'tunnel disconnected'); } catch { /* ignore */ }
    }
    this.browserSockets.clear();
  }

  private send(frame: Frame): boolean {
    if (!this.online) return false;
    try {
      this.socket!.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Proxy one buffered HTTP request through the tunnel. */
  requestHttp(method: string, path: string, headers: HeaderMap, body: Buffer | null): Promise<ProxiedResponse> {
    return new Promise((resolve, reject) => {
      if (!this.online) {
        reject(new Error('tunnel offline'));
        return;
      }
      const id = newId();
      const timer = setTimeout(() => {
        this.pendingHttp.delete(id);
        reject(new Error('tunnel request timeout'));
      }, this.opts.timeoutMs);
      timer.unref();
      this.pendingHttp.set(id, { resolve, reject, timer });
      const ok = this.send({
        type: 'http_req', id, method, path, headers,
        body: body && body.length ? body.toString('base64') : null,
      });
      if (!ok) {
        clearTimeout(timer);
        this.pendingHttp.delete(id);
        reject(new Error('tunnel offline'));
      }
    });
  }

  /** Register a browser WebSocket and open its counterpart through the tunnel. */
  openBrowserWs(browser: WebSocket, path: string, headers: HeaderMap): boolean {
    if (!this.online) return false;
    const id = newId();
    this.browserSockets.set(id, browser);
    const ok = this.send({ type: 'ws_open', id, path, headers });
    if (!ok) {
      this.browserSockets.delete(id);
      return false;
    }

    browser.on('message', (data: Buffer, isBinary: boolean) => {
      this.send({ type: 'ws_msg', id, data: data.toString('base64'), binary: isBinary });
    });
    browser.on('close', (code: number, reason: Buffer) => {
      if (this.browserSockets.delete(id)) {
        this.send({ type: 'ws_close', id, code, reason: reason.toString() });
      }
    });
    browser.on('error', () => { /* close follows */ });
    return true;
  }

  close(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.socket) {
      try { this.socket.close(1001, 'gateway shutdown'); } catch { /* ignore */ }
      // 优雅 close 依赖对端握手，兜底直接销毁，避免进程无法退出
      try { this.socket.terminate(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
