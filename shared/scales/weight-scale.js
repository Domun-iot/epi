'use strict';

const { fromHex, uint16le } = require('../bytes.cjs');
const { scaleTimestamp } = require('./timestamp.js');

function decode(hex) {
  if (!/^(?:[0-9a-f]{2}){3,15}$/i.test(hex)) return null;
  const data = fromHex(hex);
  const flags = data[0];
  const length = 3 + (flags & 2 ? 7 : 0) + (flags & 4 ? 1 : 0) + (flags & 8 ? 4 : 0);
  const value = uint16le(data, 1);
  if (flags & 0xf0 || data.length !== length || !value || value === 0xffff) return null;
  const imperial = Boolean(flags & 1);
  const scaleTime = flags & 2 ? scaleTimestamp(data, 3) : null;
  let offset = flags & 2 ? 10 : 3;
  const userId = flags & 4 ? data[offset++] : undefined;
  const deviceMetrics = {};
  if (flags & 8) {
    const bmi = uint16le(data, offset);
    const height = uint16le(data, offset + 2);
    if (bmi !== 0xffff) deviceMetrics.bmi = bmi / 10;
    if (height !== 0xffff) deviceMetrics.heightCm = height * (imperial ? 0.254 : 0.1);
  }
  return { weight: value / (imperial ? 100 : 200), unit: imperial ? 'lb' : 'kg',
    impedanceOhms: null, stable: true, removed: false, scaleTime,
    ...(userId !== undefined && userId !== 0xff && { scaleUserId: userId }),
    ...(Object.keys(deviceMetrics).length && { deviceMetrics }),
  };
}

module.exports = { serviceUuid: '0x181D', waitsForImpedance: false, decode };
