'use strict';

const { echoesMac, isMacAddress } = require('./advertisement-address.js');
const { uint16le } = require('../bytes.cjs');

// C0 and V20 signatures are grounded in the captures referenced by BLE Scale Sync
// and openScale. Bytes resembling an impedance are model-dependent placeholders.
function decodeC0(data, address, name) {
  if (data.length !== 13 || ![0x20, 0x21, 0x24, 0x25].includes(data[6])) return null;
  const yoda = /^yoda[01]/i.test(name);
  const isMac = isMacAddress(address);
  const contact = (data[2] << 8) | data[3];
  // Fitelo hardware uses the C0 weight layout and a binary electrode-contact field.
  const fitelo = /^tzc$/i.test(name) && (data[6] & 4) && data[4] === 0 && data[5] === 2
    && (contact === 0 || contact === 0x1388);
  const matchesSource = echoesMac(data, 7, address)
    || (yoda && (!isMac || data.subarray(7).every(byte => byte === 0)))
    || (fitelo && !isMac);
  if (!matchesSource) return null;
  const weight = ((data[0] << 8) | data[1]) / (data[6] & 4 ? 100 : 10);
  const stable = Boolean(data[6] & 1);
  return fitelo
    ? { weight, stable, brand: 'Fitelo', model: 'FIT PRO 2025-1', deviceMetrics: { electrodeContact: Number(contact > 0) } }
    : { weight, stable, model: 'OKOK C0' };
}

function decodeV20(data, address, name) {
  if (data.length !== 19 || data[0] !== 0x0b || data[5] !== 1 || ![1, 4, 5].includes(data[6])) return null;
  const matchesSource = isMacAddress(address) ? echoesMac(data, 13, address) : /^adv$/i.test(name);
  if (!matchesSource || data.subarray(0, 12).reduce((xor, byte) => xor ^ byte, 0x20) !== data[12]) return null;
  const weight = ((data[8] << 8) | data[9]) / (data[6] & 4 ? 100 : 10);
  return { weight, stable: Boolean(data[6] & 1), model: 'OKOK V20' };
}

function decodeV11(data, name) {
  if (data.length !== 23 || !/^(?:chipsea-ble$|adv$|yoda[01])/i.test(name)) return null;
  if (data.subarray(0, 16).reduce((xor, byte) => xor ^ byte, 0xca ^ 0x11) !== data[16]) return null;
  const properties = data[9];
  const divider = [10, 1, 100, 10][(properties >> 1) & 3];
  const rawWeight = (data[3] << 8) | data[4];
  const displayUnit = (properties >> 3) & 3;
  const weight = [
    rawWeight / divider,
    rawWeight / (2 * divider),
    rawWeight / divider * 0.45359237,
    (14 * data[3] + data[4] / divider) * 0.45359237,
  ][displayUnit];
  return { weight, stable: true, model: 'OKOK V11' };
}

function decodeAdvertisement({ kind, code, data, address, localName }) {
  if (kind !== 'Manufacturer') return null;
  const name = localName?.trim() ?? '';
  let reading;
  if (code === '0x20CA') reading = decodeV20(data, address, name);
  else if (code === '0x11CA') reading = decodeV11(data, name);
  else if (code.endsWith('C0')) reading = decodeC0(data, address, name);
  else if (code === '0xF0FF' && data.length >= 4 && /^(?:chipsea-ble$|adv$|yoda[01])/i.test(name)) {
    // VF0 has a little-endian weight field and no documented stability flag.
    reading = { weight: uint16le(data, 2) / 10, stable: false, model: 'OKOK VF0' };
  }
  if (!reading || reading.weight <= 0 || reading.weight > 300) return null;
  return { unit: 'kg', impedanceOhms: null, removed: false, scaleTime: null, ...reading };
}

module.exports = { decodeAdvertisement };
