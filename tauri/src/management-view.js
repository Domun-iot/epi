import { t, htmlText } from './i18n.js';
import { button, deviceFields, escapeHtml as e, formatCalendarDate, formatDate, formatDateMinutes, number, pairs, pageHeader, sortByName, userIcon, weight } from './format.js';

export function profilesView(profiles, selected) {
  const action = button(t('createAProfile'), 'new-profile', { primary: true });
  const entries = sortByName(profiles).map(profile => {
    const active = profile.name === selected;
    const sex = profile.sex === 'F' ? t('female') : profile.sex === 'H' ? t('male') : '—';
    const age = profile.birthDate ? t('birth', [formatCalendarDate(profile.birthDate)]) : t('ageInYears', [number(profile.age)]);
    return `<article id="profiles/${e(profile.uuid)}" tabindex="-1" class="panel list-item"><header><h2>${e(profile.name)}${active ? ` <span role="img" aria-label="${htmlText('activeProfile')}" title="${htmlText('activeProfile')}">${userIcon}</span>` : ''}</h2>
      <div class="actions">${active ? '' : button(t('select'), 'select-profile', { value: profile.name })}
      ${button(t('edit'), 'edit-profile', { value: profile.name })}</div></header>
      <p class="muted">${e(sex)} · ${e(age)} · ${e(number(profile.heightCm))} cm</p>
      ${pairs([
        [t('createdOn'), formatDateMinutes(profile.createdAt)],
        [t('lastModification'), formatDateMinutes(profile.updatedAt)],
      ])}</article>`;
  }).join('');
  const content = entries
    ? `<div class="list">${entries}</div>`
    : `<p class="panel empty">${htmlText('noSavedProfiles')}</p>`;
  return { header: pageHeader(t('profiles'), '', action), content };
}

export function deviceCard(device, actions = '') {
  return `<article id="devices/${e(device.uuid)}" tabindex="-1" class="panel list-item"><header>
    <h2>${e(device.name)}</h2>${actions ? `<div class="actions">${actions}</div>` : ''}</header>
    ${pairs(deviceFields(device))}</article>`;
}

export function devicesView(devices, filter, rawOpen, canScan = true) {
  const action = canScan ? button(t('addADevice'), 'new-device', { primary: true }) : '';
  const entries = sortByName(devices).map(device => deviceCard(device,
    button(t('edit'), 'edit-device', { value: device.bluetooth.address })
    + (!canScan || device.bluetooth.address === filter ? '' : button(t('listenOnlyToThisDevice'), 'filter-address', { value: device.bluetooth.address })))).join('');
  const filterInfo = canScan && filter ? `<div class="notice"><p>${htmlText('monitoringDevice', [filter])}</p>${button(t('listenToAllDevices'), 'clear-filter')}</div>` : '';
  const diagnostics = canScan ? `<details class="panel settings" data-expand="raw"${rawOpen ? ' open' : ''}>
    <summary>${htmlText('rawBluetoothStream')}</summary>
    <pre id="raw-frames">${htmlText('noFramesReceived')}</pre>
    ${button(t('filterByBluetoothAddress'), 'filter-custom')}</details>` : '';
  const content = filterInfo + (entries
    ? `<div class="list device-list">${entries}</div>`
    : `<p class="panel empty device-list">${htmlText('noDevicesRegistered')}</p>`) + diagnostics;
  return { header: pageHeader(t('devices'), '', action), content };
}

export function noticesView({ pending, enrollment }) {
  const messages = [];
  for (const item of pending) {
    const unknownDevice = item.reason === 'device';
    const deviceLabel = item.device?.name ?? item.event.address;
    const controls = unknownDevice
      ? button(t('registerDevice'), 'register-pending-device', { value: item.id, primary: true })
      : button(t('assignWeighIn'), 'assign-profile', { value: item.id, primary: true });
    messages.push(`<aside class="notice" data-pending-id="${e(item.id)}"><p><strong>${htmlText('weighInReceived')}</strong> · ${weight(item.event)} · ${e(deviceLabel)} · ${e(formatDate(item.event.receivedAt))}</p>
      <p>${unknownDevice ? htmlText('registerScaleForWeighIn') : htmlText('chooseWeighInProfile')}</p>
      <div class="actions">${controls}${button(t('discardWeighIn'), 'discard', { value: item.id })}</div></aside>`);
  }
  if (enrollment) messages.push(`<div class="notice">
    <p>${htmlText('waitingForScale', { detail: enrollment.name })}</p>
    ${button(t('cancelCapture'), 'cancel-device')}</div>`);
  return messages.join('');
}
