# kimi-gate-connector

运行在家里 PC 上的连接器：只建立到 Gateway 的**出站** WSS 长连接，把隧道流量转发给本地 `kimi web`。家里网络零端口开放。

## 一行命令接入（推荐）

家里电脑装好 Node.js（≥22.5）后运行（无需克隆本仓库）：

```bash
npx kimi-gate-connector --gateway wss://<你的域名> --key <配对密钥>
```

完整命令（含你的域名和配对密钥）在管理台 `https://<域名>/admin` 的"Connector 接入"区块，一键复制。

### 启动自检

命令启动前自动做两项检查，全部通过才进入常驻，失败会打印具体的修复引导：

1. **本地 kimi web 可达性**（默认 `http://127.0.0.1:58627`）：没启动会提示先跑 `kimi web --port 58627`；用了其他端口则用 `--target http://127.0.0.1:<端口>` 指定
2. **Gateway 连通与密钥**：服务器没启动、域名/DNS/443 不通、密钥错误，分别给出对应排查路径

只做自检不常驻（部署后验证用）：

```bash
npx kimi-gate-connector --gateway wss://<你的域名> --key <配对密钥> --check
```

### 参数

| 参数 | 说明 |
|---|---|
| `-g, --gateway <url>` | Gateway 地址，`wss://` 开头（也可设环境变量 `GATEWAY_URL`） |
| `-k, --key <key>` | 配对密钥（环境变量 `CONNECTOR_KEY`） |
| `-t, --target <url>` | 本地 kimi web 地址，默认 `http://127.0.0.1:58627`（环境变量 `KIMI_LOCAL_URL`） |
| `--check` | 只自检然后退出 |
| `--autostart` | 注册开机自启后退出（Windows 计划任务 / Linux systemd 用户服务 / macOS launchd） |
| `--no-autostart` | 移除开机自启后退出（无需其他参数） |
| `-h, --help` | 帮助 |

优先级：命令行 > 环境变量 > `.env` 文件（从源码运行时）。Connector 自带指数退避重连与心跳保活，断网恢复后自动重连。

## 常驻 / 开机自启

**默认不自启**：npx 命令只在前台运行，关掉就停。需要开机自启的话，跑一次：

```bash
npx kimi-gate-connector --gateway wss://<你的域名> --key <配对密钥> --autostart
```

会按当前系统自动注册（Windows 登录计划任务 / Linux systemd 用户服务 / macOS LaunchAgent），打印日志位置和撤销方法。想撤销：

```bash
npx kimi-gate-connector --no-autostart
```

### 备选：手动注册（NSSM / pm2 等）

熟悉 NSSM、pm2 或 systemd 的话，也可以用你顺手的工具托管同一条 npx 命令，效果一样。

> 注意：家里电脑睡眠会导致隧道中断，记得关闭睡眠（Windows: `powercfg /change standby-timeout-ac 0`）。

## 从源码运行（开发）

```bash
pnpm install && pnpm run build   # 在仓库根目录
cd packages/connector
cp .env.example .env             # 填 GATEWAY_URL / CONNECTOR_KEY / KIMI_LOCAL_URL
pnpm run start                   # 前台运行（开发）
```

## 日志

前台运行时输出到 stdout（连接/重连/认证失败等事件）；NSSM/任务计划程序方式写入配置的日志文件。
