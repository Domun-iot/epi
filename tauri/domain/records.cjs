'use strict';

const { normalize, normalizeBirth, normalizeProfileName, nameKey } = require('../../shared/profile-fields.cjs');

const ADDRESS = /^(?:[\dA-F]{2}(?::[\dA-F]{2}){5}|[\dA-F]{8}(?:-[\dA-F]{4}){3}-[\dA-F]{12})$/i;
const findProfile = (state, name) => typeof name === 'string'
  ? (state.profiles.find(profile => profile.uuid === name)
    ?? state.profiles.find(profile => nameKey(profile.name) === nameKey(name))) : undefined;

function profileFields({ name, sex, heightCm, age, birthDate }) {
  const profile = {
    name: normalizeProfileName(String(name ?? '')),
    sex: normalize('sex', sex),
    heightCm: normalize('heightCm', heightCm),
  };
  if (birthDate && age !== undefined && age !== null && age !== '') {
    throw Error('Choisis une date de naissance ou un âge fixe.');
  }
  if (birthDate) profile.birthDate = normalizeBirth(birthDate);
  else profile.age = normalize('age', age);
  return profile;
}

function measurementKey(row) {
  const { weight, unit, impedanceOhms } = row.measures ?? row;
  return JSON.stringify([
    row.profile?.name ? nameKey(row.profile.name) : null, row.receivedAt,
    row.reception?.bluetooth?.address ?? row.device?.bluetooth?.address ?? null,
    row.reception?.bluetooth?.serviceUuid ?? row.device?.bluetooth?.serviceUuid ?? null,
    weight, unit, impedanceOhms,
  ]);
}

function measurementSlot(row, profiles) {
  const name = row.profile?.name;
  const profile = row.profile?.uuid ?? row.profileUuid ?? (name && findProfile({ profiles }, name)?.uuid);
  return JSON.stringify([profile ?? (name ? nameKey(name) : null), Date.parse(row.receivedAt)]);
}

function appendUnique(existing, imported, key) {
  const keys = new Set(existing.map(key));
  const uuids = new Set(existing.map(row => row.uuid).filter(Boolean));
  return [...existing, ...imported.filter(row => {
    const id = key(row);
    if (keys.has(id) || (row.uuid && uuids.has(row.uuid))) return false;
    keys.add(id);
    if (row.uuid) uuids.add(row.uuid);
    return true;
  })];
}

function mergeLegacy(state, snapshot) {
  const profiles = (snapshot.profiles ?? []).map(row => ({
    ...profileFields(row),
    ...(row.uuid && { uuid: row.uuid }),
    ...(row.createdAt && { createdAt: row.createdAt }),
    ...(row.updatedAt && { updatedAt: row.updatedAt }),
  }));
  const devices = (snapshot.devices ?? []).map(record => {
    const address = record?.bluetooth?.address;
    if (typeof record?.name !== 'string' || !ADDRESS.test(address)) {
      throw Error('Fiche Bluetooth importée invalide.');
    }
    return { ...record, bluetooth: { ...record.bluetooth, address: address.toUpperCase() } };
  });
  const measurements = (snapshot.measurements ?? []).map(row => {
    const measures = row?.measures ?? row;
    if (!Number.isFinite(Date.parse(row?.receivedAt)) || !(measures?.weight > 0)
        || !['kg', 'lb'].includes(measures.unit)) throw Error('Pesée importée invalide.');
    return row;
  });
  state.profiles = appendUnique(state.profiles, profiles, row => nameKey(row.name));
  state.devices = appendUnique(state.devices, devices, row => row.bluetooth.address);
  state.measurements = appendUnique(state.measurements, measurements, row => measurementSlot(row, state.profiles));
}

module.exports = { ADDRESS, findProfile, profileFields, mergeLegacy, measurementKey, measurementSlot };
