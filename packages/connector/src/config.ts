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

/** 从 gateway 地址推导用户浏览器访问地址：wss://gate.example.com → https://gate.example.com */
export function accessUrlFromGateway(gatewayUrl: string): string {
  return gatewayUrl.replace(/^ws(s?):\/\//, 'http$1://');
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
  if (!cfg.gatewayUrl) throw new Error('缺少 gateway 地址：用 --gateway wss://<域名> 指定（或在 .env 中设置 GATEWAY_URL）');
  if (!cfg.connectorKey) throw new Error('缺少配对密钥：用 --key <密钥> 指定（管理台 /admin 的"Connector 接入"区块可复制完整命令）');
  if (!/^wss?:\/\//.test(cfg.gatewayUrl)) {
    throw new Error(`gateway 地址必须以 ws:// 或 wss:// 开头: ${cfg.gatewayUrl}`);
  }
  return cfg;
}

/**
 * 解析命令行参数为配置覆盖项（优先级：CLI > 环境变量 > .env）。
 * 独立导出以便测试；非法参数抛出带中文提示的 Error。
 */
export interface CliFlags {
  check?: boolean;
  help?: boolean;
  autostart?: boolean;
  noAutostart?: boolean;
}

export function parseCliArgs(argv: string[]): Partial<ConnectorConfig> & CliFlags {
  const out: Partial<ConnectorConfig> & CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case '--gateway': case '-g': out.gatewayUrl = next(); break;
      case '--key': case '-k': out.connectorKey = next(); break;
      case '--target': case '-t': out.targetUrl = next(); break;
      case '--check': out.check = true; break;
      case '--autostart': out.autostart = true; break;
      case '--no-autostart': out.noAutostart = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        throw new Error(`未知参数: ${a}（用 --help 查看用法）`);
    }
  }
  if (out.autostart && out.noAutostart) {
    throw new Error('--autostart 和 --no-autostart 不能同时使用');
  }
  return out;
}
