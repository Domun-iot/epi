'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fromHex } = require('../bytes.cjs');
const { decodeAdvertisement } = require('./ailink.js');

// Synthetic fixtures created for éPI from chosen protocol fields and TEA encoding.
// Fictitious locally administered MAC, 82.35 kg, 625 ohms; no upstream test vector reused.
const frame = {
  kind: 'Manufacturer', code: '0x0301', address: '02:6A:83:17:BC:40', localName: 'EL1',
  data: fromHex('0140bc17836a02469a23beece87f9cdeffff'),
};

test('AiLink EL1 decodes the completed TEA announcement', () => {
  assert.deepEqual(decodeAdvertisement(frame), {
    weight: 82.35, unit: 'kg', impedanceOhms: 625, stable: true, removed: false,
    scaleTime: null, brand: 'AiLink', model: 'EL1',
  });
});

test('AiLink EL1 drops stale impedance from live readings and accepts a final weigh-in without impedance', () => {
  const live = decodeAdvertisement({ ...frame, data: fromHex('0140bc17836a02eed33648ac5f39f764ffff') });
  assert.equal(live.weight, 82.35);
  assert.equal(live.stable, false);
  assert.equal(live.impedanceOhms, null);
  const noImpedance = decodeAdvertisement({ ...frame, data: fromHex('0140bc17836a024251129d69dd57acfbffff') });
  assert.equal(noImpedance.weight, 82.35);
  assert.equal(noImpedance.stable, true);
  assert.equal(noImpedance.impedanceOhms, null);
});

test('AiLink EL1 requires the scale identity and a valid manufacturer packet', () => {
  const data = frame.data.slice();
  data[8] ^= 1;
  assert.equal(decodeAdvertisement({ ...frame, data }), null);
  assert.equal(decodeAdvertisement({ ...frame, code: '0x0316' }), null);
  assert.equal(decodeAdvertisement({ ...frame, address: '00:00:00:00:00:00' }), null);
  const address = '00112233-4455-6677-8899-AABBCCDDEEFF';
  assert.equal(decodeAdvertisement({ ...frame, address, localName: null }), null);
  assert.equal(decodeAdvertisement({ ...frame, address }).weight, 82.35);
});
