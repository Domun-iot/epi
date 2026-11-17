import { escapeHtml, locale, t } from './i18n.js';

export { escapeHtml };

const dayMonth = { day: '2-digit', month: '2-digit' };
const dateFields = { ...dayMonth, year: 'numeric' };
const { hour12 } = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).resolvedOptions();
const minuteFields = { ...dateFields, hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit' };
const secondFields = { ...minuteFields, second: '2-digit' };
const dateTime = new Intl.DateTimeFormat(locale, secondFields);
const dateTimeMinutes = new Intl.DateTimeFormat(locale, minuteFields);
const calendarDate = new Intl.DateTimeFormat(locale, { ...dateFields, timeZone: 'UTC' });
const wallTime = new Intl.DateTimeFormat(locale, { ...secondFields, timeZone: 'UTC' });
const chartDay = new Intl.DateTimeFormat(locale, dayMonth);
const chartYear = new Intl.DateTimeFormat(locale, { year: 'numeric' });
const chartMonth = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' });

const isDateField = ({ type }) => Object.hasOwn(dateFields, type);
const slashDate = parts => parts.filter(isDateField).map(({ value }) => value).join('/');

function format(value, formatter) {
  const date = new Date(value ?? '');
  if (Number.isNaN(+date)) return '—';
  const parts = formatter.formatToParts(date);
  const dateText = slashDate(parts);
  if (!parts.some(({ type }) => type === 'hour')) return dateText;
  // Keep the locale's date/time connector and clock format after the numeric date.
  const timeText = parts.slice(parts.findLastIndex(isDateField) + 1).map(({ value }) => value).join('');
  return dateText + timeText.replace(/^\.(?=\s)/u, '');
}

export const formatDate = value => format(value, dateTime);
export const formatDateMinutes = value => format(value, dateTimeMinutes);
export const formatCalendarDate = value => format(value, calendarDate);
export const formatChartDay = time => slashDate(chartDay.formatToParts(time));
export const formatChartEdge = time => formatChartDay(time) + '\n' + chartYear.format(time);
export function formatChartMonth(time) {
  const parts = chartMonth.formatToParts(time);
  return ['month', 'year'].map(field => parts.find(({ type }) => type === field).value).join('\n');
}

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

export const deviceName = device => device?.source === 'manual' ? t('manualEntry') : device?.name;

export function deviceFields(device = {}) {
  if (device.source === 'manual') return [];
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
    [t('modelSource'), bluetooth.modelSource === 'advertisement' ? t('modelFromAdvertisement')
      : bluetooth.modelSource === 'measurement' ? t('modelFromMeasurement') : bluetooth.modelSource],
    [t('registeredOn'), formatDateMinutes(device.registeredAt)],
    [t('lastModification'), formatDateMinutes(device.updatedAt)],
  ];
}
