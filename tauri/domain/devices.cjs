'use strict';

const { buildDevice, deviceFileKey, mergeDeviceMetadata, normalizeName } = require('../../shared/device-fields.cjs');
const { ADDRESS } = require('./records.cjs');

const findDevice = (state, address) => state.devices.find(device => device.bluetooth.address === address);

function enrollmentRequest(state, { address, name }) {
  const target = address == null ? undefined : String(address).toUpperCase();
  if (target && !ADDRESS.test(target)) throw Error('Identifiant Bluetooth invalide.');
  name = normalizeName(String(name ?? ''));
  const conflict = state.devices.some(device =>
    device.bluetooth.address !== target && deviceFileKey(device.name) === deviceFileKey(name));
  if (conflict) throw Error('Ce nom d’appareil est déjà utilisé.');
  return target ? { address: target, name } : { name };
}

function applyObservation(state, request, { event, metadata }, metadataFor) {
  const address = event?.address ?? metadata?.address;
  if (!address) return null;
  const existing = findDevice(state, address);
  const matched = event?.weight > 0
    && (request?.address ? request.address === address : request && !existing);
  if (!matched && !existing) return null;

  const captured = event?.weight > 0 ? buildDevice(matched ? request.name : existing.name, event, metadataFor(address)) : null;
  if (!existing) {
    const device = { ...captured, uuid: globalThis.crypto.randomUUID() };
    state.devices = [...state.devices, device];
    return device;
  }
  let bluetooth = existing.bluetooth;
  if (captured) {
    const observed = Object.fromEntries(Object.entries(captured.bluetooth).filter(([, value]) => value != null));
    bluetooth = { ...bluetooth, ...observed };
  }
  bluetooth = mergeDeviceMetadata({ bluetooth }, metadataFor(address) ?? {});
  const device = { ...existing, name: matched ? request.name : existing.name, bluetooth };
  if (JSON.stringify(device) !== JSON.stringify(existing)) {
    device.updatedAt = new Date().toISOString();
    state.devices = state.devices.map(candidate => candidate === existing ? device : candidate);
  }
  return matched ? device : null;
}

module.exports = { applyObservation, enrollmentRequest, findDevice };
