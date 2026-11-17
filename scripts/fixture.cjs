'use strict';

const { randomInt, randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { relative } = require('node:path');
const { readOptional, saveChanges, serialize } = require('../shared/transactions.cjs');
const { listProfileFiles } = require('../cli/record-files.cjs');
const { listDevices, registerDevice } = require('../cli/devices.cjs');
const { dataDirectory, initializeDataDirectory, profileDirectory, readMeasurements, writeMeasurement, withActiveDataset } = require('../cli/storage.cjs');
const { historyRecord } = require('../shared/history.cjs');
const { nameKey } = require('../shared/profile-fields.cjs');

function findOrCreateProfile(now) {
  mkdirSync(profileDirectory, { recursive: true });
  const existing = listProfileFiles(profileDirectory).find(({ record }) => nameKey(record.name) === 'test');
  if (existing) return existing.record;

  const birth = new Date(Date.UTC(now.getFullYear() - randomInt(30, 56), randomInt(12), randomInt(1, 29)));
  const profile = {
    name: 'test',
    uuid: randomUUID(),
    sex: randomInt(2) === 0 ? 'F' : 'H',
    heightCm: randomInt(160, 191),
    birthDate: birth.toISOString().slice(0, 10),
  };
  saveChanges(dataDirectory, [{ path: 'profiles/' + profile.uuid + '.json', after: serialize(profile) }]);
  return profile;
}

function generateMeasurements(now, profile, device) {
  const monthCount = 24;
  const dietStartIndex = monthCount - 6;
  const reboundMonths = [dietStartIndex + 1, dietStartIndex + 3];
  const counts = Array(monthCount).fill(1);
  for (const index of reboundMonths) counts[index]++;
  for (let remaining = monthCount - reboundMonths.length; remaining > 0;) {
    const index = randomInt(monthCount);
    if (counts[index] < 8) {
      counts[index]++;
      remaining--;
    }
  }
  const startMonth = now.getMonth() - monthCount + 1;
  const baseline = (profile.heightCm / 100) ** 2 * randomInt(23, 29);
  const trend = randomInt(-50, 51) / 10;
  const dietStart = +new Date(now.getFullYear(), startMonth + dietStartIndex, 1);
  const dietStartWeight = baseline + trend;
  const impedance = randomInt(420, 611);
  const user = { ...profile, user: profile.name };
  return counts.flatMap((count, index) => {
    const start = +new Date(now.getFullYear(), startMonth + index, 1);
    const end = Math.min(+now, +new Date(now.getFullYear(), startMonth + index + 1, 1));
    const dates = Array.from({ length: count }, () => start + randomInt(Math.max(1, end - start)))
      .sort((a, b) => a - b);
    if (index === dietStartIndex) dates[0] = dietStart;
    if (index === monthCount - 1) dates[count - 1] = +now;

    const hasRebound = reboundMonths.includes(index);
    // The first two weigh-ins in these months are close enough to show a temporary gain.
    if (hasRebound) dates[1] = Math.min(dates[1], dates[0] + 12 * 60 * 60 * 1000);

    return dates.map((date, position) => {
      let weight = baseline + trend * index / dietStartIndex + randomInt(-15, 16) / 10;
      if (date >= dietStart) {
        const progress = (date - dietStart) / (+now - dietStart);
        let variation = randomInt(-35, 36) / 100;
        if (hasRebound && position === 0) variation = -0.2;
        if (hasRebound && position === 1) variation = 0.2;
        if (date === dietStart || date === +now) variation = 0;
        weight = dietStartWeight * (1 - 0.1 * progress) + variation;
      }
      return historyRecord({
        receivedAt: new Date(date).toISOString(),
        weight: Math.round(weight * 20) / 20,
        unit: 'kg',
        impedanceOhms: impedance + randomInt(-35, 36),
        address: device.bluetooth.address,
        serviceUuid: device.bluetooth.serviceUuid,
        stable: true,
        removed: false,
      }, user, device);
    });
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
      const path = writeMeasurement(record);
      if (path) written.push(path);
    }
  } catch (error) {
    saveChanges(dataDirectory, written.flatMap(file => {
      const before = readOptional(file);
      return before === undefined ? [] : [{ path: relative(dataDirectory, file).replaceAll('\\', '/'), before }];
    }));
    throw error;
  }
  console.log(written.length + ' pesées créées pour « ' + profile.name + ' » avec « ' + device.name + ' » dans ' + dataDirectory + '.');
}

try {
  withActiveDataset(main);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
