import { button, deleteButton, deviceFields, escapeHtml as e, formatCalendarDate, formatDate, number, pageHeader, pairs, weight } from './format.js';

export function notificationText(entry) {
  const { type, action, record, actor } = entry;
  if (type === 'pending') {
    const label = record.device?.name ?? record.event.address;
    return { title: 'Pesée reçue', text: `${weight(record.event)} · ${label} · ${entry.text}` };
  }
  if (!action) return { title: entry.text };
  const by = actor ? `Profil actif : ${actor}.` : 'Aucun profil actif.';
  const verb = action === 'deleted' ? 'supprimé' : 'enregistré';
  if (type === 'measurement') {
    const measures = record.measures ?? record;
    const impedance = measures.impedanceOhms > 0 ? `Impédance reçue (${number(measures.impedanceOhms)} Ω)` : 'Sans impédance';
    const method = record.profile?.name
      ? `${record.calculations ? 'Calculs enregistrés · ' : ''}Profil sélectionné : ${record.profile.name}`
      : record.calculations ? 'Calcul sans profil enregistré' : 'Sans profil ni calcul';
    return { title: `Pesée ${verb}e`, text: `${weight(measures)} · ${formatDate(record.receivedAt)} · ${impedance} · ${method}. ${by}` };
  }
  return { title: `${type === 'profile' ? 'Profil' : 'Appareil'} ${verb}`,
    text: `${record.name} · ${by}` };
}

export function notificationControls(entry, state) {
  if (entry.type === 'pending') {
    const pending = state.pending.find(item => item.id === entry.pendingId && item.reason === entry.reason);
    if (!pending) return '';
    const unknown = pending.reason === 'device';
    return button(unknown ? 'Enregistrer l’appareil' : 'Attribuer la pesée',
      unknown ? 'register-pending-device' : 'assign-profile', { value: pending.id, primary: true })
      + button('Ignorer la pesée', 'discard', { value: pending.id });
  }
  if (entry.type === 'enrollment' && entry.enrollmentId === state.enrollment?.id) {
    return button('Annuler la capture', 'cancel-device');
  }
  return '';
}

export function notificationBody(entry, date = false) {
  const { title, text } = notificationText(entry);
  return `<strong>${e(title)}</strong>${date ? `<small>${e(formatDate(entry.date))}</small>` : ''}
    ${text ? `<span>${e(text)}</span>` : ''}`;
}

export function notificationsView(state) {
  const content = [...state.notifications].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map(entry => {
    const controls = notificationControls(entry, state);
    const body = notificationBody(entry, true);
    const summary = entry.action
      ? `<button type="button" class="notification-summary" data-action="open-notification" data-value="${e(entry.id)}">${body}</button>`
      : `<div class="notification-summary">${body}</div>`;
    return `<article class="notice notification-item${entry.type === 'error' ? ' error' : ''}">
      <div>${summary}${controls ? `<div class="actions">${controls}</div>` : ''}</div>
      ${deleteButton('Supprimer définitivement la notification', 'delete-notification', entry.id)}</article>`;
  }).join('');
  return { header: pageHeader('Notifications'), content: content || '<p class="panel empty">Aucune notification.</p>' };
}

export function notificationDetailHeader(entry, title) {
  const removed = entry.action === 'deleted' && !entry.restored;
  return pageHeader(title, removed ? 'Cet élément a été supprimé.' : entry.restored ? 'Cet élément a été restauré.' : '',
    removed ? button('Restaurer', 'restore-notification', { value: entry.id, primary: true }) : '');
}

export function notificationRecordView(entry) {
  const { record, type } = entry;
  const fields = type === 'profile' ? [
    ['Sexe utilisé par les formules', record.sex === 'F' ? 'Femme' : 'Homme'],
    record.birthDate ? ['Date de naissance', formatCalendarDate(record.birthDate)] : ['Âge', number(record.age)],
    ['Taille (cm)', number(record.heightCm)],
    ...(entry.measurements ? [['Pesées sauvegardées', entry.measurements.length]] : []),
  ] : deviceFields(record);
  return { header: notificationDetailHeader(entry, e(record.name)), content: `<div class="panel">${pairs(fields)}</div>` };
}
