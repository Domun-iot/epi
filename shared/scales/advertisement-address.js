'use strict';

function isMacAddress(address) {
  return /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(address ?? '');
}

function echoesMac(data, offset, address, reversed = false) {
  if (!isMacAddress(address)) return false;
  const octets = address.split(':').map(octet => Number.parseInt(octet, 16));
  if (reversed) octets.reverse();
  return octets.every((octet, index) => data[offset + index] === octet);
}

module.exports = { isMacAddress, echoesMac };
