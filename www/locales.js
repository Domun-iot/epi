import { readFileSync } from 'node:fs';

export const locales = {
  bg: 'Български', cs: 'Čeština', da: 'Dansk', de: 'Deutsch', el: 'Ελληνικά',
  'en-GB': 'English (UK)', 'en-US': 'English (US)', es: 'Español', et: 'Eesti',
  fi: 'Suomi', 'fr-FR': 'Français (France)', 'fr-CA': 'Français (Canada)', ga: 'Gaeilge',
  hr: 'Hrvatski', hu: 'Magyar', it: 'Italiano', lt: 'Lietuvių', lv: 'Latviešu',
  mt: 'Malti', nl: 'Nederlands', pl: 'Polski', 'pt-PT': 'Português (Portugal)',
  ro: 'Română', sk: 'Slovenčina', sl: 'Slovenščina', sv: 'Svenska',
};

const defaults = { en: 'en-GB', fr: 'fr-FR', pt: 'pt-PT' };
function match(value) {
  const tag = value?.trim().toLowerCase();
  if (!tag || !/^[a-z]{2}(?:-[a-z0-9]{2,8})*$/.test(tag)) return undefined;
  const exact = Object.keys(locales).find(key => key.toLowerCase() === tag);
  const language = tag.split('-')[0];
  return exact ?? defaults[language] ?? (Object.hasOwn(locales, language) ? language : undefined);
}

export function selectLocale(query, cookie = '', accept = '') {
  const explicit = match(query);
  if (explicit) return { locale: explicit, chosen: true };
  const stored = match(cookie.match(/(?:^|;\s*)epi_lang=([^;]*)/)?.[1]);
  if (stored) return { locale: stored };
  const preferred = accept.split(',').map(entry => {
    const [tag, quality] = entry.trim().split(/\s*;\s*q=/i);
    return { locale: match(tag), weight: quality === undefined ? 1 : Number(quality) };
  }).filter(({ locale, weight }) => locale && weight > 0 && weight <= 1)
    .sort((first, second) => second.weight - first.weight);
  return { locale: preferred[0]?.locale ?? 'en-GB' };
}

const fields = ['language', 'headline', 'intro', 'privacy', 'deletion', 'legal', 'send',
  'director', 'local', 'sync', 'rights', 'request', 'erasure'];
const source = readFileSync(new URL('./copy.txt', import.meta.url), 'utf8');
export const catalog = Object.fromEntries(source.trim().split(/\r?\n/).map(line => {
  const [locale, ...values] = line.split('|');
  if (values.length !== fields.length || values.some(value => !value)) throw new Error('Incomplete copy for ' + locale);
  return [locale, Object.fromEntries(fields.map((field, index) => [field, values[index]]))];
}));
catalog['en-US'] = { ...catalog['en-GB'],
  rights: 'Contact us to access, correct, or delete your data, or to exercise your other data protection rights. The site saves your language preference for one year.',
};
catalog['fr-CA'] = { ...catalog['fr-FR'],
  sync: catalog['fr-FR'].sync.replace('adresse e-mail', 'adresse courriel').replace('adresse e-mail', 'adresse courriel'),
  request: 'Écrivez-nous à partir de l’adresse courriel associée à votre compte éPI. Nous pouvons vous demander de confirmer votre demande. Gardez votre mot de passe confidentiel.',
};
