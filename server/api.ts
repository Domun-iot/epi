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
const domunAccountId = /^[a-f0-9]{32}$/u;
const domunEntitlement = /^\/v1\/domun\/accounts\/([a-f0-9]{32})\/entitlement$/u;
const domunTokenPattern = /^[a-f0-9]{64}$/u;
const utcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
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

const transactionName = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{6}Z-[0-9a-f-]{36}\.json$/u;
const pendingOverhead = '{"transactions":[],"next":""}'.length + 69;

function transactionRow(value: unknown) {
  if (!isObject(value) || !isUuid(value.uuid)) throw new ApiError(400, 'invalid_transaction');
  if (value.name !== undefined && (typeof value.name !== 'string' || !transactionName.test(value.name) ||
    !value.name.endsWith('-' + value.uuid + '.json'))) throw new ApiError(400, 'invalid_transaction');
  const payload = JSON.stringify(value);
  const overhead = value.name === undefined ? '{"transactions":[]}'.length : pendingOverhead;
  if (Buffer.byteLength(payload) > maxBodyBytes - overhead) {
    throw new ApiError(413, 'transaction_too_large');
  }
  return { uuid: value.uuid, payload };
}

async function uploadStream(req: IncomingMessage, store: Store, accountId: number, deviceId: string) {
  const uuids = new Set<string>();
  let inserted = 0;
  const rows: ReturnType<typeof transactionRow>[] = [];
  let batchBytes = 0;
  let parts: Buffer[] = [];
  let bytes = 0;

  function append(part: Buffer) {
    bytes += part.length;
    if (bytes > maxBodyBytes) throw new ApiError(413, 'transaction_too_large');
    parts.push(part);
  }

  function flush() {
    if (!rows.length) return;
    const result = store.upload(accountId, deviceId, rows);
    inserted += result.inserted;
    for (const uuid of result.uuids) uuids.add(uuid);
    rows.length = 0;
    batchBytes = 0;
  }

  function save() {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes)));
    } catch {
      throw new ApiError(400, 'invalid_json');
    }
    if (batchBytes + bytes > maxBodyBytes) flush();
    rows.push(transactionRow(value));
    batchBytes += bytes;
    if (rows.length === maxBatchSize) flush();
    parts = [];
    bytes = 0;
  }

  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      append(chunk.subarray(start, end));
      save();
      start = end + 1;
    }
    if (start < chunk.length) append(chunk.subarray(start));
  }
  if (bytes) save();
  flush();
  return { inserted, uuids: [...uuids] };
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
    const regionalId = `${language}-${region}`;
    if (Object.hasOwn(googleReturn, regionalId)) return regionalId as Locale;
    const id = language === 'en' ? 'en-GB' : language === 'pt' ? 'pt-PT'
      : language === 'fr' ? 'fr-FR' : language;
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

function isPaid(account: Account, now: number) {
  return account.paid_until !== null && Date.parse(account.paid_until) > now;
}

function accountInfo(account: Account, now: number) {
  return {
    email: account.email, googleLinked: Boolean(account.google_sub), hasPassword: Boolean(account.password_hash),
    ...accountLanguages(account),
    paid: isPaid(account, now),
    ...(account.created_at && { createdAt: account.created_at }),
    ...(account.updated_at && { updatedAt: account.updated_at }),
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

const closeGoogleWindow = 'window.close();';
const googleReturnStyle = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body {
    display: grid; place-items: center; box-sizing: border-box; min-height: 100svh;
    margin: 0; padding: 1.25rem; background: #eef3f1; color: #183429;
  }
  main {
    box-sizing: border-box; width: min(100%, 28rem); padding: clamp(1.75rem, 7vw, 3rem);
    text-align: center; background: #fff; border: 1px solid #dbe7e0; border-radius: 1.5rem;
    box-shadow: 0 1rem 3rem #18342912;
  }
  h1 { margin: 0 0 1rem; font-size: 2.75rem; letter-spacing: -0.07em; color: #215d45; }
  p { margin: 0; font-size: 1.0625rem; line-height: 1.6; }
  @media (prefers-color-scheme: dark) {
    body { background: #12231c; color: #e3efe8; }
    main { background: #1a3026; border-color: #395447; }
    h1 { color: #a8dfc0; }
  }
`;

function cspHash(text: string) {
  return "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";
}

const googleReturnCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; " +
  'style-src ' + cspHash(googleReturnStyle) + '; script-src ' + cspHash(closeGoogleWindow);

function browserResult(res: ServerResponse, succeeded: boolean, locale: Locale) {
  res.writeHead(succeeded ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': googleReturnCsp,
  });
  const message = googleReturn[locale][succeeded ? 0 : 1];
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  res.end('<!doctype html><html lang="' + locale +
    '"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>éPI</title>' +
    '<style>' + googleReturnStyle + '</style><main><h1>éPI</h1><p>' + escaped + '</p></main>' +
    '<script>' + closeGoogleWindow + '</script></html>');
}

export function createApi(store: Store, now = Date.now, google?: Google,
  publicPages?: (path: string, res: ServerResponse) => boolean, domunToken?: string) {
  if (domunToken && !domunTokenPattern.test(domunToken)) {
    throw new Error('EPI_DOMUN_API_TOKEN must contain 64 lowercase hexadecimal characters');
  }
  const domunSecret = domunToken ? Buffer.from(domunToken, 'hex') : undefined;

  async function handleDomun(req: IncomingMessage, res: ServerResponse, path: string, query?: string) {
    if (!domunSecret) throw new ApiError(404, 'not_found');
    const token = /^Bearer ([0-9a-f]{64})$/iu.exec(req.headers.authorization ?? '');
    if (!token || !timingSafeEqual(domunSecret, Buffer.from(token[1], 'hex'))) {
      throw new ApiError(401, 'invalid_token');
    }
    if (req.method === 'GET' && path === '/v1/domun/accounts') {
      const after = new URLSearchParams(query).get('after') ?? '';
      if (after && !domunAccountId.test(after)) throw new ApiError(400, 'invalid_cursor');
      const accounts = store.listDomunAccounts(after, maxBatchSize + 1);
      const hasNext = accounts.length > maxBatchSize;
      if (hasNext) accounts.pop();
      return send(res, 200, { accounts, next: hasNext ? accounts.at(-1)!.id : null });
    }
    const entitlement = domunEntitlement.exec(path);
    if (req.method === 'PUT' && entitlement) {
      const { paidUntil } = await readBody(req);
      if (paidUntil !== null) {
        const time = typeof paidUntil === 'string' && utcTimestamp.test(paidUntil) ? Date.parse(paidUntil) : NaN;
        if (typeof paidUntil !== 'string' || !Number.isFinite(time) || new Date(time).toISOString() !== paidUntil) {
          throw new ApiError(400, 'invalid_paid_until');
        }
      }
      if (!store.updateEntitlement(entitlement[1], paidUntil)) throw new ApiError(404, 'account_not_found');
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    throw new ApiError(404, 'not_found');
  }
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
      const [path, query] = (req.url ?? '').split('?', 2);
      if (path.startsWith('/v1/domun/')) return await handleDomun(req, res, path, query);
      if (req.method === 'GET' && publicPages?.(path, res)) return;
      if (path === '/v1/accounts' || path === '/v1/device-tokens' ||
          path === '/v1/account' || path === '/v1/transactions' || path === '/v1/transactions/pending' ||
          path === '/v1/transactions/acknowledge' || path.startsWith('/v1/google/')) {
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
        return send(res, 200, { ...accountInfo(currentAccount(req), now()), googleAvailable: Boolean(google) });
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
        return send(res, 200, accountInfo(store.findById(account.id)!, now()));
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
          return send(res, 200, accountInfo(store.findById(account.id)!, now()));
        }
        if (action.kind === 'unlink') {
          const { account } = action;
          if (identity.sub !== account.google_sub) throw new ApiError(401, 'google_wrong_account');
          if (!store.unlinkGoogle(account.id, identity.sub, account.password_hash, action.newHash)) {
            throw new ApiError(409, 'google_conflict');
          }
          return send(res, 200, accountInfo(store.findById(account.id)!, now()));
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
          account = store.findById(account.id)!;
        }
        return send(res, 200, { ...accountInfo(account, now()), token: issueToken(account, action.deviceId) });
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
        return send(res, 200, { token: issueToken(account, deviceId), ...accountLanguages(account), paid: isPaid(account, now()) });
      }

      if (route === 'DELETE /v1/device-tokens') {
        const { selector, hash } = readToken(req);
        store.revokeToken(selector, hash);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (req.method === 'GET' && path === '/v1/transactions/pending') {
        const { account_id, device_id } = authenticate(req, store, now());
        const transactions: string[] = [];
        const envelope = '{"transactions":[';
        const after = new URLSearchParams(query).get('after') ?? '';
        if (after && !transactionName.test(after) && !/^~\d{20}$/u.test(after)) {
          throw new ApiError(400, 'invalid_cursor');
        }
        let bytes = pendingOverhead;
        let position = '';
        let next: string | null = null;
        for (const { payload, position: rowPosition } of store.pending(account_id, device_id, after, maxBatchSize + 1)) {
          const size = Buffer.byteLength(payload) + Number(transactions.length > 0);
          if (transactions.length === maxBatchSize || (transactions.length && bytes + size > maxBodyBytes)) {
            next = position;
            break;
          }
          bytes += size;
          transactions.push(payload);
          position = rowPosition;
        }
        return sendJson(res, 200, envelope + transactions.join(',') + '],"next":' + JSON.stringify(next) + '}');
      }

      if (route === 'POST /v1/transactions') {
        const { account_id, device_id } = authenticate(req, store, now());
        const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (contentType === 'application/x-ndjson') {
          return send(res, 200, await uploadStream(req, store, account_id, device_id));
        }
        const body = await readBody(req);
        const rows = batch(body.transactions).map(transactionRow);
        return send(res, 200, store.upload(account_id, device_id, rows));
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
