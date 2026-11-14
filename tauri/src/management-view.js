import { button, deviceFields, escapeHtml as e, pairs, pageHeader, userIcon, weight } from './format.js';

export function profilesView(profiles, selected) {
  const action = button('Créer un profil', 'new-profile', { primary: true });
  const entries = profiles.map(profile => {
    const active = profile.name === selected;
    const sex = profile.sex === 'F' ? 'Femme' : profile.sex === 'H' ? 'Homme' : '—';
    const age = profile.birthDate ? `Naissance : ${profile.birthDate}` : `${profile.age ?? '—'} ans`;
    return `<article class="panel list-item"><header><h2>${e(profile.name)}${active ? ` <span role="img" aria-label="Profil actif" title="Profil actif">${userIcon}</span>` : ''}</h2>
      <div class="actions">${active ? '' : button('Sélectionner', 'select-profile', { value: profile.name })}
      ${button('Modifier', 'edit-profile', { value: profile.name })}</div></header>
      <p class="muted">${e(sex)} · ${e(age)} · ${e(profile.heightCm ?? '—')} cm</p></article>`;
  }).join('');
  return pageHeader('Profils', '', action) + (entries
    ? `<div class="list">${entries}</div>`
    : '<p class="panel empty">Aucun profil enregistré.</p>');
}

export function devicesView(devices, filter, rawOpen) {
  const action = button('Ajouter un appareil', 'new-device', { primary: true });
  const entries = devices.map(device => `<article class="panel list-item"><header>
    <h2>${e(device.name)}</h2><div class="actions">${button('Actualiser la fiche', 'refresh-device', { value: device.bluetooth.address })}
    ${device.bluetooth.address === filter ? '' : button('Écouter seulement cet appareil', 'filter-address', { value: device.bluetooth.address })}</div></header>
    ${pairs(deviceFields(device))}</article>`).join('');
  const filterInfo = filter ? `<div class="notice"><p>Écoute limitée à ${e(filter)}.</p>${button('Écouter tous les appareils', 'clear-filter')}</div>` : '';
  const diagnostics = `<details class="panel settings" data-expand="raw"${rawOpen ? ' open' : ''}>
    <summary>Flux Bluetooth brut</summary>
    <pre id="raw-frames">Aucune trame reçue.</pre>
    ${button('Filtrer par adresse Bluetooth', 'filter-custom')}</details>`;
  return pageHeader('Appareils', '', action) + filterInfo + (entries
    ? `<div class="list device-list">${entries}</div>`
    : '<p class="panel empty device-list">Aucun appareil enregistré.</p>') + diagnostics;
}

export function noticesView({ pending, enrollment }, error) {
  const messages = [];
  if (error) messages.push(`<div class="notice error" role="alert">${e(error)}</div>`);
  if (enrollment) messages.push(`<div class="notice">
    <p>En attente d’une pesée de l’appareil « ${e(enrollment.name)} ». Montez sur la balance pour envoyer ses données.</p>
    ${button('Annuler la capture', 'cancel-device')}</div>`);
  for (const item of pending) {
    const unknownDevice = item.reason === 'device';
    const deviceLabel = item.device?.name ?? item.event.address;
    const controls = unknownDevice
      ? button('Enregistrer l’appareil', 'register-pending-device', { value: item.id, primary: true })
      : button('Attribuer la pesée', 'assign-profile', { value: item.id, primary: true });
    messages.push(`<aside class="notice"><p><strong>Pesée reçue</strong> · ${weight(item.event)} · ${e(deviceLabel)}</p>
      <p>${unknownDevice ? 'Enregistrez cette balance pour traiter sa pesée.' : 'Choisissez le profil auquel attribuer la pesée.'}</p>
      <div class="actions">${controls}${button('Ignorer la pesée', 'discard', { value: item.id })}</div></aside>`);
  }
  return messages.join('');
}
