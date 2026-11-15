'use strict';

const { buildDevice, deviceFileKey } = require('../../shared/device-fields.cjs');
const { canonicalAddress } = require('../../shared/scale.cjs');
const { historyRecord, latestWeights, matchWeight } = require('../../shared/history.cjs');
const { nameKey } = require('../../shared/profile-fields.cjs');
const { createAcquisition } = require('./acquisition.cjs');
const { applyObservation, enrollmentRequest, findDevice } = require('./devices.cjs');
const { ADDRESS, findProfile, profileFields, mergeLegacy, measurementSlot } = require('./records.cjs');
const { uuid, identify, upgradeIdentities } = require('./identities.cjs');

const notificationLifetime = 7 * 86400_000;

const viewDefaults = {
  measurements: { columns: ['impedanceOhms', 'bmi'], splitColumns: [], columnOrder: [] },
  details: { methodColumnOrder: [], detailSectionOrder: [] },
};
const emptyState = () => ({
  profiles: [],
  devices: [],
  measurements: [],
  pending: [],
  notifications: [],
  selectedProfile: null,
  profilePreferences: {},
  viewPresets: { measurements: [], details: [] },
  addressFilter: null,
});

function preferencesFor(state, profile = state.selectedProfile) {
  if (!profile) return state.anonymousPreferences ?? {};
  return Object.hasOwn(state.profilePreferences, profile) ? state.profilePreferences[profile] : {};
}

function retainNotifications(notifications) {
  const cutoff = Date.now() - notificationLifetime;
  const newest = new Set([...notifications].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 20));
  return notifications.filter(item => Date.parse(item.date) > cutoff || newest.has(item));
}

function restore(snapshot) {
  const { columns, ...stored } = snapshot ?? {};
  const state = { ...emptyState(), ...stored };
  state.notifications ??= [];
  if (state.selectedProfile && Array.isArray(columns) && !Object.hasOwn(state.profilePreferences, state.selectedProfile)) {
    state.profilePreferences = { ...state.profilePreferences, [state.selectedProfile]: { columns } };
  }
  return state;
}

function layoutFor(state, prefs, kind) {
  const defaults = viewDefaults[kind];
  const presets = state.viewPresets[kind];
  const id = prefs.viewPresetIds?.[kind];
  const preset = presets.find(entry => entry.id === id);
  const baseline = preset?.layout ?? defaults;
  const layout = {};
  let modified = false;
  for (const [key, fallback] of Object.entries(defaults)) {
    const original = baseline[key] ?? fallback;
    const value = layout[key] = (!id || preset ? prefs[key] : undefined) ?? original;
    const ordered = key !== 'columns' && key !== 'splitColumns';
    modified ||= value.length !== original.length
      || value.some((item, index) => ordered ? item !== original[index] : !original.includes(item));
  }
  return { presets, preset, layout, modified };
}

function selectLayout(prefs, kind, id) {
  const next = { ...prefs, viewPresetIds: { ...prefs.viewPresetIds, [kind]: id } };
  for (const key of Object.keys(viewDefaults[kind])) delete next[key];
  return next;
}

function createSession({ storage, waitMs = 15_000, dedupMs = 30_000, onWeighing }) {
  let saved;
  let enrollment = null;
  let acquisitionError = null;
  let tasks = Promise.resolve();
  const observers = new Set();

  const acquisition = createAcquisition({
    waitMs, dedupMs, onWeighing,
    settle: reading => enqueue(async () => {
      if (reading.committed) return;
      reading.expired = true;
      await transact(draft => assign(draft, reading.event));
      acquisition.commit(reading);
      acquisitionError = null;
      publish();
    }),
    fail: error => {
      acquisitionError = error.message;
      publish();
    },
  });

  function view() {
    const prefs = preferencesFor(saved);
    const measurements = layoutFor(saved, prefs, 'measurements');
    const details = layoutFor(saved, prefs, 'details');
    return { ...saved, ...measurements.layout, ...details.layout, viewLayouts: { measurements, details },
      theme: prefs.theme, rawOpen: prefs.rawOpen ?? false, detailSectionsOpen: prefs.detailSectionsOpen, enrollment, acquisitionError };
  }

  function publish() {
    const current = view();
    for (const observer of observers) observer(current);
    return current;
  }

  async function loadSaved() {
    saved = restore(await storage.load());
    try {
      await transact(upgradeIdentities);
    } catch (error) {
      saved = undefined;
      throw error;
    }
  }

  function enqueue(action) {
    const task = tasks.then(async () => {
      if (!saved) await loadSaved();
      return action();
    });
    tasks = task.catch(() => {});
    return task;
  }

  async function transact(change) {
    const draft = { ...saved };
    if (draft.notifications.some(item => typeof item.date === 'number')) {
      draft.notifications = draft.notifications.map(item => typeof item.date === 'number'
        ? { ...item, date: new Date(item.date).toISOString() } : item);
    }
    const retained = retainNotifications(draft.notifications);
    if (retained.length !== draft.notifications.length) draft.notifications = retained;
    const result = change(draft);
    if (!draft.selectedProfile && draft.profiles.length === 1) {
      draft.selectedProfile = draft.profiles[0].name;
    }
    const remaining = retainNotifications(draft.notifications);
    if (remaining.length !== draft.notifications.length) draft.notifications = remaining;
    if (Object.keys(draft).some(key => draft[key] !== saved[key])) {
      await storage.save(draft, saved);
      saved = draft;
    }
    return result;
  }

  const mutate = change => enqueue(async () => {
    await transact(change);
    return publish();
  });

  function notify(draft, entry) {
    const timestamp = draft.notifications.reduce((latest, item) => Math.max(latest, Date.parse(item.date) + 1), Date.now());
    const date = new Date(timestamp).toISOString();
    const timed = ['profile', 'device', 'measurement'].includes(entry.type)
      && ['saved', 'restored', 'deleted'].includes(entry.action);
    draft.notifications = [...draft.notifications, {
      id: globalThis.crypto.randomUUID(), date, actor: draft.selectedProfile ?? null,
      ...(timed && { banner: true, durationMs: 3000 }), ...entry,
    }];
  }

  function restoreNotification(id, withMeasurements = false, profileFieldsOverride) {
    return mutate(draft => {
      const entry = draft.notifications.find(item => item.id === id && item.action === 'deleted');
      if (!entry) throw Error('Notification de suppression introuvable.');
      const { record, type } = entry;
      const measurementExists = type === 'measurement' && draft.measurements.some(row =>
        measurementSlot(row, draft.profiles) === measurementSlot(record, draft.profiles));
      const profileExists = type === 'profile' && draft.profiles.some(profile => profile.uuid === record.uuid);
      if (measurementExists || profileExists) {
        throw Error('Cet élément a déjà été restauré.');
      }
      if (type === 'profile') {
        const profile = profileFieldsOverride ? { ...profileFields(profileFieldsOverride), uuid: record.uuid } : record;
        if (findProfile(draft, profile.name)) throw Error('Un profil porte déjà ce nom.');
        draft.profiles = [...draft.profiles, profile];
        if (entry.preferences) draft.profilePreferences = { ...draft.profilePreferences, [profile.name]: entry.preferences };
        if (withMeasurements) draft.measurements = [...draft.measurements, ...entry.measurements];
        notify(draft, { type, action: 'restored', record: profile });
      } else if (type === 'device') {
        enrollmentRequest(draft, { address: record.bluetooth.address, name: record.name });
        if (findDevice(draft, record.bluetooth.address)) throw Error('Cet appareil est déjà enregistré.');
        draft.devices = [...draft.devices, record];
        resolveDevice(draft, record);
        notify(draft, { type, action: 'restored', record });
      } else if (type === 'measurement') {
        const profile = record.profile?.uuid ? draft.profiles.find(row => row.uuid === record.profile?.uuid)
          : findProfile(draft, record.profile?.name);
        if ((record.profile?.uuid || record.profile?.name) && !profile) {
          throw Error('Restaure d’abord le profil de cette pesée.');
        }
        draft.measurements = [...draft.measurements, record];
        notify(draft, { type, action: 'restored', record });
      }
      const restoredAt = new Date().toISOString();
      draft.notifications = draft.notifications.map(item => item.id === id ? { ...item, restored: true, restoredAt } : item);
    });
  }

  function updateReceipt(draft, pendingId, update) {
    draft.notifications = draft.notifications.map(entry => entry.type === 'pending' && entry.pendingId === pendingId
      ? { ...entry, ...update(entry) } : entry);
  }

  function saveMeasurement(draft, event, profile, device, pendingId) {
    const measurement = historyRecord(event, profile ? { ...profile, user: profile.name } : null, device);
    const slot = measurementSlot(measurement, draft.profiles);
    const existing = draft.measurements.find(row => measurementSlot(row, draft.profiles) === slot);
    const stored = existing ?? measurement;
    updateReceipt(draft, pendingId, entry => ({ reason: null,
      text: existing ? 'Pesée déjà enregistrée.' : 'Pesée enregistrée.',
      measurementUuid: stored.uuid, profileUuid: stored.profile?.uuid ?? null, deviceUuid: stored.device?.uuid ?? null,
      ...(entry.replaying && { replaying: false, restoredAt: new Date().toISOString() }),
    }));
    if (existing) return;
    draft.measurements = [...draft.measurements, measurement];
    notify(draft, { type: 'measurement', action: 'saved', record: measurement });
    if (profile?.name) draft.selectedProfile = profile.name;
  }

  function assign(draft, event, id = uuid(), archivedMetadata = null, requireAttribution = false) {
    const device = findDevice(draft, event.address);
    const profile = device && !requireAttribution && matchWeight(event, draft.profiles, latestWeights(draft.measurements));
    const bluetoothMetadata = { ...acquisition.metadataFor(event.address), ...archivedMetadata };
    const reason = device ? 'profile' : 'device';
    const update = {
      reason, deviceUuid: device?.uuid ?? null, profileUuid: null, measurementUuid: null,
      text: device ? 'Choisissez le profil auquel attribuer la pesée.' : 'Enregistrez cette balance pour traiter sa pesée.',
      record: { event, bluetoothMetadata },
    };
    if (draft.notifications.some(entry => entry.type === 'pending' && entry.pendingId === id)) {
      updateReceipt(draft, id, () => update);
    } else {
      notify(draft, { type: 'pending', pendingId: id, ...update });
    }
    const pending = draft.pending.filter(row => row.id !== id);
    if (profile) {
      saveMeasurement(draft, event, profile, device, id);
      draft.pending = pending;
    } else {
      draft.pending = [...pending, { id, event, device: device ?? null, reason, bluetoothMetadata }];
    }
  }

  function replayReceipt(id) {
    return mutate(draft => {
      const entry = draft.notifications.find(item => item.id === id && item.type === 'pending');
      if (!entry?.record?.event) throw Error('Réception de pesée introuvable.');
      if (draft.pending.some(item => item.id === entry.pendingId)) return;
      if (entry.measurementUuid && draft.measurements.some(row => row.uuid === entry.measurementUuid)) {
        throw Error('Cette pesée est déjà disponible.');
      }
      updateReceipt(draft, entry.pendingId, () => ({ replaying: true }));
      assign(draft, entry.record.event, entry.pendingId, entry.record.bluetoothMetadata, true);
    });
  }

  function resolveDevice(draft, device) {
    for (const { id, event, reason, bluetoothMetadata } of draft.pending) {
      if (reason === 'device' && event.address === device.bluetooth.address) assign(draft, event, id, bluetoothMetadata);
    }
  }

  function selectProfile(name) {
    return mutate(draft => {
      const profile = findProfile(draft, name);
      if (name != null && !profile) throw Error('Profil introuvable.');
      draft.selectedProfile = profile?.name ?? null;
    });
  }

  function saveProfile(fields) {
    return mutate(draft => {
      const profile = profileFields(fields);
      const existing = findProfile(draft, fields.editUuid ?? fields.editName ?? profile.name);
      if (fields.editUuid != null || fields.editName != null) {
        if (!existing) throw Error('Profil introuvable.');
        const duplicate = findProfile(draft, profile.name);
        if (duplicate && duplicate !== existing) throw Error('Ce nom de profil est déjà utilisé.');
        if (draft.selectedProfile === existing.name) draft.selectedProfile = profile.name;
        if (profile.name !== existing.name && Object.hasOwn(draft.profilePreferences, existing.name)) {
          const { [existing.name]: preferences, ...others } = draft.profilePreferences;
          draft.profilePreferences = { ...others, [profile.name]: preferences };
        }
        draft.profiles = draft.profiles.map(candidate => candidate === existing ? { ...profile, uuid: existing.uuid } : candidate);
      } else {
        if (existing) throw Error('Ce nom de profil est déjà utilisé.');
        draft.profiles = [...draft.profiles, identify(profile)];
        draft.selectedProfile ??= profile.name;
      }
      notify(draft, { type: 'profile', action: 'saved', record: findProfile(draft, profile.name), actor: saved.selectedProfile });
    });
  }

  function deleteProfile(name) {
    return mutate(draft => {
      const profile = findProfile(draft, name);
      if (!profile) throw Error('Profil introuvable.');
      const belongsToProfile = row => row.profile?.uuid ? row.profile.uuid === profile.uuid
        : typeof row.profile?.name === 'string' && nameKey(row.profile.name) === nameKey(profile.name);
      notify(draft, { type: 'profile', action: 'deleted', record: profile,
        measurements: draft.measurements.filter(belongsToProfile),
        preferences: draft.profilePreferences[profile.name] });
      draft.profiles = draft.profiles.filter(candidate => candidate !== profile);
      draft.measurements = draft.measurements.filter(row => !belongsToProfile(row));
      draft.profilePreferences = { ...draft.profilePreferences };
      delete draft.profilePreferences[profile.name];
      if (draft.selectedProfile === profile.name) draft.selectedProfile = null;
    });
  }

  function deleteMeasurement(row) {
    return mutate(draft => {
      const index = draft.measurements.findIndex(candidate => row.uuid ? candidate.uuid === row.uuid : candidate === row);
      if (index < 0) throw Error('Pesée introuvable.');
      notify(draft, { type: 'measurement', action: 'deleted', record: draft.measurements[index] });
      draft.measurements = draft.measurements.toSpliced(index, 1);
    });
  }

  function setTheme(profile, theme) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      if (theme !== 'light' && theme !== 'dark') throw Error('Thème invalide.');
      const name = target?.name ?? null;
      const prefs = preferencesFor(draft, name);
      if (prefs.theme !== theme) savePreferences(draft, name, { ...prefs, theme });
    });
  }

  function setColumnPreference(profile, id, setting, enabled) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      if (typeof id !== 'string' || !id || !['columns', 'splitColumns'].includes(setting)
          || typeof enabled !== 'boolean') {
        throw Error('Préférence de colonne invalide.');
      }
      const { prefs, layout } = editableLayout(draft, target?.name ?? null, 'measurements');
      const values = new Set(layout[setting]);
      if (enabled) values.add(id);
      else values.delete(id);
      savePreferences(draft, target?.name, { ...prefs, [setting]: [...values] });
    });
  }

  function savePreferences(draft, profile, prefs) {
    if (profile) draft.profilePreferences = { ...draft.profilePreferences, [profile]: prefs };
    else draft.anonymousPreferences = prefs;
  }

  function editableLayout(draft, profile, kind) {
    const prefs = preferencesFor(draft, profile);
    const current = layoutFor(draft, prefs, kind);
    return { ...current, prefs: prefs.viewPresetIds?.[kind] && !current.preset
      ? selectLayout(prefs, kind, null) : prefs };
  }

  function changeViewPreset(profile, kind, action, { id = null, name } = {}) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      if (!Object.hasOwn(viewDefaults, kind)) throw Error('Vue inconnue.');
      const { prefs, presets, layout } = editableLayout(draft, target?.name ?? null, kind);
      const existing = presets.find(entry => entry.id === id);
      if (id && !existing) throw Error('Configuration introuvable.');
      const replace = entries => { draft.viewPresets = { ...draft.viewPresets, [kind]: entries }; };
      const select = selected => savePreferences(draft, target?.name, selectLayout(prefs, kind, selected));
      if (action === 'select') {
        select(id);
        return;
      }
      if (action === 'delete' && existing) {
        replace(presets.filter(entry => entry.id !== id));
        select(null);
        return;
      }
      if (!['save', 'create', 'rename'].includes(action) || (action === 'rename' && !existing)) {
        throw Error('Action invalide.');
      }
      const label = name?.trim().normalize('NFC');
      const defaultName = kind === 'measurements' ? 'Pesées' : 'Détails de la pesée';
      if (!label || label.length > 64) throw Error('Saisis un nom de 1 à 64 caractères.');
      if (label.toLowerCase() === defaultName.toLowerCase()) throw Error('Ce nom est réservé à la vue par défaut.');
      const matching = presets.find(entry => entry.name.toLowerCase() === label.toLowerCase());
      if (matching && action !== 'save' && (action === 'create' || matching.id !== id)) {
        throw Error('Ce nom est déjà utilisé.');
      }
      if (action === 'rename') {
        replace(presets.map(entry => entry.id === id ? { ...entry, name: label } : entry));
        return;
      }
      const preset = { id: matching?.id ?? globalThis.crypto.randomUUID(), name: label, layout };
      replace(matching ? presets.map(entry => entry === matching ? preset : entry) : [...presets, preset]);
      select(preset.id);
    });
  }

  function setPanelOpen(profile, section, open) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      const prefs = preferencesFor(draft, target?.name ?? null);
      const updates = section === null ? { rawOpen: open }
        : { detailSectionsOpen: { ...prefs.detailSectionsOpen, [section]: open } };
      savePreferences(draft, target?.name, { ...prefs, ...updates });
    });
  }

  function movePreference(setting, profile, source, target, visibleOrder, defaultOrder = visibleOrder) {
    return mutate(draft => {
      const current = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !current) throw Error('Profil introuvable.');
      if (source === target || !visibleOrder.includes(source) || !visibleOrder.includes(target)) return;
      const kind = setting === 'columnOrder' ? 'measurements' : 'details';
      const { prefs, layout, preset } = editableLayout(draft, current?.name ?? null, kind);
      const order = [...new Set([...layout[setting], ...visibleOrder])];
      const from = order.indexOf(source);
      const to = order.indexOf(target);
      order.splice(from, 1);
      order.splice(to, 0, source);
      const original = preset?.layout?.[setting] ?? viewDefaults[kind][setting];
      const relevantIds = new Set([...original, ...order]);
      const originalOrder = [...new Set([...original, ...defaultOrder])].filter(id => relevantIds.has(id));
      const fullOrder = [...new Set([...order, ...defaultOrder])].filter(id => relevantIds.has(id));
      const next = { ...prefs, [setting]: order };
      // A drag records explicit positions for items that may already follow the original order.
      if (fullOrder.length === originalOrder.length && fullOrder.every((id, index) => id === originalOrder[index])) {
        delete next[setting];
      }
      savePreferences(draft, current?.name, next);
    });
  }

  function renameDevice(input) {
    return enqueue(async () => {
      const request = await transact(draft => {
        const request = enrollmentRequest(draft, input);
        const existing = findDevice(draft, request.address);
        if (!existing) throw Error('Appareil introuvable.');
        if (request.name !== existing.name) {
          const renamed = { ...existing, name: request.name };
          draft.devices = draft.devices.map(device => device === existing ? renamed : device);
          notify(draft, { type: 'device', action: 'saved', record: renamed });
          if (draft.pending.some(item => item.device?.bluetooth.address === request.address)) {
            draft.pending = draft.pending.map(item => item.device?.bluetooth.address === request.address
              ? { ...item, device: renamed } : item);
          }
        }
        return request;
      });
      if (enrollment?.address === request.address) enrollment = request;
      return publish();
    });
  }

  function deleteDevice(address) {
    return enqueue(async () => {
      await transact(draft => {
        const device = findDevice(draft, address);
        if (!device) throw Error('Appareil introuvable.');
        notify(draft, { type: 'device', action: 'deleted', record: device });
        draft.devices = draft.devices.filter(candidate => candidate !== device);
        if (draft.addressFilter === address) draft.addressFilter = null;
        draft.pending = draft.pending.map(item => {
          if (item.event.address !== address) return item;
          updateReceipt(draft, item.id, () => ({ reason: 'device', text: 'Enregistrez cette balance pour traiter sa pesée.' }));
          return { ...item, device: null, reason: 'device' };
        });
      });
      if (enrollment?.address === address) enrollment = null;
      return publish();
    });
  }

  function beginDevice(input) {
    return enqueue(async () => {
      const request = enrollmentRequest(saved, input);
      const pending = request.address && saved.pending.find(row =>
        row.reason === 'device' && row.event.address === request.address);
      if (pending) {
        await transact(draft => {
          const stagedMetadata = address => ({ ...pending.bluetoothMetadata, ...acquisition.metadataFor(address) });
          const device = applyObservation(draft, request, { event: pending.event }, stagedMetadata);
          if (device) {
            notify(draft, { type: 'device', action: 'saved', record: device });
            resolveDevice(draft, device);
          }
        });
        enrollment = null;
      } else {
        const id = globalThis.crypto.randomUUID();
        await transact(draft => notify(draft, { type: 'enrollment', enrollmentId: id,
          text: `En attente d’une pesée de l’appareil « ${request.name} ». Montez sur la balance pour envoyer ses données.` }));
        enrollment = { ...request, id, actor: saved.selectedProfile };
      }
      return publish();
    });
  }

  function cancelDevice() {
    return enqueue(() => {
      enrollment = null;
      return publish();
    });
  }

  function confirmProfile({ id, name, profile: temporary }) {
    return mutate(draft => {
      const pending = draft.pending.find(row => row.id === id);
      if (!pending) throw Error('Pesée en attente introuvable.');
      const profile = name != null ? findProfile(draft, name)
        : temporary ? { ...profileFields({ ...temporary, name: 'Temporaire' }), name: null } : null;
      if (name != null && !profile) throw Error('Profil introuvable.');
      const device = findDevice(draft, pending.event.address);
      if (!device) throw Error('Identifie la balance avant d’attribuer la pesée.');
      saveMeasurement(draft, pending.event, profile, device, pending.id);
      draft.pending = draft.pending.filter(row => row.id !== id);
    });
  }

  function discardPending(id) {
    return mutate(draft => {
      const pending = draft.pending.filter(row => row.id !== id);
      if (pending.length === draft.pending.length) return;
      draft.pending = pending;
      updateReceipt(draft, id, () => ({ reason: null, text: 'Pesée ignorée.', replaying: false }));
    });
  }

  function ingest(line, now = Date.now()) {
    return enqueue(async () => {
      const observation = acquisition.observe(line, now);
      const { event, metadata } = observation;
      if (!event && !metadata) return view();
      const address = event?.address ?? metadata.address;
      const selected = !saved.addressFilter || saved.addressFilter === address;
      const enrolling = enrollment?.address === address
        || (enrollment && !enrollment.address && !findDevice(saved, address));
      if (!selected && !enrolling) return view();
      const reading = event && acquisition.accept(event, now);
      const previous = saved;
      const hadError = acquisitionError !== null;
      let enrolled;
      await transact(draft => {
        enrolled = applyObservation(draft, enrollment, observation, acquisition.metadataFor);
        if (enrolled) {
          notify(draft, { type: 'device', action: 'saved', record: enrolled, actor: enrollment.actor });
          resolveDevice(draft, enrolled);
        }
        if (metadata) {
          const staged = acquisition.metadataFor(address);
          for (const row of draft.pending) {
            if (row.event.address !== address) continue;
            const bluetoothMetadata = { ...row.bluetoothMetadata, ...staged };
            if (JSON.stringify(row.bluetoothMetadata) === JSON.stringify(bluetoothMetadata)) continue;
            draft.pending = draft.pending.map(item => item.id === row.id ? { ...item, bluetoothMetadata } : item);
            updateReceipt(draft, row.id, entry => ({ record: { ...entry.record, bluetoothMetadata } }));
          }
        }
        if (reading) assign(draft, reading.event);
      });
      if (enrolled) enrollment = null;
      if (reading) {
        acquisition.commit(reading);
        acquisitionError = null;
      }
      return saved !== previous || enrolled || (reading && hadError) ? publish() : view();
    });
  }

  function setAddressFilter(address) {
    return mutate(draft => {
      const target = address == null || address === '' ? null : canonicalAddress(String(address).trim());
      if (target && !ADDRESS.test(target)) throw Error('Identifiant Bluetooth invalide.');
      draft.addressFilter = target;
    });
  }

  function importLegacy(snapshot) {
    return mutate(draft => {
      mergeLegacy(draft, snapshot);
      upgradeIdentities(draft);
      for (const device of draft.devices) resolveDevice(draft, device);
    });
  }

  function reload() {
    return enqueue(async () => {
      await loadSaved();
      return publish();
    });
  }

  return {
    load: () => enqueue(async () => { await transact(() => {}); return view(); }),
    reload,
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    selectProfile, saveProfile, setColumnPreference, renameDevice, beginDevice, cancelDevice, confirmProfile,
    deleteProfile, deleteDevice, deleteMeasurement, setPanelOpen, changeViewPreset, setTheme,
    moveColumn: (...args) => movePreference('columnOrder', ...args),
    moveMethodColumn: (...args) => movePreference('methodColumnOrder', ...args),
    moveDetailSection: (...args) => movePreference('detailSectionOrder', ...args),
    discardPending, ingest, importLegacy, setAddressFilter, restoreNotification, replayReceipt,
    recordNotice: entry => mutate(draft => notify(draft, entry)),
    deleteNotification: id => mutate(draft => {
      draft.notifications = draft.notifications.filter(item => item.id !== id);
    }),
    pruneNotifications: () => mutate(() => {}),
  };
}

module.exports = { buildDevice, createSession, deviceFileKey };
