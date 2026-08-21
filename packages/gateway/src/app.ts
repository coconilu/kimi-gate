import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import type { GatewayConfig } from './config.js';
import { openDb, type Db } from './db.js';
import { TunnelHub } from './tunnel.js';
import { LocalUpstream } from './local.js';
import { httpProxyMiddleware, relayBrowserWs, type Upstream } from './proxy.js';
import { verifyPassword, hashPassword } from './password.js';
import { verifyTotp } from './totp.js';
import { RateLimiter } from './ratelimit.js';
import { recordAttempt, queryAttempts, attemptsToCsv } from './audit.js';
import {
  SESSION_COOKIE, createSession, getSession, revokeSession,
  markAdminVerified, listSessions, parseCookies, type Session,
} from './sessions.js';
import { CSRF_COOKIE, issueCsrf, verifyCsrf } from './csrf.js';
import { deviceFingerprint } from './fingerprint.js';
import { loginPage, adminConfirmPage, adminDashboardPage } from './views.js';

export interface Gateway {
  server: http.Server;
  /** tunnel 模式下的隧道 hub；local 模式为 null */
  hub: TunnelHub | null;
  upstream: Upstream;
  db: Db;
  port: () => number;
  close: () => Promise<void>;
}

interface AuthedRequest extends Request {
  session?: Session;
}

export function createGateway(config: GatewayConfig): Gateway {
  const db = openDb(config.dbPath);
  const isTunnel = config.upstreamMode === 'tunnel';
  const hub = isTunnel
    ? new TunnelHub({ connectorKey: config.connectorKey, timeoutMs: config.tunnelTimeoutMs })
    : null;
  const upstream: Upstream = hub ?? new LocalUpstream(config.localUpstream, config.tunnelTimeoutMs);
  const loginLimiter = new RateLimiter(db, { limit: 10, windowMs: 60_000 });

  // 管理员密码哈希解析：管理台改密后存进 settings 表并优先于 .env 的初始
  // 哈希（.env 仍作为首次部署/找回密码的引导值）。
  const adminPasswordHash = (): string => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get() as
      { value: string } | undefined;
    return row?.value ?? config.adminPasswordHash;
  };

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // --- security headers on everything ---
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'; connect-src 'self' ws: wss:");
    next();
  });

  const clientInfo = (req: Request) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    const ua = req.get('user-agent') ?? '';
    return { ip, ua, device: deviceFingerprint(ip, ua) };
  };

  const isBanned = (ip: string): boolean =>
    db.prepare('SELECT 1 FROM banned_ips WHERE ip = ?').get(ip) !== undefined;

  const secureFlag = (req: Request): string =>
    config.trustProxy && req.secure ? '; Secure' : '';

  const setCsrfCookie = (req: Request, res: Response): string => {
    const token = issueCsrf(config.sessionSecret);
    res.append('Set-Cookie', `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict${secureFlag(req)}`);
    return token;
  };

  // Token for rendering into a page: reuse the existing cookie when it holds
  // a valid signed token instead of rotating on every GET. Rotating per-GET
  // breaks real browsers — a second tab, an extension probe, or a prefetch
  // hitting GET /login invalidates the form the user is about to submit.
  // Tokens are HMAC-signed, so reuse does not weaken forgery resistance.
  const csrfForPage = (req: Request, res: Response): string => {
    const existing = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    if (verifyCsrf(config.sessionSecret, existing)) return existing;
    return setCsrfCookie(req, res);
  };

  const csrfFromRequest = (req: Request): string | undefined => {
    const bodyToken = (req.body as Record<string, unknown> | undefined)?.csrf;
    const headerToken = req.get('x-csrf-token');
    return (typeof bodyToken === 'string' && bodyToken) || headerToken || undefined;
  };

  // Signed-token CSRF check (OWASP signed-token pattern): the token's HMAC
  // signature must verify; when the kg_csrf cookie is present it must also
  // match (double-submit binding). Browsers that block cookies entirely can
  // still pass via the signature alone — a cross-site attacker cannot forge
  // the signed token either way.
  const csrfOk = (req: Request): boolean => {
    const token = csrfFromRequest(req);
    if (!verifyCsrf(config.sessionSecret, token)) return false;
    const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    return cookie === undefined || cookie === token;
  };

  const sessionFromRequest = (req: Request): Session | null =>
    getSession(db, config.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  const requireAuth = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const session = sessionFromRequest(req);
    if (!session) {
      if (req.method === 'GET' && req.accepts('html')) {
        res.redirect(302, '/login');
      } else {
        res.status(401).json({ error: 'unauthorized' });
      }
      return;
    }
    const { ip } = clientInfo(req);
    if (isBanned(ip)) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    req.session = session;
    next();
  };

  const requireAdmin = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.session?.admin_ok) {
      res.status(403).json({ error: 'admin verification required' });
      return;
    }
    next();
  };

  const requireAdminApiCsrf = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!verifyCsrf(config.sessionSecret, csrfFromRequest(req))) {
      res.status(403).json({ error: 'bad csrf token' });
      return;
    }
    next();
  };

  // --- login / logout ---
  const urlencoded = express.urlencoded({ extended: false, limit: '16kb' });

  app.get('/login', (req, res) => {
    if (sessionFromRequest(req)) return res.redirect(302, '/');
    const csrf = csrfForPage(req, res);
    res.type('html').send(loginPage({ csrf, totp: config.totpSecret !== null }));
  });

  app.post('/login', urlencoded, async (req, res) => {
    const { ip, ua, device } = clientInfo(req);
    const fail = (result: Parameters<typeof recordAttempt>[1]['result'], reason: string, status: number, msg: string) => {
      recordAttempt(db, { ip, ua, device, result, reason });
      const csrf = csrfForPage(req, res);
      res.status(status).type('html').send(loginPage({ csrf, totp: config.totpSecret !== null, error: msg }));
    };

    if (!csrfOk(req)) {
      return fail('bad_csrf', 'csrf token mismatch', 403, '表单校验失败，请重试');
    }
    if (isBanned(ip)) {
      return fail('banned', 'ip banned', 403, '该 IP 已被封禁');
    }
    if (!loginLimiter.allow(device)) {
      return fail('rate_limited', 'too many attempts', 429, '尝试过于频繁，请一分钟后再试');
    }

    const body = req.body as { password?: string; totp?: string };
    const passwordOk = typeof body.password === 'string' &&
      await verifyPassword(body.password, adminPasswordHash());
    if (!passwordOk) {
      return fail('bad_password', 'wrong password', 401, '密码错误');
    }
    if (config.totpSecret) {
      const code = typeof body.totp === 'string' ? body.totp : '';
      if (!verifyTotp(config.totpSecret, code)) {
        return fail('bad_totp', 'wrong totp', 401, '动态验证码错误');
      }
    }

    const { cookie } = createSession(db, config.sessionSecret, ip, ua);
    recordAttempt(db, { ip, ua, device, result: 'success' });
    res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`);
    res.redirect(302, '/');
  });

  app.get('/logout', (req, res) => {
    const session = sessionFromRequest(req);
    if (session) revokeSession(db, session.id);
    res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect(302, '/login');
  });

  // --- admin console ---
  app.get('/admin', requireAuth, (req: AuthedRequest, res) => {
    const csrf = csrfForPage(req, res);
    if (!req.session!.admin_ok) {
      res.type('html').send(adminConfirmPage({ csrf }));
      return;
    }
    res.type('html').send(adminDashboardPage({ csrf }));
  });

  app.post('/admin/verify', requireAuth, urlencoded, async (req: AuthedRequest, res) => {
    const renderError = (msg: string) => {
      const csrf = csrfForPage(req, res);
      res.status(401).type('html').send(adminConfirmPage({ csrf, error: msg }));
    };
    if (!csrfOk(req)) {
      return renderError('表单校验失败，请重试');
    }
    const body = req.body as { password?: string };
    const ok = typeof body.password === 'string' &&
      await verifyPassword(body.password, adminPasswordHash());
    if (!ok) return renderError('密码错误');
    markAdminVerified(db, req.session!.id);
    res.redirect(302, '/admin');
  });

  const adminApi = express.Router();
  adminApi.use(requireAuth, requireAdmin, requireAdminApiCsrf, express.json({ limit: '16kb' }));

  adminApi.get('/logs', (req, res) => {
    const rows = queryAttempts(db, {
      result: typeof req.query.result === 'string' && req.query.result ? req.query.result : undefined,
      ip: typeof req.query.ip === 'string' && req.query.ip ? req.query.ip : undefined,
      from: req.query.from ? Number(req.query.from) : undefined,
      to: req.query.to ? Number(req.query.to) : undefined,
      limit: req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json(rows);
  });

  adminApi.get('/logs.csv', (req, res) => {
    const rows = queryAttempts(db, {
      result: typeof req.query.result === 'string' && req.query.result ? req.query.result : undefined,
      ip: typeof req.query.ip === 'string' && req.query.ip ? req.query.ip : undefined,
      from: req.query.from ? Number(req.query.from) : undefined,
      to: req.query.to ? Number(req.query.to) : undefined,
      limit: 100000,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="login-attempts.csv"');
    res.send(attemptsToCsv(rows));
  });

  adminApi.get('/sessions', (_req, res) => {
    res.json(listSessions(db));
  });

  adminApi.post('/sessions/:id/revoke', (req, res) => {
    res.json({ revoked: revokeSession(db, req.params.id) });
  });

  adminApi.get('/bans', (_req, res) => {
    res.json(db.prepare('SELECT ip, created_at, reason FROM banned_ips ORDER BY created_at DESC').all());
  });

  adminApi.post('/bans', (req, res) => {
    const { ip, reason } = req.body as { ip?: string; reason?: string };
    if (!ip || typeof ip !== 'string') {
      res.status(400).json({ error: 'ip required' });
      return;
    }
    db.prepare('INSERT OR REPLACE INTO banned_ips (ip, created_at, reason) VALUES (?, ?, ?)')
      .run(ip, Date.now(), typeof reason === 'string' ? reason : '');
    res.json({ banned: ip });
  });

  adminApi.delete('/bans/:ip', (req, res) => {
    const r = db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(req.params.ip);
    res.json({ removed: Number(r.changes) > 0 });
  });

  adminApi.get('/status', (req, res) => {
    const s = upstream.stats;
    // 管理台已要求二次密码确认，向管理员本人展示配对密钥与即拷即用的接入命令
    const host = req.get('host') ?? '<你的域名>';
    res.json({
      upstreamMode: config.upstreamMode,
      tunnelOnline: s.online,
      connectorRttMs: s.rttMs,
      pendingHttp: s.pendingHttp,
      activeWs: s.activeWs,
      ...(isTunnel ? {
        connectorKey: config.connectorKey,
        connectorCommand: `npx kimi-gate-connector --gateway wss://${host} --key ${config.connectorKey}`,
      } : {}),
    });
  });

  // 修改管理员密码。止损语义：验证当前密码 → 写入新哈希（DB 优先于 .env）
  // → 删除全部既有会话（所有设备立即下线）→ 为当前设备签发新会话保持登录。
  // 注意：已建立的浏览器 WebSocket 不做强制断开，自然存活到连接关闭。
  adminApi.post('/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string; newPassword?: string;
    };
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
      res.status(400).json({ error: '当前密码与新密码必填' });
      return;
    }
    if (newPassword.length < 10 || newPassword.length > 128) {
      res.status(400).json({ error: '新密码长度需在 10–128 字符之间' });
      return;
    }
    if (!await verifyPassword(currentPassword, adminPasswordHash())) {
      res.status(401).json({ error: '当前密码错误' });
      return;
    }
    const hash = await hashPassword(newPassword);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)").run(hash);

    db.prepare('DELETE FROM sessions').run();
    const { ip, ua, device } = clientInfo(req);
    const session = createSession(db, config.sessionSecret, ip, ua);
    markAdminVerified(db, session.id);
    recordAttempt(db, { ip, ua, device, result: 'password_changed' });
    res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(session.cookie)}; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`);
    res.json({ ok: true });
  });

  app.use('/admin/api', adminApi);

  // --- everything else: authenticated reverse proxy upstream ---
  app.use(requireAuth, httpProxyMiddleware(upstream, config.kimiBearerToken, config.maxBodyBytes));

  // --- HTTP server + WebSocket upgrade routing ---
  const server = http.createServer(app);
  const wssTunnel = new WebSocketServer({ noServer: true });
  const wssBrowser = new WebSocketServer({ noServer: true });
  const upgradedSockets = new Set<import('node:net').Socket>();
  server.on('upgrade', (req, rawSocket, head) => {
    const socket = rawSocket as import('node:net').Socket;
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/tunnel') {
      if (!hub) {
        // local 模式不使用隧道：明确拒绝 Connector 连接
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wssTunnel.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
      return;
    }
    // browser-facing WebSocket (kimi web chat stream) — requires session
    const session = getSession(db, config.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const ip = req.socket.remoteAddress ?? '';
    const banned = db.prepare('SELECT 1 FROM banned_ips WHERE ip = ?').get(ip) !== undefined;
    if (!session || banned) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wssBrowser.handleUpgrade(req, socket, head, (ws) => {
      if (!relayBrowserWs(upstream, ws, req, config.kimiBearerToken)) {
        ws.close(1013, 'upstream unavailable');
      }
    });
  });

  return {
    server,
    hub,
    upstream,
    db,
    port: () => (server.address() as { port: number }).port,
    close: () =>
      new Promise((resolve) => {
        hub?.close();
        if (upstream instanceof LocalUpstream) upstream.close();
        wssTunnel.close();
        wssBrowser.close();
        server.close(() => {
          db.close();
          resolve();
        });
        // fetch/浏览器 keep-alive 连接会阻止 server.close 回调，主动销毁
        server.closeAllConnections();
        for (const s of upgradedSockets) s.destroy();
      }),
  };
}
