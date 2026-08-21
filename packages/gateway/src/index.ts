import { loadConfig } from './config.js';
import { createGateway } from './app.js';

const config = loadConfig();
const gw = createGateway(config);

gw.server.listen(config.port, config.host, () => {
  console.log(`[kimi-gate] gateway listening on http://${config.host}:${config.port}`);
  console.log(`[kimi-gate] upstream: ${config.upstreamMode === 'local' ? `local (${config.localUpstream})` : 'tunnel (等待 connector 连接)'}`);
  console.log(`[kimi-gate] db: ${config.dbPath}`);
  console.log(`[kimi-gate] totp: ${config.totpSecret ? 'enabled' : 'disabled'}`);
});

const shutdown = () => {
  console.log('\n[kimi-gate] shutting down…');
  void gw.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
