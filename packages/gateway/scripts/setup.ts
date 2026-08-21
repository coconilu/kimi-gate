/**
 * Interactive first-time setup: admin password, session secret, connector
 * pairing key, kimi bearer token, optional TOTP. Writes .env (gitignored).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { hashPassword, activeAlgorithm } from '../src/password.js';
import { generateTotpSecret } from '../src/totp.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, opts: { secret?: boolean; required?: boolean; default?: string } = {}): Promise<string> {
  for (;;) {
    const suffix = opts.default !== undefined ? ` [${opts.default}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    const value = answer || (opts.default ?? '');
    if (value || !opts.required) return value;
    console.log('  不能为空，请重新输入。');
  }
}

async function main(): Promise<void> {
  console.log('kimi-gate 初始化向导\n');

  const envPath = process.env.GATEWAY_CONFIG ?? path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const overwrite = await ask(`已存在配置文件 ${envPath}，是否覆盖？(y/N)`);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消。');
      rl.close();
      return;
    }
  }

  // --- admin password (twice) ---
  let password = '';
  for (;;) {
    password = await ask('设置管理员密码（至少 10 位）', { required: true });
    if (password.length < 10) {
      console.log('  密码太短，至少 10 位。');
      continue;
    }
    const again = await ask('再次输入密码确认', { required: true });
    if (password === again) break;
    console.log('  两次输入不一致，请重试。');
  }
  console.log(`  使用 ${activeAlgorithm()} 哈希…`);
  const passwordHash = await hashPassword(password);

  const kimiToken = await ask('kimi web 的 bearer token', { required: true });

  // --- 上游模式 ---
  let upstreamMode: 'local' | 'tunnel' = 'local';
  let localUpstream = 'http://127.0.0.1:58627';
  for (;;) {
    const m = (await ask('上游模式：A = 同机直连（kimi web 跑在本 VPS 上），B = 隧道（kimi web 在家里 PC，需要 Connector）[A/B]', { default: 'A' })).toLowerCase();
    if (m === 'a' || m === 'local') { upstreamMode = 'local'; break; }
    if (m === 'b' || m === 'tunnel') { upstreamMode = 'tunnel'; break; }
    console.log('  请输入 A 或 B。');
  }
  if (upstreamMode === 'local') {
    localUpstream = await ask('本地 kimi web 地址', { default: 'http://127.0.0.1:58627' });
  }

  const useTotp = await ask('是否启用 TOTP 双因素认证？(y/N)');
  let totpSecret = '';
  if (useTotp.toLowerCase() === 'y') {
    totpSecret = generateTotpSecret();
    console.log(`\n  TOTP 密钥（添加到 Authenticator 应用，或扫描二维码）:`);
    console.log(`    ${totpSecret}`);
    console.log(`    otpauth://totp/kimi-gate:admin?secret=${totpSecret}&issuer=kimi-gate\n`);
  }

  const port = await ask('监听端口', { default: '3000' });
  const dbPath = await ask('SQLite 数据库路径', { default: './kimi-gate.db' });

  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const connectorKey = crypto.randomBytes(32).toString('hex');

  const lines = [
    '# kimi-gate gateway configuration —— 包含密钥，切勿提交到 git',
    `PORT=${port}`,
    'HOST=0.0.0.0',
    `DB_PATH=${dbPath}`,
    `SESSION_SECRET=${sessionSecret}`,
    `ADMIN_PASSWORD_HASH=${passwordHash}`,
    `KIMI_BEARER_TOKEN=${kimiToken}`,
    `UPSTREAM_MODE=${upstreamMode}`,
    upstreamMode === 'local' ? `LOCAL_UPSTREAM=${localUpstream}` : '# LOCAL_UPSTREAM=http://127.0.0.1:58627',
    `CONNECTOR_KEY=${connectorKey}`,
    totpSecret ? `TOTP_SECRET=${totpSecret}` : '# TOTP_SECRET=',
    'TRUST_PROXY=true',
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });

  console.log(`\n配置已写入 ${envPath}（权限 0600）。`);
  if (upstreamMode === 'tunnel') {
    console.log('\nConnector 配对密钥（复制到家里 PC 的 connector 配置中）:');
    console.log(`  ${connectorKey}`);
  } else {
    console.log(`\n同机直连模式：请确保 kimi web 监听在 ${localUpstream}。`);
    console.log('（CONNECTOR_KEY 已一并生成并写入配置，今后切换到 tunnel 模式可直接使用。）');
  }
  console.log('\n启动: npm run start:gateway');
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
