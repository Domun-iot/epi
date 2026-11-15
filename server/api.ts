import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import googleReturn from './google-return.json' with { type: 'json' };
import { randomSecret, type Google, type GoogleIdentity } from './google.ts';
import type { openStore } from './store.ts';

type Store = ReturnType<typeof openStore>;

const deriveKey = promisify(scrypt);
const fallbackPasswordHash = '0'.repeat(32) + ':' + '0'.repeat(128);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const maxBodyBytes = 4 * 1024 * 1024;
const maxBatchSize = 100;
const hour = 60 * 60 * 1000;
export const tokenLifetime = 30 * 24 * hour;

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && uuidPattern.test(value);
}

async function readBody(req: IncomingMessage) {
  const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(415, 'expected_json');
  if (Number(req.headers['content-length']) > maxBodyBytes) throw new ApiError(413, 'body_too_large');

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new ApiError(413, 'body_too_large');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
  if (!isObject(body)) throw new ApiError(400, 'invalid_body');
  return body;
}

function validEmail(email: string) {
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email);
}

function deviceIdFrom(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new ApiError(400, 'invalid_device_id');
  }
  return value;
}

function credentials(body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const { password } = body;
  if (!validEmail(email) ||
      typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) {
    throw new ApiError(400, 'invalid_credentials_format');
  }
  return { email, password };
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64) as Buffer;
  return salt.toString('hex') + ':' + key.toString('hex');
}

async function verifyPassword(password: string, hash: string) {
  const [salt, key] = hash.split(':');
  return timingSafeEqual(await deriveKey(password, Buffer.from(salt, 'hex'), 64) as Buffer,
    Buffer.from(key, 'hex'));
}

function hashToken(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

function readToken(req: IncomingMessage) {
  const token = /^Bearer ([0-9a-f]{32})\.([0-9a-f]{64})$/i.exec(req.headers.authorization ?? '');
  if (!token) throw new ApiError(401, 'invalid_token');
  const [, selector, secret] = token;
  return { selector, hash: hashToken(secret) };
}

function authenticate(req: IncomingMessage, store: Store, now: number) {
  const { selector, hash } = readToken(req);
  const cutoff = now - tokenLifetime;
  const device = store.useToken(now, selector, hash, cutoff);
  if (device) return device;
  if (store.expireToken(selector, hash, cutoff)) throw new ApiError(401, 'token_expired');
  throw new ApiError(401, 'invalid_token');
}

function sendJson(res: ServerResponse, status: number, json: string) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function send(res: ServerResponse, status: number, body: object) {
  sendJson(res, status, JSON.stringify(body));
}

function batch(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > maxBatchSize) throw new ApiError(400, 'invalid_batch');
  return value;
}

type Account = NonNullable<ReturnType<Store['findById']>>;
type GoogleAction =
  | { kind: 'login' | 'register'; deviceId: string; locale: string | null }
  | { kind: 'link'; account: Account }
  | { kind: 'unlink'; account: Account; newHash: string };

type GoogleAttempt = {
  action: GoogleAction;
  verifier: string;
  locale: Locale;
  secretHash: string;
  expires: number;
  status: 'pending' | 'exchanging' | 'failed' | 'ready';
  identity?: GoogleIdentity;
};

type Locale = keyof typeof googleReturn;

function supportedLocale(value: unknown): Locale | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  try {
    const { language, region } = new Intl.Locale(value.replaceAll('_', '-'));
    const id = language === 'en' ? 'en-GB' : language === 'pt' ? 'pt-PT'
      : language === 'fr' ? (region === 'CA' ? 'fr-CA' : 'fr-FR') : language;
    return Object.hasOwn(googleReturn, id) ? id as Locale : null;
  } catch {
    return null;
  }
}

function accountLanguages(account: Account) {
  return {
    ...(account.locale && { locale: account.locale }),
    ...(account.google_locale && { googleLocale: account.google_locale }),
  };
}

function accountInfo(account: Account) {
  return {
    email: account.email, googleLinked: Boolean(account.google_sub), hasPassword: Boolean(account.password_hash),
    ...accountLanguages(account),
  };
}

async function checkPassword(password: unknown, hash: string) {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
    throw new ApiError(400, 'invalid_credentials_format');
  }
  if (!(await verifyPassword(password, hash || fallbackPasswordHash)) || !hash) {
    throw new ApiError(401, 'invalid_credentials');
  }
}

function browserResult(res: ServerResponse, succeeded: boolean, locale: Locale) {
  res.writeHead(succeeded ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  const message = googleReturn[locale][succeeded ? 0 : 1];
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  res.end('<!doctype html><html lang="' + locale +
    '"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>éPI</title><h1>éPI</h1><p>' +
    escaped + '</p></html>');
}

export function createApi(store: Store, now = Date.now, google?: Google) {
  const attempts = new Map<string, GoogleAttempt>();
  const cleanupAttempts = () => {
    for (const [state, attempt] of attempts) {
      if (attempt.expires <= now()) attempts.delete(state);
    }
  };

  function currentAccount(req: IncomingMessage) {
    const { account_id } = authenticate(req, store, now());
    const account = store.findById(account_id);
    if (!account) throw new ApiError(401, 'invalid_token');
    return account;
  }

  function issueToken(account: Account, deviceId: string) {
    const selector = randomBytes(16).toString('hex');
    const secret = randomSecret();
    store.issueToken(account.id, deviceId, selector, hashToken(secret), now());
    return selector + '.' + secret;
  }

  const sweep = () => store.expireTokens(now() - tokenLifetime);
  sweep();
  const timer = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      console.error(error);
    }
  }, hour).unref();

  const server = createServer({ requestTimeout: 30_000 }, async (req, res) => {
    try {
      const route = req.method + ' ' + req.url;
      if (req.url === '/v1/accounts' || req.url === '/v1/device-tokens' ||
          req.url === '/v1/account' || req.url?.startsWith('/v1/google/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          return res.end();
        }
      }
      if (route === 'GET /v1/account') {
        return send(res, 200, { ...accountInfo(currentAccount(req)), googleAvailable: Boolean(google) });
      }
      if (route === 'GET /v1/google/config') {
        return send(res, 200, { enabled: Boolean(google) });
      }
      if (route === 'POST /v1/google/unlink') {
        const account = currentAccount(req);
        const { password } = await readBody(req);
        if (!account.google_sub) throw new ApiError(409, 'google_not_linked');
        if (!account.password_hash) throw new ApiError(409, 'google_password_required');
        await checkPassword(password, account.password_hash);
        if (!store.unlinkGoogle(account.id, account.google_sub, account.password_hash, account.password_hash)) {
          throw new ApiError(409, 'google_conflict');
        }
        return send(res, 200, { ...accountInfo({ ...account, google_sub: null, google_locale: null }) });
      }
      if (route === 'POST /v1/google/start') {
        if (!google) throw new ApiError(503, 'google_disabled');
        const body = await readBody(req);
        let action: GoogleAction;
        if (body.action === 'login' || body.action === 'register') {
          action = { kind: body.action, deviceId: deviceIdFrom(body.deviceId), locale: supportedLocale(body.locale) };
        } else if (body.action === 'link') {
          const account = currentAccount(req);
          if (account.google_sub) throw new ApiError(409, 'google_conflict');
          await checkPassword(body.password, account.password_hash);
          action = { kind: 'link', account };
        } else if (body.action === 'unlink') {
          const account = currentAccount(req);
          if (!account.google_sub || account.password_hash) throw new ApiError(409, 'google_conflict');
          const { password } = body;
          if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
            throw new ApiError(400, 'invalid_credentials_format');
          }
          action = { kind: 'unlink', account, newHash: await hashPassword(password) };
        } else {
          throw new ApiError(400, 'invalid_google_action');
        }
        cleanupAttempts();
        if (attempts.size >= 1000) throw new ApiError(503, 'google_busy');
        const state = randomSecret();
        const secret = randomSecret();
        const verifier = randomSecret();
        attempts.set(state, { action, verifier, locale: supportedLocale(body.interfaceLocale) ?? 'en-GB', secretHash: hashToken(secret),
          expires: now() + 5 * 60 * 1000, status: 'pending' });
        return send(res, 200, { state, secret, url: google.authorize(state, verifier) });
      }
      if (req.method === 'GET' && req.url?.split('?')[0] === '/v1/google/callback') {
        cleanupAttempts();
        const query = new URLSearchParams(req.url.split('?')[1]);
        const state = query.get('state');
        const attempt = state && attempts.get(state);
        const locale = attempt ? attempt.locale : req.headers['accept-language']?.split(',')
          .map(value => supportedLocale(value.split(';')[0].trim())).find(Boolean) ?? 'en-GB';
        if (!google || !attempt || attempt.status !== 'pending') return browserResult(res, false, locale);
        const code = query.get('code');
        if (!code || query.has('error')) {
          attempt.status = 'failed';
          return browserResult(res, false, locale);
        }
        attempt.status = 'exchanging';
        try {
          attempt.identity = await google.identify(code, attempt.verifier);
          if (attempt.expires <= now()) return browserResult(res, false, locale);
          attempt.status = 'ready';
          return browserResult(res, true, locale);
        } catch {
          attempt.status = 'failed';
          return browserResult(res, false, locale);
        }
      }
      if (route === 'POST /v1/google/finish') {
        const { state, secret } = await readBody(req);
        cleanupAttempts();
        const attempt = typeof state === 'string' ? attempts.get(state) : undefined;
        if (!attempt || typeof secret !== 'string' || !/^[0-9a-f]{64}$/u.test(secret) ||
            !timingSafeEqual(Buffer.from(attempt.secretHash, 'hex'), Buffer.from(hashToken(secret), 'hex'))) {
          throw new ApiError(400, 'google_attempt_expired');
        }
        const { action, identity } = attempt;
        if ('account' in action && currentAccount(req).id !== action.account.id) {
          throw new ApiError(401, 'invalid_token');
        }
        if (attempt.status === 'pending' || attempt.status === 'exchanging') return send(res, 202, { pending: true });
        attempts.delete(state as string);
        if (!identity || attempt.status !== 'ready') throw new ApiError(401, 'google_failed');
        const googleLocale = supportedLocale(identity.locale);
        if (action.kind === 'link') {
          const { account } = action;
          if (!store.linkGoogle(account.id, identity.sub, account.password_hash, googleLocale)) {
            throw new ApiError(409, 'google_conflict');
          }
          return send(res, 200, { ...accountInfo({ ...account, google_sub: identity.sub, google_locale: googleLocale }) });
        }
        if (action.kind === 'unlink') {
          const { account } = action;
          if (identity.sub !== account.google_sub) throw new ApiError(401, 'google_wrong_account');
          if (!store.unlinkGoogle(account.id, identity.sub, account.password_hash, action.newHash)) {
            throw new ApiError(409, 'google_conflict');
          }
          return send(res, 200, { ...accountInfo({ ...account, google_sub: null, google_locale: null }), hasPassword: true });
        }
        let account = store.findGoogle(identity.sub);
        if (!account && action.kind === 'register') {
          const email = identity.email?.trim().toLowerCase() ?? '';
          if (!validEmail(email)) throw new ApiError(400, 'google_unverified_email');
          account = store.createGoogle(email, identity.sub, action.locale, googleLocale) ?? store.findGoogle(identity.sub);
          if (!account) throw new ApiError(409, 'account_exists');
        }
        if (!account) throw new ApiError(404, 'google_not_linked');
        if (googleLocale && googleLocale !== account.google_locale) {
          store.updateGoogleLocale(account.id, identity.sub, googleLocale);
          account.google_locale = googleLocale;
        }
        return send(res, 200, { ...accountInfo(account), token: issueToken(account, action.deviceId) });
      }
      if (route === 'POST /v1/accounts') {
        const body = await readBody(req);
        const { email, password } = credentials(body);
        if (!store.createAccount(email, await hashPassword(password), supportedLocale(body.locale))) {
          throw new ApiError(409, 'account_exists');
        }
        return send(res, 201, { email });
      }

      if (route === 'POST /v1/device-tokens') {
        const body = await readBody(req);
        const { email, password } = credentials(body);
        const deviceId = deviceIdFrom(body.deviceId);
        const account = store.findAccount(email);
        await checkPassword(password, account?.password_hash ?? '');
        if (!account) throw new ApiError(401, 'invalid_credentials');
        return send(res, 200, { token: issueToken(account, deviceId), ...accountLanguages(account) });
      }

      if (route === 'DELETE /v1/device-tokens') {
        const { selector, hash } = readToken(req);
        store.revokeToken(selector, hash);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (route === 'GET /v1/transactions/pending') {
        const { account_id, device_id } = authenticate(req, store, now());
        const transactions: string[] = [];
        const envelope = '{"transactions":[';
        let bytes = envelope.length + 2;
        for (const { payload } of store.pending(account_id, device_id, maxBatchSize)) {
          const size = Buffer.byteLength(payload) + Number(transactions.length > 0);
          if (bytes + size > maxBodyBytes) break;
          bytes += size;
          transactions.push(payload);
        }
        return sendJson(res, 200, envelope + transactions.join(',') + ']}');
      }

      if (route === 'POST /v1/transactions') {
        const body = await readBody(req);
        const { account_id } = authenticate(req, store, now());
        const rows = batch(body.transactions).map(value => {
          if (!isObject(value) || !isUuid(value.uuid)) throw new ApiError(400, 'invalid_transaction');
          const payload = JSON.stringify(value);
          if (Buffer.byteLength(payload) > maxBodyBytes - '{"transactions":[]}'.length) {
            throw new ApiError(413, 'transaction_too_large');
          }
          return { uuid: value.uuid, payload };
        });
        return send(res, 200, { inserted: store.upload(account_id, rows) });
      }

      if (route === 'POST /v1/transactions/acknowledge') {
        const body = await readBody(req);
        const { account_id, device_id } = authenticate(req, store, now());
        const uuids = batch(body.uuids);
        if (!uuids.every(isUuid)) throw new ApiError(400, 'invalid_uuid');
        return send(res, 200, { inserted: store.acknowledge(account_id, device_id, uuids) });
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      if (!req.complete) res.setHeader('Connection', 'close');
      if (error instanceof ApiError) return send(res, error.status, { error: error.code });
      console.error(error);
      send(res, 500, { error: 'internal_error' });
    }
  });
  server.once('close', () => clearInterval(timer));
  return server;
}
