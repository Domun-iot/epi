'use strict';

const { createReceiver, isCompleteMeasurement } = require('../../shared/scales/adapter.js');
const { parseDeviceMetadata } = require('../../shared/device-fields.cjs');

const readingKey = ({ address, serviceUuid, scaleTime, weight, unit }) =>
  JSON.stringify([address, serviceUuid, scaleTime, weight, unit]);

function createAcquisition({ waitMs, dedupMs, settle, fail, onWeighing, bluetoothFor }) {
  const readings = new Map();
  const metadataByAddress = new Map();
  const receive = createReceiver({ raw: true,
    bluetoothFor: address => ({ ...bluetoothFor(address), ...metadataByAddress.get(address) }),
  });

  function observe(line, now) {
    const metadata = parseDeviceMetadata(line);
    const event = metadata ? null : receive(line, now);
    if (!metadata && !event) return {};
    if (metadata) {
      const { address, ...fields } = metadata;
      const previous = metadataByAddress.get(address);
      metadataByAddress.delete(address);
      if (metadataByAddress.size >= 256) metadataByAddress.delete(metadataByAddress.keys().next().value);
      metadataByAddress.set(address, { ...previous, ...fields });
    }
    return { event, metadata };
  }

  function accept(event, now) {
    if (!event.stable || event.removed || !(event.weight > 0)) return null;
    for (const [key, reading] of readings) {
      if (reading.committed && now - reading.lastSeen >= dedupMs) readings.delete(key);
    }
    const key = readingKey(event);
    let reading = readings.get(key);
    if (!reading) {
      reading = { event, committed: false };
      readings.set(key, reading);
      reading.timer = setTimeout(() => settle(reading).catch(fail), waitMs);
      reading.timer.unref?.();
    }
    reading.lastSeen = now;
    if (reading.committed) return null;
    onWeighing?.();
    if (event.impedanceOhms > 0) reading.event = event;
    return isCompleteMeasurement(event) || reading.expired ? reading : null;
  }

  function commit(reading) {
    reading.committed = true;
    clearTimeout(reading.timer);
  }

  return { observe, accept, commit,
    metadataFor: address => metadataByAddress.get(address) };
}

module.exports = { createAcquisition };
