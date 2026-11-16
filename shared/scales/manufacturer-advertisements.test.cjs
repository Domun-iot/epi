'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fromHex } = require('../bytes.cjs');
const qn = require('./qn-broadcast.js');
const yunmai = require('./yunmai-x.js');
const picooc = require('./picooc-mini-lite.js');
const etekcity = require('./etekcity-fit-8s.js');
const scaleUp = require('./scale-up.js');

function advertisement(code, hex, details = {}) {
  return { kind: 'Manufacturer', code, data: fromHex(hex),
    address: '11:22:33:44:55:66', localName: null, ...details };
}

test('QN AABB uses bit 5, with bit 0 limited to the observed FITINDEX signature', () => {
  // Hardware capture from a physical FT-26R-W with its source MAC anonymized in openScale PR #1521.
  const frame = advertisement('0xFFFF', 'aabb00005e00530172000000ffffff1500761b510e032300');
  assert.deepEqual(qn.decodeAdvertisement(frame), {
    weight: 70.3, unit: 'kg', impedanceOhms: null, stable: true, removed: false, scaleTime: null,
    brand: 'FITINDEX', model: 'FT-26R',
  });
  assert.equal(qn.decodeAdvertisement({ ...frame, data: frame.data.subarray(0, 19) }).stable, false);
  frame.data[15] = 0x20;
  assert.equal(qn.decodeAdvertisement({ ...frame, data: frame.data.subarray(0, 19) }).stable, true);
  assert.equal(qn.decodeAdvertisement({ ...frame, code: '0x004C' }), null);
  assert.equal(qn.decodeAdvertisement({ ...frame, data: frame.data.subarray(0, 18) }), null);
});

test('both Yunmai signatures share weight, impedance, and state handling', () => {
  // Synthetic frames follow the layout verified on both models in openScale PR #1575.
  const international = advertisement('0x5566', '443322110b741704031d4c01f4a3');
  assert.deepEqual(yunmai.decodeAdvertisement(international), {
    weight: 75, unit: 'kg', impedanceOhms: 500, stable: true, removed: false, scaleTime: null,
    brand: 'Yunmai', model: 'YMBS-M268',
  });
  const chinese = advertisement('0x5566', '4433221106521104021d4c000057');
  assert.deepEqual(yunmai.decodeAdvertisement(chinese), {
    weight: 75, unit: 'kg', impedanceOhms: null, stable: false, removed: false, scaleTime: null,
    brand: 'Yunmai', model: 'M1827CH',
  });
  assert.equal(yunmai.decodeAdvertisement({ ...international, code: '0x0000' }), null);
  assert.equal(yunmai.decodeAdvertisement({ ...international, address: '11111111-2222-3333-4444-555555555555' }).stable, true);
  international.data[13] ^= 1;
  assert.equal(yunmai.decodeAdvertisement(international), null);
});

test('PICOOC Mini Lite decodes a public 82.7 kg, 496 ohm capture', () => {
  // Physical PICOOC Mini Lite advertisement, packet C in openScale PR #1512.
  const frame = advertisement('0x49D0', '004b4f1e391f0676136087200040', {
    address: 'D0:49:00:4B:4F:1E', localName: 'PICOOC-L',
  });
  assert.deepEqual(picooc.decodeAdvertisement(frame), {
    weight: 82.7, unit: 'kg', impedanceOhms: 496, stable: true, removed: false, scaleTime: null,
    brand: 'PICOOC', model: 'Mini Lite',
  });
  assert.equal(picooc.decodeAdvertisement({ ...frame, localName: 'PICOOC-CQ' }), null);
  assert.equal(picooc.decodeAdvertisement({ ...frame, address: 'DE:49:00:4B:4F:1E' }), null);
  frame.data[13] ^= 1;
  assert.equal(picooc.decodeAdvertisement(frame), null);
});

test('Etekcity Fit 8S decodes hardware captures from two revisions', () => {
  // Physical captures from openScale PR #1472 and etekcity_esf551_ble PR #6.
  const frame = advertisement('0x06D0', '01cea18c5789a8c0a8014e1a010e020100020300', {
    address: 'A8:89:57:8C:A1:CE',
  });
  assert.deepEqual(etekcity.decodeAdvertisement(frame), {
    weight: 72.27, unit: 'kg', impedanceOhms: 526, stable: true, removed: false, scaleTime: null,
    brand: 'Etekcity', model: 'Fit 8S',
  });
  const second = advertisement('0x06D0', '0163a0ed5d89a9c0a901563a0100000100020300', {
    address: 'A9:89:5D:ED:A0:63',
  });
  assert.equal(etekcity.decodeAdvertisement(second).weight, 80.47);
  assert.equal(etekcity.decodeAdvertisement(second).impedanceOhms, null);
  frame.data[16] = 2;
  assert.equal(etekcity.decodeAdvertisement(frame).weight, 72.27);
  frame.data[15] = 0;
  assert.equal(etekcity.decodeAdvertisement(frame).stable, false);
  frame.data[8] = 2;
  assert.equal(etekcity.decodeAdvertisement(frame), null);
});

test('Scale Up rebuilds weight from both the identifier and payload', () => {
  const frame = advertisement('0x1DE0', '4c0208112233445566', { localName: 'da' });
  assert.deepEqual(scaleUp.decodeAdvertisement(frame), {
    weight: 75, unit: 'kg', impedanceOhms: null, stable: true, removed: false, scaleTime: null,
    model: 'Scale Up',
  });
  assert.equal(scaleUp.decodeAdvertisement({ ...frame, code: '0x1DD0' }).stable, false);
  assert.equal(scaleUp.decodeAdvertisement({ ...frame, localName: 'other' }), null);
  assert.equal(scaleUp.decodeAdvertisement({ ...frame, address: '00:11:22:33:44:55' }), null);
});
