'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const windows = process.env.WINDIR || 'C:\\Windows';
const framework = join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const metadata = join(windows, 'System32', 'WinMetadata');
const compiler = join(framework, 'csc.exe');
const references = [
  ...['System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.Runtime.WindowsRuntime']
    .map(name => join(framework, name + '.dll')),
  ...['Windows.Devices', 'Windows.Storage', 'Windows.Foundation']
    .map(name => join(metadata, name + '.winmd')),
];

function checkScannerTools() {
  const missing = [compiler, ...references].filter(path => !existsSync(path));
  if (missing.length) {
    throw new Error('Composants .NET Framework ou WinRT Windows manquants :\n' + missing.join('\n'));
  }
}

function compileScanner(output) {
  checkScannerTools();
  const result = spawnSync(compiler, [
    '/nologo', '/out:' + output, ...references.map(ref => '/reference:' + ref), join(__dirname, 'scan.cs'),
  ], { stdio: ['ignore', 2, 2], windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('La compilation du lecteur Bluetooth Windows a échoué.');
}

module.exports = { checkScannerTools, compileScanner };
