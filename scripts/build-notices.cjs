'use strict';

const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createHash } = require('node:crypto');

const repository = resolve(__dirname, '..');
const noticeName = /^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i;

function copyNotices(source, destination) {
  const files = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isFile() && noticeName.test(entry.name)).map(entry => entry.name).sort();
  mkdirSync(destination, { recursive: true });
  for (const name of files) copyFileSync(join(source, name), join(destination, name));
  return files;
}

function frontendNotices(root, destination) {
  const workspace = join(root, 'tauri');
  const locked = JSON.parse(readFileSync(join(workspace, 'package-lock.json'), 'utf8')).packages;
  const result = [];
  for (const [path, entry] of Object.entries(locked)) {
    if (!path || entry.dev || (entry.optional && !existsSync(join(workspace, path)))) continue;
    const installed = join(workspace, path);
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (pkg.version !== entry.version) throw new Error('Run npm ci before collecting notices: ' + path);
    const target = join(destination, 'npm', pkg.name.replaceAll('/', '__'));
    const files = copyNotices(installed, target);
    // The Tauri plugins ship copyright/SPDX declarations; their common texts
    // are shipped by @tauri-apps/api. Preserve both the declarations and texts.
    if (pkg.name.startsWith('@tauri-apps/') && files.includes('LICENSE.spdx')) {
      const common = join(workspace, 'node_modules', '@tauri-apps', 'api');
      for (const name of ['LICENSE-MIT', 'LICENSE-APACHE-2.0']) {
        if (!files.includes(name)) copyFileSync(join(common, name), join(target, name));
        if (!files.includes(name)) files.push(name);
      }
    }
    if (!files.some(name => noticeName.test(name) && !name.endsWith('.spdx'))) {
      throw new Error('No license text found for ' + pkg.name);
    }
    result.push({ name: pkg.name, version: pkg.version, license: pkg.license, files });
  }
  return result;
}

function nodeNotice(destination, executable, override) {
  const binary = realpathSync(executable);
  const candidates = override ? [override] : [join(dirname(binary), 'LICENSE'), join(dirname(binary), '..', 'LICENSE')];
  const source = candidates.find(path => existsSync(path));
  if (!source) throw new Error('Node runtime LICENSE not found. Set EPI_NODE_LICENSE to the LICENSE supplied with this Node binary.');
  const text = readFileSync(source);
  if (!text.includes(Buffer.from('Node.js')) || !text.includes(Buffer.from('Permission is hereby granted'))) {
    throw new Error('EPI_NODE_LICENSE must contain the complete Node distribution license.');
  }
  copyFileSync(source, join(destination, 'NODE-LICENSE.txt'));
  return { version: process.version, license_sha256: createHash('sha256').update(text).digest('hex') };
}

function writeBuildNotices(output, { root = repository, frontend = false, nodeRuntime = false,
  nodeExecutable = process.execPath, nodeLicense = process.env.EPI_NODE_LICENSE } = {}) {
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(output, '.legal-'));
  const next = join(temporary, 'next');
  const previous = join(temporary, 'previous');
  const destination = join(output, 'legal');
  try {
    mkdirSync(next);
    for (const name of ['LICENSE', 'COPYING', 'COPYING.LESSER', 'THIRD_PARTY.md']) {
      copyFileSync(join(root, name), join(next, name));
    }
    cpSync(join(root, 'licenses'), join(next, 'licenses'), { recursive: true });
    const inventory = { schema: 1, npm: frontend ? frontendNotices(root, next) : [] };
    if (nodeRuntime) inventory.node = nodeNotice(next, nodeExecutable, nodeLicense);
    writeFileSync(join(next, 'components.json'), JSON.stringify(inventory, null, 2) + '\n');
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(next, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    return inventory;
  } finally {
    if (existsSync(destination) || !existsSync(previous)) rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { writeBuildNotices };
