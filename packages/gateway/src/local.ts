/**
 * LocalUpstream（路线 A）：Gateway 与 kimi web 跑在同一台机器上，
 * 代理层直接把 HTTP / WebSocket 流量转发到本地上游，不经过 Connector 隧道。
 */
import WebSocket from 'ws';
import type { HeaderMap } from 'kimi-gate-shared';
import type { ProxiedResponse } from './tunnel.js';
import type { Upstream } from './proxy.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'upgrade', 'host', 'content-length',
]);

export class LocalUpstream implements Upstream {
  private activeWsCount = 0;

  constructor(
    private readonly targetUrl: string,
    private readonly timeoutMs: number,
  ) {}

  get stats(): { online: boolean; rttMs: number; pendingHttp: number; activeWs: number } {
    // 同机直连没有"隧道在线"概念；online 恒为 true，单请求故障在请求路径上体现
    return { online: true, rttMs: 0, pendingHttp: 0, activeWs: this.activeWsCount };
  }

  async requestHttp(method: string, path: string, headers: HeaderMap, body: Buffer | null): Promise<ProxiedResponse> {
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    let res: globalThis.Response;
    try {
      res = await fetch(this.targetUrl + path, {
        method,
        headers: outHeaders,
        body: body ?? undefined,
        duplex: body ? 'half' : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      } as RequestInit);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error('upstream timeout');
      throw new Error('upstream unreachable');
    }
    const resHeaders: HeaderMap = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) resHeaders['set-cookie'] = setCookies;
    return {
      status: res.status,
      headers: resHeaders,
      body: Buffer.from(await res.arrayBuffer()),
    };
  }

  openBrowserWs(browser: WebSocket, path: string, headers: HeaderMap): boolean {
    const wsUrl = this.targetUrl.replace(/^http/, 'ws') + path;
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk.startsWith('sec-websocket-')) continue;
      outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    let local: WebSocket;
    try {
      local = new WebSocket(wsUrl, { headers: outHeaders, handshakeTimeout: this.timeoutMs });
    } catch {
      return false;
    }
    this.activeWsCount += 1;
    let finished = false;
    let localOpen = false;
    const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
    const done = () => {
      if (!finished) {
        finished = true;
        this.activeWsCount -= 1;
      }
    };

    local.on('open', () => {
      localOpen = true;
      for (const m of pending.splice(0)) {
        local.send(m.isBinary ? m.data : m.data.toString('utf8'), { binary: m.isBinary });
      }
    });
    local.on('message', (data: Buffer, isBinary: boolean) => {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(isBinary ? data : data.toString('utf8'), { binary: isBinary });
      }
    });
    local.on('close', (code: number, reason: Buffer) => {
      done();
      if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
        try { browser.close(code, reason.toString()); } catch { /* ignore */ }
      }
    });
    local.on('error', (err: Error) => {
      done();
      try { browser.close(1011, err.message.slice(0, 120)); } catch { /* ignore */ }
    });

    browser.on('message', (data: Buffer, isBinary: boolean) => {
      if (localOpen && local.readyState === WebSocket.OPEN) {
        local.send(isBinary ? data : data.toString('utf8'), { binary: isBinary });
      } else if (!finished && local.readyState === WebSocket.CONNECTING) {
        // ws 库 CONNECTING 期间 send 会抛错（不像浏览器会缓冲），手工排队
        pending.push({ data, isBinary });
      }
    });
    browser.on('close', () => {
      done();
      try { local.close(1000); } catch { /* ignore */ }
    });
    browser.on('error', () => {
      try { local.close(1011); } catch { /* ignore */ }
    });
    return true;
  }

  close(): void {
    // 无长生命周期资源；浏览器/本地 WS 随 server close 销毁
  }
}
