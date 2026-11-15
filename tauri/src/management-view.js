import { button, deviceFields, escapeHtml as e, formatCalendarDate, formatDate, formatDateMinutes, number, pairs, pageHeader, sortByName, userIcon, weight } from './format.js';

export function profilesView(profiles, selected) {
  const action = button('Créer un profil', 'new-profile', { primary: true });
  const entries = sortByName(profiles).map(profile => {
    const active = profile.name === selected;
    const sex = profile.sex === 'F' ? 'Femme' : profile.sex === 'H' ? 'Homme' : '—';
    const age = profile.birthDate ? `Naissance : ${formatCalendarDate(profile.birthDate)}` : `${number(profile.age)} ans`;
    return `<article id="profiles/${e(profile.uuid)}" tabindex="-1" class="panel list-item"><header><h2>${e(profile.name)}${active ? ` <span role="img" aria-label="Profil actif" title="Profil actif">${userIcon}</span>` : ''}</h2>
      <div class="actions">${active ? '' : button('Sélectionner', 'select-profile', { value: profile.name })}
      ${button('Modifier', 'edit-profile', { value: profile.name })}</div></header>
      <p class="muted">${e(sex)} · ${e(age)} · ${e(number(profile.heightCm))} cm</p>
      ${pairs([
        ['Créé le', formatDateMinutes(profile.createdAt)],
        ['Dernière modification', formatDateMinutes(profile.updatedAt)],
      ])}</article>`;
  }).join('');
  const content = entries
    ? `<div class="list">${entries}</div>`
    : '<p class="panel empty">Aucun profil enregistré.</p>';
  return { header: pageHeader('Profils', '', action), content };
}

export function deviceCard(device, actions = '') {
  return `<article id="devices/${e(device.uuid)}" tabindex="-1" class="panel list-item"><header>
    <h2>${e(device.name)}</h2>${actions ? `<div class="actions">${actions}</div>` : ''}</header>
    ${pairs(deviceFields(device))}</article>`;
}

export function devicesView(devices, filter, rawOpen, canScan = true) {
  const action = canScan ? button('Ajouter un appareil', 'new-device', { primary: true }) : '';
  const entries = sortByName(devices).map(device => deviceCard(device,
    button('Modifier', 'edit-device', { value: device.bluetooth.address })
    + (!canScan || device.bluetooth.address === filter ? '' : button('Écouter seulement cet appareil', 'filter-address', { value: device.bluetooth.address })))).join('');
  const filterInfo = canScan && filter ? `<div class="notice"><p>Écoute limitée à ${e(filter)}.</p>${button('Écouter tous les appareils', 'clear-filter')}</div>` : '';
  const diagnostics = canScan ? `<details class="panel settings" data-expand="raw"${rawOpen ? ' open' : ''}>
    <summary>Flux Bluetooth brut</summary>
    <pre id="raw-frames">Aucune trame reçue.</pre>
    ${button('Filtrer par adresse Bluetooth', 'filter-custom')}</details>` : '';
  const content = filterInfo + (entries
    ? `<div class="list device-list">${entries}</div>`
    : '<p class="panel empty device-list">Aucun appareil enregistré.</p>') + diagnostics;
  return { header: pageHeader('Appareils', '', action), content };
}

export function noticesView({ pending, enrollment }) {
  const messages = [];
  for (const item of pending) {
    const unknownDevice = item.reason === 'device';
    const deviceLabel = item.device?.name ?? item.event.address;
    const controls = unknownDevice
      ? button('Enregistrer l’appareil', 'register-pending-device', { value: item.id, primary: true })
      : button('Attribuer la pesée', 'assign-profile', { value: item.id, primary: true });
    messages.push(`<aside class="notice" data-pending-id="${e(item.id)}"><p><strong>Pesée reçue</strong> · ${weight(item.event)} · ${e(deviceLabel)} · ${e(formatDate(item.event.receivedAt))}</p>
      <p>${unknownDevice ? 'Enregistrez cette balance pour traiter sa pesée.' : 'Choisissez le profil auquel attribuer la pesée.'}</p>
      <div class="actions">${controls}${button('Ignorer la pesée', 'discard', { value: item.id })}</div></aside>`);
  }
  if (enrollment) messages.push(`<div class="notice">
    <p>En attente d’une pesée de l’appareil « ${e(enrollment.name)} ». Montez sur la balance pour envoyer ses données.</p>
    ${button('Annuler la capture', 'cancel-device')}</div>`);
  return messages.join('');
}
