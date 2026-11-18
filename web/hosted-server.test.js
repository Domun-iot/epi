import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('hosted notices are readable as text while other private files and mutation requests remain inaccessible', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'epi-hosted-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(new URL('./hosted-server.js', import.meta.url), join(directory, 'server.mjs'));
  await mkdir(join(directory, 'public/legal/npm/@example'), { recursive: true });
  await writeFile(join(directory, 'hosted.ok'), 'ok');
  await writeFile(join(directory, 'public/legal/npm/@example/LICENSE'), 'example notice');
  await writeFile(join(directory, 'secret.txt'), 'private runtime file');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [join(directory, 'server.mjs')], {
    env: { ...process.env, EPI_WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
  });
  const ready = once(child.stdout, 'data');
  const failed = once(child, 'exit').then(([code]) => { throw new Error('Hosted server exited before listening: ' + code); });
  await Promise.race([ready, failed]);
  const origin = 'http://127.0.0.1:' + port;
  const response = await fetch(origin + '/legal/npm/@example/LICENSE');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(await response.text(), 'example notice');
  assert.equal((await fetch(origin + '/legal/npm/@example/LICENSE', { method: 'HEAD' })).status, 200);
  for (const path of ['/secret.txt', '/legal/../../secret.txt', '/legal/%2e%2e/secret.txt', '/legal/npm/@example/missing']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin + '/legal/npm/@example/LICENSE', { method: 'POST' })).status, 404);
});
