'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromHex } = require('../bytes.cjs');
const eufy = require('./eufy.js');
const okok = require('./okok.js');
const senssun = require('./senssun-if-b7.js');
const silvergear = require('./silvergear.js');

function manufacturer(code, hex, address, localName = null) {
  return { kind: 'Manufacturer', code, data: fromHex(hex), address, localName };
}

test('decodes Silvergear and beatXP captures through the same 0xA0AC port', () => {
  // BLE Scale Sync #297 and beatxp-smart-scale PROTOCOL.md, trace 2.
  const first = manufacturer('0xA0AC', '4fe9916185a0202d07600da1', 'A0:85:61:91:E9:4F', '108');
  const second = manufacturer('0xA0AC', '261f385d85a0202d825a0db6', 'A0:85:5D:38:1F:26', 'AAA041');
  assert.equal(silvergear.decodeAdvertisement(first).weight, 108.48);
  assert.equal(silvergear.decodeAdvertisement(first).stable, true);
  assert.equal(silvergear.decodeAdvertisement(second).weight, 74.49);
  assert.equal(silvergear.decodeAdvertisement(second).model, 'BXPBMI1004');
  assert.equal(silvergear.decodeAdvertisement({ ...first, address: second.address }), null);
  first.data[11] ^= 1;
  assert.equal(silvergear.decodeAdvertisement(first), null);
});

test('decodes the INSMART firmware whose high weight bits differ from Silvergear', () => {
  const insmart = manufacturer('0xA0AC', '0cc9a45491a020c99cd20da4', 'A0:91:54:A4:C9:0C', 'AAA006');
  assert.equal(silvergear.decodeAdvertisement(insmart).weight, 81.01);
  assert.equal(silvergear.decodeAdvertisement(insmart).brand, 'INSMART');
});

test('uses the advertised company high byte for a recognized AAAx model', () => {
  const frame = manufacturer('0xA0AC', '0cc9a45491a020c99cd20da4', 'A0:91:54:A4:C9:0C', 'AAA07A');
  frame.code = '0x81AC';
  for (let offset = 6; offset < 12; offset++) frame.data[offset] ^= 0xa0 ^ 0x81;
  assert.equal(silvergear.decodeAdvertisement(frame).weight, 81.01);
  assert.equal(silvergear.decodeAdvertisement(frame).model, 'FG220LB');
  assert.equal(silvergear.decodeAdvertisement({ ...frame, localName: null }), null);
});

test('decodes Senssun captures in kg even when the display shows lb', () => {
  // BLE Scale Sync #423.
  const result = manufacturer('0x0100', '02031164fb012d925001223800caa2864d', '64:FB:01:2D:92:50');
  const live = manufacturer('0x0100', '02031164fb012d925001221a00000190ce', result.address);
  assert.equal(senssun.decodeAdvertisement(result).weight, 87.6);
  assert.equal(senssun.decodeAdvertisement(result).stable, true);
  assert.equal(senssun.decodeAdvertisement(result).impedanceOhms, null);
  assert.equal(senssun.decodeAdvertisement(live).stable, false);
  live.data[10] ^= 1;
  assert.equal(senssun.decodeAdvertisement(live), null);
});

test('checks the source and stability of OKOK C0 and V20 captures', () => {
  // openScale #1191, #1177, and #410. r1 is an opaque field in these captures.
  const c0 = manufacturer('0x10C0', '396c17700a012508b8d0deb53a', '08:B8:D0:DE:B5:3A');
  const yoda = manufacturer('0x3FC0', '1dce1388000025000000000000', '08:B8:D0:E8:5F:6D', 'Yoda0');
  const v20 = manufacturer('0x20CA', '0b41af2f810105051a90177087ed67372669d7', 'ED:67:37:26:69:D7', 'ADV');
  assert.equal(okok.decodeAdvertisement(c0).weight, 147);
  assert.equal(okok.decodeAdvertisement(c0).impedanceOhms, null);
  assert.equal(okok.decodeAdvertisement(yoda).weight, 76.3);
  assert.equal(okok.decodeAdvertisement({ ...yoda, localName: null }), null);
  assert.equal(okok.decodeAdvertisement(v20).weight, 68);
  assert.equal(okok.decodeAdvertisement(v20).stable, true);
  v20.data[12] ^= 1;
  assert.equal(okok.decodeAdvertisement(v20), null);
});

test('uses the OKOK C0 port for Fitelo and keeps electrode contact separate from impedance', () => {
  // Published hardware log samples/contact-vs-nocontact_2026-05-30.txt in the Fitelo decoder repository.
  const address = 'FE:FA:00:3F:40:BC';
  const contact = manufacturer('0x9EC0', '1eaa1388000225fefa003f40bc', address, 'tzc');
  const noContact = manufacturer('0x06C0', '1eaa0000000225fefa003f40bc', address, 'tzc');
  assert.deepEqual(okok.decodeAdvertisement(contact), {
    weight: 78.5, unit: 'kg', impedanceOhms: null, stable: true, removed: false, scaleTime: null,
    brand: 'Fitelo', model: 'FIT PRO 2025-1', deviceMetrics: { electrodeContact: 1 },
  });
  assert.deepEqual(okok.decodeAdvertisement(noContact).deviceMetrics, { electrodeContact: 0 });
  assert.equal(okok.decodeAdvertisement({ ...contact, address: '00:00:00:00:00:00' }), null);
  const apple = { ...contact, address: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  assert.equal(okok.decodeAdvertisement(apple).weight, 78.5);
  assert.equal(okok.decodeAdvertisement({ ...apple, localName: null }), null);
});

test('decodes the checksum-protected OKOK V11 capture', () => {
  // openScale #496.
  const reading = manufacturer('0x11CA', '0f000102f25821332e0000000000000041c8b21e156edb', '08:B2:1E:15:6E:DB', 'Chipsea-BLE');
  assert.equal(okok.decodeAdvertisement(reading).weight, 75.4);
  reading.data[16] ^= 1;
  assert.equal(okok.decodeAdvertisement(reading), null);
});

test('routes six Eufy aliases over three advertisement layouts', () => {
  // Synthetic vectors based on eufylife-ble-client.
  const address = 'AA:BB:CC:DD:EE:FF';
  const c20 = manufacturer('0xBC64', '00000000000000000000050090331b000000', address, 'eufy T9130');
  const p2 = manufacturer('0xFF48', '000000000000cf48c0401f0000000000000000', address, 'eufy T9148');
  const c1 = manufacturer('0x0000', '00000000cf0000401f000000000090000000', address, 'eufy T9146');
  assert.equal(eufy.decodeAdvertisement(c20).weight, 132);
  assert.equal(eufy.decodeAdvertisement({ ...c20, localName: 'eufy T9150', code: '0x0001' }).model, 'T9150');
  assert.equal(eufy.decodeAdvertisement(p2).weight, 80);
  assert.deepEqual(eufy.decodeAdvertisement({ ...p2, localName: 'eufy T9149' }).deviceMetrics, { heartRateBpm: 72 });
  assert.equal(eufy.decodeAdvertisement(c1).stable, true);
  assert.equal(eufy.decodeAdvertisement({ ...c1, localName: 'eufy T9147' }).weight, 80);
  c1.data[14] ^= 1;
  assert.equal(eufy.decodeAdvertisement(c1), null);
});

test('follows identified P3 from weight lock through impedance and late pulse', () => {
  // Real P3 frames from eufylife-ble-client #3 reproduced in BLE Scale Sync, with the MAC masked.
  const address = 'CF:01:02:03:04:05';
  const name = 'eufy T9150';
  const locked = manufacturer('0xCF4D', '0102030405002c4f706705005820000000000000000000', address, name);
  const composition = manufacturer('0xCF4D', '010203040500324f7067650058200000000b143534d900', address, name);
  const final = manufacturer('0xCF4D', '010203040500384f7067a5805820005f000b143534d900', address, name);
  assert.equal(eufy.decodeAdvertisement(locked).weight, 82.8);
  assert.equal(eufy.decodeAdvertisement(locked).waitsForImpedance, true);
  assert.equal(eufy.decodeAdvertisement(composition).impedanceOhms, 513.1);
  assert.equal(eufy.decodeAdvertisement(composition).waitsForImpedance, true);
  assert.equal(eufy.decodeAdvertisement(final).impedanceOhms, 513.1);
  assert.deepEqual(eufy.decodeAdvertisement(final).deviceMetrics, { heartRateBpm: 95 });
  assert.equal(eufy.decodeAdvertisement(final).waitsForImpedance, false);
  const nameless = eufy.decodeAdvertisement({ ...final, localName: null });
  assert.equal(nameless.weight, 82.8);
  assert.equal(nameless.impedanceOhms, null);
  assert.equal(eufy.decodeAdvertisement({ ...final, localName: null, address: 'CF:F1:02:03:04:05' }), null);
  final.data[10] = 0x0d;
  assert.equal(eufy.decodeAdvertisement(final), null);
});

test('decodes C20 same-frame impedance and pulse flags separately from P3', () => {
  const frame = manufacturer('0xCF02', '010203040500384f7067c5005820005f000b143534d900', 'CF:01:02:03:04:05', 'eufy T9130');
  const sample = eufy.decodeAdvertisement(frame);
  assert.equal(sample.weight, 82.8);
  assert.equal(sample.impedanceOhms, 513.1);
  assert.deepEqual(sample.deviceMetrics, { heartRateBpm: 95 });
});
