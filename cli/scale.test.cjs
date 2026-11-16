'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReceiver } = require('../shared/scales/adapter.js');
const { decode } = require('../shared/scales/xiaomi.js');

// XMTZC05HM capture: https://github.com/lolouk44/hassio-addons/issues/14
const full = '0226e40709060d2605e9015a37';
const removed = '02a6e40709060d2614e9015a37';
// Weight-only capture: https://github.com/ipanalytics/Xiaomi-Scale-Unlocked-Reverse-Engineering
const weightOnly = '0224b2070104030637fdff983a';
const packet = hex => 'AABBCCDDEEFF -58 ' + hex;

test('decodes a real XMTZC05HM packet', () => {
  assert.deepEqual(decode(full), {
    weight: 70.85, unit: 'kg', impedanceOhms: 489,
    stable: true, removed: false, scaleTime: '2020-09-06T13:38:05',
  });
});
test('decodes weight without impedance, and converts the lb representation', () => {
  assert.equal(decode(weightOnly).weight, 75);
  assert.equal(decode(weightOnly).impedanceOhms, null);
  const pounds = decode('0324b2070104030637fdff983a');
  assert.equal(pounds.unit, 'lb');
  assert.equal(pounds.weight, 150);
  assert.equal(decode('0226'), null);
});
test('filters other addresses, unstable and unloaded readings and repeated broadcasts', () => {
  const receive = createReceiver({ mac: 'AA:BB:CC:DD:EE:FF' });
  assert.equal(receive('000000000000 -58 ' + full, 0), null);
  assert.equal(receive(packet('0206' + full.slice(4)), 0), null);
  assert.equal(receive(packet(removed), 0), null);
  const event = receive(packet(full), 0);
  assert.equal(event.rssi, -58);
  assert.equal(event.receivedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(receive(packet(full), 1), null);
  assert.equal(receive(packet('0266' + full.slice(4)), 2), null);
  assert.ok(receive(packet('0224' + full.slice(4)), 3));
  assert.ok(receive(packet(full), 30_002));
});
test('receives identified and unknown scales on the same receiver without mixing ports or addresses', () => {
  const models = { 'AA:BB:CC:DD:EE:FF': { model: 'XMTZC05HM' } };
  const receive = createReceiver({ bluetoothFor: address => models[address] });
  const xiaomi = 'AABBCCDDEEFF -58 181B ' + full;
  const weightScale = '112233445566 -62 181D 00404C';
  assert.equal(receive(xiaomi, 0).weight, 70.85);
  assert.equal(receive(weightScale, 1).weight, 97.6);
  assert.equal(receive(xiaomi, 2), null);
  assert.equal(receive(xiaomi.replace('AABBCCDDEEFF', '112233445577'), 3).weight, 70.85);
  assert.equal(receive(xiaomi.replace('181B', '1234'), 4), null);
});

test('raw mode exposes repeat and unloaded packets', () => {
  const receive = createReceiver({ raw: true });
  assert.equal(receive(packet(removed), 0).hex, removed);
  assert.equal(receive(packet(removed), 1).removed, true);
});
