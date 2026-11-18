import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const downloadsRoot = fileURLToPath(new URL('../downloads/', import.meta.url));
const base = '/epi/downloads';
const groups = ['windows', 'linux', 'android', 'cli-windows', 'cli-linux', 'web'];
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export async function manifests(root = downloadsRoot) {
  return (await Promise.all(groups.map(async group => {
    try { return { ...JSON.parse(await readFile(path.join(root, group, 'release.json'), 'utf8')), group }; }
    catch { return null; }
  }))).filter(Boolean);
}
export async function serveDownload(req, res, pathname, root = downloadsRoot) {
  if (pathname !== base && !pathname.startsWith(base + '/')) return false;
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
  try {
    const relative = decodeURIComponent(pathname.slice(base.length));
    if (relative.split('/').some(p => p.startsWith('.') || p.includes('\\')) || relative.includes('\0')) throw Error('Invalid path');
    const realRoot = await realpath(root);
    const file = await realpath(path.join(root, relative));
    if (file !== realRoot && !file.startsWith(realRoot + path.sep)) throw Error('Outside downloads');
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(308, { ...headers, Location: pathname + '/' }).end(); return true; }
      const entries = (await readdir(file, { withFileTypes: true })).filter(e => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
      const body = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>éPI downloads</title><h1>' + esc(pathname) + '</h1><p><a href="/epi/developers">Developers</a></p><ul>' +
        entries.map(e => '<li><a href="' + esc(pathname + encodeURIComponent(e.name) + (e.isDirectory() || e.isSymbolicLink() ? '/' : '')) + '">' + esc(e.name) + '</a></li>').join('') + '</ul></html>';
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : body);
    } else {
      const text = /(?:\.json|SHA256SUMS)$/.test(file);
      res.writeHead(200, { ...headers, 'Content-Length': info.size, 'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        ...(!text && { 'Content-Disposition': 'attachment; filename="' + path.basename(file).replace(/[^\w.-]/g, '_') + '"' }) });
      if (req.method === 'HEAD') res.end();
      else { const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); }
    }
  } catch { res.writeHead(404, headers).end(); }
  return true;
}
export function renderDownloads(locale, list, developer = false) {
  const fr = locale.startsWith('fr');
  const text = (a, b) => fr ? a : b;
  const link = (url, label) => '<a class="button" href="' + esc(url) + '">' + esc(label) + '</a>';
  const webNote = text('Saisie, consultation et synchronisation (version PRO). Sans connexion aux balances connectées.', 'Manual entry, viewing and synchronisation (PRO version). No connection to smart scales.');
  const noScale = text('Sans connexion aux balances connectées.', 'No connection to smart scales.');
  const card = (title, note, body) => '<article class="download-card"><h3>' + title + '</h3><p>' + note + '</p>' + body + '</article>';
  function files(group, kinds) {
    const release = list.find(m => m.group === group);
    const selected = release?.files.filter(f => kinds.includes(f.kind)) ?? [];
    if (!selected.length) return '<p class="download-pending">' + text('Téléchargement à venir', 'Download coming soon') + '</p>';
    return selected.map(f => '<div class="download-file">' + link(base + '/' + group + '/' + f.name, f.label) +
      '<small>v' + esc(release.version) + ' · ' + (f.size / 1000000).toFixed(1) + ' MB</small>' +
      '<details><summary>SHA-256</summary><code>' + esc(f.sha256) + '</code></details></div>').join('');
  }
  let body = '<section class="download-section" lang="' + (fr ? 'fr' : 'en') + '">' +
    (developer ? '<h1>' + text('Open source / Développeurs', 'Open source / Developers') + '</h1>' : '') +
    '<h2>' + text('Utiliser immédiatement', 'Use now') + '</h2>' +
    card(text('Application web', 'Web application'), webNote, link('https://epi.domun.eu/', text('Ouvrir éPI', 'Open éPI'))) +
    '<h2>' + text('Installer', 'Install') + '</h2><div class="download-grid">' +
    card('Android', text('Lancez l’app, puis pesez-vous : c’est enregistré.', 'Launch the app, then weigh yourself: it’s saved.'), link('https://play.google.com/store/apps/details?id=eu.domun.epi', 'Google Play')) +
    card('Windows', text('Reliez votre PC à votre balance connectée.', 'Connect your PC to your smart scale.'), files('windows', ['public'])) +
    card('Linux', text('Linux Debian/Ubuntu/Mint compatibles. Reliez votre PC à votre balance connectée.', 'Compatible Debian/Ubuntu/Mint Linux. Connect your PC to your smart scale.'), files('linux', ['public'])) +
    card(text('Application web installée (PWA)', 'Installed web application (PWA)'), noScale,
      '<details><summary>' + text('Comment l’installer', 'How to install') + '</summary><p>' +
      text('Ouvrez éPI dans votre navigateur. Chrome/Edge : menu → Installer l’application. iPhone/iPad : Safari → Partager → Sur l’écran d’accueil. Mac : Safari → Fichier → Ajouter au Dock.',
        'Open éPI in your browser. Chrome/Edge: menu → Install app. iPhone/iPad: Safari → Share → Add to Home Screen. Mac: Safari → File → Add to Dock.') + '</p></details>') + '</div>';
  if (developer) {
    body += '<h2>' + text('Autres formats', 'Other formats') + '</h2><div class="download-grid">' +
      card('Windows MSI', text('Déploiements administrés. WebView2 installé si nécessaire (connexion Internet requise).', 'Managed deployments. Installs WebView2 when needed (Internet required).'), files('windows', ['msi'])) +
      card('Windows portable', text('Nécessite WebView2 déjà installé. Données dans le dossier utilisateur d’éPI.', 'Requires WebView2 already installed. Data lives in the éPI user directory.'), files('windows', ['portable'])) +
      card('Linux AppImage', text('Distribution compatible requise. BlueZ requis pour le Bluetooth ; FUSE selon le système.', 'Requires a compatible distribution. BlueZ required for Bluetooth; FUSE depending on the system.'), files('linux', ['appimage'])) +
      card(text('Linux — binaire brut', 'Linux — raw binary'), text('Nécessite WebKitGTK 4.1, GTK 3, BlueZ et les bibliothèques liées au build. Données dans le dossier utilisateur d’éPI. Vérifiez les dépendances avec ldd ./epi.', 'Requires WebKitGTK 4.1, GTK 3, BlueZ and build-linked libraries. Data lives in the éPI user directory. Check dependencies with ldd ./epi.'), files('linux', ['portable'])) +
      card('Android APK', text('APK de production signé. Android 8 ou ultérieur. Autorisez l’installation depuis le gestionnaire de fichiers.', 'Signed production APK. Android 8 or later. Allow installation from your file manager.'), files('android', ['apk'])) +
      card('CLI Windows / Linux', text('Node.js embarqué. Scan Bluetooth sous Windows uniquement.', 'Node.js included. Bluetooth scanning on Windows only.'), files('cli-windows', ['cli']) + files('cli-linux', ['cli'])) +
      card(text('Web personnel', 'Personal web server'), text('Node.js 20.19 ou ultérieur et npm requis. Démarrer avec npm start. Sans réception Bluetooth. Ne pas exposer directement sur Internet.', 'Requires Node.js 20.19 or later and npm. Start with npm start. No Bluetooth reception. Do not expose directly to the Internet.'), files('web', ['web'])) + '</div>' +
      '<h2>' + text('Sources et documentation', 'Source and documentation') + '</h2><p>' +
      '<a href="/epi/developers/guide">' + text('Compilation et publication des releases', 'Build and release publication') + '</a> · ' +
      '<a href="/epi/downloads/">' + text('Parcourir les téléchargements et l’historique', 'Browse downloads and version history') + '</a></p>' +
      '<p>' + text('Dépôt source :', 'Source repository:') + ' <code>git clone https://github.com/domun-iot/epi.git</code></p>';
  } else body += '<p><a href="/epi/developers">' + text('Open source / Développeurs', 'Open source / Developers') + '</a></p>';
  return body + '</section>';
}
