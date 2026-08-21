/** Server-rendered minimal HTML pages. No frontend framework. */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · kimi-gate</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f1115; color: #e6e6e6; }
  .card { width: 320px; padding: 28px; border-radius: 12px; background: #1a1d24; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 18px; margin: 0 0 20px; text-align: center; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; color: #9aa0aa; }
  input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #333a45; background: #12151b; color: #e6e6e6; font-size: 14px; }
  input:focus { outline: none; border-color: #4f8cff; }
  button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px; background: #4f8cff; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #3f7bef; }
  .err { margin-top: 14px; padding: 10px; border-radius: 8px; background: #402225; color: #ff9a9a; font-size: 13px; }
  .brand { text-align: center; color: #6b7280; font-size: 12px; margin-top: 18px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

export function loginPage(opts: { csrf: string; error?: string; totp: boolean }): string {
  return page('登录', `
<div class="card">
  <h1>kimi-gate 登录</h1>
  <form method="post" action="/login" autocomplete="off">
    <input type="hidden" name="csrf" value="${esc(opts.csrf)}">
    <label for="password">密码</label>
    <input id="password" name="password" type="password" required autofocus>
    ${opts.totp ? `<label for="totp">动态验证码 (TOTP)</label>
    <input id="totp" name="totp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" required>` : ''}
    <button type="submit">登录</button>
  </form>
  ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
  <div class="brand">kimi-gate · 自托管安全网关</div>
</div>`);
}

export function adminConfirmPage(opts: { csrf: string; error?: string }): string {
  return page('管理台确认', `
<div class="card">
  <h1>进入管理台</h1>
  <form method="post" action="/admin/verify" autocomplete="off">
    <input type="hidden" name="csrf" value="${esc(opts.csrf)}">
    <label for="password">请再次输入密码确认</label>
    <input id="password" name="password" type="password" required autofocus>
    <button type="submit">确认</button>
  </form>
  ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
</div>`);
}

export function adminDashboardPage(opts: { csrf: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${esc(opts.csrf)}">
<title>管理台 · kimi-gate</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 22px; background: #1a1d24; border-bottom: 1px solid #262b35; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  .pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; }
  .on { background: #17351f; color: #7ee2a0; }
  .off { background: #402225; color: #ff9a9a; }
  main { padding: 22px; display: grid; gap: 22px; max-width: 1100px; margin: 0 auto; }
  section { background: #1a1d24; border-radius: 12px; padding: 18px; }
  h2 { font-size: 14px; margin: 0 0 12px; color: #9aa0aa; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #262b35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  th { color: #6b7280; font-weight: 600; }
  select, input, button, a.btn { font-size: 12.5px; padding: 6px 10px; border-radius: 6px; border: 1px solid #333a45; background: #12151b; color: #e6e6e6; }
  button, a.btn { cursor: pointer; background: #232936; text-decoration: none; }
  button:hover, a.btn:hover { background: #2d3547; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  .danger { color: #ff9a9a; }
</style>
</head>
<body>
<header>
  <h1>kimi-gate 管理台</h1>
  <span id="tunnel" class="pill off">隧道: …</span>
  <a class="btn" href="/" target="_blank">打开应用</a>
  <a class="btn" href="/logout">退出登录</a>
</header>
<main>
  <section>
    <h2>登录日志</h2>
    <div class="row">
      <select id="f-result">
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="bad_password">密码错误</option>
        <option value="bad_totp">TOTP 错误</option>
        <option value="rate_limited">被限流</option>
        <option value="banned">被封禁</option>
        <option value="bad_csrf">CSRF 拒绝</option>
        <option value="password_changed">修改密码</option>
      </select>
      <input id="f-ip" placeholder="按 IP 筛选">
      <button onclick="loadLogs()">查询</button>
      <a class="btn" id="csv" href="/admin/api/logs.csv">导出 CSV</a>
    </div>
    <table><thead><tr><th>时间</th><th>IP</th><th>结果</th><th>原因</th><th>UA</th></tr></thead><tbody id="logs"></tbody></table>
  </section>
  <section>
    <h2>活跃会话</h2>
    <table><thead><tr><th>创建时间</th><th>IP</th><th>过期时间</th><th>UA</th><th></th></tr></thead><tbody id="sessions"></tbody></table>
  </section>
  <section>
    <h2>IP 封禁</h2>
    <div class="row">
      <input id="ban-ip" placeholder="IP 地址">
      <input id="ban-reason" placeholder="原因（可选）">
      <button onclick="addBan()">封禁</button>
    </div>
    <table><thead><tr><th>IP</th><th>时间</th><th>原因</th><th></th></tr></thead><tbody id="bans"></tbody></table>
  </section>
  <section>
    <h2>修改密码</h2>
    <div class="row">
      <input id="pw-current" type="password" placeholder="当前密码" autocomplete="off">
      <input id="pw-new" type="password" placeholder="新密码（至少 10 位）" autocomplete="new-password">
      <input id="pw-new2" type="password" placeholder="重复新密码" autocomplete="new-password">
      <button onclick="changePassword()">修改</button>
    </div>
    <div id="pw-msg" style="font-size:12.5px;color:#9aa0aa">修改成功后，其他所有设备的登录会话会立即全部下线（本设备保持登录）。</div>
  </section>
  <section id="connector-section" style="display:none">
    <h2>Connector 接入（家里电脑）</h2>
    <div style="font-size:12.5px;color:#9aa0aa;margin-bottom:10px">在家里电脑上安装 Node.js（≥22.5）后，复制下面的命令运行即可接入，无需克隆仓库；自带连通性自检，成功后会打印访问地址。配对密钥包含在命令中，请勿泄露。</div>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px;cursor:pointer">
      <input type="checkbox" id="connector-autostart" onchange="renderConnectorCmds()" style="width:auto;margin:0">
      开机自启（重启电脑后自动接入；不勾选则关掉命令窗口就停止）
    </label>
    <div style="font-size:12.5px;color:#9aa0aa;margin-bottom:4px">启动：</div>
    <div class="row">
      <input id="connector-cmd" readonly style="flex:1;font-family:ui-monospace,monospace">
      <button onclick="copyInput('connector-cmd', this)">复制</button>
    </div>
    <div id="connector-stop-block" style="display:none;margin-top:10px">
      <div style="font-size:12.5px;color:#9aa0aa;margin-bottom:4px">关闭（撤销自启）：</div>
      <div class="row">
        <input id="connector-stop-cmd" readonly style="flex:1;font-family:ui-monospace,monospace">
        <button onclick="copyInput('connector-stop-cmd', this)">复制</button>
      </div>
    </div>
    <div id="connector-stop-hint" style="font-size:12.5px;color:#9aa0aa;margin-top:10px">未开启自启时，在运行命令的窗口按 Ctrl+C 即可停止。先加 <code>--check</code> 可只自检不常驻，适合部署后验证。</div>
  </section>
</main>
<script>
const csrf = document.querySelector('meta[name="csrf-token"]').content;
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const fmt = ts => new Date(ts).toLocaleString();
async function loadStatus() {
  const s = await api('/admin/api/status');
  const el = document.getElementById('tunnel');
  if (s.upstreamMode === 'local') {
    el.textContent = '模式: 同机直连';
    el.className = 'pill on';
    return;
  }
  el.textContent = s.tunnelOnline ? '隧道: 在线 (' + s.connectorRttMs + 'ms)' : '隧道: 离线';
  el.className = 'pill ' + (s.tunnelOnline ? 'on' : 'off');
  if (s.connectorCommand) {
    document.getElementById('connector-section').style.display = '';
    connectorBaseCmd = s.connectorCommand;
    renderConnectorCmds();
  }
}
let connectorBaseCmd = '';
function renderConnectorCmds() {
  const auto = document.getElementById('connector-autostart').checked;
  document.getElementById('connector-cmd').value = connectorBaseCmd + (auto ? ' --autostart' : '');
  document.getElementById('connector-stop-block').style.display = auto ? '' : 'none';
  document.getElementById('connector-stop-hint').style.display = auto ? 'none' : '';
  if (auto) {
    document.getElementById('connector-stop-cmd').value = 'npx kimi-gate-connector --no-autostart';
  }
}
async function copyInput(id, btn) {
  const el = document.getElementById(id);
  el.select();
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    document.execCommand('copy');
  }
  if (btn) { const t = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = t; }, 1500); }
}
async function loadLogs() {
  const p = new URLSearchParams();
  const r = document.getElementById('f-result').value, ip = document.getElementById('f-ip').value.trim();
  if (r) p.set('result', r);
  if (ip) p.set('ip', ip);
  document.getElementById('csv').href = '/admin/api/logs.csv?' + p;
  const rows = await api('/admin/api/logs?' + p);
  document.getElementById('logs').innerHTML = rows.map(x =>
    '<tr><td>' + fmt(x.ts) + '</td><td>' + x.ip + '</td><td>' + x.result + '</td><td>' + (x.reason || '') + '</td><td title="' + (x.ua||'').replace(/"/g,'&quot;') + '">' + (x.ua||'') + '</td></tr>').join('');
}
async function loadSessions() {
  const rows = await api('/admin/api/sessions');
  document.getElementById('sessions').innerHTML = rows.map(x =>
    '<tr><td>' + fmt(x.created_at) + '</td><td>' + x.ip + '</td><td>' + fmt(x.expires_at) + '</td><td>' + (x.ua||'') + '</td>' +
    '<td><button class="danger" onclick="kick(\\'' + x.id + '\\')">踢下线</button></td></tr>').join('');
}
async function kick(id) {
  await api('/admin/api/sessions/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
  loadSessions();
}
async function loadBans() {
  const rows = await api('/admin/api/bans');
  document.getElementById('bans').innerHTML = rows.map(x =>
    '<tr><td>' + x.ip + '</td><td>' + fmt(x.created_at) + '</td><td>' + (x.reason||'') + '</td>' +
    '<td><button class="danger" onclick="unban(\\'' + x.ip + '\\')">解封</button></td></tr>').join('');
}
async function addBan() {
  const ip = document.getElementById('ban-ip').value.trim();
  if (!ip) return;
  await api('/admin/api/bans', { method: 'POST', body: JSON.stringify({ ip, reason: document.getElementById('ban-reason').value.trim() }) });
  document.getElementById('ban-ip').value = '';
  loadBans();
}
async function unban(ip) {
  await api('/admin/api/bans/' + encodeURIComponent(ip), { method: 'DELETE' });
  loadBans();
}
async function changePassword() {
  const msg = document.getElementById('pw-msg');
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const new2 = document.getElementById('pw-new2').value;
  if (newPassword !== new2) {
    msg.textContent = '两次输入的新密码不一致';
    msg.style.color = '#ff9a9a';
    return;
  }
  try {
    await api('/admin/api/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    msg.textContent = '密码已修改，其他所有设备的会话已全部下线。';
    msg.style.color = '#7ee2a0';
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-new2').value = '';
    loadSessions();
  } catch (e) {
    let detail = '';
    try { detail = JSON.parse(e.message).error || ''; } catch { detail = e.message; }
    msg.textContent = '修改失败：' + detail;
    msg.style.color = '#ff9a9a';
  }
}
function refresh() { loadStatus(); loadLogs(); loadSessions(); loadBans(); }
refresh();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
}
