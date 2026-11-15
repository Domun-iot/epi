'use strict';

const prefixes = require('./mac-prefixes.json');

function macManufacturer(address) {
  if (!/^(?:[\da-f]{12}|(?:[\da-f]{2}:){5}[\da-f]{2})$/i.test(address ?? '')) return;
  const mac = address.replaceAll(':', '').toUpperCase();
  // IEEE assignments identify globally administered unicast addresses.
  if ((parseInt(mac.slice(0, 2), 16) & 3) !== 0) return;
  return prefixes[mac.slice(0, 9)] ?? prefixes[mac.slice(0, 7)] ?? prefixes[mac.slice(0, 6)];
}

module.exports = { macManufacturer };
