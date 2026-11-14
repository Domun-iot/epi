'use strict';

const { deviceFileKey } = require('../../shared/device-fields.cjs');
const { canonicalAddress } = require('../../shared/scale.cjs');
const { historyRecord, latestWeights, matchWeight } = require('../../shared/history.cjs');
const { createAcquisition } = require('./acquisition.cjs');
const { applyObservation, enrollmentRequest, findDevice } = require('./devices.cjs');
const { ADDRESS, findProfile, profileFields, mergeLegacy } = require('./records.cjs');

const viewDefaults = {
  measurements: { columns: ['impedanceOhms', 'bmi'], splitColumns: [], columnOrder: [] },
  details: { methodColumnOrder: [], detailSectionOrder: [] },
};
const emptyState = () => ({
  profiles: [],
  devices: [],
  measurements: [],
  pending: [],
  selectedProfile: null,
  profilePreferences: {},
  viewPresets: { measurements: [], details: [] },
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

  function movePreference(setting, profile, source, target, visibleOrder) {
    return mutate(draft => {
      const current = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !current) throw Error('Profil introuvable.');
      if (source === target || !visibleOrder.includes(source) || !visibleOrder.includes(target)) return;
      const kind = setting === 'columnOrder' ? 'measurements' : 'details';
      const { prefs, layout } = editableLayout(draft, current?.name ?? null, kind);
      const order = [...new Set([...layout[setting], ...visibleOrder])];
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
    setPanelOpen, changeViewPreset, setTheme,
    moveColumn: (...args) => movePreference('columnOrder', ...args),
    moveMethodColumn: (...args) => movePreference('methodColumnOrder', ...args),
    moveDetailSection: (...args) => movePreference('detailSectionOrder', ...args),
    discardPending, ingest, importLegacy, setAddressFilter,
  };
}

module.exports = { createSession, deviceFileKey };
