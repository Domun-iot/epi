import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { fileRecords, recordPath } from './file-records.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const safeName = /^[\p{Alphabetic}\p{Number}][\p{Alphabetic}\p{Number} _-]*$/u;
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const globalKeys = ['selectedProfile', 'pending', 'addressFilter', 'anonymousPreferences'];
const presetFolders = { measurements: 'prefs/measurements', details: 'prefs/measurement-details' };
const conflict = () => new Error('Un fichier a changé. Recharge les données avant de réessayer.');
const parse = contents => contents === undefined ? undefined : JSON.parse(contents.replace(/^\uFEFF/u, ''));

async function optional(read) {
  try { return await read(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function preferencePath(name) {
  return safeName.test(name) ? `prefs/profil-${name}.json` : `prefs/profil~${Buffer.from(name).toString('hex')}.json`;
}

function idPath(folder, id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Identifiant de fiche invalide.');
  return `${folder}/${id}.json`;
}

function measurementPath(row, profiles) {
  const name = row.profile?.name;
  const namedProfile = typeof name === 'string' && profiles.find(profile => profile.name?.toLowerCase() === name.toLowerCase());
  const id = row.profile?.uuid ?? row.profileUuid ?? namedProfile?.uuid;
  if (id != null && !uuid.test(id)) throw new Error('UUID de profil invalide.');
  if (id == null && name != null && (!safeName.test(name) || name.endsWith(' '))) {
    throw new Error('Nom de profil incompatible avec le dossier data.');
  }
  let folder = (id ?? name ?? '_sans-profil').toLowerCase();
  if (reserved.test(folder)) folder = '_' + folder;
  const stamp = new Date(row.receivedAt).toISOString().replaceAll(':', '-');
  return `measures/${folder}/${stamp}.json`;
}

async function writeAtomic(path, contents, replace) {
  if (contents === undefined) return rm(path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function fileStorage(root) {
  const read = path => optional(() => readFile(join(root, path), 'utf8'));
  const entries = async folder => (await optional(() => readdir(join(root, folder), { withFileTypes: true }))) ?? [];
  const readJson = async path => parse(await read(path));
  const readGlobal = async () => (await readJson('prefs/global.json')) ?? (await readJson('interface.json')) ?? {};

  async function records(key, folder = key) {
    const found = [];
    for (const entry of await entries(folder)) {
      const path = folder + '/' + entry.name;
      if (entry.isDirectory() && folder === 'measures') {
        found.push(...await records(key, path));
      } else if (entry.isFile() && recordPath.test(path)) {
        const contents = await read(path);
        if (contents !== undefined) found.push({ path, contents, row: fileRecords([{ path, contents }])[key][0] });
      }
    }
    return found;
  }

  async function list(folder, valid) {
    const items = await Promise.all((await entries(folder)).filter(entry =>
      entry.isFile() && entry.name.endsWith('.json') && uuid.test(entry.name.slice(0, -5)),
    ).map(async ({ name }) => {
      const item = await readJson(folder + '/' + name);
      return item?.id === name.slice(0, -5) && valid(item) ? item : undefined;
    }));
    return items.filter(Boolean);
  }

  async function load() {
    const [global, profiles, devices, measurements, notifications, ...presets] = await Promise.all([
      readGlobal(), records('profiles'), records('devices'), records('measurements', 'measures'),
      list('notifications', row => typeof row.date === 'string' || Number.isSafeInteger(row.date)),
      ...Object.values(presetFolders).map(folder => list(folder, row =>
        typeof row.name === 'string' && row.layout && typeof row.layout === 'object' && !Array.isArray(row.layout))),
    ]);
    const profilePrefs = await Promise.all(profiles.filter(({ row }) => typeof row.name === 'string' && row.name).map(async ({ row }) => [row.name, await readJson(preferencePath(row.name))]));
    const { window, ...preferences } = global;
    return {
      ...preferences,
      profiles: profiles.map(({ row }) => row),
      devices: devices.map(({ row }) => row),
      measurements: measurements.map(({ row }) => row),
      notifications,
      profilePreferences: Object.fromEntries(profilePrefs.filter(([, prefs]) => prefs !== undefined)),
      viewPresets: Object.fromEntries(Object.keys(presetFolders).map((key, index) => [key, presets[index]])),
    };
  }

  async function save(state, previous) {
    const changes = new Map();
    async function stage(path, row, before, check = true) {
      const contents = await read(path);
      const current = parse(contents);
      if (equal(current, row)) return;
      if (check && !equal(current, before)) throw conflict();
      changes.set(path, { contents, next: row === undefined ? undefined : JSON.stringify(row, null, 2) + '\n' });
    }

    for (const key of ['profiles', 'devices', 'measurements']) {
      if (state[key] === previous[key]) continue;
      const measurements = key === 'measurements';
      const disk = await records(key, measurements ? 'measures' : key);
      const after = new Map(state[key].filter(row => row.uuid).map(row => [row.uuid, row]));
      const added = new Set(state[key]);
      const used = new Set();
      const byId = new Map(disk.filter(({ row }) => row.uuid).map(file => [file.row.uuid, file]));
      for (const [index, old] of previous[key].entries()) {
        const row = old.uuid ? after.get(old.uuid) : state[key][index];
        added.delete(row);
        if (equal(row, old)) continue;
        const file = old.uuid ? byId.get(old.uuid) : disk.find(item => !used.has(item) && equal(item.row, old));
        if (!file || !equal(file.row, old)) throw conflict();
        used.add(file);
        const path = row && (measurements ? file.path : idPath(key, row.uuid));
        if (path?.toLowerCase() === file.path.toLowerCase()) {
          await stage(file.path, row, parse(file.contents));
        } else {
          if (path) await stage(path, row, undefined);
          await stage(file.path, undefined, parse(file.contents));
        }
      }
      const occupied = new Set();
      if (measurements && added.size) {
        for (const file of disk) {
          // Legacy filenames may represent the same timestamp as a new canonical path.
          try { occupied.add(measurementPath(file.row, state.profiles)); }
          catch (error) { if (!(error instanceof RangeError)) throw error; }
        }
      }
      for (const row of added) {
        const path = measurements ? measurementPath(row, state.profiles) : idPath(key, row.uuid);
        if (occupied.has(path)) throw conflict();
        await stage(path, row, undefined);
        occupied.add(path);
      }
    }

    async function saveItems(folder, before, after) {
      if (before === after) return;
      const old = new Map(before.map(row => [row.id, row]));
      const next = new Map(after.map(row => [row.id, row]));
      for (const id of new Set([...old.keys(), ...next.keys()])) {
        if (!equal(old.get(id), next.get(id))) await stage(idPath(folder, id), next.get(id), old.get(id));
      }
    }
    await saveItems('notifications', previous.notifications, state.notifications);
    for (const [key, folder] of Object.entries(presetFolders)) {
      await saveItems(folder, previous.viewPresets[key], state.viewPresets[key]);
    }
    const before = previous.profilePreferences;
    const after = state.profilePreferences;
    const paths = new Set(state.profiles.filter(row => typeof row.name === 'string').map(row => preferencePath(row.name).toLowerCase()));
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (equal(before[name], after[name])) continue;
      const path = preferencePath(name);
      if (Object.hasOwn(after, name)) {
        // A restored profile can reuse preferences kept after its deletion.
        await stage(path, after[name], before[name], Object.hasOwn(before, name) && await read(path) !== undefined);
      } else if (!paths.has(path.toLowerCase()) && previous.profiles.some(row =>
        row.name === name && state.profiles.some(profile => profile.uuid === row.uuid))) {
        await stage(path, undefined, before[name], false);
      }
    }
    const globalChanges = globalKeys.filter(key => !equal(previous[key], state[key]));
    if (globalChanges.length) {
      const path = 'prefs/global.json';
      const contents = await read(path);
      const global = parse(contents) ?? (await readJson('interface.json')) ?? {};
      for (const key of globalChanges) global[key] = state[key];
      changes.set(path, { contents, next: JSON.stringify(global, null, 2) + '\n' });
    }

    const applied = [];
    try {
      for (const [path, { contents, next }] of changes) {
        if (await read(path) !== contents) throw conflict();
        await writeAtomic(join(root, path), next, contents !== undefined);
        applied.push(path);
      }
    } catch (error) {
      const failures = [];
      for (const path of applied.reverse()) {
        const { contents, next } = changes.get(path);
        try {
          if (await read(path) !== next) throw conflict();
          await writeAtomic(join(root, path), contents, next !== undefined);
        } catch (failure) {
          failures.push(path + ' · ' + failure.message);
        }
      }
      if (failures.length) throw new Error(error.message + ' · Restauration incomplète : ' + failures.join(', '));
      throw error;
    }
  }

  return { load, save };
}
