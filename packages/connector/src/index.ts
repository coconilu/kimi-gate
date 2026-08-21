#!/usr/bin/env node
/**
 * kimi-gate-connector CLI
 *
 *   npx kimi-gate-connector --gateway wss://<域名> --key <配对密钥> [--target http://127.0.0.1:58627] [--check]
 *
 * 启动前先自检（本地 kimi web → Gateway 握手认证），全过才进入常驻连接；
 * --check 只自检不常驻，用于部署后验证。
 */
import { loadConfig, parseCliArgs, accessUrlFromGateway } from './config.js';
import os from 'node:os';
import { startConnector } from './client.js';
import { checkTarget, checkGateway } from './preflight.js';
import { buildEnablePlan, buildDisablePlan, applyPlan, disableLeftoverFiles } from './autostart.js';

const HELP = `
kimi-gate-connector — 家里电脑与 kimi-gate Gateway 之间的加密隧道

用法:
  npx kimi-gate-connector --gateway wss://<你的域名> --key <配对密钥> [选项]

选项:
  -g, --gateway <url>   Gateway 地址，如 wss://kimi.example.com（也可设环境变量 GATEWAY_URL）
  -k, --key <key>       配对密钥（管理台 /admin 的"Connector 接入"区块可复制完整命令）
  -t, --target <url>    本地 kimi web 地址，默认 http://127.0.0.1:58627
      --check           只做连通性自检然后退出（不常驻）
      --autostart       注册开机自启（Windows 计划任务 / Linux systemd / macOS launchd）后退出
      --no-autostart    移除开机自启后退出
  -h, --help            显示本帮助

参数优先级：命令行 > 环境变量 > .env 文件。默认不自启，需要常驻才用 --autostart。
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

  // ---- 移除自启：不需要配置，直接执行 ----
  if (cli.noAutostart) {
    const plan = buildDisablePlan();
    try {
      const warnings = applyPlan(plan, {
        removeFiles: disableLeftoverFiles(process.platform, os.homedir()),
        ignoreCommandErrors: true,
      });
      console.log(`✓ ${plan.summary}`);
      for (const w of warnings) console.warn(`  提示: ${w}`);
      return 0;
    } catch (err) {
      console.error(`✗ 移除自启失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  let config;
  try {
    config = loadConfig(cli);
  } catch (err) {
    console.error(`✗ 配置不完整：${err instanceof Error ? err.message : String(err)}`);
    console.error('  提示：登录管理台 /admin 的"Connector 接入"区块，可以一键复制完整命令。');
    return 2;
  }

  // ---- 注册自启：写入当前平台的开机启动项后退出（不常驻、不自检） ----
  if (cli.autostart) {
    const plan = buildEnablePlan(config);
    try {
      applyPlan(plan);
      console.log(`✓ ${plan.summary}`);
      return 0;
    } catch (err) {
      console.error(`✗ 注册自启失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
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

  const accessUrl = accessUrlFromGateway(config.gatewayUrl);
  console.log('\n✅ 自检通过，Connector 启动中。保持本进程运行即可远程访问；Ctrl+C 停止。');
  console.log(`   远程访问地址：${accessUrl}  （手机/电脑浏览器打开，输密码即可使用）`);
  console.log('   需要开机自启的话，加 --autostart 跑一次即可注册（默认不自启）。\n');

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
