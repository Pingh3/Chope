// Verifies a Google ID token (what the Gmail extension gets from "Sign in with Google").
// Same approach as lib/verifyFirebaseToken.js — `jose` directly, never firebase-admin/auth — but
// for Google's own OIDC tokens: signature against Google's published keys, issuer, audience
// (must be OUR OAuth client, so a token minted for some other app is rejected), expiry, and a
// verified email address.
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let sharedRemoteKeys;

export function createGoogleVerifier({ clientId, keySet } = {}) {
  if (!clientId) throw new Error('Google OAuth client id is required to verify ID tokens');
  const keys = keySet || (sharedRemoteKeys ||= createRemoteJWKSet(new URL(JWKS_URL)));
  return async function verify(idToken) {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      algorithms: ['RS256'],
    });
    if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email) {
      throw new Error('token has no verified email');
    }
    return payload;
  };
}
