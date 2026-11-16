'use strict';

const { uint16le } = require('../bytes.cjs');

function scaleTimestamp(data, offset) {
  if (data.length < offset + 7) return null;
  const year = uint16le(data, offset);
  const [month, day, hour, minute, second] = data.subarray(offset + 2, offset + 7);
  if (year < 1582 || year > 9999 || month < 1 || month > 12 || day < 1
      || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  const pad = value => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

module.exports = { scaleTimestamp };
