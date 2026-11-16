import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { catalog, locales, selectLocale } from './locales.js';
import { isMailbox, readAccountEmail, saveDeletionMail } from './deletion-mail.js';

const base = '/epi';
const routes = new Map([
  [base, 'home'],
  [base + '/privacy-policy', 'privacy'],
  [base + '/delete-account', 'deletion'],
  [base + '/legal-notice', 'legal'],
]);
const flagOverrides = { cs: 'cz', da: 'dk', el: 'gr', et: 'ee', ga: 'ie', sl: 'si', sv: 'se' };
const flags = Object.fromEntries(Object.keys(locales).map(locale =>
  [locale, flagOverrides[locale] ?? locale.split('-').at(-1).toLowerCase()],
));
const assets = new Map(Object.entries({
  ...Object.fromEntries(Object.values(flags).map(code => ['flags/' + code + '.svg', 'image/svg+xml'])),
  'style.css': 'text/css; charset=utf-8',
  'epi.svg': 'image/svg+xml',
  'chart.jpg': 'image/jpeg',
}).map(([name, type]) => [base + '/assets/' + name, {
  type, body: readFileSync(new URL('./public/' + name, import.meta.url)),
}]));
const stylePath = base + '/assets/style.css';
const styleVersion = createHash('sha256').update(assets.get(stylePath).body).digest('hex').slice(0, 12);
const escape = value => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function renderLanguagePicker(path, locale) {
  const label = key => '<img class="flag" src="' + base + '/assets/flags/' + flags[key] +
    '.svg" alt="" width="20" height="15"><span lang="' + key + '">' + locales[key] + '</span>';
  const links = Object.keys(locales).map(key => '<li><a href="' + path + '?lang=' + key + '"' +
    (key === locale ? ' aria-current="true"' : '') + '>' + label(key) + '</a></li>').join('');
  return '<details class="languages"><summary><span class="sr-only">' + catalog[locale].language +
    ' </span>' + label(locale) + '</summary><ul class="language-options">' + links + '</ul></details>';
}

function renderDeletionForm(t, deletion, status) {
  if (status === 'submitted') return '<p role="status">' + t.submitted + '</p>';
  return '<p>' + t.request + '</p>' +
    (status === 'error' ? '<p role="alert">' + t.submissionError + '</p>' : '') +
    '<form class="deletion-form" method="post" action="' + deletion + '">' +
    '<label for="account-email">' + t.accountEmail + '</label>' +
    '<input id="account-email" name="email" type="email" autocomplete="email" maxlength="254" required>' +
    '<button class="button" type="submit">' + t.send + '</button></form>';
}

function render(path, page, locale, retention, status) {
  const t = catalog[locale];
  const privacy = base + '/privacy-policy';
  const deletion = base + '/delete-account';
  const contactLink = '<a href="https://logisan.fr/contact/">Logisan</a>';
  const retentionText = retention[locale] ? '<p>' + escape(retention[locale]) + '</p>' : '';
  const titles = { home: t.headline, privacy: t.privacy, deletion: t.deletion, legal: t.legal, missing: '404' };
  const content = {
    home: () => '<div class="hero"><div><h1>' + t.headline + '</h1><p>' + t.intro +
      '</p></div><img class="chart" src="' + base + '/assets/chart.jpg" alt="" width="824" height="1784"></div>',
    privacy: () => '<h1>' + t.privacy + '</h1><p>éPI · Domun by Logisan' +
      '</p><p>' + t.local + '</p><p>' + t.sync + '</p><p>' + t.rights + ' ' + contactLink +
      '</p>' + retentionText + '<p><a href="' + deletion + '">' + t.deletion + '</a></p>',
    deletion: () => '<h1>' + t.deletion + '</h1>' + renderDeletionForm(t, deletion, status) +
      '<p>' + t.erasure + '</p>' + retentionText + '<p><a href="' + privacy + '">' + t.privacy + '</a></p>',
    legal: () => '<h1>' + t.legal + '</h1><p><strong>Domun by Logisan</strong></p><address>Logisan SAS · 100 000 €<br>13 Le Pré Robert<br>56460 Val d’Oust, France<br>' +
      '949 547 319 RCS Vannes · FR95949547319</address><p>' + t.director + ' Baptiste Pillot</p>' +
      '<p><a href="https://logisan.fr/mentions-legales/">Logisan</a></p>',
    missing: () => '<h1>404</h1><p><a href="' + base + '">éPI</a></p>',
  };
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + titles[page] +
    ' | éPI</title><link rel="icon" href="' + base + '/assets/epi.svg"><link rel="stylesheet" href="' +
    stylePath + '?v=' + styleVersion + '"></head><body><header><a class="brand" href="' + base +
    '"><img src="' + base + '/assets/epi.svg" alt="" width="35" height="35">éPI</a>' +
    renderLanguagePicker(path, locale) + '</header>' +
    '<main' + (page === 'home' ? '' : ' class="document"') + '>' + content[page]() + '</main>' +
    '<footer><span>Domun by Logisan</span><nav><a href="' + privacy + '">' + t.privacy +
    '</a><a href="' + deletion + '">' + t.deletion + '</a><a href="' + base + '/legal-notice">' + t.legal +
    '</a></nav></footer></body></html>';
}

export function createSite({
  contact = 'support@domun.eu', mailDirectory = './data/emails', retention = {}, secureCookie = false,
} = {}) {
  if (!isMailbox(contact)) throw new Error('Invalid EPI_WWW_CONTACT');
  for (const [locale, value] of Object.entries(retention)) {
    if (!Object.hasOwn(locales, locale) || typeof value !== 'string' || !value.trim()) {
      throw new Error('Invalid retention notice for ' + locale);
    }
  }
  return createServer(async (req, res) => {
    const url = new URL('http://localhost' + (req.url?.startsWith('/') ? req.url : '/'));
    const path = url.pathname.replace(/\/$/, '');
    const page = routes.get(path) ?? 'missing';
    const postDeletion = req.method === 'POST' && page === 'deletion';
    if (!postDeletion && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: page === 'deletion' ? 'GET, HEAD, POST' : 'GET, HEAD' }).end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
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
    if (postDeletion) {
      try {
        const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        const fetchSite = req.headers['sec-fetch-site'];
        const email = contentType === 'application/x-www-form-urlencoded' &&
          (!fetchSite || fetchSite === 'same-origin') && await readAccountEmail(req);
        if (!email) {
          req.resume();
          res.writeHead(400, headers).end(render(path, page, locale, retention, 'error'));
          return;
        }
        await saveDeletionMail(mailDirectory, contact, email, locale);
        res.writeHead(303, { ...headers, Location: path + '?submitted=1' }).end();
      } catch (error) {
        console.error('Unable to record deletion request:', error.code ?? error.name);
        res.writeHead(503, headers).end(render(path, page, locale, retention, 'error'));
      }
      return;
    }
    if (chosen && page !== 'missing') {
      headers['Set-Cookie'] = 'epi_lang=' + locale + '; Path=/epi; Max-Age=31536000; HttpOnly; SameSite=Lax' +
        (secureCookie ? '; Secure' : '');
      url.searchParams.delete('lang');
      headers.Location = path + url.search;
      res.writeHead(303, headers).end();
      return;
    }
    res.writeHead(page === 'missing' ? 404 : 200, headers);
    const status = url.searchParams.get('submitted') === '1' ? 'submitted' : undefined;
    res.end(req.method === 'HEAD' ? undefined : render(page === 'missing' ? base : path, page, locale, retention, status));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    EPI_WWW_PORT = '3002', EPI_WWW_CONTACT, EPI_WWW_MAIL_DIRECTORY, EPI_WWW_RETENTION_FILE, EPI_WWW_SECURE_COOKIE,
  } = process.env;
  const retention = EPI_WWW_RETENTION_FILE
    ? JSON.parse(readFileSync(EPI_WWW_RETENTION_FILE, 'utf8').replace(/^\uFEFF/, ''))
    : undefined;
  createSite({
    contact: EPI_WWW_CONTACT, mailDirectory: EPI_WWW_MAIL_DIRECTORY, retention, secureCookie: EPI_WWW_SECURE_COOKIE === '1',
  })
    .listen(Number(EPI_WWW_PORT), '127.0.0.1', () => console.log('http://127.0.0.1:' + EPI_WWW_PORT + base));
}
