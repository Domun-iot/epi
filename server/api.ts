import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
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

function credentials(body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const { password } = body;
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) ||
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

export function createApi(store: Store, now = Date.now) {
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
      if (req.url === '/v1/accounts' || req.url === '/v1/device-tokens') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': req.url === '/v1/accounts' ? 'POST' : 'POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          return res.end();
        }
      }
      if (route === 'POST /v1/accounts') {
        const { email, password } = credentials(await readBody(req));
        if (!store.createAccount(email, await hashPassword(password))) {
          throw new ApiError(409, 'account_exists');
        }
        return send(res, 201, { email });
      }

      if (route === 'POST /v1/device-tokens') {
        const body = await readBody(req);
        const { email, password } = credentials(body);
        const { deviceId } = body;
        if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(deviceId)) {
          throw new ApiError(400, 'invalid_device_id');
        }
        const account = store.findAccount(email);
        const verified = await verifyPassword(password, account?.password_hash ?? fallbackPasswordHash);
        if (!account || !verified) throw new ApiError(401, 'invalid_credentials');
        const selector = randomBytes(16).toString('hex');
        const secret = randomBytes(32).toString('hex');
        store.issueToken(account.id, deviceId, selector, hashToken(secret), now());
        return send(res, 200, { token: selector + '.' + secret });
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
