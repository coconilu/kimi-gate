/**
 * 启动前自检：本地 kimi web 可达性 + Gateway 连通与配对密钥校验。
 * 目标是让用户跑一条命令就能知道"通没通、没通该修哪"。
 */
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from 'kimi-gate-shared';

export interface CheckResult {
  ok: boolean;
  /** 人类可读的结论；失败时包含修复引导 */
  detail: string;
}

const TIMEOUT_MS = 10_000;

/** 本地 kimi web 是否在 targetUrl 上响应（任意 HTTP 状态码都算存活）。 */
export async function checkTarget(targetUrl: string, timeoutMs = TIMEOUT_MS): Promise<CheckResult> {
  try {
    await fetch(targetUrl + '/', { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { ok: true, detail: `本地 kimi web 可达（${targetUrl}）` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout|abort/i.test(msg);
    const cause = isTimeout ? '连接超时' : '连接被拒绝';
    return {
      ok: false,
      detail:
        `未检测到本地 kimi web（${cause}：${targetUrl}）。\n` +
        `  修复方法：\n` +
        `  1. 若还没启动，先运行：kimi web --port 58627\n` +
        `  2. 若 kimi web 用了其他端口，用 --target 指定，例如：--target http://127.0.0.1:58628\n` +
        `  3. 确认没有开代理/VPN 拦截本机回环请求`,
    };
  }
}

/**
 * 连 Gateway 的 /tunnel 完成一次握手认证，然后主动断开。
 * 分类失败原因：服务器不可达 / 密钥错误 / 协议不兼容。
 */
export function checkGateway(gatewayUrl: string, connectorKey: string, timeoutMs = TIMEOUT_MS): Promise<CheckResult> {
  return new Promise((resolve) => {
    const url = `${gatewayUrl}/tunnel`;
    let settled = false;
    const done = (r: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({
      ok: false,
      detail:
        `连接 Gateway 超时（${url}）。\n` +
        `  修复方法：\n` +
        `  1. 确认云服务器上的 Gateway 在运行：ssh 到服务器执行 systemctl status kimi-gate-gateway\n` +
        `  2. 确认域名解析指向服务器 IP，且防火墙放行了 443\n` +
        `  3. 确认 --gateway 地址拼写正确（wss:// 开头，不带路径）`,
    }), timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, detail: `Gateway 地址无效：${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    ws.on('open', () => {
      ws.send(encodeFrame({ type: 'auth', version: PROTOCOL_VERSION, key: connectorKey }));
    });
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data.toString());
      if (!frame) return;
      if (frame.type === 'auth_ok') {
        done({ ok: true, detail: `Gateway 连通，配对密钥有效（${gatewayUrl}）` });
      } else if (frame.type === 'auth_err') {
        done({
          ok: false,
          detail:
            `Gateway 拒绝了配对密钥（${frame.reason}）。\n` +
            `  修复方法：登录管理台 https://<你的域名>/admin ，在"Connector 接入"区块复制最新完整命令（密钥以管理台为准）`,
        });
      }
    });
    ws.on('error', (err: Error) => {
      const msg = err.message;
      let guidance: string;
      if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
        guidance = `域名解析失败。检查 --gateway 里的域名拼写，以及 DNS 记录是否已生效`;
      } else if (/ECONNREFUSED/.test(msg)) {
        guidance = `服务器拒绝了连接。检查 Gateway 是否运行、Caddy/443 端口是否放行`;
      } else if (/certificate|CERT|TLS|self.signed/i.test(msg)) {
        guidance = `HTTPS 证书校验失败。确认 Caddy 证书已签发（浏览器直接访问域名看是否有证书警告）`;
      } else {
        guidance = `检查服务器网络与 Gateway 运行状态（systemctl status kimi-gate-gateway）`;
      }
      done({ ok: false, detail: `无法连接 Gateway（${url}）：${msg}\n  修复方法：${guidance}` });
    });
    ws.on('close', (code: number) => {
      if (code === 4003) {
        done({
          ok: false,
          detail:
            `Gateway 拒绝了配对密钥。\n` +
            `  修复方法：登录管理台 https://<你的域名>/admin ，在"Connector 接入"区块复制最新完整命令`,
        });
      } else if (code === 4002) {
        done({ ok: false, detail: `协议版本不兼容：请升级 connector（npx kimi-gate-connector@latest …）` });
      } else {
        done({ ok: false, detail: `Gateway 在认证完成前关闭了连接（code ${code}）` });
      }
    });
  });
}
