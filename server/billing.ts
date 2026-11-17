export type PaidUntil = (accountId: string) => Promise<string | null>;

export function billingFromEnvironment(env = process.env): PaidUntil {
  const raw = env.EPI_DOMUN_BILLING_URL;
  if (!raw) return async () => { throw new Error('Domun billing not configured'); };
  const origin = new URL(raw);
  const token = env.EPI_DOMUN_API_TOKEN;
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' ||
    origin.search || origin.hash || origin.username || origin.password || !token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Invalid Domun billing configuration');
  }
  return async accountId => {
    const response = await fetch(new URL('/v1/epi/entitlement/' + accountId, origin), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Domun billing unavailable');
    const { paidUntil } = await response.json();
    if (paidUntil !== null && (typeof paidUntil !== 'string' || !Number.isFinite(Date.parse(paidUntil)))) {
      throw new Error('Invalid Domun billing response');
    }
    return paidUntil;
  };
}
