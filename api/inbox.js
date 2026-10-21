// Chope inbox: tasks added from outside the app (the Gmail Chrome extension) wait here until the
// user's Chope picks them up. See lib/inbox.js for why this isn't a direct write to the task list.
//
//   POST {action:'add', requestId, name, notes?, deadline?, priority?, cat?, link?}
//        Authorization: Bearer <Google ID token>        (from the extension's "Sign in with Google")
//        -> {ok, id, duplicate}
//   POST {action:'drain'}                                (from the Chope web app)
//        Authorization: Bearer <Firebase ID token>
//        -> {items: [task, ...]}  the caller's pending tasks
//   POST {action:'ack', ids:[taskId, ...]}               (from the Chope web app, after saving them)
//        Authorization: Bearer <Firebase ID token>      -> {ok}
//
// Everyone must be on the same chope_allowlist the app's login uses. Both token types are
// verified with `jose` directly (never firebase-admin/auth — see lib/verifyFirebaseToken.js).
import { adminDb } from '../lib/firebaseAdmin.js';
import { createFirebaseVerifier } from '../lib/verifyFirebaseToken.js';
import { createGoogleVerifier } from '../lib/verifyGoogleToken.js';
import { buildInboxTask, createFirestoreInbox, ValidationError } from '../lib/inbox.js';

// The OAuth client the app's "Connect Gmail" already uses; the extension signs in through it too.
const GOOGLE_CLIENT_ID = process.env.EXTENSION_OAUTH_CLIENT_ID
  || '1052353371305-ibjabb8j5o8okn4ou5a05q8g1ta3s3li.apps.googleusercontent.com';

async function allowlisted(email, fallbackName) {
  const col = adminDb().collection('chope_allowlist');
  let snap = await col.doc(email).get();
  if (!snap.exists && email !== email.toLowerCase()) snap = await col.doc(email.toLowerCase()).get();
  if (!snap.exists) return null;
  return { email, name: snap.data().name || fallbackName || null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const inbox = createFirestoreInbox(adminDb());

    if (body.action === 'add') {
      let claims;
      try { claims = await createGoogleVerifier({ clientId: GOOGLE_CLIENT_ID })(token); }
      catch { return res.status(401).json({ error: 'Sign-in expired or invalid — open the extension and sign in again.' }); }
      const user = await allowlisted(claims.email, claims.given_name || claims.name?.split(' ')[0]);
      if (!user) return res.status(403).json({ error: `${claims.email} is not on the Chope allowlist.` });
      const task = buildInboxTask(body, user);
      const added = await inbox.add(user.email, task);
      return res.status(200).json({ ok: true, id: task.id, duplicate: !added });
    }

    if (body.action === 'drain' || body.action === 'ack') {
      let claims;
      try { claims = await createFirebaseVerifier({ projectId: process.env.FIREBASE_PROJECT_ID })(token); }
      catch { return res.status(401).json({ error: 'unauthorized' }); }
      if (!claims.email) return res.status(401).json({ error: 'unauthorized' });
      const user = await allowlisted(claims.email, null);
      if (!user) return res.status(403).json({ error: 'not allowlisted' });
      if (body.action === 'drain') return res.status(200).json({ items: await inbox.list(user.email) });
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
      await inbox.ack(user.email, ids);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
    console.error('inbox failed:', e);
    return res.status(500).json({ error: 'something went wrong — try again' });
  }
}
