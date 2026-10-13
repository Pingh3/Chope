// Shared firebase-admin bootstrap (same service-account env vars api/focus.js already uses).
//
// Firestore only. Do NOT import 'firebase-admin/auth' here: it drags in jwks-rsa, which require()s
// the ESM-only `jose` package and crashes Vercel functions at startup (ERR_REQUIRE_ESM). ID tokens
// are verified in lib/verifyFirebaseToken.js instead.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function app() {
  if (getApps().length) return getApps()[0];
  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

export const adminDb = () => getFirestore(app());
