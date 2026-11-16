import { locale, localizeMessage, messageCode, t, htmlText } from './i18n.js';
import { deviceCard } from './management-view.js';
import { deleteButton, escapeHtml as e, formatCalendarDate, formatDate, number, pageHeader, pairs, weight } from './format.js';

const restorationDate = new Intl.DateTimeFormat(locale, {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const notificationTitles = {
  measurement: { deleted: 'measurementDeleted', restored: 'measurementRestored', saved: 'measurementSaved' },
  profile: { deleted: 'profileDeleted', restored: 'profileRestored', saved: 'profileSaved' },
  device: { deleted: 'deviceDeleted', restored: 'deviceRestored', saved: 'deviceSaved' },
};

export function notificationText(entry, state) {
  const { type, action, record, actor } = entry;
  if (type === 'pending') {
    const label = state?.devices.find(device => device.uuid === entry.deviceUuid)?.name
      ?? record.device?.name ?? record.event.address;
    const title = (entry.text === messageCode('weighInDiscarded') || entry.text === 'Pesée ignorée.') ? t('weighInDiscarded') : t('weighInReceived');
    return { title, text: `${weight(record.event)} · ${label}` };
  }
  if (!action) return { title: localizeMessage(entry.text) };
  const title = t(notificationTitles[type]?.[action] ?? 'notifications');
  const by = actor ? t('activeProfileNotice', [actor]) : t('noActiveProfile');
  if (type === 'measurement') {
    const measures = record.measures ?? record;
    const impedance = measures.impedanceOhms > 0
      ? action === 'deleted' ? t('withImpedance') : t('receivedImpedance', [number(measures.impedanceOhms)])
      : t('withoutImpedance');
    const method = record.profile?.name
      ? [record.calculations && t('calculationsSaved'), t('selectedProfile', { profile: record.profile.name })].filter(Boolean).join(' · ')
      : record.calculations ? t('calculationWithoutSavedProfile') : t('withoutProfileOrCalculation');
    return { title, text: `${weight(measures)} · ${formatDate(record.receivedAt)} · ${impedance} · ${method}. ${by}` };
  }
  return { title,
    text: `${record.name} · ${by}` };
}

export function notificationBody(entry, state, detailed = false) {
  const { title, text } = notificationText(entry, state);
  const message = detailed ? title : String(title ?? '').trimStart().split(/\r\n?|\n/, 1)[0].trimEnd();
  const heading = `<strong>${e(message)}</strong>`;
  const files = Array.isArray(entry.reloadFiles) ? entry.reloadFiles : [];
  const changes = files.length ? `<ul class="notification-reload-files">${files.map(file =>
    `<li title="${e(file)}">${e(file)}</li>`).join('')}</ul>` : '';
  if (!detailed) return heading + changes;
  const receipt = entry.type === 'pending';
  const receivedAt = receipt ? entry.record.event.receivedAt : entry.date;
  const restoredAt = !receipt ? Date.parse(entry.restoredAt) : NaN;
  const restoration = entry.type === 'measurement' ? 'measurementRestoredOn' : 'restoredOn';
  return `${heading}<small>${e(formatDate(receivedAt))}</small>
    ${text ? `<span>${e(text)}</span>` : ''}${changes}
    ${Number.isFinite(restoredAt) ? `<small>${htmlText(restoration, { date: restorationDate.format(restoredAt) })}</small>` : ''}`;
}

export function notificationsView(state) {
  const content = [...state.notifications].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(entry => {
    const body = notificationBody(entry, state, true);
    const summary = entry.action || entry.type === 'pending'
      ? `<button type="button" class="notification-summary" data-action="open-notification" data-value="${e(entry.id)}">${body}</button>`
      : `<div class="notification-summary">${body}</div>`;
    return `<article class="notice notification-item${entry.type === 'error' ? ' error' : ''}">
      ${summary}
      ${deleteButton(t('deleteNotificationPermanently'), 'delete-notification', entry.id)}</article>`;
  }).join('');
  const actions = content ? `<button class="button" type="button" data-action="delete-all-notifications">${htmlText('deleteAll')}</button>` : '';
  return { header: pageHeader(t('notifications'), '', actions), content: content || `<p class="panel empty">${htmlText('noNotifications')}</p>` };
}

export function resolveNotification(state, entry) {
  if (!entry) return entry;
  const receipt = entry.type === 'pending';
  const type = receipt ? 'measurement' : entry.type;
  const uuid = receipt ? entry.measurementUuid : entry.record?.uuid;
  const records = { measurement: state.measurements, profile: state.profiles, device: state.devices }[type];
  if (!uuid || !records) return entry;
  const live = records.find(row => row.uuid === uuid);
  if (live) return { ...entry, type, record: live, live: true, restored: entry.action === 'deleted' };
  const archive = state.notifications.reduce((latest, item) => {
    if (item.type !== type || item.action !== 'deleted' || item.record.uuid !== uuid) return latest;
    return !latest || Date.parse(item.date) > Date.parse(latest.date) ? item : latest;
  }, null);
  return archive ? { ...archive, restored: false } : receipt ? entry : { ...entry, missing: true };
}

export function notificationDetailHeader(entry, title) {
  const removed = entry.action === 'deleted' && !entry.live;
  return pageHeader(title, removed ? t('thisItemHasBeenRemoved')
    : entry.restored ? t('thisItemHasBeenRestored') : entry.missing ? t('thisItemWasNotFound') : '');
}

export function notificationRecordView(entry) {
  const { record, type } = entry;
  if (type === 'device') return { header: notificationDetailHeader(entry, t('device')), content: deviceCard(record) };
  const fields = [
    [t('sexForCalculations'), record.sex === 'F' ? t('female') : t('male')],
    record.birthDate ? [t('dateOfBirth'), formatCalendarDate(record.birthDate)] : [t('age'), number(record.age)],
    [t('heightCm'), number(record.heightCm)],
    ...(entry.measurements ? [[t('savedWeighIns'), entry.measurements.length]] : []),
  ];
  return { header: notificationDetailHeader(entry, record.name), content: `<div class="panel">${pairs(fields)}</div>` };
}
