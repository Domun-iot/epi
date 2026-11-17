import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const prefixes = JSON.parse(await readFile(new URL('../../shared/mac-prefixes.json', import.meta.url), 'utf8'));

for (const mode of ['production', 'web', 'hosted']) {
  test(mode + ' keeps bounded JavaScript chunks and the complete offline MAC database', async () => {
    const { output } = await build({ root, mode, logLevel: 'silent', build: { write: false } });
    const chunks = output.filter(item => item.type === 'chunk');
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk.code) <= 500_000, chunk.fileName + ' exceeds the Vite warning limit');
      assert.ok(!chunk.code.includes('Dynamic require of'), chunk.fileName + ' has a browser-incompatible require');
    }
    const tables = chunks.filter(chunk => chunk.fileName.includes('/mac-prefixes-'));
    assert.ok(tables.length > 1, 'MAC database must be split into standalone data chunks');
    const actual = {};
    for (const chunk of tables) {
      assert.deepEqual(chunk.imports, [], 'data chunks must be independently loadable');
      assert.equal(chunk.exports.length, 1);
      const module = await import('data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64'));
      Object.assign(actual, module[chunk.exports[0]]);
    }
    assert.deepEqual(actual, prefixes, 'every MAC prefix and manufacturer must survive bundling');
  });
}

test('development resolves the offline MAC lookup through virtual domain modules', async () => {
  const server = await createServer({ root, logLevel: 'silent',
    server: { middlewareMode: true, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } });
  try {
    const { bluetooth } = await server.ssrLoadModule('virtual:epi-domain');
    const observation = bluetooth.createWatchDecoder()('PAYLOAD D4278722D707 -91 Manufacturer 3030 1 30 QVBfMzQxODczMTY0NA==');
    assert.equal(observation.label, 'Shanghai High-Flying Electronics Technology Co., Ltd (0x3030)');
  } finally { await server.close(); }
});
