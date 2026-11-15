import { loadCatalog, languages } from './locales/index.js';
import english from './locales/en-GB.json' with { type: 'json' };
import legacy from './locales/legacy.json' with { type: 'json' };

export { languages };

const fallback = 'en-GB';
const storageKey = 'epi-account-language';
const regional = { en: 'en-GB', fr: 'fr-FR', pt: 'pt-PT' };

// Keep the familiar Canadian variant when a regional tag includes more subtags.
export function supportedLocale(tag) {
  if (typeof tag !== 'string') return undefined;
  try {
    const { language, region } = new Intl.Locale(tag.replaceAll('_', '-'));
    const id = language === 'fr' && region === 'CA' ? 'fr-CA' : regional[language] ?? language;
    return Object.hasOwn(languages, id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function accountLanguage() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? 'null');
  } catch {
    return null;
  }
}

export function chooseLocale({ preference, google, browser = [], system } = {}) {
  return [preference, google, ...browser, system].map(supportedLocale).find(Boolean) ?? fallback;
}

let systemLocale;
function detectLocale() {
  const account = accountLanguage();
  const browser = globalThis.navigator;
  return chooseLocale({
    preference: account?.preference,
    google: account?.google,
    browser: [...(browser?.languages ?? []), browser?.language],
    system: systemLocale ?? Intl.DateTimeFormat().resolvedOptions().locale,
  });
}

export let locale = detectLocale();

let messages = english;

export async function initialiseLanguage(system) {
  systemLocale = system;
  locale = detectLocale();
  messages = locale === fallback ? english : await loadCatalog(locale);
  document.documentElement.lang = locale;
  document.title = t('appTitle');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attr of ['aria-label', 'title', 'placeholder']) {
    for (const element of document.querySelectorAll('[data-i18n-' + attr + ']')) {
      element.setAttribute(attr, t(element.getAttribute('data-i18n-' + attr)));
    }
  }
}

// Reload to reformat existing views, including charts, with the updated locale.
export function useAccountLanguage(preference, google) {
  localStorage.setItem(storageKey, JSON.stringify({
    preference: supportedLocale(preference),
    google: supportedLocale(google),
  }));
  if (detectLocale() !== locale) window.location.reload();
}

export function t(id, values = {}) {
  const message = messages[id] ?? english[id] ?? id;
  return message.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export const htmlText = (id, values) => escapeHtml(t(id, values));

const codePrefix = 'epi-i18n:';
export const messageCode = id => codePrefix + id;

// Older records and server versions use French diagnostic text. Accept those
// alongside identifiers and leave third-party diagnostics and record names intact.
const legacyTemplates = Object.entries(legacy)
  .filter(([source]) => source.includes('{detail}'))
  .map(([source, id]) => ({ id, parts: source.split('{detail}') }));

export function localizeMessage(source) {
  if (typeof source !== 'string') return source;
  if (source.includes('\n' + codePrefix)) return source.split('\n').map(localizeMessage).join('\n');
  if (Object.hasOwn(legacy, source)) return t(legacy[source]);
  if (source.startsWith(codePrefix)) {
    const match = /^epi-i18n:([\w.]+)(?: · ([\s\S]*))?$/.exec(source);
    if (match && Object.hasOwn(english, match[1])) {
      const [, id, detail] = match;
      return t(id, detail === undefined ? {} : { detail: localizeMessage(detail) });
    }
  }
  for (const { id, parts: [prefix, suffix] } of legacyTemplates) {
    if (source.length >= prefix.length + suffix.length && source.startsWith(prefix) && source.endsWith(suffix)) {
      return t(id, { detail: source.slice(prefix.length, source.length - suffix.length) });
    }
  }
  return source;
}
