/**
 * Reverse-proxy layer: authenticated browser traffic is forwarded upstream
 * (tunnel via Connector, or a same-host local kimi web), with the Kimi
 * bearer token injected HERE, on the Gateway — phones and the Connector
 * never see it.
 */
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { HeaderMap } from 'kimi-gate-shared';
import type { ProxiedResponse } from './tunnel.js';

/** 上游抽象：TunnelHub（路线 B）与 LocalUpstream（路线 A）共用同一接口。 */
export interface Upstream {
  requestHttp(method: string, path: string, headers: HeaderMap, body: Buffer | null): Promise<ProxiedResponse>;
  /** 中继一条已认证的浏览器 WebSocket；返回 false 表示上游不可用 */
  openBrowserWs(browser: WebSocket, path: string, headers: HeaderMap): boolean;
  readonly stats: { online: boolean; rttMs: number; pendingHttp: number; activeWs: number };
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'upgrade',
]);

const REQUEST_STRIP = new Set([
  ...HOP_BY_HOP, 'host', 'content-length', 'cookie', 'authorization',
]);

const RESPONSE_STRIP = new Set([...HOP_BY_HOP, 'content-length']);

function sanitizeRequestHeaders(raw: IncomingMessage['headers'], kimiToken: string): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (REQUEST_STRIP.has(lk) || lk.startsWith('sec-websocket-')) continue;
    out[k] = v;
  }
  out['authorization'] = `Bearer ${kimiToken}`;
  return out;
}

function sanitizeResponseHeaders(headers: HeaderMap): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (RESPONSE_STRIP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function httpProxyMiddleware(upstream: Upstream, kimiToken: string, maxBodyBytes: number) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req, maxBodyBytes);
      const headers = sanitizeRequestHeaders(req.headers, kimiToken);
      const upstreamRes = await upstream.requestHttp(req.method, req.originalUrl, headers, body);
      res.status(upstreamRes.status);
      for (const [k, v] of Object.entries(sanitizeResponseHeaders(upstreamRes.headers))) {
        res.setHeader(k, v);
      }
      res.end(upstreamRes.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'proxy error';
      if (msg === 'tunnel offline' || msg === 'tunnel disconnected') {
        res.status(503).type('text/plain').send('Connector 离线：家里 PC 的 connector 未连接');
      } else if (msg === 'tunnel request timeout' || msg === 'upstream timeout') {
        res.status(504).type('text/plain').send('上游请求超时');
      } else if (msg === 'body too large') {
        res.status(413).type('text/plain').send('请求体过大');
      } else if (msg === 'upstream unreachable') {
        res.status(502).type('text/plain').send('本地上游不可达：kimi web 未运行？');
      } else {
        res.status(502).type('text/plain').send('代理错误');
      }
    }
  };
}

/** Relay one authenticated browser WebSocket upstream. Returns false if upstream unavailable. */
export function relayBrowserWs(
  upstream: Upstream,
  browser: WebSocket,
  req: IncomingMessage,
  kimiToken: string,
): boolean {
  const headers = sanitizeRequestHeaders(req.headers, kimiToken);
  return upstream.openBrowserWs(browser, req.url ?? '/', headers);
}
