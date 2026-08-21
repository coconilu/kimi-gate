/**
 * kimi-gate tunnel protocol.
 *
 * A single WSS connection from the Connector (outbound, behind NAT) to the
 * Gateway (`/tunnel`) multiplexes two kinds of traffic:
 *
 *  1. HTTP request/response proxying:
 *       Gateway  --http_req(id)-->  Connector --(local http)--> kimi web
 *       Gateway  <--http_res(id)--  Connector
 *
 *  2. WebSocket upgrade relaying (kimi web's chat stream is WebSocket):
 *       Gateway  --ws_open(id)-->   Connector --(local ws)--> kimi web
 *       Gateway  <--ws_opened(id)-  Connector
 *       both     <-ws_msg(id)->     (bidirectional, base64 payload)
 *       both     <-ws_close(id)->
 *
 * All frames are JSON text messages on the tunnel socket. Binary payloads
 * (HTTP bodies, WS frames) are base64-encoded inside the JSON. This trades a
 * little bandwidth for a protocol that is trivial to debug and version.
 */

export const PROTOCOL_VERSION = 1;

export type HeaderMap = Record<string, string | string[]>;

export interface AuthFrame {
  type: 'auth';
  version: number;
  key: string;
}
export interface AuthOkFrame {
  type: 'auth_ok';
}
export interface AuthErrFrame {
  type: 'auth_err';
  reason: string;
}

export interface HttpReqFrame {
  type: 'http_req';
  id: string;
  method: string;
  /** path + query string, e.g. /api/chat?x=1 */
  path: string;
  headers: HeaderMap;
  /** base64 body, or null when there is no body */
  body: string | null;
}
export interface HttpResFrame {
  type: 'http_res';
  id: string;
  status: number;
  headers: HeaderMap;
  /** base64 body */
  body: string;
}

export interface WsOpenFrame {
  type: 'ws_open';
  id: string;
  path: string;
  headers: HeaderMap;
}
export interface WsOpenedFrame {
  type: 'ws_opened';
  id: string;
}
export interface WsMsgFrame {
  type: 'ws_msg';
  id: string;
  /** base64 payload */
  data: string;
  /** true if the original WS frame was binary */
  binary: boolean;
}
export interface WsCloseFrame {
  type: 'ws_close';
  id: string;
  code?: number;
  reason?: string;
}
export interface WsErrorFrame {
  type: 'ws_error';
  id: string;
  message: string;
}

export interface PingFrame {
  type: 'ping';
  ts: number;
}
export interface PongFrame {
  type: 'pong';
  ts: number;
}

export type Frame =
  | AuthFrame
  | AuthOkFrame
  | AuthErrFrame
  | HttpReqFrame
  | HttpResFrame
  | WsOpenFrame
  | WsOpenedFrame
  | WsMsgFrame
  | WsCloseFrame
  | WsErrorFrame
  | PingFrame
  | PongFrame;

const KNOWN_TYPES = new Set([
  'auth', 'auth_ok', 'auth_err',
  'http_req', 'http_res',
  'ws_open', 'ws_opened', 'ws_msg', 'ws_close', 'ws_error',
  'ping', 'pong',
]);

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(data: string): Frame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const type = (obj as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) return null;
  return obj as Frame;
}

export function newId(): string {
  return crypto.randomUUID();
}
