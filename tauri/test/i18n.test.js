import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chooseLocale, languages, localizeMessage, t } from '../src/i18n.js';

test('matches account preferences, Google hints, browser languages and the OS in order', () => {
  assert.equal(chooseLocale({ preference: 'fr_CA', google: 'de', browser: ['fr-FR'], system: 'it' }), 'fr-CA');
  assert.equal(chooseLocale({ google: 'pt-BR', browser: ['fr-FR'], system: 'it' }), 'pt-PT');
  assert.equal(chooseLocale({ browser: ['ja', 'fr-CA'], system: 'it' }), 'fr-CA');
  assert.equal(chooseLocale({ browser: ['ja'], system: 'it-IT' }), 'it');
  assert.equal(chooseLocale({ browser: ['en-US'] }), 'en-US');
  assert.equal(chooseLocale({ preference: 'en_US', browser: ['en-GB'] }), 'en-US');
  assert.equal(chooseLocale({ browser: ['ja'], system: 'zh-Hant' }), 'en-GB');
});

test('all supported locales provide every message and its parameters', async () => {
  const expected = 'bg cs da de el en-GB en-US es et fi fr-CA fr-FR ga hr hu it lt lv mt nl pl pt-PT ro sk sl sv'.split(' ');
  assert.deepEqual(Object.keys(languages).sort(), expected);
  const read = async locale => JSON.parse(await readFile(new URL('../src/locales/' + locale + '.json', import.meta.url)));
  const english = await read('en-GB');
  const keys = Object.keys(english).sort();
  const parameters = message => [...message.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const locale of expected) {
    const catalog = await read(locale);
    assert.deepEqual(Object.keys(catalog).sort(), keys, locale);
    for (const key of keys) {
      assert.ok(catalog[key].trim().length, locale + ': ' + key);
      assert.deepEqual(parameters(catalog[key]), parameters(english[key]), locale + ': ' + key);
    }
  }
});


// Identical terms are valid only when reviewed for the specified languages.
const sharedTerms = {
  bmiShort: 'cs da de fi ga hr hu it mt nl pl sk sl sv',
  'metric.bmi': 'cs da de fi ga hr hu it mt nl pl sk sl sv',
  data: 'cs da fi mt sv', exportZip: 'fr-CA fr-FR', importZip: 'fr-CA fr-FR',
  impedanceOhms: 'cs ga', model: 'cs da hr nl ro sk sl',
  trend: 'cs da de et hr hu nl pl ro sk sl sv',
  service: 'da de fr-CA fr-FR sv', unknownService: 'da fr-CA fr-FR sv',
  name: 'de', no: 'es it', reloadNotification: 'fr-CA fr-FR', date: 'fr-CA fr-FR',
  notifications: 'fr-CA fr-FR', visible: 'fr-CA fr-FR', visualisation: 'fr-CA fr-FR',
  bluetoothSignalDbm: 'hr sl', password: 'mt', period: 'sv',
};
const invariantNames = new Set(['freePlan', 'proPlan', 'method.Sun', 'method.Jan', 'method.Deu', 'method.CUN', 'method.Wat', 'method.MSJ']);

test('catalogues contain no duplicate keys or unreviewed English copies', async () => {
  const read = async locale => readFile(new URL('../src/locales/' + locale + '.json', import.meta.url), 'utf8');
  const english = JSON.parse(await read('en-GB'));
  for (const locale of Object.keys(languages)) {
    const source = await read(locale);
    // Catalogues are deliberately flat. A second member on one line must count too.
    const members = [...source.matchAll(/(?:^|[,\n])\s*"([^"\n]+)"\s*:/g)].map(match => match[1]);
    assert.equal(new Set(members).size, members.length, locale + ': duplicate key');
    const catalog = JSON.parse(source);
    assert.equal(members.length, Object.keys(catalog).length, locale + ': flat catalogue');
    for (const [key, message] of Object.entries(catalog)) {
      assert.equal(typeof message, 'string', locale + ': ' + key);
      if (locale.startsWith('en-') || message !== english[key]) continue;
      assert.ok(invariantNames.has(key) || sharedTerms[key]?.split(' ').includes(locale), locale + ': untranslated ' + key);
    }
  }
});

test('literal UI keys, diagnostic identifiers, legacy aliases and computed metric keys exist', async () => {
  const { readdir } = await import('node:fs/promises');
  const { default: composition } = await import('../../shared/composition.cjs');
  const read = file => readFile(new URL(file, import.meta.url), 'utf8');
  const english = JSON.parse(await read('../src/locales/en-GB.json'));
  const legacy = JSON.parse(await read('../src/locales/legacy.json'));
  for (const key of Object.values(legacy)) assert.ok(Object.hasOwn(english, key), key);
  for (const [id] of composition.columns) assert.ok(Object.hasOwn(english, 'method.' + id.replace('*', '')), id);
  for (const [id] of composition.metrics) assert.ok(Object.hasOwn(english, 'metric.' + id), id);
  const files = ['../index.html'];
  for (const directory of ['../src/', '../domain/', '../src-tauri/src/']) {
    for (const entry of await readdir(new URL(directory, import.meta.url), { recursive: true })) {
      if (/\.(?:js|cjs|rs)$/.test(entry) && !entry.includes('.test.')) files.push(directory + entry.replaceAll('\\', '/'));
    }
  }
  for (const file of files) {
    const source = await read(file);
    const patterns = [
      /\b(?:t|htmlText|messageCode)\(\s*['"]([\w.]+)['"]\s*[,)]/g,
      /data-i18n(?:-[\w-]+)?="([\w.]+)"/g,
      /epi-i18n:([\w.]+)/g,
    ];
    for (const [, key, suffix] of source.matchAll(/epi-i18n:([\w.]+)([^'"\n]*)/g)) {
      if (english[key]?.includes('{detail}')) assert.ok(suffix.includes(' · '), file + ': missing detail for ' + key);
    }
    for (const pattern of patterns) for (const [, key] of source.matchAll(pattern)) {
      assert.ok(Object.hasOwn(english, key), file + ': ' + key);
    }
  }
});

test('owned storage diagnostics are translated without changing paths or third-party errors', () => {
  assert.equal(localizeMessage('dataset_locked'), t('localAccountRequired'));
  assert.equal(localizeMessage('installation_busy'), t('diagnostic.installationBusy'));
  assert.equal(localizeMessage('The active dataset changed.'), t('diagnostic.theDataHasChangedReloadThe'));
  assert.equal(localizeMessage('Invalid snapshot record.'), t('diagnostic.invalidLocalData'));
  assert.equal(localizeMessage('Ambiguous interrupted migration: local'), t('diagnostic.dataMigrationFailed'));
  assert.equal(localizeMessage('profiles/unchanged.json · Objet JSON attendu.'), 'profiles/unchanged.json · ' + t('diagnostic.expectedJsonObject2'));
  assert.equal(localizeMessage('Invalid data path: ../unchanged'), t('diagnostic.invalidDataPath', { detail: '../unchanged' }));
  assert.equal(localizeMessage('External error · Sensor disconnected'), 'External error · Sensor disconnected');
  assert.equal(localizeMessage('epi-i18n:bluetoothUnavailable · epi-i18n:diagnostic.bluetoothStreamWasInterrupted'), t('bluetoothUnavailable', { detail: t('diagnostic.bluetoothStreamWasInterrupted') }));
});


test('owned literal storage and domain errors have a translation mapping', async () => {
  const { readdir } = await import('node:fs/promises');
  const legacy = JSON.parse(await readFile(new URL('../src/locales/legacy.json', import.meta.url), 'utf8'));
  const templates = Object.keys(legacy).filter(key => key.includes('{detail}')).map(key => key.split('{detail}')[0]);
  const files = ['../../shared/profile-fields.cjs', '../../shared/device-fields.cjs', '../../shared/transactions.cjs',
    '../../shared/account-storage.cjs', '../../shared/installation-lock.cjs', '../../web/session-api.js',
    '../../web/local-api.js', '../../web/file-records.js', '../src/dataset-controller.js',
    '../src/storage/browser-storage.js', '../src/storage/snapshot-files.js'];
  for (const name of await readdir(new URL('../domain/', import.meta.url))) {
    if (name.endsWith('.cjs') && !name.includes('.test.')) files.push('../domain/' + name);
  }
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [, , message] of source.matchAll(/(?:new\s+)?Error\(\s*(['"])(.*?)\1/g)) {
      assert.ok(message.startsWith('epi-i18n:') || Object.hasOwn(legacy, message) || templates.some(prefix => message.startsWith(prefix)), file + ': ' + message);
    }
  }
});
