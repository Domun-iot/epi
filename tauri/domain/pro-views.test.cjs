const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSession } = require('./session.cjs');

test('FREE uses one editable layout; returning to PRO restores both profiles and named views', async () => {
  let paid = true;
  const alice = { name: 'Alice', sex: 'F', age: 45, heightCm: 165 };
  const bob = { name: 'Bob', sex: 'M', age: 42, heightCm: 180 };
  let disk = { profiles: [alice, bob], selectedProfile: 'Alice' };
  const open = () => createSession({
    storage: { load: () => disk, save: value => { disk = value; } }, hasProViews: () => paid
  });

  const session = open();
  await session.setColumnPreference('Alice', 'fatPercent', 'columns', true);
  await session.changeViewPreset('Alice', 'measurements', 'create', { name: 'Alice PRO' });
  await session.setColumnPreference('Bob', 'muscleMassKg', 'columns', true);
  const presets = disk.viewPresets;
  const profiles = disk.profilePreferences;
  paid = false;
  let view = await session.refreshView();
  assert.equal(view.proViews, false);
  assert.deepEqual(view.viewLayouts.measurements.presets, []);
  assert.equal(view.viewLayouts.measurements.preset, undefined);
  assert.equal(view.viewLayouts.measurements.modified, false);
  await session.changeViewPreset('Alice', 'measurements', 'create', { name: 'Not saved' });
  await session.setColumnPreference('Alice', 'impedanceOhms', 'columns', true);
  await session.setMeasurementDisplay('Alice', 'chart', null);
  await session.setPanelOpen('Alice', 'methods', true);
  view = await session.selectProfile('Bob');
  assert.deepEqual(view.columns, ['bmi', 'impedanceOhms']);
  assert.equal(view.measurementDisplay, 'chart');
  assert.equal(view.detailSectionsOpen.methods, true);
  assert.equal(view.viewLayouts.measurements.modified, false);
  assert.deepEqual(disk.viewPresets, presets);
  assert.deepEqual(disk.profilePreferences, profiles);
  assert.deepEqual((await open().load()).columns, view.columns);

  paid = true;
  view = await session.refreshView();
  assert.ok(view.columns.includes('muscleMassKg'));
  assert.ok(!view.columns.includes('impedanceOhms'));
  view = await session.selectProfile('Alice');
  assert.ok(view.columns.includes('fatPercent'));
  assert.equal(view.viewLayouts.measurements.preset.name, 'Alice PRO');
});
