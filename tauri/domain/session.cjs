'use strict';

const { buildDevice, deviceFileKey } = require('../../shared/device-fields.cjs');
const { canonicalAddress } = require('../../shared/scale.cjs');
const { historyRecord, latestWeights, matchWeight } = require('../../shared/history.cjs');
const { nameKey } = require('../../shared/profile-fields.cjs');
const { metrics } = require('../../shared/composition.cjs');
const { createAcquisition } = require('./acquisition.cjs');
const { applyObservation, enrollmentRequest, findDevice } = require('./devices.cjs');
const { ADDRESS, findProfile, profileFields, mergeLegacy, measurementSlot } = require('./records.cjs');
const { uuid, identify, upgradeIdentities } = require('./identities.cjs');

const notificationLifetime = 7 * 86400_000;

const viewDefaults = {
  measurements: { columns: ['bmi'], splitColumns: [], columnOrder: [] },
  details: { methodColumnOrder: [], detailSectionOrder: [] },
};
const chartColumns = ['impedanceOhms', ...metrics.map(([id]) => id)];
const chartStates = ['visible', 'bold', 'hidden'];
const chartViewKey = preset => preset?.id ?? 'default';

const chartDefaults = { display: 'table', mode: 'smooth', period: 'all' };

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
    const personalColumns = kind === 'measurements' && key === 'columns'
      ? prefs.chartByView?.[chartViewKey(preset)]?.columns : undefined;
    const value = layout[key] = (!id || preset ? prefs[key] : undefined) ?? personalColumns ?? original;
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

function chartSeries(columns, stored) {
  const ids = ['weight', ...chartColumns.filter(id => columns.includes(id))];
  return Object.fromEntries(ids.map(id => {
    const status = stored?.[id];
    return [id, chartStates.includes(status) ? status : id === 'weight' ? 'bold' : 'visible'];
  }));
}

function chartPreferences(prefs, { preset, layout }) {
  const key = chartViewKey(preset);
  const stored = prefs.chartByView?.[key];
  const baseline = { ...chartDefaults, ...preset?.chart?.options };
  const options = stored?.options ?? {
    ...baseline,
    ...(prefs.measurementDisplay === 'chart' && !preset?.chart ? { display: 'chart' } : {}),
    ...prefs.chartOptionsByView?.[key],
  };
  const series = chartSeries(layout.columns, stored?.series ?? prefs.chartSeriesByView?.[key] ?? preset?.chart?.series);
  const original = chartSeries(layout.columns, preset?.chart?.series);
  const modified = Object.keys(chartDefaults).some(id => options[id] !== baseline[id])
    || options.range?.[0] !== baseline.range?.[0] || options.range?.[1] !== baseline.range?.[1]
    || Object.keys(series).some(id => series[id] !== original[id]);
  return { key, stored, options, series, modified };
}

function withChartPreferences(prefs, key, chart) {
  return { ...prefs, chartByView: { ...prefs.chartByView, [key]: chart } };
}

function modifiedInactiveViews(state, prefs, kind, active) {
  return [null, ...active.presets.map(preset => preset.id)].filter(id => {
    if (id === (active.preset?.id ?? null)) return false;
    const view = layoutFor(state, {
      ...selectLayout(prefs, kind, id),
      ...prefs.inactiveLayouts?.[kind]?.[id ?? 'default'],
    }, kind);
    return view.modified || (kind === 'measurements' && chartPreferences(prefs, view).modified);
  });
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
    const chart = chartPreferences(prefs, measurements);
    measurements.modified ||= chart.modified;
    measurements.modifiedInactiveIds = modifiedInactiveViews(saved, prefs, 'measurements', measurements);
    details.modifiedInactiveIds = modifiedInactiveViews(saved, prefs, 'details', details);
    return { ...saved, ...measurements.layout, ...details.layout, viewLayouts: { measurements, details },
      measurementDisplay: chart.options.display, chartOptions: chart.options, chartSeries: chart.series,
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
    const prefs = preferencesFor(draft);
    const measurements = layoutFor(draft, prefs, 'measurements');
    const { key, stored, options, series } = chartPreferences(prefs, measurements);
    if (!stored && (measurements.preset || options.display === 'chart' || prefs.chartOptionsByView?.[key]
        || prefs.chartSeriesByView?.[key])) {
      const chart = { options, series };
      if (options.display === 'chart' || prefs.chartOptionsByView?.[key] || prefs.chartSeriesByView?.[key]) {
        chart.columns = measurements.layout.columns;
      }
      savePreferences(draft, draft.selectedProfile, withChartPreferences(prefs, key, chart));
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
        const profile = profileFieldsOverride ? {
          ...profileFields(profileFieldsOverride), uuid: record.uuid,
          ...(record.createdAt && { createdAt: record.createdAt }),
          updatedAt: new Date().toISOString(),
        } : record;
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
      if (entry.measurementUuid && draft.notifications.some(item => item.type === 'measurement'
        && item.action === 'deleted' && item.record?.uuid === entry.measurementUuid)) {
        throw Error('Cette pesée peut être restaurée depuis son historique.');
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
        const updated = { ...profile, uuid: existing.uuid, updatedAt: new Date().toISOString() };
        if (existing.createdAt) updated.createdAt = existing.createdAt;
        draft.profiles = draft.profiles.map(candidate => candidate === existing ? updated : candidate);
      } else {
        if (existing) throw Error('Ce nom de profil est déjà utilisé.');
        draft.profiles = [...draft.profiles, identify({ ...profile, createdAt: new Date().toISOString() })];
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

  function setMeasurementDisplay(profile, display, viewId) {
    return setChartOptions(profile, viewId, { display });
  }

  function cycleChartSeries(profile, viewId, id) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      const name = target?.name ?? null;
      const prefs = preferencesFor(draft, name);
      const current = layoutFor(draft, prefs, 'measurements');
      if ((current.preset?.id ?? null) !== viewId) return;
      const { key, options, series } = chartPreferences(prefs, current);
      if (!Object.hasOwn(series, id)) return;
      const next = chartStates[(chartStates.indexOf(series[id]) + 1) % chartStates.length];
      if (next === 'bold') {
        for (const entry of Object.keys(series)) {
          if (series[entry] === 'bold') series[entry] = 'visible';
        }
      }
      series[id] = next;
      savePreferences(draft, name, withChartPreferences(prefs, key, { options, series, columns: current.layout.columns }));
    });
  }

  function setChartOptions(profile, viewId, options) {
    return mutate(draft => {
      const target = profile == null ? null : findProfile(draft, profile);
      if (profile != null && !target) throw Error('Profil introuvable.');
      const name = target?.name ?? null;
      const prefs = preferencesFor(draft, name);
      const current = layoutFor(draft, prefs, 'measurements');
      if (viewId !== undefined && (current.preset?.id ?? null) !== viewId) return;
      const { key, options: original, series } = chartPreferences(prefs, current);
      const next = { ...original };
      if (Object.hasOwn(options, 'display')) {
        if (!['chart', 'table'].includes(options.display)) throw Error('Visualisation des pesées invalide.');
        next.display = options.display;
      }
      if (Object.hasOwn(options, 'mode')) {
        if (!['raw', 'smooth'].includes(options.mode)) throw Error('Mode de graphique invalide.');
        next.mode = options.mode;
      }
      if (Object.hasOwn(options, 'period')) {
        const { period } = options;
        if (!['30', '90', '365', 'all'].includes(period)) throw Error('Période invalide.');
        next.period = period;
        delete next.range;
      }
      if (Object.hasOwn(options, 'range')) {
        const { range } = options;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(time =>
          Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15) || range[0] >= range[1]) {
          throw Error('Plage de dates invalide.');
        }
        next.range = range;
      }
      savePreferences(draft, name, withChartPreferences(prefs, key,
        { options: next, series, columns: current.layout.columns }));
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
      const current = editableLayout(draft, target?.name ?? null, 'measurements');
      const { prefs, layout } = current;
      const values = new Set(layout[setting]);
      if (enabled) values.add(id);
      else values.delete(id);
      const next = { ...prefs, [setting]: [...values] };
      const { key, stored, options } = chartPreferences(prefs, current);
      if (setting === 'columns' && (options.display === 'chart' || stored?.columns)) {
        const columns = next.columns;
        const { series } = chartPreferences(prefs, { ...current, layout: { ...layout, columns } });
        delete next.columns;
        savePreferences(draft, target?.name, withChartPreferences(next, key, { options, series, columns }));
        return;
      }
      savePreferences(draft, target?.name, next);
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
      const current = editableLayout(draft, target?.name ?? null, kind);
      const { prefs, presets, layout } = current;
      const existing = presets.find(entry => entry.id === id);
      if (id && !existing) throw Error('Configuration introuvable.');
      const replace = entries => { draft.viewPresets = { ...draft.viewPresets, [kind]: entries }; };
      const select = (selected, preferences = prefs) => {
        const activeId = current.preset?.id ?? null;
        const activeKey = activeId ?? 'default';
        const selectedKey = selected ?? 'default';
        const inactive = { ...prefs.inactiveLayouts?.[kind] };
        const next = selectLayout(preferences, kind, selected);
        if (selected !== activeId && (action === 'select' || action === 'reset')) {
          inactive[activeKey] = Object.fromEntries(Object.keys(viewDefaults[kind])
            .filter(key => Object.hasOwn(prefs, key)).map(key => [key, prefs[key]]));
        }
        if (action === 'select' || action === 'delete') {
          Object.assign(next, inactive[selectedKey]);
        }
        delete inactive[selectedKey];
        if (action === 'delete') delete inactive[activeKey];
        next.inactiveLayouts = { ...prefs.inactiveLayouts, [kind]: inactive };
        savePreferences(draft, target?.name, next);
      };
      if (action === 'select' || action === 'reset') {
        if (action === 'reset' && kind === 'measurements') {
          const columns = existing?.layout.columns ?? viewDefaults.measurements.columns;
          const { key, options, series } = chartPreferences({}, { preset: existing, layout: { columns } });
          const chart = options.display === 'chart' ? { options, series, columns } : { options, series };
          select(id, withChartPreferences(prefs, key, chart));
        } else {
          select(id);
        }
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
      let next = prefs;
      if (kind === 'measurements') {
        const { options, series } = chartPreferences(prefs, current);
        preset.chart = { options, series };
        next = withChartPreferences(prefs, preset.id, { ...preset.chart, columns: layout.columns });
      }
      replace(matching ? presets.map(entry => entry === matching ? preset : entry) : [...presets, preset]);
      select(preset.id, next);
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
          const renamed = { ...existing, name: request.name, updatedAt: new Date().toISOString() };
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
    deleteProfile, deleteDevice, deleteMeasurement, setPanelOpen, changeViewPreset, setTheme, setMeasurementDisplay, cycleChartSeries, setChartOptions,
    moveColumn: (...args) => movePreference('columnOrder', ...args),
    moveMethodColumn: (...args) => movePreference('methodColumnOrder', ...args),
    moveDetailSection: (...args) => movePreference('detailSectionOrder', ...args),
    discardPending, ingest, importLegacy, setAddressFilter, restoreNotification, replayReceipt,
    recordNotice: entry => mutate(draft => notify(draft, entry)),
    deleteNotification: id => mutate(draft => {
      draft.notifications = draft.notifications.filter(item => item.id !== id);
    }),
    deleteAllNotifications: () => mutate(draft => {
      draft.notifications = [];
    }),
    pruneNotifications: () => mutate(() => {}),
  };
}

module.exports = { buildDevice, createSession, deviceFileKey };
