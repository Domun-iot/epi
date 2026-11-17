import { formatDate, weight } from './format.js';
import { localizeMessage, t } from './i18n.js';

const conflicts = [
  'aConfigurationHasBeenModifiedReload', 'aFileAlreadyExistsReloadThe', 'aFileHasBeenModifiedReload',
  'aFileHasChangedReloadThe', 'theDataHasChangedReloadThe', 'theNotificationHasChangedReloadThe',
  'weighInChanged',
].map(key => 'diagnostic.' + key);

export function isDataConflict(error) {
  if (error?.code === 'dataset_changed' || error?.message === 'dataset_changed') return true;
  const message = localizeMessage(error?.message ?? String(error));
  return conflicts.some(id => message === t(id));
}

export function createReloadQueue() {
  let tail = Promise.resolve();
  let finished = -Infinity;
  return operation => {
    const reload = tail.then(async () => {
      let delay;
      while ((delay = finished + 1000 - performance.now()) > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.ceil(delay)));
      }
      try {
        return await operation();
      } finally {
        finished = performance.now();
      }
    });
    tail = reload.catch(() => {});
    return reload;
  };
}

function equal(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

function changedRecords(before, after, identity, describe) {
  const old = new Map(before.map(row => [identity(row), row]));
  const next = new Map(after.map(row => [identity(row), row]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter(id => !equal(old.get(id), next.get(id)))
    .map(id => describe(next.get(id) ?? old.get(id)));
}

export function changedFileSummaries(before, after, describeNotice) {
  const lines = [
    ...changedRecords(before.profiles, after.profiles, row => row.uuid ?? row.name,
      row => [t('profile'), row.name]),
    ...changedRecords(before.devices, after.devices, row => row.uuid ?? row.bluetooth?.address,
      row => [t('device'), row.name || row.bluetooth?.model || row.bluetooth?.address]),
    ...changedRecords(before.measurements, after.measurements,
      row => row.uuid ?? JSON.stringify([row.profile?.name, row.receivedAt]),
      row => [t('reloadWeighIn'), row.profile?.name ?? row.device?.name,
        weight(row.measures ?? row), formatDate(row.receivedAt)]),
    ...changedRecords(before.notifications, after.notifications, row => row.id,
      row => [t('reloadNotification'), describeNotice(row).title, formatDate(row.date)]),
  ];
  for (const kind of ['measurements', 'details']) {
    lines.push(...changedRecords(before.viewPresets[kind], after.viewPresets[kind], row => row.id,
      row => [t('viewPresets'), row.name]));
  }
  for (const name of new Set([...Object.keys(before.profilePreferences), ...Object.keys(after.profilePreferences)])) {
    if (!equal(before.profilePreferences[name], after.profilePreferences[name])) {
      lines.push([t('reloadProfilePreferences'), name]);
    }
  }
  if (['selectedProfile', 'pending', 'addressFilter', 'anonymousPreferences', 'languagePreference']
    .some(key => !equal(before[key], after[key]))) lines.push([t('reloadGlobalPreferences')]);
  return lines.map(parts => parts.filter(Boolean).map(part => String(part).replace(/\s+/gu, ' ').trim())
    .join(' · ').slice(0, 180));
}
