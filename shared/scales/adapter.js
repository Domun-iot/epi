'use strict';

const { fromBase64, fromHex } = require('../bytes.cjs');
const xiaomi = require('./xiaomi.js');
const weightScale = require('./weight-scale.js');

// The first port for a service is its fallback when the model is unknown.
const ports = [
  { port: xiaomi, models: ['XMTZC02HM', 'XMTZC05HM'] },
  { port: weightScale, models: [] },
];
const advertisementPorts = {
  'xiaomi-weight': require('./xiaomi-weight.js'),
  'eufy': require('./eufy.js'),
  'silvergear': require('./silvergear.js'),
  'senssun-if-b7': require('./senssun-if-b7.js'),
  'okok': require('./okok.js'),
  'qn-broadcast': require('./qn-broadcast.js'),
  'yunmai-x': require('./yunmai-x.js'),
  'picooc-mini-lite': require('./picooc-mini-lite.js'),
  'etekcity-fit-8s': require('./etekcity-fit-8s.js'),
  'scale-up': require('./scale-up.js'),
  'ailink': require('./ailink.js'),
};

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
  if (event.waitsForImpedance === true) return false;
  return event.waitsForImpedance === false || event.impedanceOhms > 0 || Object.hasOwn(advertisementPorts, event.protocol)
    || portFor(event)?.waitsForImpedance === false;
}

function mergeMeasurement(previous, latest) {
  if (!latest.impedanceOhms && !latest.deviceMetrics && latest.waitsForImpedance !== false) return previous;
  const deviceMetrics = previous.deviceMetrics || latest.deviceMetrics
    ? { ...previous.deviceMetrics, ...latest.deviceMetrics } : undefined;
  return { ...latest, impedanceOhms: latest.impedanceOhms ?? previous.impedanceOhms,
    ...(deviceMetrics && { deviceMetrics }) };
}

const ADDRESS = '([a-f\\d]{12}|[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12})';
const canonicalAddress = value => {
  const address = value.toUpperCase();
  return address.length === 12 ? address.match(/../g).join(':') : address;
};

const framePattern = new RegExp(String.raw`^${ADDRESS} (-?\d+|-|NA) (?:([a-f\d]{4}) )?((?:[a-f\d]{2}){3,15})(?: (\w+) ([A-Za-z0-9+/=]*))?$`, 'i');
const payloadPattern = new RegExp(
  String.raw`^PAYLOAD ${ADDRESS} (-?\d+|-) (Service128|Service|Manufacturer|Announcement) ([\da-f]{4}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}) (\d+) ((?:[\da-f]{2})*) ([A-Za-z0-9+/=]*)$`, 'i');

function parsePayload(line) {
  const match = payloadPattern.exec(line);
  if (!match) return null;
  const [, identity, signal, payloadType, id, length, hex, name] = match;
  const bytes = Number(length);
  if (bytes * 2 !== hex.length) return null;
  const kind = ['Service', 'Service128', 'Manufacturer', 'Announcement'].find(type => type.toLowerCase() === payloadType.toLowerCase());
  return { address: canonicalAddress(identity), rssi: signal === '-' ? null : Number(signal), kind,
    code: id.length === 4 ? '0x' + id.toUpperCase() : id.toLowerCase(),
    bytes, hex: hex.toLowerCase(), localName: fromBase64(name) || null };
}

function decodePayload(payload, bluetooth) {
  if (!payload.bytes || payload.kind === 'Announcement') return null;
  const frame = { ...payload, data: fromHex(payload.hex), localName: payload.localName ?? bluetooth?.localName };
  for (const [protocol, port] of Object.entries(advertisementPorts)) {
    const measurement = port.decodeAdvertisement(frame);
    if (measurement) return { ...measurement, protocol };
  }
  return null;
}

function createReceiver({ mac, acceptAddress = () => true, bluetoothFor = () => undefined, raw = false, includeHex = raw } = {}) {
  const recent = new Map();
  return (line, now = Date.now()) => {
    const payload = parsePayload(line);
    const match = payload ? null : framePattern.exec(line);
    if (!payload && !match) return null;
    const address = payload?.address ?? canonicalAddress(match[1]);
    if ((mac && address !== mac) || !acceptAddress(address)) return null;
    const bluetooth = bluetoothFor(address);
    let event, measurement;
    if (payload) {
      measurement = decodePayload(payload, bluetooth);
      if (!measurement) return null;
      const { kind, code, rssi, hex, localName } = payload;
      const manufacturer = kind === 'Manufacturer';
      event = { address, serviceUuid: manufacturer ? null : code, rssi,
        localName: localName ?? bluetooth?.localName ?? null, hex, advertisementType: kind,
        ...(manufacturer && { manufacturerId: code }) };
    } else {
      const serviceUuid = match[3] ? '0x' + match[3].toUpperCase() : defaultServiceUuid;
      const hex = match[4].toLowerCase();
      const localName = match[5] ? fromBase64(match[6]) || null : null;
      const identity = identifyScale({ ...bluetooth, localName: localName ?? bluetooth?.localName });
      const model = identity?.model ?? bluetooth?.model;
      measurement = decodeMeasurement(hex, { serviceUuid, model });
      const signal = Number(match[2]);
      event = { address, serviceUuid, hex, rssi: Number.isFinite(signal) ? signal : null,
        ...(match[5] && { advertisementType: match[5], localName }) };
    }
    if (!raw) {
      if (!measurement?.stable || measurement.removed || !measurement.weight) return null;
      for (const [key, seen] of recent) if (now - seen >= 30_000) recent.delete(key);
      const { weight, unit, impedanceOhms, scaleTime } = measurement;
      const key = JSON.stringify([address, measurement.protocol ?? event.serviceUuid, weight, unit, impedanceOhms,
        scaleTime, measurement.scaleUserId, measurement.waitsForImpedance, measurement.deviceMetrics]);
      const repeated = recent.has(key);
      recent.set(key, now);
      if (repeated) return null;
    }
    const { hex, ...fields } = event;
    return { receivedAt: new Date(now).toISOString(), ...fields, ...measurement, ...(includeHex && { hex }) };
  };
}

module.exports = { ADDRESS, canonicalAddress, createReceiver, decodeMeasurement, defaultServiceUuid,
  identifyScale, isCompleteMeasurement, mergeMeasurement, parsePayload };
