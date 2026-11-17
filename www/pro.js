import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./pro.html', import.meta.url), 'utf8');
const row = readFileSync(new URL('./pro-row.html', import.meta.url), 'utf8');
const plan = JSON.parse(readFileSync(new URL('./plan-copy.json', import.meta.url), 'utf8'));
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);

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

export function renderPro(locale, catalog, escape) {
  const t = planCopy(locale);
  const prices = formatCatalog(catalog, locale);
  const template = html.replace(/<!--(promo|priced)-->([\s\S]*?)<!--end\1-->/g,
    (_, section, content) => (section === 'priced' ? prices : prices?.freeProMonth) ? content : '');
  return fill(template, {
    language: planLanguage(locale), locale: encodeURIComponent(locale),
    ...Object.fromEntries(Object.entries(t).filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, escape(value)])),
    offer: escape(prices ? t.offer.replace('{month}', prices.month).replace('{year}', prices.year) : t.unavailable),
    rows: t.rows.map(([label, free]) => fill(row, {
      label: escape(label), free: escape(free ? t.yes : t.no), pro: escape(t.yes),
    })).join(''),
  });
}
