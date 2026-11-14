'use strict';

const { fromHex, fromBase64, uint16le } = require('./bytes.cjs');

function decode(hex) {
  if (!/^(?:02|03)[0-9a-f]{24}$/i.test(hex)) return null;
  const data = fromHex(hex);
  const flags = data[1];
  const unit = data[0] === 2 ? 'kg' : 'lb';
  const impedance = uint16le(data, 9);
  const year = uint16le(data, 2);
  const [month, day, hour, minute, second] = data.subarray(4, 9);
  const clock = [month, day, hour, minute, second].map(v => String(v).padStart(2, '0'));
  const scaleTime = year >= 1970 && year <= 9999
    ? `${year}-${clock[0]}-${clock[1]}T${clock[2]}:${clock[3]}:${clock[4]}`
    : null;
  return {
    weight: uint16le(data, 11) / (unit === 'kg' ? 200 : 100),
    unit,
    impedanceOhms: flags & 2 && impedance > 0 && impedance < 0xfffd ? impedance : null,
    stable: Boolean(flags & 0x20),
    removed: Boolean(flags & 0x80),
    scaleTime,
  };
}

function decodeWeight(hex) {
  if (!/^(?:[0-9a-f]{2}){3,15}$/i.test(hex)) return null;
  const data = fromHex(hex);
  const flags = data[0];
  const length = 3 + (flags & 2 ? 7 : 0) + (flags & 4 ? 1 : 0) + (flags & 8 ? 4 : 0);
  const value = uint16le(data, 1);
  if (flags & 0xf0 || data.length !== length || !value || value === 0xffff) return null;
  const imperial = Boolean(flags & 1);
  return { weight: value / (imperial ? 100 : 200), unit: imperial ? 'lb' : 'kg',
    impedanceOhms: null, stable: true, removed: false, scaleTime: null };
}

const ADDRESS = '([a-f\\d]{12}|[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12})';
const canonicalAddress = value => {
  const address = value.toUpperCase();
  return address.length === 12 ? address.match(/../g).join(':') : address;
};

function createReceiver({ mac, acceptAddress = () => true, raw = false, includeHex = raw } = {}) {
  const recent = new Map();
  return (line, now = Date.now()) => {
    const match = new RegExp(String.raw`^${ADDRESS} (-?\d+|-|NA) (?:(181B|181D) )?((?:[a-f\d]{2}){3,15})(?: (\w+) ([A-Za-z0-9+/=]*))?$`, 'i').exec(line);
    if (!match) return null;
    const address = canonicalAddress(match[1]);
    if ((mac && address !== mac) || !acceptAddress(address)) return null;
    const serviceUuid = '0x' + (match[3]?.toUpperCase() ?? '181B');
    const hex = match[4].toLowerCase();
    const measurement = serviceUuid === '0x181D' ? decodeWeight(hex) : decode(hex);
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
      ...(match[5] ? { advertisementType: match[5], localName: fromBase64(match[6]) || null } : {}),
      ...measurement, ...(includeHex ? { hex } : {}) };
  };
}

module.exports = { decode, createReceiver, ADDRESS, canonicalAddress };
