import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';

export function openStore(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS devices (
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      device_id TEXT NOT NULL,
      token_selector TEXT NOT NULL UNIQUE,
      token_hash TEXT,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, device_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS devices_expiry ON devices(last_used_at)
      WHERE token_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS transactions (
      sequence INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      uuid TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE (account_id, uuid)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS transactions_order ON transactions(account_id, sequence);
    CREATE TABLE IF NOT EXISTS receipts (
      account_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      uuid TEXT NOT NULL,
      PRIMARY KEY (account_id, device_id, uuid),
      FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, device_id),
      FOREIGN KEY (account_id, uuid) REFERENCES transactions(account_id, uuid)
    ) STRICT;
  `);

  const createAccount = db.prepare(`
    INSERT INTO accounts (email, password_hash) VALUES (?, ?)
    ON CONFLICT (email) DO NOTHING
  `);
  const findAccount = db.prepare('SELECT id, password_hash FROM accounts WHERE email = ?');
  const issueToken = db.prepare(`
    INSERT INTO devices (account_id, device_id, token_selector, token_hash, last_used_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (account_id, device_id) DO UPDATE SET
      token_selector = excluded.token_selector, token_hash = excluded.token_hash,
      last_used_at = excluded.last_used_at
  `);
  const useToken = db.prepare(`
    UPDATE devices SET last_used_at = MAX(last_used_at, ?)
    WHERE token_selector = ? AND token_hash = ? AND last_used_at >= ?
    RETURNING account_id, device_id
  `);
  const expireToken = db.prepare(`
    UPDATE devices SET token_hash = NULL
    WHERE token_selector = ? AND (token_hash IS NULL OR (token_hash = ? AND last_used_at < ?))
    RETURNING device_id
  `);
  const expireTokens = db.prepare(`
    UPDATE devices SET token_hash = NULL WHERE token_hash IS NOT NULL AND last_used_at < ?
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (account_id, uuid, payload) VALUES (?, ?, ?)
    ON CONFLICT (account_id, uuid) DO NOTHING
  `);
  const pending = db.prepare(`
    SELECT t.payload FROM transactions t
    WHERE t.account_id = ? AND NOT EXISTS (
      SELECT 1 FROM receipts r
      WHERE r.account_id = t.account_id AND r.device_id = ? AND r.uuid = t.uuid
    )
    ORDER BY t.sequence LIMIT ?
  `);
  const acknowledge = db.prepare(`
    INSERT INTO receipts (account_id, device_id, uuid)
    SELECT account_id, ?, uuid FROM transactions WHERE account_id = ? AND uuid = ?
    ON CONFLICT (account_id, device_id, uuid) DO NOTHING
  `);

  function writeBatch<T>(rows: T[], write: (row: T) => StatementResultingChanges) {
    db.exec('BEGIN IMMEDIATE');
    try {
      let inserted = 0;
      for (const row of rows) inserted += Number(write(row).changes);
      db.exec('COMMIT');
      return inserted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    createAccount: (email: string, hash: string) => createAccount.run(email, hash).changes === 1,
    findAccount: (email: string) => findAccount.get(email) as { id: number; password_hash: string } | undefined,
    issueToken: (accountId: number, deviceId: string, selector: string, hash: string, now: number) =>
      issueToken.run(accountId, deviceId, selector, hash, now),
    useToken: (now: number, selector: string, hash: string, cutoff: number) =>
      useToken.get(now, selector, hash, cutoff) as { account_id: number; device_id: string } | undefined,
    expireToken: (selector: string, hash: string, cutoff: number) => expireToken.get(selector, hash, cutoff),
    expireTokens: (cutoff: number) => expireTokens.run(cutoff),
    upload: (accountId: number, rows: { uuid: string; payload: string }[]) => writeBatch(rows, ({ uuid, payload }) =>
      insertTransaction.run(accountId, uuid, payload)),
    pending: (accountId: number, deviceId: string, limit: number) =>
      pending.iterate(accountId, deviceId, limit) as IterableIterator<{ payload: string }>,
    acknowledge: (accountId: number, deviceId: string, uuids: string[]) => writeBatch(uuids, uuid =>
      acknowledge.run(deviceId, accountId, uuid)),
    close: () => db.close(),
  };
}
