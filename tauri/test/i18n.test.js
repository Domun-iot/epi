import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chooseLocale, languages } from '../src/i18n.js';

test('matches account preferences, Google hints, browser languages and the OS in order', () => {
  assert.equal(chooseLocale({ preference: 'fr_CA', google: 'de', browser: ['fr-FR'], system: 'it' }), 'fr-CA');
  assert.equal(chooseLocale({ google: 'pt-BR', browser: ['fr-FR'], system: 'it' }), 'pt-PT');
  assert.equal(chooseLocale({ browser: ['ja', 'fr-CA'], system: 'it' }), 'fr-CA');
  assert.equal(chooseLocale({ browser: ['ja'], system: 'it-IT' }), 'it');
  assert.equal(chooseLocale({ browser: ['en-US'] }), 'en-GB');
  assert.equal(chooseLocale({ browser: ['ja'], system: 'zh-Hant' }), 'en-GB');
});

test('all official EU locales and Canadian French provide every message and its parameters', async () => {
  const expected = 'bg cs da de el en-GB es et fi fr-CA fr-FR ga hr hu it lt lv mt nl pl pt-PT ro sk sl sv'.split(' ');
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
