'use strict';

const globalKeys = ['selectedProfile', 'pending', 'addressFilter', 'anonymousPreferences', 'languagePreference'];
const dateTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/iu;

function validDate(value) {
  if (typeof value === 'string' ? !dateTime.test(value) : !Number.isSafeInteger(value)) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function creationDate(record) {
  return validDate(record?.createdAt) ?? validDate(record?.registeredAt)
    ?? validDate(record?.receivedAt) ?? validDate(record?.date);
}

function versionDate(record) {
  return validDate(record?.updatedAt) ?? creationDate(record);
}

function isNewer(candidate, current) {
  const candidateDate = versionDate(candidate);
  const currentDate = versionDate(current);
  return candidateDate !== undefined && (currentDate === undefined || candidateDate > currentDate);
}

function sameContent(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameContent(left[key], right[key]));
}

function stampRecord(record, previous, now = new Date().toISOString()) {
  const { createdAt, updatedAt, ...contents } = record;
  const modification = validDate(updatedAt);
  if (!previous) {
    return { ...contents, createdAt: creationDate(record) ?? now,
      ...(modification && { updatedAt: modification }) };
  }
  const { createdAt: oldCreation, updatedAt: oldUpdate, ...oldContents } = previous;
  if (sameContent(contents, oldContents)) {
    const recoveredCreation = validDate(createdAt);
    return recoveredCreation && !validDate(oldCreation) ? { ...previous, createdAt: recoveredCreation } : previous;
  }
  const previousTime = Date.parse(versionDate(previous));
  const nextTime = Number.isFinite(previousTime) ? Math.max(Date.parse(now), previousTime + 1) : Date.parse(now);
  return { ...contents, createdAt: creationDate(previous) ?? validDate(oldUpdate) ?? creationDate(record) ?? now,
    updatedAt: new Date(nextTime).toISOString() };
}

module.exports = { globalKeys, creationDate, versionDate, isNewer, sameContent, stampRecord };
