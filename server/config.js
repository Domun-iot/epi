import { fileURLToPath } from 'node:url';

export default {
  host: '127.0.0.1',
  port: 8787,
  path: fileURLToPath(new URL('./data/epi.sqlite', import.meta.url)),
};
