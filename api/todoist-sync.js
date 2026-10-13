// Server-side Chope -> Todoist sync. One writer for everything, so devices can't race each other
// into duplicate Todoist tasks.
//
//   POST (browser)  Authorization: Bearer <Firebase ID token of an allowlisted user>
//        {action:'status'}                       -> {enabled}
//        {action:'sync', deleted?:[taskIds]}     -> run a sync now (debounced pings after each save)
//        {action:'strikes', min?:3}              -> reschedule counts + the 3-strike review list
//        {action:'decided', taskId}              -> owner only: reset a task's strike count
//   GET  (Vercel Cron / external scheduler)  Authorization: Bearer <CRON_SECRET>  -> full reconcile
//
// Config (environment variables only — never committed):
//   TODOIST_API_TOKEN     the owner's Todoist token (sync is disabled until this is set)
//   TODOIST_PROJECT_NAME  default "Chope"
//   TODOIST_OWNER         default "Victor" — only tasks assigned to this person are synced
//   CHOPE_TZ              default "Asia/Singapore" — defines "same calendar day" for strikes
//   CRON_SECRET           shared secret for the scheduled reconcile
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY   (already set for api/focus.js)
import { adminDb } from '../lib/firebaseAdmin.js';
import { createFirebaseVerifier } from '../lib/verifyFirebaseToken.js';
import { createTodoistClient } from '../lib/todoistClient.js';
import { createFirestoreStore } from '../lib/syncStore.js';
import { runSync, decide, buildStrikeView } from '../lib/todoistSync.js';

function config() {
  return {
    token: process.env.TODOIST_API_TOKEN || '',
    projectName: process.env.TODOIST_PROJECT_NAME || 'Chope',
    ownerName: process.env.TODOIST_OWNER || 'Victor',
    tz: process.env.CHOPE_TZ || 'Asia/Singapore',
  };
}

// Same gate as the app's login: a verified Firebase user whose email is in chope_allowlist.
async function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const decoded = await createFirebaseVerifier({ projectId: process.env.FIREBASE_PROJECT_ID })(m[1]);
    if (!decoded.email) return null;
    const snap = await adminDb().collection('chope_allowlist').doc(decoded.email).get();
    if (!snap.exists) return null;
    return { email: decoded.email, name: snap.data().name || decoded.name?.split(' ')[0] || null };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = config();
  const authz = req.headers.authorization || '';
  const cronOk = !!process.env.CRON_SECRET && authz === `Bearer ${process.env.CRON_SECRET}`;

  try {
    const makeDeps = () => ({
      todoist: createTodoistClient({ token: cfg.token }),
      store: createFirestoreStore(adminDb()),
      ownerName: cfg.ownerName, tz: cfg.tz, projectName: cfg.projectName,
    });

    // Scheduled reconcile (Vercel Cron issues GET).
    if (req.method === 'GET') {
      if (!cronOk) return res.status(401).json({ error: 'unauthorized' });
      if (!cfg.token) return res.status(200).json({ ok: true, skipped: 'TODOIST_API_TOKEN not set' });
      const r = await runSync(makeDeps());
      console.log('todoist-sync (cron)', JSON.stringify({ ...r, counts: undefined }));
      return res.status(200).json({ ...r, counts: undefined });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const user = cronOk ? { name: cfg.ownerName } : await authUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    if (body.action === 'status') return res.status(200).json({ enabled: !!cfg.token, owner: cfg.ownerName });
    if (!cfg.token) return res.status(200).json({ enabled: false });

    const deps = makeDeps();
    switch (body.action) {
      case 'sync': {
        const deleted = Array.isArray(body.deleted) ? body.deleted.slice(0, 200).map(String) : [];
        const r = await runSync(deps, { deleted });
        console.log('todoist-sync', JSON.stringify({ ...r, counts: undefined }));
        return res.status(200).json({ enabled: true, ...r });
      }
      case 'strikes': {
        const v = await buildStrikeView(deps, Number(body.min) || 3);
        return res.status(200).json({ enabled: true, ...v });
      }
      case 'decided': {
        if (user.name !== cfg.ownerName) return res.status(403).json({ error: 'only the owner can mark a task decided' });
        const taskId = String(body.taskId || '');
        const out = await decide(deps, taskId);
        if (!out.ok) return res.status(out.error === 'busy' ? 409 : 404).json(out);
        const v = await buildStrikeView(deps, 3);
        return res.status(200).json({ enabled: true, ...out, counts: v.counts });
      }
      default:
        return res.status(400).json({ error: 'unknown action' });
    }
  } catch (e) {
    console.error('todoist-sync failed:', e);
    return res.status(500).json({ error: e.message || 'sync failed' });
  }
}
