'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { writeBuildNotices } = require('./build-notices.cjs');

const repository = resolve(__dirname, '..');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'epi-legal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['LICENSE', 'COPYING', 'COPYING.LESSER', 'THIRD_PARTY.md']) {
    copyFileSync(join(repository, file), join(root, file));
  }
  cpSync(join(repository, 'licenses'), join(root, 'licenses'), { recursive: true });
  const output = join(root, 'output');
  mkdirSync(join(output, 'legal'), { recursive: true });
  writeFileSync(join(output, 'legal', 'previous.txt'), 'previous usable notices');
  return { root, output };
}

test('a failed Node notice collection preserves the previous artifact notices', t => {
  const { root, output } = fixture(t);
  const license = join(root, 'incomplete-node.txt');
  writeFileSync(license, 'MIT');
  assert.throws(() => writeBuildNotices(output, { root, nodeRuntime: true, nodeLicense: license }), /complete Node/);
  assert.equal(readFileSync(join(output, 'legal', 'previous.txt'), 'utf8'), 'previous usable notices');
  assert.equal(existsSync(join(output, 'legal', 'components.json')), false);
});

test('notice collection refuses dependency versions differing from the lockfile', t => {
  const { root, output } = fixture(t);
  const pkg = join(root, 'tauri', 'node_modules', 'example');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'tauri', 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/example': { version: '1.0.0', license: 'MIT' },
  } }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '2.0.0', license: 'MIT' }));
  assert.throws(() => writeBuildNotices(output, { root, frontend: true }), /npm ci/);
  assert.equal(readFileSync(join(output, 'legal', 'previous.txt'), 'utf8'), 'previous usable notices');
});
