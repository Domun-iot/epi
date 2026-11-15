import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApi } from './dist/api.js';
import { googleFromEnvironment } from './dist/google.js';
import { openStore } from './dist/store.js';

test('the Google provider binds the authorization code to PKCE and verifies the ID token received over HTTPS', async t => {
  const google = googleFromEnvironment({
    EPI_GOOGLE_CLIENT_ID: 'test-id',
    EPI_GOOGLE_CLIENT_SECRET: 'test-secret',
    EPI_GOOGLE_REDIRECT_URI: 'https://sync.example.org/v1/google/callback',
  });
  const url = new URL(google.authorize('test-state', 'test-verifier'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('state'), 'test-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(url.searchParams.get('code_challenge'), 'test-verifier');

  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com', aud: 'test-id', nonce: url.searchParams.get('nonce'),
    iat, exp: iat + 300, sub: 'google-user', email: 'user@example.org', email_verified: false, locale: 'fr-CA',
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('code'), 'test-code');
    assert.equal(options.body.get('code_verifier'), 'test-verifier');
    assert.equal(options.body.get('client_secret'), 'test-secret');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return Response.json({ id_token: 'header.' + payload + '.signature' });
  });
  assert.deepEqual(await google.identify('test-code', 'test-verifier'), { sub: 'google-user', email: undefined, locale: 'fr-CA' });
  claims.nonce = 'another-request';
  await assert.rejects(google.identify('test-code', 'test-verifier'), /Invalid Google identity/);
});

test('Google registration, linking and unlinking preserve local accounts and require fresh proof', async t => {
  const store = openStore(':memory:');
  const identities = new Map([
    ['alice', { sub: 'a', email: 'alice@example.org', locale: 'fr-CA' }],
    ['alice-changed', { sub: 'a', email: 'changed@example.org' }],
    ['bob', { sub: 'b', email: 'bob@example.org' }],
    ['collision', { sub: 'c', email: 'bob@example.org' }],
    ['unverified', { sub: 'd' }],
  ]);
  let time = Date.now();
  const google = {
    authorize: state => 'https://accounts.google.com/test?state=' + state,
    identify: async code => {
      const identity = identities.get(code);
      assert.ok(identity);
      return identity;
    },
  };
  const server = createApi(store, () => time, google);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = 'http://127.0.0.1:' + server.address().port + '/v1/';

  async function request(route, body, status = 200, token) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(root + route, { method: body ? 'POST' : 'GET', headers, body: JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json;
  }
  async function start(action, fields, token) {
    const { state, secret } = await request('google/start', { action, ...fields }, 200, token);
    return { state, secret };
  }
  async function callback({ state }, code, expected = 200, locale = 'en-GB') {
    const res = await fetch(root + 'google/callback?' + new URLSearchParams({ state, code }));
    assert.equal(res.status, expected);
    assert.match(await res.text(), new RegExp('lang="' + locale + '"'));
  }
  async function flow(action, code, status = 200, fields = { deviceId: 'google' }, token) {
    const proof = await start(action, fields, token);
    await callback(proof, code);
    return request('google/finish', proof, status, token);
  }

  const bob = { email: 'bob@example.org', password: 'bob-password', locale: 'pt-PT' };
  await request('accounts', bob, 201);
  const bobSession = await request('device-tokens', { ...bob, deviceId: 'pc' });
  assert.equal(bobSession.locale, 'pt-PT');
  const { token: bobToken } = bobSession;
  assert.equal((await flow('register', 'collision', 409)).error, 'account_exists');
  assert.equal((await flow('register', 'unverified', 400)).error, 'google_unverified_email');

  const proof = await start('register', { deviceId: 'google', locale: 'de', interfaceLocale: 'fr-CA' });
  assert.deepEqual(await request('google/finish', proof, 202), { pending: true });
  await callback(proof, 'alice', 200, 'fr-CA');
  await callback(proof, 'bob', 400, 'fr-CA');
  await request('google/finish', { ...proof, secret: '0'.repeat(64) }, 400);
  const alice = await request('google/finish', proof);
  assert.equal(alice.email, 'alice@example.org');
  assert.equal(alice.hasPassword, false);
  assert.equal(alice.locale, 'de');
  assert.equal(alice.googleLocale, 'fr-CA');
  await request('google/finish', proof, 400);
  await request('device-tokens', { email: alice.email, password: 'guess', deviceId: 'pc' }, 401);
  assert.equal((await flow('login', 'alice-changed')).email, alice.email);

  const password = 'new-alice-password';
  const { token: aliceToken } = await flow('login', 'alice', 200, { deviceId: 'phone' });
  await request('google/unlink', { password }, 409, aliceToken);
  assert.equal((await flow('unlink', 'bob', 401, { password }, aliceToken)).error, 'google_wrong_account');
  const updated = await flow('unlink', 'alice', 200, { password }, aliceToken);
  assert.equal(updated.googleLinked, false);
  assert.equal(updated.hasPassword, true);
  assert.equal(updated.locale, 'de');
  assert.equal(updated.googleLocale, undefined);
  await flow('login', 'alice', 404);
  await request('device-tokens', { email: alice.email, password, deviceId: 'pc' });

  await request('google/start', { action: 'link', password: 'invalid' }, 401, bobToken);
  const linking = await start('link', { password: bob.password }, bobToken);
  await callback(linking, 'bob');
  await request('google/finish', linking, 401, aliceToken);
  assert.equal((await request('google/finish', linking, 200, bobToken)).googleLinked, true);
  assert.equal((await flow('login', 'bob')).email, bob.email);
  await request('device-tokens', { ...bob, deviceId: 'backup' });
  assert.equal((await request('google/unlink', { password: bob.password }, 200, bobToken)).googleLinked, false);
  await flow('login', 'bob', 404);

  const expired = await start('login', { deviceId: 'google' });
  time += 5 * 60 * 1000;
  await callback(expired, 'alice', 400);
  assert.equal((await request('google/finish', expired, 400)).error, 'google_attempt_expired');
});
