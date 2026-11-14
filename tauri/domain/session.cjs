'use strict';

const { deviceFileKey } = require('../../shared/device-fields.cjs');
const { canonicalAddress } = require('../../shared/scale.cjs');
const { historyRecord, latestWeights, matchWeight } = require('../../shared/history.cjs');
const { createAcquisition } = require('./acquisition.cjs');
const { applyObservation, enrollmentRequest, findDevice } = require('./devices.cjs');
const { ADDRESS, findProfile, profileFields, mergeLegacy } = require('./records.cjs');

const defaultColumns = ['impedanceOhms', 'bmi'];
const defaultSplitColumns = [];
const defaultColumnOrder = [];
const defaultDetailSectionOrder = [];
const emptyState = () => ({
  profiles: [],
  devices: [],
  measurements: [],
  pending: [],
  selectedProfile: null,
  profilePreferences: {},
  addressFilter: null,
});

function preferencesFor(state, profile = state.selectedProfile) {
  if (!profile) return state.anonymousPreferences ?? {};
  return Object.hasOwn(state.profilePreferences, profile) ? state.profilePreferences[profile] : {};
}

function restore(snapshot) {
  const { columns, ...stored } = snapshot ?? {};
  const state = { ...emptyState(), ...stored };
  if (state.selectedProfile && Array.isArray(columns) && !Object.hasOwn(state.profilePreferences, state.selectedProfile)) {
    state.profilePreferences = { ...state.profilePreferences, [state.selectedProfile]: { columns } };
  }
  return state;
}

function createSession({ storage, waitMs = 15_000, dedupMs = 30_000 }) {
  let saved;
  let enrollment = null;
  let acquisitionError = null;
  let tasks = Promise.resolve();
  const observers = new Set();

  const acquisition = createAcquisition({
    waitMs, dedupMs,
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
    const { columns = defaultColumns, splitColumns = defaultSplitColumns, columnOrder = defaultColumnOrder,
      methodColumnOrder = defaultColumnOrder, detailSectionOrder = defaultDetailSectionOrder,
      rawOpen = false, detailSectionsOpen } = preferencesFor(saved);
    return { ...saved, columns, splitColumns, columnOrder, methodColumnOrder, detailSectionOrder,
      rawOpen, detailSectionsOpen, enrollment, acquisitionError };
  }

  function publish() {
    const current = view();
    for (const observer of observers) observer(current);
    return current;
  }

  function enqueue(action) {
    const task = tasks.then(async () => {
      saved ??= restore(await storage.load());
      return action();
    });
    tasks = task.catch(() => {});
    return task;
  }

  async function transact(change) {
    const draft = { ...saved };
    const result = change(draft);
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

  function saveMeasurement(draft, event, profile, device) {
    const measurement = historyRecord(event, profile ? { ...profile, user: profile.name } : null, device);
    draft.measurements = [...draft.measurements, measurement];
    if (profile?.name) draft.selectedProfile = profile.name;
  }

  function assign(draft, event, pendingId = null) {
    const device = findDevice(draft, event.address);
    const profile = device && matchWeight(event, draft.profiles, latestWeights(draft.measurements));
    if (profile) {
      saveMeasurement(draft, event, profile, device);
      if (pendingId) draft.pending = draft.pending.filter(row => row.id !== pendingId);
      return;
    }
    const id = pendingId ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const bluetoothMetadata = device ? null : acquisition.metadataFor(event.address) ?? null;
    const row = { id, event, device: device ?? null, reason: device ? 'profile' : 'device', bluetoothMetadata };
    draft.pending = pendingId
      ? draft.pending.map(item => item.id === id ? row : item)
      : [...draft.pending, row];
  }

  function resolveDevice(draft, device) {
    for (const { id, event, reason } of draft.pending) {
      if (reason === 'device' && event.address === device.bluetooth.address) assign(draft, event, id);
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
      const existing = findProfile(draft, fields.editName ?? profile.name);
      if (fields.editName != null) {
        if (!existing) throw Error('Profil introuvable.');
        if (profile.name !== existing.name) throw Error('Le nom du profil doit rester identique.');
        draft.profiles = draft.profiles.map(candidate => candidate === existing ? profile : candidate);
      } else {
        if (existing) throw Error('Ce nom de profil est déjà utilisé.');
        draft.profiles = [...draft.profiles, profile];
        draft.selectedProfile ??= profile.name;
      }
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
      const prefs = preferencesFor(draft, target?.name ?? null);
      const values = new Set(prefs[setting] ?? (setting === 'columns' ? defaultColumns : defaultSplitColumns));
      if (enabled) values.add(id);
      else values.delete(id);
      savePreferences(draft, target?.name, { ...prefs, [setting]: [...values] });
    });
  }

  function savePreferences(draft, profile, prefs) {
    if (profile) draft.profilePreferences = { ...draft.profilePreferences, [profile]: prefs };
    else draft.anonymousPreferences = prefs;
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

  function movePreference(setting, profile, source, target, visibleOrder) {
    return mutate(draft => {
      const current = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !current) throw Error('Profil introuvable.');
      if (source === target || !visibleOrder.includes(source) || !visibleOrder.includes(target)) return;
      const prefs = preferencesFor(draft, current?.name ?? null);
      const order = [...new Set([...(prefs[setting] ?? []), ...visibleOrder])];
      const from = order.indexOf(source);
      const to = order.indexOf(target);
      order.splice(from, 1);
      order.splice(to, 0, source);
      savePreferences(draft, current?.name, { ...prefs, [setting]: order });
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
          if (device) resolveDevice(draft, device);
        });
        enrollment = null;
      } else {
        enrollment = request;
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
      saveMeasurement(draft, pending.event, profile, device);
      draft.pending = draft.pending.filter(row => row.id !== id);
    });
  }

  function discardPending(id) {
    return mutate(draft => {
      const pending = draft.pending.filter(row => row.id !== id);
      if (pending.length !== draft.pending.length) draft.pending = pending;
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
        if (enrolled) resolveDevice(draft, enrolled);
        if (metadata && !findDevice(draft, address)) {
          const staged = acquisition.metadataFor(address);
          if (draft.pending.some(row => row.event.address === address
              && JSON.stringify(row.bluetoothMetadata) !== JSON.stringify(staged))) {
            draft.pending = draft.pending.map(row => row.event.address === address
              ? { ...row, bluetoothMetadata: staged } : row);
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
      for (const device of draft.devices) resolveDevice(draft, device);
    });
  }

  function reload() {
    return enqueue(async () => {
      saved = restore(await storage.load());
      return publish();
    });
  }

  return {
    load: () => enqueue(view),
    reload,
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    selectProfile, saveProfile, setColumnPreference, beginDevice, cancelDevice, confirmProfile,
    setPanelOpen,
    moveColumn: (...args) => movePreference('columnOrder', ...args),
    moveMethodColumn: (...args) => movePreference('methodColumnOrder', ...args),
    moveDetailSection: (...args) => movePreference('detailSectionOrder', ...args),
    discardPending, ingest, importLegacy, setAddressFilter,
  };
}

module.exports = { createSession, deviceFileKey };
