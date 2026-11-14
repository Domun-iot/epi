'use strict';

const { randomInt } = require('node:crypto');
const { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { listDevices, registerDevice } = require('../cli/devices.cjs');
const { dataDirectory, initializeDataDirectory, profileDirectory, readMeasurements, writeMeasurement } = require('../cli/storage.cjs');
const { historyRecord } = require('../shared/history.cjs');
const { nameKey } = require('../shared/profile-fields.cjs');

function findOrCreateProfile(now) {
  mkdirSync(profileDirectory, { recursive: true });
  for (const file of readdirSync(profileDirectory, { withFileTypes: true })) {
    const match = /^profil-(.+)\.json$/.exec(file.name);
    if (!file.isFile() || !match) continue;
    const profile = JSON.parse(readFileSync(join(profileDirectory, file.name), 'utf8').replace(/^\uFEFF/, ''));
    const name = profile.name || match[1];
    if (nameKey(name) === 'test') return { ...profile, name };
  }

  const birth = new Date(Date.UTC(now.getFullYear() - randomInt(30, 56), randomInt(12), randomInt(1, 29)));
  const profile = {
    name: 'test',
    sex: randomInt(2) === 0 ? 'F' : 'H',
    heightCm: randomInt(160, 191),
    birthDate: birth.toISOString().slice(0, 10),
  };
  writeFileSync(join(profileDirectory, 'profil-test.json'), JSON.stringify(profile, null, 2) + '\n', { flag: 'wx' });
  return profile;
}

function generateMeasurements(now, profile, device) {
  const monthCount = 24;
  const counts = Array(monthCount).fill(1);
  for (let remaining = monthCount; remaining > 0;) {
    const index = randomInt(monthCount);
    if (counts[index] < 8) {
      counts[index]++;
      remaining--;
    }
  }
  const startMonth = now.getMonth() - monthCount + 1;
  const baseline = (profile.heightCm / 100) ** 2 * randomInt(23, 29);
  const trend = randomInt(-50, 51) / 10;
  const impedance = randomInt(420, 611);
  const user = { ...profile, user: profile.name };
  return counts.flatMap((count, index) => {
    const start = +new Date(now.getFullYear(), startMonth + index, 1);
    const end = Math.min(+now, +new Date(now.getFullYear(), startMonth + index + 1, 1));
    return Array.from({ length: count }, () => historyRecord({
      receivedAt: new Date(start + randomInt(Math.max(1, end - start))).toISOString(),
      weight: Math.round((baseline + trend * index / (monthCount - 1) + randomInt(-15, 16) / 10) * 20) / 20,
      unit: 'kg',
      impedanceOhms: impedance + randomInt(-35, 36),
      address: device.bluetooth.address,
      serviceUuid: device.bluetooth.serviceUuid,
      stable: true,
      removed: false,
    }, user, device));
  });
}

function main() {
  initializeDataDirectory();
  const now = new Date();
  const historyExists = readMeasurements().some(row => row.profile?.name && nameKey(row.profile.name) === 'test');
  const devices = listDevices();
  const profile = findOrCreateProfile(now);
  const device = devices[0] ?? registerDevice('test', {
    address: '02:00:00:00:00:01',
    receivedAt: now.toISOString(),
  });
  if (historyExists) {
    console.log('Historique de « ' + profile.name + ' » déjà présent dans ' + dataDirectory + '.');
    return;
  }

  const written = [];
  try {
    for (const record of generateMeasurements(now, profile, device)) {
      written.push(writeMeasurement(record));
    }
  } catch (error) {
    for (const file of written) unlinkSync(file);
    throw error;
  }
  console.log(written.length + ' pesées créées pour « ' + profile.name + ' » avec « ' + device.name + ' » dans ' + dataDirectory + '.');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
