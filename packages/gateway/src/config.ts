/**
 * Gateway configuration.
 *
 * Values come from process.env, optionally pre-loaded from a `.env` file
 * (path in GATEWAY_CONFIG, default `./.env`). The .env file is gitignored;
 * see .env.example for the full list.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface GatewayConfig {
  port: number;
  host: string;
  sessionSecret: string;
  adminPasswordHash: string;
  kimiBearerToken: string;
  connectorKey: string;
  totpSecret: string | null;
  dbPath: string;
  /** behind a TLS-terminating proxy (Caddy): trust X-Forwarded-* and set Secure cookies */
  trustProxy: boolean;
  /** HTTP request timeout through the tunnel / to the local upstream */
  tunnelTimeoutMs: number;
  /** max buffered HTTP body proxied upstream */
  maxBodyBytes: number;
  /**
   * 上游模式：
   *  - tunnel：经 Connector 的 WSS 隧道转发（路线 B，kimi web 在家里 PC）
   *  - local：直接转发到同机本地上游（路线 A，kimi web 与 Gateway 同机）
   */
  upstreamMode: 'tunnel' | 'local';
  /** local 模式的上游地址（本地 kimi web） */
  localUpstream: string;
}

export function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // missing file is fine
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const envFile = process.env.GATEWAY_CONFIG ?? path.resolve(process.cwd(), '.env');
  loadEnvFile(envFile);

  const cfg: GatewayConfig = {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    sessionSecret: process.env.SESSION_SECRET ?? '',
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
    kimiBearerToken: process.env.KIMI_BEARER_TOKEN ?? '',
    connectorKey: process.env.CONNECTOR_KEY ?? '',
    totpSecret: process.env.TOTP_SECRET || null,
    dbPath: process.env.DB_PATH ?? path.resolve(process.cwd(), 'kimi-gate.db'),
    trustProxy: (process.env.TRUST_PROXY ?? 'true') !== 'false',
    tunnelTimeoutMs: Number(process.env.TUNNEL_TIMEOUT_MS ?? 30000),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 32 * 1024 * 1024),
    upstreamMode: (process.env.UPSTREAM_MODE ?? 'tunnel') as 'tunnel' | 'local',
    localUpstream: (process.env.LOCAL_UPSTREAM ?? 'http://127.0.0.1:58627').replace(/\/+$/, ''),
    ...overrides,
  };
  if (cfg.upstreamMode !== 'tunnel' && cfg.upstreamMode !== 'local') {
    throw new Error(`UPSTREAM_MODE 必须是 tunnel 或 local: ${cfg.upstreamMode}`);
  }
  for (const key of ['sessionSecret', 'adminPasswordHash', 'kimiBearerToken'] as const) {
    if (!cfg[key]) throw new Error(`missing required config for ${key} (run \`npm run setup\` first)`);
  }
  // 配对密钥只在 tunnel 模式下必需
  if (cfg.upstreamMode === 'tunnel' && !cfg.connectorKey) {
    throw new Error('missing required config for connectorKey (run `npm run setup` first)');
  }
  return cfg;
}
