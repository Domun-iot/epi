import { readFileSync } from 'node:fs';
import { renderFeature } from './features.js';
import { featureCopy } from './features-copy.js';

const html = readFileSync(new URL('./pro.html', import.meta.url), 'utf8');
const row = readFileSync(new URL('./pro-row.html', import.meta.url), 'utf8');
const plan = JSON.parse(readFileSync(new URL('./plan-copy.json', import.meta.url), 'utf8'));
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);

// Match the order of the comparison rows shared with Domun account in plan-copy.json.
const rowIcons = [
  'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 6a5 5 0 0 1 10 0m-5 0 2-2',
  'M4 4v16h16M7 15l4-4 3 2 6-7',
  'M7 16H6a4 4 0 1 1 .8-7.9 6 6 0 0 1 11.4 1.3A3.5 3.5 0 0 1 18.5 16H17m-7 2 2 2 2-2m-2 2v-7',
  'M6 4h12v17l-6-4-6 4V4Z',
  'M4 8v12h16V8M3 4h18v4H3zM10 12h4',
];

function icon(path, className) {
  return '<svg class="' + className + '" aria-hidden="true" viewBox="0 0 24 24" width="24" height="24"' +
    ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="' + path + '"/></svg>';
}

function availabilityMark(included, t, escape) {
  const path = included ? 'M4 4h16v16H4zM8 12l3 3 5-6' : 'M7 7l10 10M17 7 7 17';
  return icon(path, included ? 'plan-mark plan-included' : 'plan-mark plan-excluded') +
    '<span class="sr-only">' + escape(included ? t.yes : t.no) + '</span>';
}

export function planLanguage(locale) {
  return Object.hasOwn(plan, locale) ? locale : Object.hasOwn(plan, locale.split('-')[0]) ? locale.split('-')[0] : 'en';
}

export function planCopy(locale) {
  return plan[planLanguage(locale)];
}

export function formatCatalog(value, locale) {
  if (value?.code !== 'epi' || ![value.monthlyPriceMinor, value.yearlyPriceMinor].every(
    price => Number.isSafeInteger(price) && price > 0
  ) || ![true, false, 0, 1].includes(value.freeProMonth)) return null;
  const wholeEuros = Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const fractionalEuros = Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  const format = cents => (cents % 100 === 0 ? wholeEuros : fractionalEuros).format(cents / 100);
  return { month: format(value.monthlyPriceMinor), year: format(value.yearlyPriceMinor),
    freeProMonth: Boolean(value.freeProMonth) };
}

export async function loadPrices(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(2500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export function renderPro(base, locale, catalog, escape) {
  const t = planCopy(locale);
  const features = featureCopy(locale);
  const prices = formatCatalog(catalog, locale);
  const template = html.replace(/<!--(promo|priced)-->([\s\S]*?)<!--end\1-->/g,
    (_, section, content) => (section === 'priced' ? prices : prices?.freeProMonth) ? content : '');
  return fill(template, {
    language: planLanguage(locale), locale: encodeURIComponent(locale),
    ...Object.fromEntries(Object.entries(t).filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, escape(value)])),
    offer: escape(prices ? t.offer.replace('{month}', prices.month).replace('{year}', prices.year) : t.unavailable),
    features: [
      ['sync', t.sync, t.syncDescription],
      ['views', t.views, t.viewsDescription],
      ['local', t.zip, t.zipDescription],
    ].map(([id, title, description]) => renderFeature(base, id, title, description, features, escape)).join(''),
    rows: t.rows.map(([label, free], index) => fill(row, {
      icon: icon(rowIcons[index], 'plan-icon'), label: escape(label),
      free: availabilityMark(free, t, escape), pro: availabilityMark(true, t, escape),
    })).join(''),
  });
}
