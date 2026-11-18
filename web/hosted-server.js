import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
await readFile(resolve(root, 'hosted.ok'));
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.ico', 'image/x-icon'], ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);
const files = new Set(['/index.html', '/favicon.ico', '/manifest.webmanifest']);
const port = Number(process.env.EPI_WEB_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid EPI_WEB_PORT.');
const server = createServer(async (request, response) => {
  try {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '')) {
      response.writeHead(403); return response.end();
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? '/index.html' : pathname;
    const legal = /^\/legal\/(?:[\w@][\w@.-]*\/)*[\w@][\w@.-]*$/.test(file);
    const allowed = legal || files.has(file) || /^\/assets\/[\w.-]+$/.test(file) || /^\/app-icons\/[\w-]+\.png$/.test(file);
    const type = legal ? 'text/plain; charset=utf-8' : types.get(extname(file));
    if (!['GET', 'HEAD'].includes(request.method) || !allowed || !type) {
      response.writeHead(404); return response.end();
    }
    const contents = await readFile(resolve(root, 'public', '.' + file));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': contents.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin' });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end();
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
server.listen(port, '127.0.0.1', () => console.log('éPI hosted web listening on 127.0.0.1:' + port));
