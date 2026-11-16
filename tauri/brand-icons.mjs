import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = fileURLToPath(new URL('.', import.meta.url));
const brand = join(app, '..', 'assets', 'epi');
const cli = join(app, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function withIcons(action) {
  const temp = mkdtempSync(join(tmpdir(), 'epi-icons-'));
  try {
    action(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function render(source, output, sizes = []) {
  mkdirSync(output, { recursive: true });
  const result = spawnSync(process.execPath, [
    cli, 'icon', source, '-o', output, ...sizes.flatMap(size => ['--png', String(size)]),
  ], { cwd: app, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Échec de génération des icônes.');
}

const midnight = '#102b29';
const onDark = svg => svg.replaceAll('#a95a00', '#ffbd57').replaceAll('#087d73', '#74e8d0');

export function updateAndroidIcons(project) {
  withIcons(temp => {
    const master = readFileSync(join(brand, 'logo.svg'), 'utf8');
    writeFileSync(join(temp, 'foreground.svg'), onDark(master));
    const manifest = join(temp, 'android.json');
    writeFileSync(manifest, JSON.stringify({
      default: join(brand, 'logo-app.svg'),
      bg_color: midnight,
      android_fg: 'foreground.svg',
      android_fg_scale: 76,
    }));
    render(manifest, temp);
    cpSync(join(temp, 'android'), join(project, 'app', 'src', 'main', 'res'), { recursive: true });
  });
}

function updateAssets() {
  withIcons(temp => {
    const master = readFileSync(join(brand, 'logo.svg'), 'utf8');
    const midnight = '#102b29';
    const white = '#ffffff';
    const accent = (amber, mint) => master.replaceAll('#a95a00', amber).replaceAll('#087d73', mint);
    const onDark = accent('#ffbd57', '#74e8d0');
    const background = (svg, fill, radius = 0) => svg.replace('  <g', `  <rect width="64" height="64" rx="${radius}" fill="${fill}"/>\n  <g`);
    const badge = background(onDark, midnight, 14);
    const maskable = background(onDark.replace('  <g', '  <g transform="translate(5.12 5.12) scale(.84)">\n  <g').replace('</svg>', '  </g>\n</svg>'), midnight);
    const variants = {
      logo: master,
      'logo-blanc': background(master, white),
      'logo-noir': background(onDark, '#000000'),
      'logo-fonce': background(onDark, midnight),
      'logo-app': badge,
    };

    const appIcons = join(app, 'public', 'app-icons');
    const desktop = join(app, 'src-tauri', 'icons');
    for (const [name, svg] of Object.entries(variants)) {
      const source = join(brand, `${name}.svg`);
      if (name !== 'logo') writeFileSync(source, svg);
      render(source, temp, name === 'logo-app' ? [180, 192, 512] : name === 'logo-blanc' ? [120, 512] : [512]);
      copyFileSync(join(temp, '512x512.png'), join(brand, `${name}.png`));
      if (name === 'logo-blanc') copyFileSync(join(temp, '120x120.png'), join(brand, 'logo-oauth-120.png'));
    }
    for (const [size, name] of [[180, 'apple-touch-icon'], [192, 'epi-192'], [512, 'epi-512']]) {
      copyFileSync(join(temp, `${size}x${size}.png`), join(appIcons, `${name}.png`));
    }
    const maskSource = join(temp, 'maskable.svg');
    writeFileSync(maskSource, maskable);
    render(maskSource, temp, [512]);
    copyFileSync(join(temp, '512x512.png'), join(appIcons, 'epi-maskable.png'));

    render(join(brand, 'logo-app.svg'), temp);
    for (const [from, to] of [['32x32.png', '32.png'], ['128x128.png', '128.png'], ['icon.png', 'icon.png'], ['icon.ico', 'icon.ico']]) {
      copyFileSync(join(temp, from), join(desktop, to));
    }
    copyFileSync(join(temp, 'icon.ico'), join(app, 'public', 'favicon.ico'));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) updateAssets();
