'use strict';

const { calculateComposition } = require('./composition.cjs');

const { profileAt, nameKey } = require('./profile-fields.cjs');
const { decodeMeasurement, defaultServiceUuid, isCompleteMeasurement, mergeMeasurement } = require('./scales/adapter.js');
const { creationDate } = require('./record-version.cjs');

const services = require('./bluetooth-services.json');

function receptionRecord({ hex, address, rssi, stable, removed, scaleTime,
  serviceUuid = hex ? defaultServiceUuid : null, manufacturerId, protocol, scaleUserId }, model) {
  // Older Xiaomi records can carry the raw advertisement without decoded reception fields.
  const decoded = hex && serviceUuid === defaultServiceUuid ? decodeMeasurement(hex, { serviceUuid, model }) : null;
  return {
    raw: hex ? { hex } : null,
    bluetooth: { serviceUuid, service: services[serviceUuid] ?? null, address: address ?? null, rssiDbm: rssi ?? null,
      ...(manufacturerId && { manufacturerId }), ...(protocol && { protocol }) },
    scale: {
      stable: stable ?? decoded?.stable ?? null,
      removed: removed ?? decoded?.removed ?? null,
      scaleTime: scaleTime ?? decoded?.scaleTime ?? null,
      ...(scaleUserId !== undefined && { userId: scaleUserId }),
    },
  };
}

function historyRecord(event, profile, device = null) {
  const { receivedAt, weight, unit, impedanceOhms, deviceMetrics } = event;
  profile = profileAt(profile, receivedAt);
  return {
    uuid: globalThis.crypto.randomUUID(),
    receivedAt,
    createdAt: receivedAt,
    profile: profile ? {
      uuid: profile.uuid ?? null, name: profile.user ?? null, sex: profile.sex, age: profile.age,
      ageAtWeighIn: profile.age, heightCm: profile.heightCm,
      ...(profile.birthDate ? { birthDate: profile.birthDate } : {}),
    } : null,
    device,
    measures: { weight, unit, impedanceOhms, ...(deviceMetrics && { deviceMetrics }) },
    calculations: profile ? calculateComposition({ weight, unit, impedanceOhms }, profile).methods : null,
    reception: receptionRecord(event, device?.bluetooth?.model),
  };
}

function upgradeMeasurement(row, profileUuid, deviceUuid, uuid) {
  const { profileUuid: oldProfile, deviceUuid: oldDevice, updatedAt, ...data } = row;
  const createdAt = creationDate(row);
  function snapshot(key, legacy, fallback) {
    const saved = row[key];
    const id = saved && Object.hasOwn(saved, 'uuid') ? saved.uuid
      : legacy !== undefined ? legacy : fallback ?? null;
    if (saved?.uuid === id || (!saved && id == null)) return saved;
    return { ...saved, uuid: id };
  }
  const profile = snapshot('profile', oldProfile, profileUuid);
  const device = snapshot('device', oldDevice, deviceUuid);
  if (row.uuid && !Object.hasOwn(row, 'profileUuid') && !Object.hasOwn(row, 'deviceUuid')
      && row.createdAt === createdAt && !Object.hasOwn(row, 'updatedAt')
      && profile === row.profile && device === row.device) return row;
  return { ...data, uuid: row.uuid ?? uuid ?? globalThis.crypto.randomUUID(),
    ...(createdAt && { createdAt }),
    ...(profile !== undefined && { profile }), ...(device !== undefined && { device }) };
}

function bufferHistory(save, waitMs = 15000) {
  let first;
  let timer;
  let done = false;
  const key = event => JSON.stringify([event.address, event.protocol ?? event.serviceUuid, event.scaleTime, event.scaleUserId, event.weight, event.unit]);
  const finish = event => {
    done = true;
    clearTimeout(timer);
    save(event);
  };

  return event => {
    if (done) return;
    if (first && key(first) !== key(event)) return;
    if (isCompleteMeasurement(event)) {
      finish(first ? mergeMeasurement(first, event) : event);
    } else if (!first) {
      first = event;
      timer = setTimeout(() => finish(first), waitMs);
    } else {
      first = mergeMeasurement(first, event);
    }
  };
}

function kg(event) {
  const { weight, unit } = event.measures ?? event;
  return unit === 'lb' ? weight * 0.45359237 : weight;
}

function latestWeights(rows) {
  const latest = new Map();
  for (const row of rows) {
    const name = row.profile?.name;
    if (!name || !(kg(row) > 0) || !Number.isFinite(Date.parse(row.receivedAt))) continue;
    const key = row.profile?.uuid ?? nameKey(name);
    if (!latest.has(key) || Date.parse(row.receivedAt) >= Date.parse(latest.get(key).receivedAt)) {
      latest.set(key, row);
    }
  }
  return latest;
}

function matchWeight(event, profiles, latest) {
  let best;
  let closest = Infinity;
  for (const profile of profiles) {
    const last = latest.get(profile.uuid) ?? latest.get(nameKey(profile.name));
    if (!last) continue;
    const distance = Math.abs(kg(event) / kg(last) - 1);
    if (distance <= 0.10 + Number.EPSILON && distance < closest) {
      best = profile;
      closest = distance;
    }
  }
  return best;
}

module.exports = { receptionRecord, historyRecord, upgradeMeasurement, bufferHistory, kg, latestWeights, matchWeight };
