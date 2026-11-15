import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

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

  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'google_sub'").get()) {
      db.exec('ALTER TABLE accounts ADD COLUMN google_sub TEXT');
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'locale'").get()) {
      db.exec('ALTER TABLE accounts ADD COLUMN locale TEXT; ALTER TABLE accounts ADD COLUMN google_locale TEXT');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_google_sub ON accounts(google_sub)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  const createAccount = db.prepare(`
    INSERT INTO accounts (email, password_hash, locale) VALUES (?, ?, ?)
    ON CONFLICT (email) DO NOTHING
  `);
  type Account = { id: number; email: string; password_hash: string; google_sub: string | null; locale: string | null; google_locale: string | null };
  const findAccount = db.prepare('SELECT * FROM accounts WHERE email = ?');
  const findById = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const findGoogle = db.prepare('SELECT * FROM accounts WHERE google_sub = ?');
  const createGoogle = db.prepare(
    "INSERT INTO accounts (email, password_hash, google_sub, locale, google_locale) VALUES (?, '', ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *"
  );
  const linkGoogle = db.prepare(
    'UPDATE OR IGNORE accounts SET google_sub = ?, google_locale = ? WHERE id = ? AND google_sub IS NULL AND password_hash = ?'
  );
  const updateGoogleLocale = db.prepare('UPDATE accounts SET google_locale = ? WHERE id = ? AND google_sub = ?');
  const unlinkGoogle = db.prepare(
    'UPDATE accounts SET google_sub = NULL, google_locale = NULL, password_hash = ? WHERE id = ? AND google_sub = ? AND password_hash = ?'
  );
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
  const revokeToken = db.prepare(`
    UPDATE devices SET token_hash = NULL WHERE token_selector = ? AND token_hash = ?
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (account_id, uuid, payload) VALUES (?, ?, ?)
    ON CONFLICT (account_id, uuid) DO NOTHING
  `);
  const storedTransaction = db.prepare('SELECT payload FROM transactions WHERE account_id = ? AND uuid = ?');
  const updateTransactionPayload = db.prepare('UPDATE transactions SET payload = ? WHERE account_id = ? AND uuid = ?');
  const pending = db.prepare(`
    SELECT t.payload, COALESCE(json_extract(t.payload, '$.name'), printf('~%020d', t.sequence)) AS position
    FROM transactions t
    WHERE t.account_id = ? AND NOT EXISTS (
      SELECT 1 FROM receipts r
      WHERE r.account_id = t.account_id AND r.device_id = ? AND r.uuid = t.uuid
    )
    AND COALESCE(json_extract(t.payload, '$.name'), printf('~%020d', t.sequence)) > ?
    ORDER BY position LIMIT ?
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

  const removeAccount = ['receipts', 'transactions', 'devices', 'accounts'].map(table =>
    db.prepare(table === 'accounts' ? 'DELETE FROM accounts WHERE id = ?' : `DELETE FROM ${table} WHERE account_id = ?`));

  return {
    deleteAccount(id: number) {
      writeBatch(removeAccount, statement => statement.run(id));
    },
    createAccount: (email: string, hash: string, locale: string | null) => createAccount.run(email, hash, locale).changes === 1,
    findAccount: (email: string) => findAccount.get(email) as Account | undefined,
    findById: (id: number) => findById.get(id) as Account | undefined,
    findGoogle: (sub: string) => findGoogle.get(sub) as Account | undefined,
    createGoogle: (email: string, sub: string, locale: string | null, googleLocale: string | null) =>
      createGoogle.get(email, sub, locale, googleLocale) as Account | undefined,
    linkGoogle: (id: number, sub: string, hash: string, locale: string | null) =>
      linkGoogle.run(sub, locale, id, hash).changes === 1,
    updateGoogleLocale: (id: number, sub: string, locale: string) => updateGoogleLocale.run(locale, id, sub),
    unlinkGoogle: (id: number, sub: string, oldHash: string, newHash: string) =>
      unlinkGoogle.run(newHash, id, sub, oldHash).changes === 1,
    issueToken: (accountId: number, deviceId: string, selector: string, hash: string, now: number) =>
      issueToken.run(accountId, deviceId, selector, hash, now),
    useToken: (now: number, selector: string, hash: string, cutoff: number) =>
      useToken.get(now, selector, hash, cutoff) as { account_id: number; device_id: string } | undefined,
    expireToken: (selector: string, hash: string, cutoff: number) => expireToken.get(selector, hash, cutoff),
    expireTokens: (cutoff: number) => expireTokens.run(cutoff),
    revokeToken: (selector: string, hash: string) => revokeToken.run(selector, hash),
    upload(accountId: number, deviceId: string, rows: { uuid: string; payload: string }[]) {
      const uuids = new Set<string>();
      const inserted = writeBatch(rows, ({ uuid, payload }) => {
        const result = insertTransaction.run(accountId, uuid, payload);
        const stored = result.changes ? undefined : storedTransaction.get(accountId, uuid)?.payload;
        let accepted = Boolean(result.changes) || stored === payload;
        if (!accepted && typeof stored === 'string') {
          const previous = JSON.parse(stored);
          const current = JSON.parse(payload);
          if (isDeepStrictEqual(previous, current)) {
            accepted = true;
          } else {
            const { name: previousName, ...previousTransaction } = previous;
            const { name: currentName, ...currentTransaction } = current;
            if ((previousName === undefined || currentName === undefined) &&
              isDeepStrictEqual(previousTransaction, currentTransaction)) {
              if (currentName !== undefined) updateTransactionPayload.run(payload, accountId, uuid);
              accepted = true;
            }
          }
        }
        if (accepted) {
          acknowledge.run(deviceId, accountId, uuid);
          uuids.add(uuid);
        }
        return result;
      });
      return { inserted, uuids: [...uuids] };
    },
    pending: (accountId: number, deviceId: string, after: string, limit: number) =>
      pending.iterate(accountId, deviceId, after, limit) as IterableIterator<{ payload: string; position: string }>,
    acknowledge: (accountId: number, deviceId: string, uuids: string[]) => writeBatch(uuids, uuid =>
      acknowledge.run(deviceId, accountId, uuid)),
    close: () => db.close(),
  };
}
