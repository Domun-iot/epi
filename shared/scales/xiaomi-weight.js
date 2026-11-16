'use strict';

const { uint16le } = require('../bytes.cjs');
const { scaleTimestamp } = require('./timestamp.js');

function decodeAdvertisement({ kind, code, data, localName }) {
  if (kind !== 'Service' || code !== '0x181D' || data.length !== 10) return null;
  const flags = data[0];
  const format = flags & ~0xe0;
  const raw = uint16le(data, 1);
  if (![0x02, 0x03, 0x12].includes(format) || !raw || raw === 0xffff) return null;
  const scaleTime = scaleTimestamp(data, 3);
  const inPounds = format === 0x03;
  const model = localName === 'MI SCALE2' ? 'XMTZC04HM' : localName === 'MI_SCALE' ? 'XMTZC01HM' : undefined;
  if (!scaleTime && !model) return null;
  return {
    weight: raw / (inPounds ? 100 : 200), unit: inPounds ? 'lb' : 'kg',
    stable: Boolean(flags & 0x20), removed: Boolean(flags & 0x80), impedanceOhms: null, scaleTime,
    brand: 'Xiaomi', ...(model && { model }),
  };
}

module.exports = { decodeAdvertisement };
