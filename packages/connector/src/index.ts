import { loadConfig } from './config.js';
import { startConnector } from './client.js';

const config = loadConfig();
const handle = startConnector(config);

const shutdown = () => {
  config.log('shutting down…');
  handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
