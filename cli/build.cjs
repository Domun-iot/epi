'use strict';

const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const { inject } = require('postject');
const { join } = require('node:path');
const { compileScanner } = require('./scanner.cjs');
const { writeBuildNotices } = require('../scripts/build-notices.cjs');

const platform = { win32: 'windows', linux: 'linux' }[process.platform];
if (!platform) throw new Error('Le build du CLI est disponible sous Windows et Linux.');

const release = join(__dirname, '..', 'release', 'cli');
const output = join(release, platform);

async function buildRelease() {
  mkdirSync(release, { recursive: true });
  const temporary = mkdtempSync(join(release, '.build-'));
  const next = join(temporary, 'next');
  const previous = join(temporary, 'previous');
  try {
    mkdirSync(next);
    writeBuildNotices(next, { nodeRuntime: true });
    const main = join(temporary, 'cli.cjs');
    const blob = join(temporary, 'cli.blob');
    const config = join(temporary, 'sea.json');
    const name = platform === 'windows' ? 'epi-cli.exe' : 'epi-cli';
    const executable = join(next, name);
    const assets = {};
    if (platform === 'windows') {
      assets['scanner.exe'] = join(temporary, 'scanner.exe');
      compileScanner(assets['scanner.exe']);
    }

    await build({
      entryPoints: [join(__dirname, 'index.cjs')],
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
    });
    writeFileSync(config, JSON.stringify({ main, output: blob, assets, disableExperimentalSEAWarning: true }));
    execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
    copyFileSync(process.execPath, executable);
    await inject(executable, 'NODE_SEA_BLOB', readFileSync(blob), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    });
    if (platform === 'linux') chmodSync(executable, 0o755);
    execFileSync(executable, ['--help'], { cwd: next });

    if (existsSync(output)) renameSync(output, previous);
    try {
      renameSync(next, output);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, output);
      throw error;
    }
    console.log('Release CLI ' + join(output, name));
  } finally {
    if (existsSync(output) || !existsSync(previous)) rmSync(temporary, { recursive: true, force: true });
  }
}

buildRelease().catch(error => { console.error(error.message); process.exitCode = 1; });
