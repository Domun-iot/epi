'use strict';

const { fromHex, uint16le } = require('../bytes.cjs');

function identify({ localName, companyIds }) {
  // The name alone does not uniquely identify the model.
  if (localName === 'MIBFS' && companyIds?.includes('0x0157')) {
    return { brand: 'Xiaomi', model: 'XMTZC05HM' };
  }
}

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

module.exports = { serviceUuid: '0x181B', waitsForImpedance: true, identify, decode };
