import { createHash, randomBytes } from 'node:crypto';

export type GoogleIdentity = { sub: string; email?: string };
export type Google = {
  authorize: (state: string, verifier: string) => string;
  identify: (code: string, verifier: string) => Promise<GoogleIdentity>;
};

export const randomSecret = () => randomBytes(32).toString('hex');

function nonceFor(verifier: string) {
  return createHash('sha256').update('epi-google-nonce:').update(verifier).digest('base64url');
}

export function googleFromEnvironment(env = process.env): Google | undefined {
  const { EPI_GOOGLE_CLIENT_ID: clientId, EPI_GOOGLE_CLIENT_SECRET: clientSecret,
    EPI_GOOGLE_REDIRECT_URI: redirectUri } = env;
  if (!clientId && !clientSecret && !redirectUri) return;
  if (!clientId || !clientSecret || !redirectUri) throw new Error('Incomplete Google OAuth configuration');
  const callback = new URL(redirectUri);
  if ((callback.protocol !== 'https:' &&
      !(callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname))) ||
      callback.pathname !== '/v1/google/callback' || callback.search || callback.hash ||
      callback.username || callback.password) {
    throw new Error('Invalid EPI_GOOGLE_REDIRECT_URI');
  }

  return {
    authorize(state, verifier) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, scope: 'openid email',
        response_type: 'code', state, nonce: nonceFor(verifier), prompt: 'select_account', code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString();
      return url.href;
    },
    async identify(code, verifier) {
      const token = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: 'authorization_code', code, code_verifier: verifier,
        }),
      });
      if (!token.ok) throw new Error('Google rejected the authorization code');
      const { id_token: idToken } = await token.json();
      if (typeof idToken !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(idToken)) {
        throw new Error('Missing or malformed Google ID token');
      }

      // OIDC Core 3.1.3.7 allows TLS issuer validation for tokens received
      // directly from the token endpoint. This code never accepts client-supplied tokens.
      const { sub, email, email_verified: verified, iss, aud, azp, exp, iat, nonce } =
        JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);
      if ((iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') ||
          aud !== clientId || (azp !== undefined && azp !== clientId) ||
          !Number.isSafeInteger(exp) || exp <= now || !Number.isSafeInteger(iat) || iat > now + 60 ||
          nonce !== nonceFor(verifier) || typeof sub !== 'string' || !sub || sub.length > 255) {
        throw new Error('Invalid Google identity');
      }
      return { sub, email: verified === true && typeof email === 'string' ? email : undefined };
    },
  };
}
