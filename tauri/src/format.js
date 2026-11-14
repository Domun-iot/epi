export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

export function formatDate(value) {
  const date = new Date(value ?? '');
  return Number.isNaN(+date) ? '—' : dateTime.format(date);
}

export function number(value, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString('fr-FR', { maximumFractionDigits: digits })
    : '—';
}

export function weight({ weight: value, unit } = {}) {
  return Number.isFinite(value) ? `${number(value)} ${unit === 'lb' ? 'lb' : 'kg'}` : '—';
}

export const nameKey = name => name?.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function pairs(fields) {
  return `<dl>${fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '—')}</dd>`).join('')}</dl>`;
}

export function button(label, action, { value, primary = false } = {}) {
  const key = value == null ? '' : ` data-value="${escapeHtml(value)}"`;
  return `<button class="button${primary ? ' primary' : ''}" type="button" data-action="${action}"${key}>${escapeHtml(label)}</button>`;
}

export function pageHeader(title, subtitle = '', actions = '') {
  return `<header class="page-header"><div><h1>${title}</h1>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}</div>${actions}</header>`;
}

export function deviceFields(device = {}) {
  const { bluetooth = {} } = device;
  return [
    ['Adresse Bluetooth', bluetooth.address],
    ['Service', [bluetooth.serviceUuid, bluetooth.service].filter(Boolean).join(' · ') || null],
    ['Nom annoncé', bluetooth.localName],
    ['Type d’annonce', bluetooth.advertisementType],
    ['Identifiants fabricant', bluetooth.companyIds?.join(', ') || null],
    ['Fabricants', bluetooth.manufacturers?.filter(Boolean).join(', ') || null],
    ['Marque', bluetooth.brand],
    ['Modèle', bluetooth.model],
    ['Origine du modèle', bluetooth.modelSource],
    ['Enregistré le', formatDate(device.registeredAt)],
  ];
}
