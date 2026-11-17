'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('./session.cjs');

const start = Date.parse('2026-10-01T09:00:00Z');
const address = 'AA:BB:CC:DD:EE:FF';
const otherAddress = '11:22:33:44:55:66';
const xiaomi = (hex, source = 'AABBCCDDEEFF') => source + ' -58 181B ' + hex;
const full = '0226e40709060d2605e9015a37';
const weightOnly = '0224e40709060d260500005a37';
const removed = '02a6e40709060d2605e9015a37';
const indicating = '112233445566 -68 181D 00803e Gatt ';
const lou = { name: 'Lou', sex: 'F', birthDate: '1990-02-12', heightCm: 170 };
const sam = { name: 'Sam', sex: 'H', age: 37, heightCm: 177 };
const device = { name: 'Cuisine', bluetooth: { address, serviceUuid: '0x181B' } };
const prior = { receivedAt: '2026-09-28T09:00:00.000Z', profile: { name: 'Lou' },
  measures: { weight: 70.15, unit: 'kg', impedanceOhms: null }, calculations: { IMC: { bmi: 24 } } };

function fixture(seed, options) {
  let disk = structuredClone(seed);
  const session = createSession({
    storage: {
      load: async () => structuredClone(disk),
      save: async snapshot => { disk = structuredClone(snapshot); },
    },
    ...options,
  });
  return { session, disk: () => disk };
}

test('keeps the manual selection on reopen and edits profile details without changing history', async () => {
  const { session, disk } = fixture({ profiles: [lou, sam], selectedProfile: 'Sam', measurements: [prior] });
  const initial = await session.load();
  assert.equal(initial.selectedProfile, 'Sam');
  await assert.rejects(session.saveProfile({ ...lou, name: 'Lóu' }), /déjà utilisé/);
  await session.saveProfile({ ...lou, editName: 'Lou', birthDate: '', age: 42, heightCm: '171,5' });
  const selected = await session.selectProfile('LOU');
  assert.equal(selected.selectedProfile, 'Lou');
  assert.deepEqual(selected.measurements, initial.measurements);
  assert.equal(selected.measurements[0].profile.uuid, initial.profiles[0].uuid);
  const { updatedAt, createdAt, ...edited } = selected.profiles[0];
  assert.ok(createdAt <= updatedAt);
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.deepEqual(edited, { name: 'Lou', sex: 'F', heightCm: 171.5, age: 42, uuid: initial.profiles[0].uuid });
  await session.setColumnPreference('Lou', 'fatPercent', 'columns', true);
  await session.setColumnPreference('Lou', 'fatPercent', 'splitColumns', true);
  const other = await session.selectProfile('Sam');
  assert.deepEqual(other.columns, ['bmi']);
  assert.deepEqual(other.splitColumns, []);
  await session.setColumnPreference('Sam', 'bmi', 'columns', false);
  assert.deepEqual((await session.selectProfile('Lou')).splitColumns, ['fatPercent']);
  const reopened = await fixture(disk()).session.load();
  assert.equal(reopened.selectedProfile, 'Lou');
  assert.deepEqual(reopened.columns, ['bmi', 'fatPercent']);
  assert.deepEqual(reopened.splitColumns, ['fatPercent']);
});

test('shares the full chart configuration and restores personal preferences by profile and view', async () => {
  const { session, disk } = fixture({ profiles: [lou, sam], selectedProfile: 'Lou' });
  const modified = state => state.viewLayouts.measurements.modified;
  assert.equal(modified(await session.load()), false);
  assert.equal(modified(await session.setMeasurementDisplay('Lou', 'chart', null)), true);
  const created = await session.changeViewPreset('Lou', 'measurements', 'create', { name: 'Composition' });
  const id = created.viewLayouts.measurements.preset.id;
  assert.match(id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
  assert.equal(created.measurementDisplay, 'chart');
  assert.equal(modified(created), false);

  await session.selectProfile('Sam');
  assert.equal(modified(await session.changeViewPreset('Sam', 'measurements', 'select', { id })), false);
  assert.equal(modified(await session.setChartOptions('Sam', id, { mode: 'raw' })), true);
  assert.equal(modified(await session.setChartOptions('Sam', id, { mode: 'smooth' })), false);
  await session.setMeasurementDisplay('Sam', 'table', id);
  await session.selectProfile('Lou');
  await session.setColumnPreference('Lou', 'impedanceOhms', 'columns', true);
  await Promise.all([
    session.cycleChartSeries('Lou', id, 'bmi'),
    session.cycleChartSeries('Lou', id, 'bmi'),
  ]);
  const range = [Date.parse('2026-01-01'), Date.parse('2026-01-07')];
  await Promise.all([
    session.setChartOptions('Lou', id, { mode: 'raw', period: '90' }),
    session.setChartOptions('Lou', id, { range }),
  ]);
  const renamed = await session.changeViewPreset('Lou', 'measurements', 'rename', { id, name: 'Corps' });
  assert.equal(renamed.viewLayouts.measurements.preset.id, id);
  assert.equal(modified(renamed), true);
  const shared = await session.changeViewPreset('Lou', 'measurements', 'save', { id, name: 'Corps' });
  assert.equal(modified(shared), false);
  assert.deepEqual(shared.chartLastRange, range);
  assert.deepEqual(shared.chartOptions.range, range);
  assert.equal(Object.hasOwn(shared.viewLayouts.measurements.preset.chart.options, 'range'), false);
  assert.deepEqual(shared.chartSeries, { weight: 'visible', impedanceOhms: 'visible', bmi: 'hidden' });

  const reopened = fixture(disk()).session;
  assert.equal(modified(await reopened.load()), false);
  const replacement = [range[0], range[1] + 86400000];
  await reopened.setChartOptions('Lou', id, { range: replacement });
  await reopened.setChartOptions('Lou', id, { period: '90' });
  const otherView = await reopened.changeViewPreset('Lou', 'measurements', 'select');
  assert.equal(otherView.chartLastRange, undefined);
  const restoredView = await reopened.changeViewPreset('Lou', 'measurements', 'select', { id });
  assert.deepEqual(restoredView.chartLastRange, replacement);
  assert.equal(restoredView.chartOptions.range, undefined);
  const personal = await reopened.selectProfile('Sam');
  assert.equal(personal.measurementDisplay, 'table');
  assert.deepEqual(personal.columns, ['bmi']);
  assert.equal(modified(personal), true);
  const defaultView = await reopened.changeViewPreset('Sam', 'measurements', 'select');
  assert.ok(defaultView.viewLayouts.measurements.modifiedInactiveIds.includes(id));
  const switchedBack = await reopened.changeViewPreset('Sam', 'measurements', 'select', { id });
  assert.equal(switchedBack.measurementDisplay, 'table');
  assert.equal(modified(switchedBack), true);
  const reset = await reopened.changeViewPreset('Sam', 'measurements', 'reset', { id });
  assert.equal(modified(reset), false);
  assert.deepEqual(reset.chartOptions, { display: 'chart', mode: 'raw', period: '90' });
  assert.equal(reset.chartLastRange, undefined);
  assert.deepEqual(reset.chartSeries, shared.chartSeries);
  assert.deepEqual(reset.columns, ['bmi', 'impedanceOhms']);

  await reopened.selectProfile(null);
  const inherited = await reopened.changeViewPreset(null, 'measurements', 'select', { id });
  assert.equal(modified(inherited), false);
  assert.deepEqual(inherited.chartOptions, reset.chartOptions);
  assert.deepEqual(inherited.chartSeries, reset.chartSeries);
  assert.deepEqual(inherited.columns, reset.columns);
});

test('restores existing chart preferences from older versions', async () => {
  const range = [Date.parse('2026-01-01'), Date.parse('2026-01-07')];
  const viewPresets = { measurements: [{ id: 'old', name: 'Ancienne vue', layout: {},
    chart: { options: { display: 'chart', period: '90', range } } }], details: [] };
  const { session, disk } = fixture({ profiles: [lou], selectedProfile: 'Lou', viewPresets, profilePreferences: { Lou: {
    measurementDisplay: 'chart',
    chartOptionsByView: { default: { mode: 'raw', range } },
    chartSeriesByView: { default: { weight: 'visible', bmi: 'hidden' } },
  } } });
  const loaded = await session.load();
  assert.equal(loaded.viewLayouts.measurements.modified, true);
  assert.deepEqual(loaded.chartOptions, { display: 'chart', mode: 'raw', period: 'all', range });
  assert.deepEqual(loaded.chartSeries, { weight: 'visible', bmi: 'hidden' });
  await session.setChartOptions('Lou', null, { period: '30' });
  const reopened = await fixture(disk()).session.load();
  assert.deepEqual(reopened.chartOptions, { display: 'chart', mode: 'raw', period: '30' });
  assert.deepEqual(reopened.chartLastRange, range);
  assert.deepEqual(reopened.chartSeries, loaded.chartSeries);
  assert.deepEqual(disk().viewPresets.measurements[0].chart.options, { display: 'chart', period: '90' });
});

test('settles parallel readings, replaces weight-only with impedance, and switches profile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, disk } = fixture({ profiles: [lou, sam], devices: [device],
    measurements: [prior], selectedProfile: 'Sam' });
  const snapshots = [];
  session.subscribe(snapshot => snapshots.push(snapshot));
  await session.ingest(xiaomi(weightOnly), start);
  const second = await session.ingest(indicating, start + 1);
  assert.equal(second.pending[0].event.address, otherAddress);
  assert.equal(second.selectedProfile, 'Sam');
  const settled = await session.ingest(xiaomi(full), start + 2);
  assert.equal(settled.selectedProfile, 'Lou');
  const reading = settled.measurements.at(-1);
  assert.equal(reading.measures.impedanceOhms, 489);
  assert.equal(reading.reception.raw.hex, full);
  assert.equal(reading.profile.age, 36);
  assert.ok(reading.calculations['Sun*'].leanKg > 0);
  assert.deepEqual(disk().measurements, settled.measurements);
  assert.equal(snapshots.at(-1), settled);
  await session.ingest(xiaomi(weightOnly), start + 3);
  await session.ingest(xiaomi(full), start + 4);
  await session.ingest(xiaomi(removed), start + 5);
  t.mock.timers.tick(15_000);
  assert.equal((await session.load()).measurements.length, 2);
});

test('expires a weight-only reading and publishes the saved result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = fixture({ profiles: [lou], devices: [device], measurements: [prior] });
  let current;
  session.subscribe(state => { current = state; });
  await session.ingest(xiaomi(weightOnly), start);
  t.mock.timers.tick(14_999);
  assert.equal((await session.load()).measurements.length, 1);
  t.mock.timers.tick(1);
  const state = await session.load();
  assert.equal(state.measurements.length, 2);
  assert.equal(current.measurements.at(-1).measures.impedanceOhms, null);
  assert.equal(current.selectedProfile, 'Lou');
});

test('registers captured device information, refreshes it only through Bluetooth, and confirms a new profile', async () => {
  const { session, disk } = fixture();
  const waiting = await session.ingest(xiaomi(full), start);
  await session.ingest('META AABBCCDDEEFF TUlCRlM= 0157', start + 1);
  const [{ id, reason }] = waiting.pending;
  assert.equal(reason, 'device');
  const { profiles: [created] } = await session.saveProfile(sam);
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
  assert.equal(created.updatedAt, undefined);
  await assert.rejects(session.confirmProfile({ id, name: 'Sam' }), /balance/);

  const reopened = fixture(disk()).session;
  const enrolled = await reopened.beginDevice({ name: 'Cuisine', address });
  assert.equal(enrolled.devices[0].bluetooth.model, 'XMTZC05HM');
  assert.equal(enrolled.devices[0].updatedAt, undefined);
  assert.equal(enrolled.pending[0].reason, 'profile');
  await reopened.beginDevice({ address, name: 'Salon', bluetooth: { model: 'Saisi' } });
  const ignored = await reopened.ingest(indicating, start + 2);
  assert.equal(ignored.enrollment.name, 'Salon');
  const refreshed = await reopened.ingest(xiaomi(full) + ' Advertisement TUlCRlM=', start + 3);
  assert.equal(refreshed.enrollment, null);
  assert.equal(refreshed.devices[0].name, 'Salon');
  assert.equal(refreshed.devices[0].registeredAt, enrolled.devices[0].registeredAt);
  const { updatedAt } = refreshed.devices[0];
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.equal(refreshed.devices[0].bluetooth.model, 'XMTZC05HM');
  const confirmed = await reopened.confirmProfile({ id, name: 'Sam' });
  assert.equal(confirmed.selectedProfile, 'Sam');
  assert.equal(confirmed.measurements[0].device.name, 'Salon');
});

test('can filter acquisition, enroll a separate balance, and compute an anonymous reading', async () => {
  const { session } = fixture({ profiles: [lou], selectedProfile: 'Lou' });
  await session.setAddressFilter(address);
  assert.equal((await session.ingest(indicating, start)).pending.length, 0);
  await session.beginDevice({ name: 'Standard' });
  const state = await session.ingest(indicating, start + 1);
  assert.equal(state.devices[0].bluetooth.address, otherAddress);
  const next = await session.confirmProfile({ id: state.pending[0].id, name: null,
    profile: { sex: 'F', heightCm: 162, age: 29 } });
  assert.equal(next.selectedProfile, 'Lou');
  assert.equal(next.measurements[0].profile.name, null);
  assert.ok(next.measurements[0].calculations.IMC.bmi > 0);
  assert.equal(next.profiles.length, 1);
});

test('enrolls a manufacturer-advertisement scale and keeps its reception without a service id', async () => {
  const { session } = fixture();
  const initial = await session.beginDevice({ name: 'PICOOC' });
  assert.ok(initial.enrollment);
  const frame = 'PAYLOAD D049004B4F1E -50 Manufacturer 49D0 14 004B4F1E391F0676136087200040 UElDT09DLUw=';
  const observed = await session.ingest(frame, start);
  assert.equal(observed.devices[0].bluetooth.model, 'Mini Lite');
  assert.equal(observed.devices[0].bluetooth.serviceUuid, null);
  const assigned = await session.confirmProfile({ id: observed.pending[0].id, name: null });
  const [row] = assigned.measurements;
  assert.deepEqual(row.measures, { weight: 82.7, unit: 'kg', impedanceOhms: 496 });
  assert.equal(row.reception.bluetooth.manufacturerId, '0x49D0');
  assert.equal(row.reception.bluetooth.protocol, 'picooc-mini-lite');
  assert.equal(row.reception.raw.hex, '004b4f1e391f0676136087200040');
  const repeated = await session.ingest(frame, start + 400);
  assert.equal(repeated.measurements.length, 1);
});

test('persists the scale-reported WSS measurements separately from estimates', async () => {
  const { session } = fixture();
  await session.beginDevice({ name: 'Standard' });
  const observed = await session.ingest('112233445566 -68 181D 0e803eea070b100b0c0d02e600d606 Gatt ', start);
  const assigned = await session.confirmProfile({ id: observed.pending[0].id, name: null });
  const [row] = assigned.measurements;
  assert.equal(row.measures.weight, 80);
  assert.deepEqual(row.measures.deviceMetrics, { bmi: 23, heightCm: 175 });
  assert.equal(row.reception.scale.scaleTime, '2026-11-16T11:12:13');
  assert.equal(row.reception.scale.userId, 2);
  assert.equal(row.calculations, null);
});

test('merges a legacy archive idempotently and preserves historical calculated values', async () => {
  const { session } = fixture();
  const imported = { profiles: [lou], devices: [device], measurements: [prior] };
  const first = await session.importLegacy(imported);
  await session.saveProfile({ ...lou, editName: 'Lou', heightCm: 173 });
  const second = await session.importLegacy({ ...imported, profiles: [{ ...lou, name: 'Loú' }] });
  assert.equal(second.profiles.length, 1);
  assert.equal(second.profiles[0].heightCm, 173);
  assert.deepEqual(second.devices, first.devices);
  assert.deepEqual(second.measurements, first.measurements);
  assert.deepEqual(second.measurements[0].calculations, prior.calculations);
  assert.equal(first.measurements[0].profile.uuid, second.profiles[0].uuid);
});

test('preserves UUID identifiers and unknown signal strength', async () => {
  const { session } = fixture();
  const id = '12345678-9012-4356-A123-789012345678';
  await session.beginDevice({ name: 'Mobile', address: id });
  const state = await session.ingest(id + ' - 181D 00803e Gatt ', start);
  assert.equal(state.devices[0].bluetooth.address, id);
  const assigned = await session.confirmProfile({ id: state.pending[0].id, name: null });
  assert.equal(assigned.measurements[0].reception.bluetooth.rssiDbm, null);
  assert.equal(assigned.measurements[0].profile, null);
});

test('reloads external updates while leaving live enrollment in place', async () => {
  let snapshot = { profiles: [lou], selectedProfile: 'Lou' };
  const session = createSession({ storage: {
    load: async () => snapshot,
    save: async next => { snapshot = next; },
  } });
  await session.beginDevice({ name: 'Salle' });
  snapshot = { ...snapshot, profiles: [lou, sam] };
  const state = await session.reload();
  assert.equal(state.profiles.length, 2);
  assert.equal(state.selectedProfile, 'Lou');
  assert.equal(state.enrollment.name, 'Salle');
});

test('reload keeps the more recent version and accepts external deletions', async () => {
  const uuid = 'a2788c87-ab0a-44f7-aeea-6e3d37442ae7';
  const created = { ...lou, uuid, createdAt: '2026-04-01T09:00:00.000Z' };
  const latest = { ...created, heightCm: 173, updatedAt: '2026-06-01T09:00:00.000Z' };
  const { session, disk } = fixture({ profiles: [latest], selectedProfile: 'Lou' });
  await session.load();
  disk().profiles = [created];
  assert.deepEqual((await session.reload()).profiles, [latest]);
  assert.deepEqual(disk().profiles, [latest]);
  const external = { ...latest, heightCm: 175, updatedAt: '2026-07-01T09:00:00.000Z' };
  disk().profiles = [external];
  assert.deepEqual((await session.reload()).profiles, [external]);
  disk().profiles = [];
  assert.deepEqual((await session.reload()).profiles, []);
});

test('dates a creation and only records real updates', async () => {
  const { session } = fixture();
  const [created] = (await session.saveProfile(lou)).profiles;
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
  assert.equal(Object.hasOwn(created, 'updatedAt'), false);
  const [unchanged] = (await session.saveProfile({ ...lou, editName: lou.name })).profiles;
  assert.deepEqual(unchanged, created);
  const [updated] = (await session.saveProfile({ ...lou, editName: lou.name, heightCm: 175 })).profiles;
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.createdAt);
});

test('serializes writes and leaves published state unchanged if persistence rejects', async () => {
  let breakSave = true;
  const session = createSession({ storage: {
    load: async () => null,
    save: async () => {
      if (breakSave) throw Error('Disque indisponible');
    },
  } });
  const states = [];
  session.subscribe(state => states.push(state));
  await assert.rejects(session.saveProfile(lou), /Disque/);
  assert.deepEqual((await session.load()).profiles, []);
  assert.equal(states.length, 0);
  breakSave = false;
  await Promise.all([session.saveProfile(lou), session.saveProfile(sam), session.selectProfile('Sam')]);
  assert.equal(states.at(-1).selectedProfile, 'Sam');
  assert.equal(states.at(-1).profiles.length, 2);
});

test('keeps seven days plus the newest twenty and persists explicitly removed entries', async () => {
  const now = Date.now();
  const notifications = Array.from({ length: 25 }, (_, index) => ({
    id: String(index), date: now - (index < 3 ? 1 : 8) * 86400_000 - index,
  }));
  const { session, disk } = fixture({ notifications });
  const loaded = await session.load();
  assert.deepEqual(loaded.notifications.map(item => item.id), notifications.slice(0, 20).map(item => item.id));
  assert.equal(loaded.notifications[0].date, new Date(notifications[0].date).toISOString());
  assert.deepEqual(disk().notifications, loaded.notifications);
  await session.deleteNotification('2');
  assert.equal((await fixture(disk()).session.load()).notifications.length, 19);

  const recent = notifications.map((item, index) => ({ ...item, date: now - index }));
  assert.equal((await fixture({ notifications: recent }).session.load()).notifications.length, 25);

  const recorded = await session.recordNotice({ type: 'info', text: 'Test' });
  const date = recorded.notifications.at(-1).date;
  assert.equal(date, new Date(date).toISOString());
  assert.equal(disk().notifications.at(-1).date, date);
});

test('stores deletion snapshots and restores profiles, measurements and devices independently', async () => {
  const anonymous = { ...prior, profile: null };
  const preferences = { theme: 'dark', columns: ['bmi', 'fatPercent'] };
  const { session, disk } = fixture({ profiles: [lou, sam], devices: [device],
    selectedProfile: 'Sam', measurements: [prior, anonymous], profilePreferences: { Lou: preferences } });
  const initial = await session.load();
  const removedProfile = (await session.deleteProfile('Lou')).notifications.at(-1);
  assert.equal(removedProfile.actor, 'Sam');
  assert.deepEqual(removedProfile.record, initial.profiles[0]);
  assert.deepEqual(removedProfile.measurements, [initial.measurements[0]]);
  assert.deepEqual(disk().notifications.at(-1).preferences, preferences);
  assert.equal(Object.hasOwn(disk().profilePreferences, 'Lou'), false);
  const { session: reopened, disk: restoredDisk } = fixture(disk());
  const restored = await reopened.restoreNotification(removedProfile.id, false);
  assert.ok(restored.profiles.some(profile => profile.name === 'Lou'));
  const { createdAt, ...restoredPreferences } = restoredDisk().profilePreferences.Lou;
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  assert.deepEqual(restoredPreferences, preferences);
  assert.deepEqual(restored.measurements, [initial.measurements[1]]);
  await assert.rejects(reopened.restoreNotification(removedProfile.id), /déjà été restauré/);

  const removedDevice = (await reopened.deleteDevice(address)).notifications.at(-1);
  const restoredDevice = await reopened.restoreNotification(removedDevice.id);
  assert.deepEqual(restoredDevice.devices.map(({ updatedAt, ...row }) => row), initial.devices);
  assert.ok(restoredDevice.devices[0].updatedAt > removedDevice.date);
  const removedMeasurement = (await reopened.deleteMeasurement(restoredDevice.measurements[0])).notifications.at(-1);
  const restoredMeasurement = await reopened.restoreNotification(removedMeasurement.id);
  assert.deepEqual(restoredMeasurement.measurements.map(({ updatedAt, ...row }) => row), [initial.measurements[1]]);
  assert.ok(restoredMeasurement.measurements[0].updatedAt > removedMeasurement.date);
});

test('links one complete receipt through enrollment, attribution, deletion and replay', async () => {
  const { session, disk } = fixture({ profiles: [lou], selectedProfile: 'Lou' });
  await session.ingest('META AABBCCDDEEFF TUlCRlM= 0157', start);
  const received = await session.ingest(xiaomi(full), start);
  const receipt = received.notifications.find(item => item.type === 'pending');
  assert.equal(receipt.record.event.hex, full);
  assert.equal(receipt.record.event.impedanceOhms, 489);
  assert.deepEqual(receipt.record.bluetoothMetadata.companyIds, ['0x0157']);
  assert.equal(receipt.deviceUuid, null);

  const enrolled = await session.beginDevice({ address, name: 'Salle' });
  const enrolledReceipt = enrolled.notifications.find(item => item.id === receipt.id);
  assert.equal(enrolledReceipt.deviceUuid, enrolled.devices[0].uuid);
  assert.equal(enrolledReceipt.reason, 'profile');
  assert.equal(enrolled.notifications.filter(item => item.type === 'pending').length, 1);
  await session.renameDevice({ address, name: 'Cuisine' });
  const attributed = await session.confirmProfile({ id: receipt.pendingId, name: 'Lou' });
  const linked = attributed.notifications.find(item => item.id === receipt.id);
  const [measurement] = attributed.measurements;
  assert.equal(linked.profileUuid, attributed.profiles[0].uuid);
  assert.equal(linked.deviceUuid, enrolledReceipt.deviceUuid);
  assert.equal(linked.measurementUuid, measurement.uuid);
  assert.equal(measurement.device.uuid, linked.deviceUuid);
  assert.equal(measurement.profile.uuid, linked.profileUuid);
  assert.deepEqual(linked.record, receipt.record);

  const reopened = fixture(disk()).session;
  await assert.rejects(reopened.replayReceipt(receipt.id), /déjà disponible/);
  const deleted = await reopened.deleteMeasurement(measurement);
  const archive = deleted.notifications.find(item => item.action === 'deleted');
  assert.equal(archive.record.uuid, measurement.uuid);
  await assert.rejects(reopened.replayReceipt(receipt.id), /peut être restaurée/);

  const unlinked = disk();
  unlinked.measurements = [];
  unlinked.notifications = deleted.notifications.map(item => item.id === receipt.id
    ? { ...item, measurementUuid: null, text: 'Pesée ignorée.' } : item);
  const recovered = fixture(unlinked).session;
  const recoveredState = await recovered.load();
  assert.equal(recoveredState.notifications.find(item => item.id === receipt.id).measurementUuid, measurement.uuid);
  await assert.rejects(recovered.replayReceipt(receipt.id), /peut être restaurée/);

  await reopened.deleteNotification(archive.id);
  const pending = await reopened.replayReceipt(receipt.id);
  assert.equal(pending.pending[0].reason, 'profile');
  assert.deepEqual(pending.pending[0].event, receipt.record.event);
  assert.equal(pending.notifications.find(item => item.id === receipt.id).date, receipt.date);
  assert.deepEqual((await reopened.replayReceipt(receipt.id)).pending, pending.pending);
  await reopened.discardPending(receipt.pendingId);
  await reopened.deleteDevice(address);

  const replayed = await reopened.replayReceipt(receipt.id);
  assert.equal(replayed.pending[0].reason, 'device');
  assert.deepEqual(replayed.pending[0].event, receipt.record.event);
  assert.deepEqual(replayed.pending[0].bluetoothMetadata, receipt.record.bluetoothMetadata);
  assert.equal(replayed.notifications.filter(item => item.id === receipt.id).length, 1);
  assert.deepEqual((await reopened.replayReceipt(receipt.id)).pending, replayed.pending);
});

test('links old receipts and migration IDs stay stable across reload', async () => {
  const receivedAt = new Date(start).toISOString();
  const row = { ...prior, receivedAt, device };
  const receipt = { id: 'old-receipt', type: 'pending', date: Date.now(),
    record: { event: { receivedAt, address, ...row.measures } } };
  const { session, disk } = fixture({ profiles: [lou], devices: [device], measurements: [row], notifications: [receipt] });
  const state = await session.load();
  const retained = state.notifications[0];
  assert.equal(retained.measurementUuid, state.measurements[0].uuid);
  assert.equal(retained.profileUuid, state.profiles[0].uuid);
  assert.equal(retained.deviceUuid, state.devices[0].uuid);
  assert.deepEqual((await fixture(disk()).session.load()).notifications, state.notifications);
});

test('keeps the original timestamp slot after renaming its profile and deleting its device', async () => {
  const reading = { ...prior, device };
  const { session } = fixture({ profiles: [lou], devices: [device], measurements: [reading] });
  const { profiles: [profile], devices: [balance], measurements: [archived] } = await session.load();
  await session.saveProfile({ ...lou, editUuid: profile.uuid, name: 'Louise' });
  await session.renameDevice({ address, name: 'Salon' });
  await session.deleteDevice(address);

  const state = await session.importLegacy({ measurements: [
    { ...reading, receivedAt: '2026-09-28T11:00:00+02:00', profile: { name: 'Louise', uuid: profile.uuid },
      device: { ...device, uuid: balance.uuid }, measures: { weight: 75, unit: 'kg' } },
  ] });
  assert.deepEqual(state.measurements, [archived]);
  assert.equal(archived.device.uuid, balance.uuid);
  assert.equal(archived.device.name, 'Cuisine');
});

test('moves old measurement references into archived snapshots without replacing their content', async () => {
  const seed = { profiles: [], devices: [], measurements: [{
    ...prior, uuid: '2beb4877-7a52-409f-8cf4-40ed01c843d2',
    profileUuid: 'f65d7265-af96-41e0-bddf-9904f4881809',
    deviceUuid: 'a837aff0-3124-4dac-991c-51d72e54e244', device,
  }] };
  const { session, disk } = fixture(seed);
  const { profileUuid, deviceUuid, ...reading } = seed.measurements[0];
  const [migrated] = (await session.load()).measurements;
  assert.deepEqual(migrated, { ...reading, createdAt: new Date(reading.receivedAt).toISOString(), profile: { ...reading.profile, uuid: profileUuid },
    device: { ...device, uuid: deviceUuid } });
  assert.deepEqual(disk().measurements, [migrated]);
  assert.deepEqual((await session.reload()).measurements, [migrated]);
});
