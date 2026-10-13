// Verifies a Firebase Auth ID token (the one the browser gets from currentUser.getIdToken()).
//
// Why this exists instead of firebase-admin's getAuth().verifyIdToken(): importing
// 'firebase-admin/auth' pulls in jwks-rsa, a CommonJS package that require()s the ESM-only `jose`
// package. Vercel's Node runtime rejects that (ERR_REQUIRE_ESM), which crashed the function at
// startup before any of our code ran. Using `jose` directly from ESM sidesteps the problem, and
// performs the same checks Firebase documents for verifying an ID token:
//   * RS256 signature against Google's published securetoken keys (JWKS, cached by jose)
//   * iss  === https://securetoken.google.com/<project id>
//   * aud  === <project id>
//   * exp / nbf in range, and a non-empty `sub`
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let sharedRemoteKeys; // reused across invocations of a warm instance so keys aren't refetched every call

export function createFirebaseVerifier({ projectId, keySet } = {}) {
  if (!projectId) throw new Error('Firebase project id is required to verify ID tokens');
  const keys = keySet || (sharedRemoteKeys ||= createRemoteJWKSet(new URL(JWKS_URL)));
  return async function verify(idToken) {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no subject');
    return payload;
  };
}
