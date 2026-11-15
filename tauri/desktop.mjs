import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('.', import.meta.url));
const windows = process.platform === 'win32';
const platform = windows ? 'windows' : process.platform;
const target = join(app, 'src-tauri', 'target', 'desktop');
const binary = windows ? 'epi.exe' : 'epi';
const compiled = join(target, 'release', binary);
const release = resolve(app, '..', 'release', platform);
const portable = join(release, binary);
const npm = windows ? process.env.ComSpec || 'cmd.exe' : 'npm';
const installArgs = windows ? ['/d', '/c', 'npm ci'] : ['ci'];
const cli = join(app, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const env = { ...process.env, CARGO_TARGET_DIR: target };
const formats = windows ? { nsis: '.exe', msi: '.msi' }
  : { deb: '.deb', rpm: '.rpm', appimage: '.AppImage' };

function run(command, args, commandEnv = env) {
  const result = spawnSync(command, args, { cwd: app, env: commandEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function ensureDependencies() {
  const available = existsSync(cli) && spawnSync(process.execPath, [cli, '--version'], {
    cwd: app, stdio: 'ignore',
  }).status === 0;
  if (!available && !run(npm, installArgs)) throw new Error('npm ci a échoué.');
}

function compile() {
  ensureDependencies();
  if (!run(process.execPath, [cli, 'build', '--no-bundle'])) {
    throw new Error('La compilation Tauri a échoué.');
  }
  mkdirSync(release, { recursive: true });
  const temporary = portable + '.tmp';
  copyFileSync(compiled, temporary);
  if (!windows) chmodSync(temporary, 0o755);
  renameSync(temporary, portable);
}

function openRelease() {
  const command = windows ? 'explorer.exe' : 'xdg-open';
  if (!windows && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const child = spawn(command, [release], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => console.error(`Impossible d’ouvrir le dossier. ${error.message}`));
  child.unref();
}

function buildAndroid() {
  const tools = windows ? join(process.env.LOCALAPPDATA, 'epi-dev')
    : join(homedir(), '.local', 'share', 'epi-dev');
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(tools, 'android-sdk');
  const javaHome = process.env.JAVA_HOME || (windows ? join(tools, 'jdk-17') : '/usr/lib/jvm/java-17-openjdk-amd64');
  const ndkHome = process.env.NDK_HOME || join(androidHome, 'ndk', '28.2.13676358');
  if (![androidHome, javaHome, ndkHome].every(path => existsSync(path))) {
    throw new Error(`Outils Android manquants. Lance ${windows ? 'run/prep/android.bat' : 'sh run/prep/android.sh'}.`);
  }

  ensureDependencies();
  const androidEnv = {
    ...process.env,
    ANDROID_HOME: androidHome,
    JAVA_HOME: javaHome,
    NDK_HOME: ndkHome,
    PATH: [join(javaHome, 'bin'), join(androidHome, 'platform-tools'), process.env.PATH].join(delimiter),
  };
  const project = join(app, 'src-tauri', 'gen', 'android');
  const gradlew = join(project, windows ? 'gradlew.bat' : 'gradlew');
  const npmPrefix = windows ? ['/d', '/c'] : [];
  const tauriArgs = args => windows ? [...npmPrefix, 'npm run tauri -- ' + args.join(' ')] : ['run', 'tauri', '--', ...args];
  if (!existsSync(gradlew) && !run(npm, tauriArgs(['android', 'init', '--ci']), androidEnv)) {
    throw new Error('L’initialisation du projet Android a échoué.');
  }

  // Gradle signe automatiquement la variante debug, installable sur un téléphone.
  // Tauri uses the npm invocation to generate Gradle’s callback to the CLI.
  if (!run(npm, tauriArgs(['android', 'build', '--apk', '--debug', '--ci']), androidEnv)) {
    throw new Error('La compilation de l’APK a échoué.');
  }
  const apk = join(project, 'app', 'build', 'outputs', 'apk', 'universal', 'debug', 'app-universal-debug.apk');
  const destination = resolve(app, '..', 'release', 'android');
  mkdirSync(destination, { recursive: true });
  const output = join(destination, 'epi-debug.apk');
  copyFileSync(apk, output + '.tmp');
  renameSync(output + '.tmp', output);
  console.log(`APK Android ${output}`);
}

function buildDesktop(selected) {
  if (selected.includes('--portable') && selected.length !== 1
      || selected.some(format => format !== '--portable' && !Object.hasOwn(formats, format))) {
    throw new Error(`Formats disponibles : --portable, ${Object.keys(formats).join(', ')}.`);
  }
  compile();
  for (const format of new Set(selected)) {
    if (format === '--portable') continue;
    const started = Date.now();
    if (!run(process.execPath, [cli, 'bundle', '--bundles', format, '--no-binary-patching'])) {
      console.error(`La génération du format ${format} a échoué.`);
      process.exitCode = 1;
      continue;
    }
    const bundle = join(target, 'release', 'bundle', format);
    const files = (existsSync(bundle) ? readdirSync(bundle) : []).filter(name => name.endsWith(formats[format])
      && statSync(join(bundle, name)).mtimeMs >= started - 2000);
    if (!files.length) {
      console.error(`Aucun nouveau paquet ${format} n’a été trouvé dans ${bundle}.`);
      process.exitCode = 1;
    }
    for (const name of files) {
      const file = join(release, basename(name));
      copyFileSync(join(bundle, name), file);
      if (format === 'appimage') chmodSync(file, 0o755);
    }
  }
  console.log(`Release : ${release}`);
  openRelease();
}

try {
  if (!['windows', 'linux'].includes(platform)) throw new Error('Utilise ces scripts sur Windows ou Linux.');
  const [, , mode, ...args] = process.argv;
  if (mode === 'android' && !args.length) buildAndroid();
  else if (mode === 'build' && windows) buildDesktop(args.length ? args : Object.keys(formats));
  else if (mode === 'linux' && !windows) buildDesktop(args.length ? args : ['appimage']);
  else if (mode === 'ubuntu' && !windows) buildDesktop(args.length ? args : ['deb']);
  else throw new Error('Utilise le script de build correspondant à ta plateforme.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
