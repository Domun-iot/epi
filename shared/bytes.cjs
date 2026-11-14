'use strict';

const decoder = new TextDecoder();

function fromBase64(value) {
  try {
    return decoder.decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
  } catch {
    return '';
  }
}

const fromHex = hex => Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));
const uint16le = (data, offset) => data[offset] | (data[offset + 1] << 8);

module.exports = { fromBase64, fromHex, uint16le };
