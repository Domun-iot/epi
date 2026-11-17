export const accountApi = 'https://epi.domun.eu';

export function createPaidUntilReader({ request = globalThis.fetch, now = Date.now } = {}) {
  const accounts = new Map();
  return async (token, refresh = false) => {
    const time = now();
    for (const [key, account] of accounts) {
      if (account.paidUntil <= time && account.checkedAt + 60_000 <= time) accounts.delete(key);
    }
    if (!token) return 0;
    const cached = accounts.get(token);
    if (!refresh && cached && time < cached.checkedAt + 60_000
        && (cached.paidUntil === 0 || time < cached.paidUntil)) {
      return cached.paidUntil;
    }
    try {
      const response = await request(accountApi + '/v1/account', {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 500) throw new Error('Account server unavailable');
      const account = response.ok ? await response.json() : null;
      const paidUntil = account?.paid === true ? Date.parse(account.paidUntil) || 0 : 0;
      accounts.set(token, { paidUntil, checkedAt: now() });
      return paidUntil;
    } catch {
      // As in the native client, an outage preserves previously verified rights until expiry.
      const paidUntil = cached?.paidUntil > time ? cached.paidUntil : 0;
      accounts.set(token, { paidUntil, checkedAt: now() });
      return paidUntil;
    }
  };
}
