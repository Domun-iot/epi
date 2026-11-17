import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatCatalog, loadPrices, planCopy, planLanguage, renderPro } from './pro.js';
import { catalog, locales, selectLocale } from './locales.js';
import { referenceTitle, renderHome, renderReference } from './features.js';
import { deletionUrl, flags, playIcon, playUrl, renderFooter, renderHeader } from './layout.js';

const base = '/epi';
const homeActionsCopy = {
  fr: ['Télécharger sur', 'Gratuite et sans pub', 'Découvrir la version Pro', 'Synchronisation, vues enregistrées et sauvegardes ZIP'],
  en: ['Get it on', 'Free and ad-free', 'Explore the Pro version', 'Sync, saved views and ZIP backups'],
};
const illustratedPages = new Set(['home', 'pro']);
const routes = new Map([
  [base, 'home'],
  [base + '/compatible-scales', 'scales'],
  [base + '/pro', 'pro'],
  [base + '/calculation-methods', 'methods'],
  [base + '/privacy-policy', 'privacy'],
  [base + '/legal-notice', 'legal'],
]);
const assets = new Map(Object.entries({
  ...Object.fromEntries(Object.values(flags).map(code => ['flags/' + code + '.svg', 'image/svg+xml'])),
  'style.css': 'text/css; charset=utf-8',
  'scenes.js': 'text/javascript; charset=utf-8',
  'epi.svg': 'image/svg+xml',
  'google-play.svg': 'image/svg+xml',
  'chart.jpg': 'image/jpeg',
}).map(([name, type]) => [base + '/assets/' + name, {
  type, body: readFileSync(new URL('./public/' + name, import.meta.url)),
}]));
assets.set(base + '/assets/weigh-ins.jpg', {
  type: 'image/jpeg', body: readFileSync(new URL('../docs/google-play/pesees.jpg', import.meta.url)),
});
const stylePath = base + '/assets/style.css';
const styleVersion = createHash('sha256').update(assets.get(stylePath).body).digest('hex').slice(0, 12);
const scenesPath = base + '/assets/scenes.js';
const scenesVersion = createHash('sha256').update(assets.get(scenesPath).body).digest('hex').slice(0, 12);
const escape = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function renderHomeActions(locale) {
  const language = locale.startsWith('fr-') ? 'fr' : 'en';
  const [download, free, pro, benefits] = homeActionsCopy[language];
  return '<div class="home-actions" lang="' + language + '">' +
    '<a class="home-action home-download" href="' + playUrl + '">' + playIcon(base) +
    '<span><small>' + download + '</small><strong>Google Play</strong><span>' + free + '</span></span>' +
    '<span class="home-action-arrow" aria-hidden="true">↗</span></a>' +
    '<a class="home-action home-pro" href="' + base + '/pro"><span class="pro-badge" aria-hidden="true">PRO</span>' +
    '<span><strong>' + pro + '</strong><span>' + benefits + '</span></span>' +
    '<span class="home-action-arrow" aria-hidden="true">→</span></a></div>';
}

function render(path, page, locale, retention, prices) {
  const t = catalog[locale];
  const contactLink = '<a href="https://logisan.fr/contact/">Logisan</a>';
  const retentionText = retention[locale] ? '<p>' + escape(retention[locale]) + '</p>' : '';
  const titles = {
    pro: planCopy(locale).title,
    home: t.headline, privacy: t.privacy, legal: t.legal, missing: '404',
    scales: referenceTitle('scales', locale), methods: referenceTitle('methods', locale),
  };
  const content = {
    home: () => renderHome(base, t, locale, escape) + renderHomeActions(locale),
    pro: () => renderPro(base, locale, prices, escape),
    scales: () => renderReference(base, page, locale, escape),
    methods: () => renderReference(base, page, locale, escape),
    privacy: () => '<h1>' + t.privacy + '</h1><p>éPI · Domun by Logisan' +
      '</p><p>' + t.local + '</p><p>' + t.sync + '</p><p>' + t.rights + ' ' + contactLink +
      '</p>' + retentionText + '<p><a href="' + deletionUrl + '">' + t.deletion + '</a></p>',
    legal: () => '<h1>' + t.legal + '</h1><p><strong>Domun by Logisan</strong></p><address>Logisan SAS · 100 000 €<br>13 Le Pré Robert<br>56460 Val d’Oust, France<br>' +
      '949 547 319 RCS Vannes · FR95949547319</address><p>' + t.director + ' Baptiste Pillot</p>' +
      '<p><a href="https://logisan.fr/mentions-legales/">Logisan</a></p>',
    missing: () => '<h1>404</h1><p><a href="' + base + '">éPI</a></p>',
  };
  const home = page === 'home';
  return '<!doctype html><html lang="' + locale + '"' + (home ? ' class="home-page"' : '') +
    '><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + titles[page] +
    ' | éPI</title><link rel="icon" href="' + base + '/assets/epi.svg"><link rel="stylesheet" href="' +
    stylePath + '?v=' + styleVersion + '">' +
    (illustratedPages.has(page) ? '<script defer src="' + scenesPath + '?v=' + scenesVersion + '"></script>' : '') +
    '</head><body>' + renderHeader(base, path, locale, home) +
    '<main' + (illustratedPages.has(page) ? '' : ' class="document"') + '>' + content[page]() + '</main>' +
    renderFooter(base, locale) + '</body></html>';
}

export function createSite({
  retention = {}, secureCookie = false, catalogUrl,
} = {}) {
  for (const [locale, value] of Object.entries(retention)) {
    if (!Object.hasOwn(locales, locale) || typeof value !== 'string' || !value.trim()) {
      throw new Error('Invalid retention notice for ' + locale);
    }
  }
  return createServer(async (req, res) => {
    const url = new URL('http://localhost' + (req.url?.startsWith('/') ? req.url : '/'));
    const path = url.pathname.replace(/\/$/, '');
    const page = routes.get(path) ?? 'missing';
    if (path === base + '/delete-account' && ['GET', 'HEAD', 'POST'].includes(req.method)) {
      req.resume();
      res.writeHead(303, { Location: deletionUrl, 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    const { locale, chosen } = selectLocale(url.searchParams.get('lang'), req.headers.cookie, req.headers['accept-language']);
    if (url.pathname === base + '/plan-features.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' }).end(req.method === 'HEAD' ? undefined :
          JSON.stringify({ language: planLanguage(locale), ...planCopy(locale) }));
      return;
    }
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Language': locale,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" +
        (illustratedPages.has(page) ? "; script-src 'self'" : ''),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
      Vary: 'Accept-Language, Cookie',
    };
    if (chosen && page !== 'missing') {
      headers['Set-Cookie'] = 'epi_lang=' + locale + '; Path=/epi; Max-Age=31536000; HttpOnly; SameSite=Lax' +
        (secureCookie ? '; Secure' : '');
      url.searchParams.delete('lang');
      headers.Location = path + url.search;
      res.writeHead(303, headers).end();
      return;
    }
    const prices = page === 'pro' ? await loadPrices(catalogUrl) : undefined;
    res.writeHead(page === 'missing' ? 404 : page === 'pro' && !formatCatalog(prices, locale) ? 503 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : render(page === 'missing' ? base : path, page, locale, retention, prices));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    DOMUN_SOFTWARE_CATALOG_URL, EPI_WWW_PORT = '3002', EPI_WWW_RETENTION_FILE, EPI_WWW_SECURE_COOKIE,
  } = process.env;
  const retention = EPI_WWW_RETENTION_FILE
    ? JSON.parse(readFileSync(EPI_WWW_RETENTION_FILE, 'utf8').replace(/^\uFEFF/, ''))
    : undefined;
  createSite({
    catalogUrl: DOMUN_SOFTWARE_CATALOG_URL, retention, secureCookie: EPI_WWW_SECURE_COOKIE === '1',
  })
    .listen(Number(EPI_WWW_PORT), '127.0.0.1', () => console.log('http://127.0.0.1:' + EPI_WWW_PORT + base));
}
