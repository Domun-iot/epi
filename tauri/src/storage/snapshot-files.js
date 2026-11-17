import { fileRecords, snapshotPath } from '../../../web/file-records.js';

export const accountPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const transactionName = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{6}Z-[0-9a-f-]{36}\.json$/u;
const folders = { measurements: 'prefs/measurements', details: 'prefs/measurement-details' };
export const clone = value => JSON.parse(JSON.stringify(value));
export const changedDataset = () => Object.assign(new Error('dataset_changed'), { code: 'dataset_changed' });

function preferencePath(name) {
  return /^[\p{Alphabetic}\p{Number}][\p{Alphabetic}\p{Number} _-]*$/u.test(name)
    ? 'prefs/profil-' + name + '.json'
    : 'prefs/profil~' + Array.from(new TextEncoder().encode(name), byte => byte.toString(16).padStart(2, '0')).join('') + '.json';
}

// Durable fields only: computed views, BLE acquisition and window state stay outside the port.
export function snapshotFiles(state, globalKeys) {
  const files = {};
  const add = (path, value) => { files[path] = clone(value); };
  for (const kind of ['profiles', 'devices']) for (const row of state[kind] ?? []) add(kind + '/' + row.uuid + '.json', row);
  for (const row of state.measurements ?? []) {
    const profile = state.profiles?.find(item => item.name?.toLowerCase() === row.profile?.name?.toLowerCase());
    let folder = (row.profile?.uuid ?? row.profileUuid ?? profile?.uuid ?? row.profile?.name ?? '_sans-profil').toLowerCase();
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(folder)) folder = '_' + folder;
    add('measures/' + folder + '/' + new Date(row.receivedAt).toISOString().replaceAll(':', '-') + '.json', row);
  }
  for (const row of state.notifications ?? []) add('notifications/' + row.id + '.json', row);
  for (const [kind, folder] of Object.entries(folders)) for (const row of state.viewPresets?.[kind] ?? []) add(folder + '/' + row.id + '.json', row);
  for (const [name, prefs] of Object.entries(state.profilePreferences ?? {})) add(preferencePath(name), prefs);
  add('prefs/global.json', Object.fromEntries([...globalKeys, 'createdAt', 'updatedAt']
    .filter(key => state[key] !== undefined).map(key => [key, state[key]])));
  for (const path of Object.keys(files)) if (!snapshotPath(path)) throw new Error('Invalid data path: ' + path);
  return files;
}

export function filesSnapshot(files) {
  const records = fileRecords(Object.entries(files).map(([path, value]) => ({ path, contents: JSON.stringify(value) })));
  const { window, ...global } = files['prefs/global.json'] ?? files['interface.json'] ?? files['session.json'] ?? {};
  return { ...clone(global), ...records,
    notifications: Object.entries(files).filter(([path]) => path.startsWith('notifications/')).map(([, value]) => clone(value)),
    profilePreferences: Object.fromEntries(records.profiles.flatMap(row => {
      const prefs = typeof row.name === 'string' ? files[preferencePath(row.name)] : undefined;
      return prefs === undefined ? [] : [[row.name, clone(prefs)]];
    })),
    viewPresets: Object.fromEntries(Object.entries(folders).map(([kind, folder]) => [kind,
      Object.entries(files).filter(([path]) => path.startsWith(folder + '/')).map(([, value]) => clone(value))])),
  };
}

export function summarize(files) {
  const state = filesSnapshot(files);
  const dates = state.measurements.map(row => row.receivedAt).filter(value => Number.isFinite(Date.parse(value))).sort();
  return { count: state.measurements.length, from: dates[0] ?? null, to: dates.at(-1) ?? null,
    hasData: ['profiles', 'devices', 'measurements', 'pending'].some(key => state[key]?.length > 0) };
}

export function transactionTime(name) {
  return new Date(name.slice(0, 27).replace(/T(\d\d)-(\d\d)-(\d\d)/u, 'T$1:$2:$3')).toISOString();
}

export function operations(row) {
  if (!accountPattern.test(row?.uuid ?? '') || !transactionName.test(row?.name ?? '') || !row.name.endsWith('-' + row.uuid + '.json')) throw new Error('Invalid transaction.');
  const changes = row.type === 'batch' ? row.data : [{ ...row.data, type: row.type }];
  if (!Array.isArray(changes) || !changes.length) throw new Error('Invalid transaction.');
  const paths = new Set();
  for (const operation of changes) {
    if (!['create', 'update', 'delete'].includes(operation?.type) || typeof operation.path !== 'string'
        || !snapshotPath(operation.path) || /^(?:transactions|installation)/u.test(operation.path)
        || (operation.type === 'delete' ? Object.hasOwn(operation, 'value')
          : !operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value))) throw new Error('Invalid transaction operation.');
    const key = operation.path.toLowerCase();
    if (paths.has(key)) throw new Error('Repeated transaction path.');
    paths.add(key);
  }
  return changes;
}

export function emptyDataset() { return { files: {}, pending: {}, sent: {}, ids: [], tombstones: {}, syncReady: false }; }

export function recordChanges(dataset, changes, after = 0) {
  if (!changes.length) return false;
  const uuid = crypto.randomUUID();
  dataset.stamp = Math.max(Date.now() * 1000, (dataset.stamp ?? 0) + 1, after * 1000);
  const stamp = new Date(Math.floor(dataset.stamp / 1000)).toISOString()
    .replace('Z', String(dataset.stamp % 1000).padStart(3, '0') + 'Z').replaceAll(':', '-');
  const name = stamp + '-' + uuid + '.json';
  const row = changes.length === 1 ? { uuid, type: changes[0].type,
    data: Object.fromEntries(Object.entries(changes[0]).filter(([key]) => key !== 'type')) }
    : { uuid, type: 'batch', data: changes };
  operations({ ...row, name });
  dataset.pending[name] = row;
  dataset.ids.push(uuid);
  for (const change of changes) if (change.type === 'delete') dataset.tombstones[change.path.toLowerCase()] = transactionTime(name);
  return true;
}

export function replaceFiles(dataset, next, versions) {
  const changes = [];
  for (const path of new Set([...Object.keys(dataset.files), ...Object.keys(next)])) {
    if (versions.sameContent(dataset.files[path], next[path])) continue;
    const value = next[path];
    changes.push(value === undefined ? { type: 'delete', path }
      : { type: dataset.files[path] === undefined ? 'create' : 'update', path, value });
  }
  // The file protocol compares millisecond versions: a deletion must follow its
  // removed record even when creation and deletion occur within one clock tick.
  const deletionFloor = changes.filter(change => change.type === 'delete').reduce((latest, change) =>
    Math.max(latest, (Date.parse(versions.versionDate(dataset.files[change.path])) || 0) + 1), 0);
  recordChanges(dataset, changes, deletionFloor);
  dataset.files = clone(next);
  return changes.length;
}

export function integrate(dataset, rows, versions) {
  const ids = new Set(dataset.ids), uuids = [];
  let changed = false;
  for (const row of rows) {
    let changes;
    try { changes = operations(row); } catch { continue; }
    if (ids.has(row.uuid)) { uuids.push(row.uuid); continue; }
    for (const operation of changes) {
      const key = operation.path.toLowerCase(), current = dataset.files[operation.path];
      const time = operation.type === 'delete' ? transactionTime(row.name) : versions.versionDate(operation.value) ?? transactionTime(row.name);
      const deletion = dataset.tombstones[key];
      if (operation.type !== 'delete' && deletion && time <= deletion) continue;
      if (operation.type === 'delete' && (!deletion || time > deletion)) dataset.tombstones[key] = time;
      if (current !== undefined && versions.versionDate(current) && !versions.isNewer({ updatedAt: time }, current)) continue;
      if (operation.type === 'delete') { changed ||= current !== undefined; delete dataset.files[operation.path]; }
      else if (!versions.sameContent(current, operation.value)) { dataset.files[operation.path] = clone(operation.value); changed = true; }
    }
    const { name, ...transaction } = row;
    dataset.sent[name] = clone(transaction);
    ids.add(row.uuid);
    uuids.push(row.uuid);
  }
  dataset.ids = [...ids];
  return { uuids: [...new Set(uuids)], changed };
}

export function importSnapshot(entries, versions) {
  const dataset = emptyDataset(), seen = new Set(), incoming = [];
  for (const { path, contents } of entries) {
    if (!snapshotPath(path) || typeof contents !== 'string' || seen.has(path.toLowerCase())) throw new Error('Invalid snapshot file.');
    seen.add(path.toLowerCase());
    if (path === 'transactions.index') {
      for (const id of contents.split(/\r?\n/u).filter(Boolean)) {
        if (!accountPattern.test(id)) throw new Error('Invalid transaction index.');
        dataset.ids.push(id);
      }
      continue;
    }
    const value = JSON.parse(contents.replace(/^\uFEFF/u, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot record.');
    if (path.startsWith('transactions')) {
      const [folder, name] = path.split('/'), row = { ...value, name };
      const changes = operations(row);
      if (folder === 'transactions.incoming') { incoming.push(row); continue; }
      dataset[folder === 'transactions' ? 'pending' : 'sent'][name] = value;
      dataset.ids.push(value.uuid);
      for (const change of changes) if (change.type === 'delete') {
        const key = change.path.toLowerCase(), time = transactionTime(name);
        if (!dataset.tombstones[key] || time > dataset.tombstones[key]) dataset.tombstones[key] = time;
      }
    } else dataset.files[path] = value;
  }
  dataset.ids = [...new Set(dataset.ids)];
  if (incoming.length) {
    const pending = incoming.filter(row => !dataset.ids.includes(row.uuid));
    const result = integrate(dataset, incoming.sort((a, b) => a.name.localeCompare(b.name)), versions);
    if (new Set(result.uuids).size !== new Set(incoming.map(row => row.uuid)).size) throw new Error('Invalid incoming journal.');
    for (const { name, ...row } of pending) { dataset.pending[name] = row; delete dataset.sent[name]; }
  }
  return dataset;
}

export function exportSnapshot(dataset) {
  return [...Object.entries(dataset.files),
    ...Object.entries(dataset.pending).map(([name, value]) => ['transactions/' + name, value]),
    ...Object.entries(dataset.sent).map(([name, value]) => ['transactions.sent/' + name, value])]
    .map(([path, value]) => ({ path, contents: JSON.stringify(value, null, 2) + '\n' }))
    .concat({ path: 'transactions.index', contents: dataset.ids.join('\n') + '\n' });
}


function recordKeys(path, value, profiles) {
  const records = fileRecords([{ path, contents: JSON.stringify(value) }]);
  const profile = records.profiles[0], device = records.devices[0], measurement = records.measurements[0];
  if (profile) return [profile.uuid && 'profile-id:' + profile.uuid.toLowerCase(),
    profile.name && 'profile-name:' + profile.name.toLowerCase()].filter(Boolean);
  if (device) return [device.uuid && 'device-id:' + device.uuid.toLowerCase(),
    device.bluetooth?.address && 'device-address:' + device.bluetooth.address.replace(/[^a-f0-9]/giu, '').toUpperCase()].filter(Boolean);
  if (measurement) {
    const associated = profiles.find(row => row.uuid === (measurement.profile?.uuid ?? measurement.profileUuid));
    const name = measurement.profile?.name ?? associated?.name;
    const named = typeof name === 'string' && profiles.find(row => row.name?.toLowerCase() === name.toLowerCase());
    const id = named?.uuid ?? associated?.uuid ?? name?.toLowerCase() ?? '_sans-profil';
    const time = Date.parse(measurement.receivedAt);
    return [measurement.uuid && 'measurement-id:' + measurement.uuid,
      Number.isFinite(time) && 'measurement-slot:' + id + ':' + time].filter(Boolean);
  }
  return [];
}

// ZIP paths can differ while identifying the same legacy profile, device or reading.
export function mergeImportedFiles(current, incoming) {
  const entries = files => Object.entries(files).map(([path, value]) => ({ path, contents: JSON.stringify(value) }));
  const profiles = fileRecords([...entries(current), ...entries(incoming)]).profiles;
  const keys = new Set(), paths = new Set(Object.keys(current).map(path => path.toLowerCase()));
  const files = { ...current };
  for (const [path, value] of Object.entries(current)) for (const key of recordKeys(path, value, profiles)) keys.add(key);
  let added = 0;
  for (const [path, value] of Object.entries(incoming)) {
    const identities = recordKeys(path, value, profiles);
    if (paths.has(path.toLowerCase()) || identities.some(key => keys.has(key))) continue;
    paths.add(path.toLowerCase());
    for (const key of identities) keys.add(key);
    files[path] = value;
    added += 1;
  }
  return { files, added };
}
