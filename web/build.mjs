import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import notices from '../scripts/build-notices.cjs';

const source = fileURLToPath(new URL('.', import.meta.url));
const tauri = fileURLToPath(new URL('../tauri/', import.meta.url));
const output = process.env.EPI_WEB_OUTPUT || fileURLToPath(new URL('../release/web/', import.meta.url));
const hosted = process.argv.includes('--hosted');
const marker = join(output, hosted ? 'hosted.ok' : 'build.ok');

await mkdir(output, { recursive: true });
await Promise.all(['build.ok', 'hosted.ok'].map(name => rm(join(output, name), { force: true })));
const result = spawnSync(process.execPath, [
  join(tauri, 'node_modules/vite/bin/vite.js'), 'build', '--mode', hosted ? 'hosted' : 'web',
  '--outDir', join(output, 'public'), '--emptyOutDir',
], { cwd: tauri, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

for (const file of ['package.json', 'server.js', 'local-api.js', 'hosted-server.js', 'actions.js', 'account-api.js', 'session-api.js', 'file-records.js', 'file-storage.js']) {
  const contents = await (await import('node:fs/promises')).readFile(join(source, file), 'utf8');
  await writeFile(join(output, file), file.endsWith('.js')
    ? contents.replaceAll("'../shared/", "'./shared/")
    : file === 'package.json' && hosted
      ? JSON.stringify({ ...JSON.parse(contents), scripts: { start: 'node hosted-server.js' } }, null, 2) + '\n' : contents);
}
await copyFile(join(source, 'config.js'), join(output, 'config.js'), constants.COPYFILE_EXCL)
  .catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
await cp(join(tauri, 'domain'), join(output, 'tauri', 'domain'), {
  recursive: true, filter: path => !path.endsWith('.test.cjs'),
});
await cp(join(source, '..', 'shared'), join(output, 'shared'), {
  recursive: true, filter: path => !path.endsWith('.test.cjs'),
});
notices.writeBuildNotices(output, { frontend: true });
await writeFile(marker, 'ok\n');
