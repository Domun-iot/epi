import { deviceCard } from './management-view.js';
import { deleteButton, escapeHtml as e, formatCalendarDate, formatDate, number, pageHeader, pairs, weight } from './format.js';

const restorationDate = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function notificationText(entry, state) {
  const { type, action, record, actor } = entry;
  if (type === 'pending') {
    const label = state?.devices.find(device => device.uuid === entry.deviceUuid)?.name
      ?? record.device?.name ?? record.event.address;
    const title = entry.text === 'Pesée ignorée.' ? 'Pesée ignorée' : 'Pesée reçue';
    return { title, text: `${weight(record.event)} · ${label}` };
  }
  if (!action) return { title: entry.text };
  const by = actor ? `Profil actif : ${actor}.` : 'Aucun profil actif.';
  const verb = action === 'deleted' ? 'supprimé' : action === 'restored' ? 'restauré' : 'enregistré';
  if (type === 'measurement') {
    const measures = record.measures ?? record;
    const impedance = measures.impedanceOhms > 0
      ? action === 'deleted' ? 'avec impédance' : `Impédance reçue (${number(measures.impedanceOhms)} Ω)`
      : 'Sans impédance';
    const method = record.profile?.name
      ? `${record.calculations ? 'Calculs enregistrés · ' : ''}Profil sélectionné : ${record.profile.name}`
      : record.calculations ? 'Calcul sans profil enregistré' : 'Sans profil ni calcul';
    return { title: `Pesée ${verb}e`, text: `${weight(measures)} · ${formatDate(record.receivedAt)} · ${impedance} · ${method}. ${by}` };
  }
  return { title: `${type === 'profile' ? 'Profil' : 'Appareil'} ${verb}`,
    text: `${record.name} · ${by}` };
}

export function notificationBody(entry, state, detailed = false) {
  const { title, text } = notificationText(entry, state);
  const message = detailed ? title : String(title ?? '').trimStart().split(/\r\n?|\n/, 1)[0].trimEnd();
  const heading = `<strong>${e(message)}</strong>`;
  if (!detailed) return heading;
  const receipt = entry.type === 'pending';
  const receivedAt = receipt ? entry.record.event.receivedAt : entry.date;
  const restoredAt = !receipt ? Date.parse(entry.restoredAt) : NaN;
  const restoration = entry.type === 'measurement' ? 'Restaurée' : 'Restauré';
  return `${heading}<small>${e(formatDate(receivedAt))}</small>
    ${text ? `<span>${e(text)}</span>` : ''}
    ${Number.isFinite(restoredAt) ? `<small>${restoration} le ${e(restorationDate.format(restoredAt))}</small>` : ''}`;
}

export function notificationsView(state) {
  const content = [...state.notifications].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(entry => {
    const body = notificationBody(entry, state, true);
    const summary = entry.action || entry.type === 'pending'
      ? `<button type="button" class="notification-summary" data-action="open-notification" data-value="${e(entry.id)}">${body}</button>`
      : `<div class="notification-summary">${body}</div>`;
    return `<article class="notice notification-item${entry.type === 'error' ? ' error' : ''}">
      ${summary}
      ${deleteButton('Supprimer définitivement la notification', 'delete-notification', entry.id)}</article>`;
  }).join('');
  const actions = content ? '<button class="button" type="button" data-action="delete-all-notifications">Supprimer tout</button>' : '';
  return { header: pageHeader('Notifications', '', actions), content: content || '<p class="panel empty">Aucune notification.</p>' };
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
  if (receipt) return entry;
  const archive = state.notifications.reduce((latest, item) => {
    if (item.type !== type || item.action !== 'deleted' || item.record.uuid !== uuid) return latest;
    return !latest || Date.parse(item.date) > Date.parse(latest.date) ? item : latest;
  }, null);
  return archive ? { ...archive, restored: false } : { ...entry, missing: true };
}

export function notificationDetailHeader(entry, title) {
  const removed = entry.action === 'deleted' && !entry.live;
  return pageHeader(title, removed ? 'Cet élément a été supprimé.'
    : entry.restored ? 'Cet élément a été restauré.' : entry.missing ? 'Cet élément est introuvable.' : '');
}

export function notificationRecordView(entry) {
  const { record, type } = entry;
  if (type === 'device') return { header: notificationDetailHeader(entry, 'Appareil'), content: deviceCard(record) };
  const fields = [
    ['Sexe utilisé par les formules', record.sex === 'F' ? 'Femme' : 'Homme'],
    record.birthDate ? ['Date de naissance', formatCalendarDate(record.birthDate)] : ['Âge', number(record.age)],
    ['Taille (cm)', number(record.heightCm)],
    ...(entry.measurements ? [['Pesées sauvegardées', entry.measurements.length]] : []),
  ];
  return { header: notificationDetailHeader(entry, e(record.name)), content: `<div class="panel">${pairs(fields)}</div>` };
}
