import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { catalog, locales, selectLocale } from './locales.js';

const base = '/epi';
const routes = new Map([
  [base, 'home'],
  [base + '/privacy-policy', 'privacy'],
  [base + '/delete-account', 'deletion'],
  [base + '/legal-notice', 'legal'],
]);
const assets = new Map(Object.entries({
  'style.css': 'text/css; charset=utf-8',
  'epi.svg': 'image/svg+xml',
  'chart.jpg': 'image/jpeg',
}).map(([name, type]) => [base + '/assets/' + name, {
  type, body: readFileSync(new URL('./public/' + name, import.meta.url)),
}]));
const escape = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function render(path, page, locale, contact, retention) {
  const t = catalog[locale];
  const email = escape(contact);
  const privacy = base + '/privacy-policy';
  const deletion = base + '/delete-account';
  const contactLink = '<a href="mailto:' + email + '">' + email + '</a>';
  const retentionText = retention[locale] ? '<p>' + escape(retention[locale]) + '</p>' : '';
  const titles = { home: t.headline, privacy: t.privacy, deletion: t.deletion, legal: t.legal, missing: '404' };
  const content = {
    home: () => '<div class="hero"><div><h1>' + t.headline + '</h1><p>' + t.intro +
      '</p></div><img class="chart" src="' + base + '/assets/chart.jpg" alt="" width="824" height="1784"></div>',
    privacy: () => '<h1>' + t.privacy + '</h1><p>éPI · Domun by Logisan' +
      '</p><p>' + t.local + '</p><p>' + t.sync + '</p><p>' + t.rights + ' ' + contactLink +
      '</p>' + retentionText + '<p><a href="' + deletion + '">' + t.deletion + '</a></p>',
    deletion: () => '<h1>' + t.deletion + '</h1><p>' + t.request + '</p><p><a class="button" href="mailto:' +
      email + '?subject=' + encodeURIComponent(t.deletion) + '">' + t.send + '</a></p><p>' + email +
      '</p><p>' + t.erasure + '</p>' + retentionText + '<p><a href="' + privacy + '">' + t.privacy + '</a></p>',
    legal: () => '<h1>' + t.legal + '</h1><p><strong>Domun by Logisan</strong> · ' + contactLink +
      '</p><address>Logisan SAS · 100 000 €<br>13 Le Pré Robert<br>56460 Val d’Oust, France<br>' +
      '949 547 319 RCS Vannes · FR95949547319</address><p>' + t.director + ' Baptiste Pillot</p>' +
      '<p><a href="https://logisan.fr/mentions-legales/">Logisan</a></p>',
    missing: () => '<h1>404</h1><p><a href="' + base + '">éPI</a></p>',
  };
  const options = Object.entries(locales).map(([key, label]) =>
    '<option value="' + key + '" lang="' + key + '"' + (key === locale ? ' selected' : '') + '>' + label + '</option>'
  ).join('');
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + titles[page] +
    ' | éPI</title><link rel="icon" href="' + base + '/assets/epi.svg"><link rel="stylesheet" href="' +
    base + '/assets/style.css"></head><body><header><a class="brand" href="' + base +
    '"><img src="' + base + '/assets/epi.svg" alt="" width="35" height="35">éPI</a><form method="get" action="' +
    path + '"><label><span class="sr-only">' + t.language + '</span><select name="lang">' +
    options + '</select></label><button type="submit" aria-label="' + t.language + '">↵</button></form></header>' +
    '<main' + (page === 'home' ? '' : ' class="document"') + '>' + content[page]() + '</main>' +
    '<footer><span>Domun by Logisan</span><nav><a href="' + privacy + '">' + t.privacy +
    '</a><a href="' + deletion + '">' + t.deletion + '</a><a href="' + base + '/legal-notice">' + t.legal +
    '</a></nav></footer></body></html>';
}

export function createSite({ contact = 'support@domun.eu', retention = {}, secureCookie = false } = {}) {
  if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(contact)) throw new Error('Invalid EPI_WWW_CONTACT');
  for (const [locale, value] of Object.entries(retention)) {
    if (!Object.hasOwn(locales, locale) || typeof value !== 'string' || !value.trim()) {
      throw new Error('Invalid retention notice for ' + locale);
    }
  }
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL('http://localhost' + (req.url?.startsWith('/') ? req.url : '/'));
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    const path = url.pathname.replace(/\/$/, '');
    const page = routes.get(path) ?? 'missing';
    const { locale, chosen } = selectLocale(url.searchParams.get('lang'), req.headers.cookie, req.headers['accept-language']);
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Language': locale,
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    res.writeHead(page === 'missing' ? 404 : 200, headers);
    res.end(req.method === 'HEAD' ? undefined : render(page === 'missing' ? base : path, page, locale, contact, retention));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EPI_WWW_PORT = '3002', EPI_WWW_CONTACT, EPI_WWW_RETENTION_FILE, EPI_WWW_SECURE_COOKIE } = process.env;
  const retention = EPI_WWW_RETENTION_FILE
    ? JSON.parse(readFileSync(EPI_WWW_RETENTION_FILE, 'utf8').replace(/^\uFEFF/, ''))
    : undefined;
  createSite({ contact: EPI_WWW_CONTACT, retention, secureCookie: EPI_WWW_SECURE_COOKIE === '1' })
    .listen(Number(EPI_WWW_PORT), '127.0.0.1', () => console.log('http://127.0.0.1:' + EPI_WWW_PORT + base));
}
