'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const repo = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const bash = process.env.EPI_SMOKE_BASH;
const shells = windows ? ['windows', ...(bash ? ['linux'] : [])] : ['linux'];

function launch(shell, script, args, cwd, env) {
  const command = shell === 'windows' ? process.env.ComSpec || 'cmd.exe' : bash || 'sh';
  const argv = shell === 'windows'
    ? ['/d', '/c', 'call', script, ...args]
    : [script, ...args];
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}

function expectExit(result, code) {
  assert.equal(result.status, code, result.stderr + result.stdout);
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return;
    await delay(50);
  }
  assert.fail('The launcher did not start the executable.');
}

async function checkRelease(shell, target, scenario) {
  const batch = shell === 'windows';
  const desktop = target === 'desktop';
  const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'epi launcher '));
  try {
    const checkout = path.join(sandbox, 'checkout with spaces');
    const run = path.join(checkout, 'run');
    const launcher = desktop ? (batch ? 'éPI.bat' : 'éPI.sh') : (batch ? 'run/cli.bat' : 'run/cli.sh');
    const check = batch ? 'check-windows-build.ps1' : 'check-linux-build.sh';
    const build = desktop ? (batch ? 'build-windows.bat' : 'build-linux.sh') : (batch ? 'build-cli.bat' : 'build-cli.sh');
    const binary = desktop
      ? (batch ? 'release/windows/epi.exe' : 'release/linux/epi')
      : (batch ? 'release/cli/windows/epi-cli.exe' : 'release/cli/linux/epi-cli');
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(checkout, 'cli'));
    fs.mkdirSync(path.dirname(path.join(checkout, binary)), { recursive: true });
    for (const file of [launcher, 'run/' + check]) fs.copyFileSync(path.join(repo, file), path.join(checkout, file));

    const probe = path.join(sandbox, 'probe.cjs');
    const marker = path.join(sandbox, 'launched.json');
    const buildLog = path.join(sandbox, 'built.txt');
    const stub = path.join(sandbox, batch ? 'probe.exe' : 'probe.sh');
    const input = path.join(checkout, 'shared', 'input.cjs');
    const executable = path.join(checkout, binary);
    fs.mkdirSync(path.dirname(input));
    fs.writeFileSync(input, '');
    fs.writeFileSync(probe, [
      "const fs = require('node:fs');",
      "const marker = process.env.EPI_SMOKE_MARKER;",
      "fs.writeFileSync(marker + '.tmp', JSON.stringify([process.cwd(), ...process.argv.slice(2)]));",
      "fs.renameSync(marker + '.tmp', marker);",
      "process.exitCode = 23;",
    ].join('\n'));
    if (batch) fs.copyFileSync(process.execPath, stub);
    else fs.writeFileSync(stub, '#!/bin/sh\nexec "$EPI_SMOKE_NODE" "$@"\n', { mode: 0o755 });

    const batchBuild = [
      '@echo off',
      'echo(%*>"%EPI_SMOKE_BUILD_LOG%"',
      'if "%EPI_SMOKE_FAIL%"=="yes" exit /b 1',
      'copy /y "%EPI_SMOKE_STUB%" "%EPI_SMOKE_EXE%" >nul',
      'exit /b %errorlevel%',
    ].join('\r\n');
    const shellBuild = [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$EPI_SMOKE_BUILD_LOG"',
      '[ "$EPI_SMOKE_FAIL" != yes ] || exit 1',
      'cp "$EPI_SMOKE_STUB" "$EPI_SMOKE_EXE" && chmod +x "$EPI_SMOKE_EXE"',
    ].join('\n');
    fs.writeFileSync(path.join(run, build), batch ? batchBuild : shellBuild);

    if (scenario !== 'missing') {
      fs.copyFileSync(stub, executable);
      if (!batch) fs.chmodSync(executable, 0o755);
      const mtime = new Date(Date.now() + (scenario === 'fresh' ? 60000 : -60000));
      fs.utimesSync(executable, mtime, mtime);
    }

    const env = {
      ...process.env,
      EPI_SMOKE_NODE: process.execPath,
      EPI_SMOKE_MARKER: marker,
      EPI_SMOKE_BUILD_LOG: buildLog,
      EPI_SMOKE_STUB: stub,
      EPI_SMOKE_EXE: executable,
      EPI_SMOKE_FAIL: scenario === 'failure' ? 'yes' : 'no',
    };
    const args = ['argument with spaces', '--raw'];
    const result = launch(shell, path.join(checkout, launcher), [probe, ...args], sandbox, env);
    assert.equal(fs.existsSync(buildLog), scenario !== 'fresh');
    if (scenario !== 'fresh') {
      assert.equal(fs.readFileSync(buildLog, 'utf8').trim(), desktop ? '--portable' : '');
    }
    if (scenario === 'failure') {
      expectExit(result, 1);
      await delay(300);
      assert.equal(fs.existsSync(marker), false);
    } else {
      expectExit(result, batch && desktop ? 0 : 23);
      await waitForFile(marker);
      const [cwd, ...actualArgs] = JSON.parse(fs.readFileSync(marker, 'utf8'));
      assert.equal(fs.realpathSync(cwd), fs.realpathSync(desktop ? checkout : sandbox));
      assert.deepEqual(actualArgs, args);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function checkFixture(shell) {
  const output = fs.mkdtempSync(path.join(tmpdir(), 'epi fixture '));
  try {
    const launcher = shell === 'windows' ? 'run/fixture.bat' : 'run/fixture.sh';
    const env = { ...process.env, EPI_DATA_DIR: output };
    for (let attempt = 0; attempt < 2; attempt++) {
      expectExit(launch(shell, path.join(repo, launcher), [], output, env), 0);
      const files = fs.readdirSync(path.join(output, 'measures'), { recursive: true });
      assert.equal(files.filter(name => name.endsWith('.json')).length, 48);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

async function main() {
  for (const shell of shells) {
    for (const target of ['desktop', 'cli']) {
      for (const scenario of ['missing', 'fresh', 'stale', 'failure']) {
        await checkRelease(shell, target, scenario);
        console.log(shell, target, scenario, 'OK');
      }
    }
    checkFixture(shell);
    console.log(shell, 'fixture OK');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
