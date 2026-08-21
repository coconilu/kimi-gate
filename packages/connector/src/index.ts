#!/usr/bin/env node
/**
 * kimi-gate-connector CLI
 *
 *   npx kimi-gate-connector --gateway wss://<域名> --key <配对密钥> [--target http://127.0.0.1:58627] [--check]
 *
 * 启动前先自检（本地 kimi web → Gateway 握手认证），全过才进入常驻连接；
 * --check 只自检不常驻，用于部署后验证。
 */
import { loadConfig, parseCliArgs } from './config.js';
import { startConnector } from './client.js';
import { checkTarget, checkGateway } from './preflight.js';

const HELP = `
kimi-gate-connector — 家里电脑与 kimi-gate Gateway 之间的加密隧道

用法:
  npx kimi-gate-connector --gateway wss://<你的域名> --key <配对密钥> [选项]

选项:
  -g, --gateway <url>   Gateway 地址，如 wss://kimi.example.com（也可设环境变量 GATEWAY_URL）
  -k, --key <key>       配对密钥（管理台 /admin 的"Connector 接入"区块可复制完整命令）
  -t, --target <url>    本地 kimi web 地址，默认 http://127.0.0.1:58627
      --check           只做连通性自检然后退出（不常驻）
  -h, --help            显示本帮助

参数优先级：命令行 > 环境变量 > .env 文件。
`.trim();

async function main(): Promise<number> {
  let cli: ReturnType<typeof parseCliArgs>;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(HELP);
    return 2;
  }
  if (cli.help) {
    console.log(HELP);
    return 0;
  }

  let config;
  try {
    config = loadConfig(cli);
  } catch (err) {
    console.error(`✗ 配置不完整：${err instanceof Error ? err.message : String(err)}`);
    console.error('  提示：登录管理台 /admin 的"Connector 接入"区块，可以一键复制完整命令。');
    return 2;
  }

  // ---- 自检 1/2：本地 kimi web ----
  process.stdout.write('自检 1/2 本地 kimi web … ');
  const target = await checkTarget(config.targetUrl);
  console.log(target.ok ? '✓' : '✗');
  if (!target.ok) {
    console.error(`\n${target.detail}`);
    return 1;
  }

  // ---- 自检 2/2：Gateway 握手认证 ----
  process.stdout.write('自检 2/2 Gateway 连通与密钥 … ');
  const gw = await checkGateway(config.gatewayUrl, config.connectorKey);
  console.log(gw.ok ? '✓' : '✗');
  if (!gw.ok) {
    console.error(`\n${gw.detail}`);
    return 1;
  }

  if (cli.check) {
    console.log('\n✅ 自检全部通过，可以正式运行（去掉 --check 即为常驻模式）。');
    return 0;
  }

  console.log('\n✅ 自检通过，Connector 启动中。保持本进程运行即可远程访问；Ctrl+C 停止。');
  console.log('   想开机自启/后台常驻，见文档：管理台"Connector 接入"区块或 packages/connector/README.md\n');

  const handle = startConnector(config);
  const shutdown = () => {
    config.log('shutting down…');
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

void main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((err) => {
  console.error('✗ 未预期的错误：', err);
  process.exitCode = 1;
});
