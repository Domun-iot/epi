import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '#config';
import { createApi } from './api.ts';
import { openStore } from './store.ts';

const { host, port, path } = config;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port in config.js');
mkdirSync(dirname(path), { recursive: true });
const store = openStore(path);
const server = createApi(store);
server.once('close', () => store.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close());
}
server.listen(port, host, () => console.log('éPI sync server listening on', server.address()));
