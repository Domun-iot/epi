'use strict';

const { fromBase64 } = require('../bytes.cjs');
const xiaomi = require('./xiaomi.js');
const weightScale = require('./weight-scale.js');

// The first port for a service is its fallback when the model is unknown.
const ports = [
  { port: xiaomi, models: ['XMTZC05HM'] },
  { port: weightScale, models: [] },
];
// Older scanner lines omit the service ID and carry Xiaomi advertisements.
const defaultServiceUuid = xiaomi.serviceUuid;

function identifyScale(bluetooth) {
  for (const { port } of ports) {
    const identity = port.identify?.(bluetooth);
    if (identity) return identity;
  }
}

function portFor({ serviceUuid, model }) {
  return (ports.find(entry => entry.port.serviceUuid === serviceUuid && entry.models.includes(model))
    ?? ports.find(entry => entry.port.serviceUuid === serviceUuid))?.port;
}

function decodeMeasurement(hex, bluetooth) {
  return portFor(bluetooth)?.decode(hex) ?? null;
}

function isCompleteMeasurement(event) {
  return event.impedanceOhms > 0 || portFor(event)?.waitsForImpedance === false;
}

const ADDRESS = '([a-f\\d]{12}|[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12})';
const canonicalAddress = value => {
  const address = value.toUpperCase();
  return address.length === 12 ? address.match(/../g).join(':') : address;
};

const framePattern = new RegExp(String.raw`^${ADDRESS} (-?\d+|-|NA) (?:([a-f\d]{4}) )?((?:[a-f\d]{2}){3,15})(?: (\w+) ([A-Za-z0-9+/=]*))?$`, 'i');

function createReceiver({ mac, acceptAddress = () => true, bluetoothFor = () => undefined, raw = false, includeHex = raw } = {}) {
  const recent = new Map();
  return (line, now = Date.now()) => {
    const match = framePattern.exec(line);
    if (!match) return null;
    const address = canonicalAddress(match[1]);
    if ((mac && address !== mac) || !acceptAddress(address)) return null;
    const serviceUuid = match[3] ? '0x' + match[3].toUpperCase() : defaultServiceUuid;
    const hex = match[4].toLowerCase();
    const localName = match[5] ? fromBase64(match[6]) || null : null;
    const bluetooth = bluetoothFor(address);
    const identity = identifyScale({ ...bluetooth, localName: localName ?? bluetooth?.localName });
    const model = identity?.model ?? bluetooth?.model;
    const measurement = decodeMeasurement(hex, { serviceUuid, model });
    if (!raw) {
      if (!measurement?.stable || measurement.removed || !measurement.weight) return null;
      for (const [key, seen] of recent) if (now - seen >= 30_000) recent.delete(key);
      const { weight, unit, impedanceOhms, scaleTime } = measurement;
      const key = JSON.stringify([address, serviceUuid, weight, unit, impedanceOhms, scaleTime]);
      const repeated = recent.has(key);
      recent.set(key, now);
      if (repeated) return null;
    }
    return { receivedAt: new Date(now).toISOString(), address, serviceUuid, rssi: Number.isFinite(Number(match[2])) ? Number(match[2]) : null,
      ...(match[5] ? { advertisementType: match[5], localName } : {}),
      ...measurement, ...(includeHex ? { hex } : {}) };
  };
}

module.exports = { ADDRESS, canonicalAddress, createReceiver, decodeMeasurement, defaultServiceUuid,
  identifyScale, isCompleteMeasurement };
