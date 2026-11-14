'use strict';

const { calculateComposition } = require('./composition.cjs');

const { profileAt, nameKey } = require('./profile-fields.cjs');
const { decode } = require('./scale.cjs');

const services = require('./bluetooth-services.json');

function receptionRecord({ hex, address, rssi, stable, removed, scaleTime, serviceUuid = hex ? '0x181B' : null }) {
  const decoded = hex && serviceUuid === '0x181B' ? decode(hex) : null;
  return {
    raw: hex ? { hex } : null,
    bluetooth: { serviceUuid, service: services[serviceUuid] ?? null, address: address ?? null, rssiDbm: rssi ?? null },
    scale: {
      stable: stable ?? decoded?.stable ?? null,
      removed: removed ?? decoded?.removed ?? null,
      scaleTime: scaleTime ?? decoded?.scaleTime ?? null,
    },
  };
}

function historyRecord(event, profile, device = null) {
  const { receivedAt, weight, unit, impedanceOhms } = event;
  profile = profileAt(profile, receivedAt);
  return {
    receivedAt,
    profile: profile ? {
      name: profile.user ?? null, sex: profile.sex, age: profile.age, heightCm: profile.heightCm,
      ...(profile.birthDate ? { birthDate: profile.birthDate } : {}),
    } : null,
    device,
    measures: { weight, unit, impedanceOhms },
    calculations: profile ? calculateComposition({ weight, unit, impedanceOhms }, profile).methods : null,
    reception: receptionRecord(event),
  };
}

function bufferHistory(save, waitMs = 15000) {
  let first;
  let timer;
  let done = false;
  const key = event => JSON.stringify([event.address, event.serviceUuid, event.scaleTime, event.weight, event.unit]);
  const finish = event => {
    done = true;
    clearTimeout(timer);
    save(event);
  };

  return event => {
    if (done) return;
    if (first && key(first) !== key(event)) return;
    if (event.serviceUuid === '0x181D' || event.impedanceOhms > 0) {
      finish(event);
    } else if (!first) {
      first = event;
      timer = setTimeout(() => finish(first), waitMs);
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
    const key = nameKey(name);
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
    const last = latest.get(nameKey(profile.name));
    if (!last) continue;
    const distance = Math.abs(kg(event) / kg(last) - 1);
    if (distance <= 0.10 + Number.EPSILON && distance < closest) {
      best = profile;
      closest = distance;
    }
  }
  return best;
}

module.exports = { receptionRecord, historyRecord, bufferHistory, latestWeights, matchWeight };
