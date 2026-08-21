# @kimi-gate/connector

运行在家里 PC 上的连接器：只建立到 Gateway 的**出站** WSS 长连接，把隧道流量转发给本地 `kimi web`。家里网络零端口开放。

## 配置

复制 `.env.example` 为 `.env`：

```env
GATEWAY_URL=wss://gate.example.com     # 你的 Gateway 域名
CONNECTOR_KEY=...                      # gateway 上 `npm run setup` 输出的配对密钥
KIMI_LOCAL_URL=http://127.0.0.1:58627  # 本地 kimi web（默认即可）
```

## 运行

```bash
npm run build          # 在仓库根目录先构建
cd packages/connector
npm run start          # 前台运行（开发）
```

Connector 自带指数退避重连（1s→30s 上限，含抖动）与心跳保活，断网恢复后会自动重连。

## Windows 注册为服务

### 方式一：NSSM（推荐）

1. 下载 [NSSM](https://nssm.cc/download)，解压得到 `nssm.exe`
2. 安装服务（假设仓库在 `E:\dev\kimi-gate`，node 在 PATH 中）：

```powershell
nssm install kimi-gate-connector "C:\Program Files\nodejs\node.exe" "E:\dev\kimi-gate\packages\connector\dist\index.js"
nssm set kimi-gate-connector AppDirectory "E:\dev\kimi-gate\packages\connector"
nssm set kimi-gate-connector AppEnvironmentExtra "CONNECTOR_CONFIG=E:\dev\kimi-gate\packages\connector\.env"
nssm set kimi-gate-connector AppStdout "E:\dev\kimi-gate\packages\connector\connector.log"
nssm set kimi-gate-connector AppStderr "E:\dev\kimi-gate\packages\connector\connector.log"
nssm start kimi-gate-connector
```

### 方式二：任务计划程序（开机自启，无需第三方工具）

```powershell
$action = New-ScheduledTaskAction `
  -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument "E:\dev\kimi-gate\packages\connector\dist\index.js" `
  -WorkingDirectory "E:\dev\kimi-gate\packages\connector"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "kimi-gate-connector" -Action $action -Trigger $trigger `
  -Description "kimi-gate connector (outbound tunnel to gateway)"
Start-ScheduledTask -TaskName "kimi-gate-connector"
```

注意：方式二下 connector 从 `packages/connector` 目录启动，默认读取该目录的 `.env`；如放别处，设置环境变量 `CONNECTOR_CONFIG=<绝对路径>`。

## 日志

前台运行时日志输出到 stdout，包含连接/重连/认证失败等事件；NSSM 方式写入 `connector.log`。
