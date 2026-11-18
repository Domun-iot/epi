import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream';

export function createHostedProxy({ port = Number(process.env.EPI_WEB_PORT ?? 3001) } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid EPI_WEB_PORT.');
  return async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    const pathname = request.url?.split('?')[0] ?? '/';
    if (pathname.startsWith('/v1/') || pathname.startsWith('/api/')) return false;
    await new Promise(resolve => {
      const upstream = httpRequest({ host: '127.0.0.1', port, path: request.url,
        method: request.method, headers: { Host: '127.0.0.1:' + port } }, remote => {
        response.writeHead(remote.statusCode ?? 502, remote.headers);
        pipeline(remote, response, () => resolve());
      });
      upstream.setTimeout(10000, () => upstream.destroy(new Error('Web service timeout')));
      upstream.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('éPI web est temporairement indisponible.');
        } else response.destroy();
        resolve();
      });
      request.once('aborted', () => upstream.destroy());
      upstream.end();
    });
    return true;
  };
}
