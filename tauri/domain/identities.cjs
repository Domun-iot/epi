'use strict';

const { nameKey } = require('../../shared/profile-fields.cjs');
const { upgradeMeasurement } = require('../../shared/history.cjs');
const { measurementKey } = require('./records.cjs');

const uuid = () => globalThis.crypto.randomUUID();
const identify = row => row.uuid ? row : { ...row, uuid: uuid() };

function updateRows(state, key, update) {
  const before = state[key];
  const after = before.map(update);
  if (after.some((row, index) => row !== before[index])) state[key] = after;
}

function receiptKey(event) {
  return JSON.stringify([event.receivedAt, event.address, event.weight, event.unit, event.hex ?? null]);
}

function upgradeIdentities(state) {
  updateRows(state, 'profiles', identify);
  updateRows(state, 'devices', identify);
  const profiles = new Map(state.profiles.map(row => [nameKey(row.name), row.uuid]));
  const devices = new Map(state.devices.map(row => [row.bluetooth.address, row.uuid]));

  const enrichMeasurement = (row, archivedProfile, canonical) => {
    const profile = canonical?.profile?.uuid ?? archivedProfile
      ?? (row.profile?.name && profiles.get(nameKey(row.profile.name)));
    const address = row.device?.bluetooth?.address ?? row.reception?.bluetooth?.address;
    const device = canonical?.device?.uuid ?? devices.get(address);
    return upgradeMeasurement(row, profile, device, canonical?.uuid);
  };

  updateRows(state, 'measurements', row => enrichMeasurement(row));
  const known = new Map();
  const measurementsByUuid = new Map();
  function remember(row) {
    measurementsByUuid.set(row.uuid, row);
    const key = measurementKey(row);
    if (!known.has(key)) known.set(key, row);
    else if (known.get(key)?.uuid !== row.uuid) known.set(key, null);
  }
  for (const row of state.measurements) remember(row);
  function archivedMeasurement(row, profileUuid) {
    const key = measurementKey(row);
    const canonical = !row.uuid && known.get(key);
    const identified = enrichMeasurement(row, profileUuid, canonical);
    remember(identified);
    return identified;
  }

  updateRows(state, 'notifications', entry => {
    if (!entry.action || !entry.record) return entry;
    const record = entry.type === 'measurement' ? archivedMeasurement(entry.record)
      : ['profile', 'device'].includes(entry.type) ? identify(entry.record) : entry.record;
    const measurements = entry.measurements?.map(row => archivedMeasurement(row, record.uuid));
    if (record === entry.record && !measurements?.some((row, index) => row !== entry.measurements[index])) return entry;
    return { ...entry, record, ...(measurements && { measurements }) };
  });

  // Old receipts and receipts replayed after deletion may lack a direct link.
  // Repair it only when the frame identifies a single measurement.
  const receipts = new Map();
  for (const row of measurementsByUuid.values()) {
    const key = receiptKey({ ...(row.measures ?? row), receivedAt: row.receivedAt,
      address: row.reception?.bluetooth?.address ?? row.device?.bluetooth?.address,
      hex: row.reception?.raw?.hex });
    if (!receipts.has(key)) receipts.set(key, row);
    else if (receipts.get(key)?.uuid !== row.uuid) receipts.set(key, null);
  }
  updateRows(state, 'notifications', entry => {
    if (entry.type !== 'pending' || !entry.record?.event || entry.measurementUuid) return entry;
    const { event, device } = entry.record;
    const pendingId = entry.pendingId ?? entry.id;
    const pending = state.pending.find(row => row.id === pendingId);
    const linked = !pending && receipts.get(receiptKey(event));
    if (!linked && Object.hasOwn(entry, 'measurementUuid')) return entry;
    return { ...entry, pendingId,
      deviceUuid: linked?.device?.uuid ?? device?.uuid ?? devices.get(event.address) ?? null,
      profileUuid: linked?.profile?.uuid ?? null, measurementUuid: linked?.uuid ?? null,
      ...(linked && { text: 'Pesée enregistrée.' }),
      record: { ...entry.record, bluetoothMetadata: entry.record.bluetoothMetadata ?? pending?.bluetoothMetadata ?? null } };
  });
}

module.exports = { uuid, identify, upgradeIdentities };
