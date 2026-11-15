import { escapeHtml, locale, t } from './i18n.js';

export { escapeHtml };

const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' });
const dateTimeMinutes = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
const calendarDate = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' });
const wallTime = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' });

function format(value, formatter) {
  const date = new Date(value ?? '');
  return Number.isNaN(+date) ? '—' : formatter.format(date);
}

export const formatDate = value => format(value, dateTime);
export const formatDateMinutes = value => format(value, dateTimeMinutes);
export const formatCalendarDate = value => format(value, calendarDate);

// The scale sends a wall-clock time with no time zone.
export const formatScaleTime = value => format(value ? value + 'Z' : null, wallTime);

export function number(value, digits = 1) {
  return Number.isFinite(value)
    ? value.toLocaleString(locale, { maximumFractionDigits: Math.min(digits, 1) })
    : '—';
}

export function weight({ weight: value, unit } = {}) {
  return Number.isFinite(value) ? `${number(value)} ${unit === 'lb' ? 'lb' : 'kg'}` : '—';
}

export const nameKey = name => name?.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const nameCollator = new Intl.Collator(locale, { sensitivity: 'base' });
export const sortByName = entries => [...entries].sort((a, b) => nameCollator.compare(a.name, b.name));

export const userIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2"/></svg>';

export function pairs(fields) {
  return `<dl>${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '—')}</dd>`).join('')}</dl>`;
}

export function button(label, action, { value, primary = false } = {}) {
  const key = value == null ? '' : ` data-value="${escapeHtml(value)}"`;
  return `<button class="button${primary ? ' primary' : ''}" type="button" data-action="${action}"${key}>${escapeHtml(label)}</button>`;
}

export const trashIcon = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>';

export function deleteButton(label, action, value) {
  const key = value == null ? '' : ` data-value="${escapeHtml(value)}"`;
  return `<button class="button icon-button" type="button" data-action="${action}"${key}
    title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${trashIcon}</svg></button>`;
}

export function pageHeader(title, subtitle = '', actions = '') {
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ''}</div>${actions}</header>`;
}

export function deviceFields(device = {}) {
  const { bluetooth = {} } = device;
  return [
    [t('bluetoothAddress'), bluetooth.address],
    [t('service'), [bluetooth.serviceUuid, bluetooth.service].filter(Boolean).join(' · ') || null],
    [t('advertisedName'), bluetooth.localName],
    [t('announcementType'), bluetooth.advertisementType],
    [t('manufacturerIdentifiers'), bluetooth.companyIds?.join(', ') || null],
    [t('manufacturers'), bluetooth.manufacturers?.filter(Boolean).join(', ') || null],
    [t('macPrefixManufacturer'), bluetooth.macManufacturer],
    [t('brand'), bluetooth.brand],
    [t('model'), bluetooth.model],
    [t('modelSource'), bluetooth.modelSource],
    [t('registeredOn'), formatDateMinutes(device.registeredAt)],
    [t('lastModification'), formatDateMinutes(device.updatedAt)],
  ];
}
