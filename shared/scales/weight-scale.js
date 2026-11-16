'use strict';

const { fromHex, uint16le } = require('../bytes.cjs');

function decode(hex) {
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

module.exports = { serviceUuid: '0x181D', waitsForImpedance: false, decode };
