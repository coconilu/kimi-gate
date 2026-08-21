/**
 * Connector configuration: gateway URL, pairing key, local kimi web address.
 * Values come from process.env, optionally pre-loaded from a `.env` file
 * (path in CONNECTOR_CONFIG, default `./.env`).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ConnectorConfig {
  /** e.g. wss://gate.example.com (ws:// allowed for local testing) */
  gatewayUrl: string;
  connectorKey: string;
  /** local kimi web, default http://127.0.0.1:58627 */
  targetUrl: string;
  log: (msg: string) => void;
}

export function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

export function loadConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  const envFile = process.env.CONNECTOR_CONFIG ?? path.resolve(process.cwd(), '.env');
  loadEnvFile(envFile);

  const cfg: ConnectorConfig = {
    gatewayUrl: (process.env.GATEWAY_URL ?? '').replace(/\/+$/, ''),
    connectorKey: process.env.CONNECTOR_KEY ?? '',
    targetUrl: (process.env.KIMI_LOCAL_URL ?? 'http://127.0.0.1:58627').replace(/\/+$/, ''),
    log: (msg) => console.log(`[connector] ${new Date().toISOString()} ${msg}`),
    ...overrides,
  };
  cfg.gatewayUrl = cfg.gatewayUrl.replace(/\/+$/, '');
  cfg.targetUrl = cfg.targetUrl.replace(/\/+$/, '');
  if (!cfg.gatewayUrl) throw new Error('missing GATEWAY_URL (see .env.example)');
  if (!cfg.connectorKey) throw new Error('missing CONNECTOR_KEY (从 gateway 的 setup 输出中复制)');
  if (!/^wss?:\/\//.test(cfg.gatewayUrl)) {
    throw new Error(`GATEWAY_URL 必须以 ws:// 或 wss:// 开头: ${cfg.gatewayUrl}`);
  }
  return cfg;
}
