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
import { planCleanup, applyCleanup, summarizePlan } from '../lib/todoistCleanup.js';
import { createDryRun, createDryStore } from '../lib/dryRun.js';

function config() {
  return {
    token: process.env.TODOIST_API_TOKEN || '',
    // Having a token is NOT enough to start syncing: the switch is TODOIST_SYNC_ENABLED=1. That lets the
    // token be stored and the one-off duplicate cleanup be run and reviewed first, so nothing is
    // created in Todoist until the owner deliberately turns syncing on.
    syncOn: !!process.env.TODOIST_API_TOKEN && process.env.TODOIST_SYNC_ENABLED === '1',
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
      if (!cfg.syncOn) return res.status(200).json({ ok: true, skipped: 'Todoist sync is switched off' });
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

    if (body.action === 'status') return res.status(200).json({ enabled: cfg.syncOn, owner: cfg.ownerName });

    // One-off duplicate cleanup. Owner only, needs the token but NOT the sync switch. Without
    // apply:true it only reports what it WOULD do (nothing is changed); applying needs confirm:'APPLY'.
    if (body.action === 'cleanup') {
      if (user.name !== cfg.ownerName) return res.status(403).json({ error: 'only the owner can run the cleanup' });
      if (!cfg.token) return res.status(400).json({ error: 'TODOIST_API_TOKEN is not set' });
      const d = makeDeps();
      const project = (await d.todoist.listProjects()).find(p => p.name === cfg.projectName);
      if (!project) return res.status(200).json({ ok: true, applied: false, note: `No Todoist project named "${cfg.projectName}" yet — nothing to clean.` });
      const [chopeTasks, state, todoistTasks] = await Promise.all([d.store.loadTasks(), d.store.loadState(), d.todoist.listActive({ projectId: project.id })]);
      const plan = planCleanup({ chopeTasks, todoistTasks, ownerName: cfg.ownerName, state });
      if (body.apply !== true) return res.status(200).json({ ok: true, applied: false, todoistActive: todoistTasks.length, plan: summarizePlan(plan) });
      if (body.confirm !== 'APPLY') return res.status(400).json({ error: 'to apply, send confirm: "APPLY"' });
      const result = await applyCleanup(d, plan);
      console.log('todoist cleanup applied', JSON.stringify(result));
      return res.status(200).json({ ok: result.errors.length === 0, applied: true, result });
    }

    // Dry-run of the real sync: reads everything for real, performs nothing. Owner only, needs the
    // token but not the sync switch — it's how the owner sees what switching syncing on WILL do.
    if (body.action === 'preview') {
      if (user.name !== cfg.ownerName) return res.status(403).json({ error: 'only the owner can preview the sync' });
      if (!cfg.token) return res.status(400).json({ error: 'TODOIST_API_TOKEN is not set' });
      const real = makeDeps();
      const dry = createDryRun(real.todoist);
      const report = await runSync({ ...real, todoist: dry.todoist, store: createDryStore(real.store) });
      const by = k => dry.writes.filter(w => w.kind === k);
      return res.status(200).json({
        ok: true, dryRun: true,
        counts: { createTask: by('createTask').length, updateTask: by('updateTask').length, closeTask: by('closeTask').length,
          reopenTask: by('reopenTask').length, deleteTask: by('deleteTask').length, createLabel: by('createLabel').length, createProject: by('createProject').length },
        report: { created: report.created, updated: report.updated, closed: report.closed, reopened: report.reopened, deleted: report.deleted,
          adopted: report.adopted, recreated: report.recreated, errors: report.errors, skipped: report.skipped },
        writes: dry.writes,
      });
    }

    if (!cfg.syncOn) return res.status(200).json({ enabled: false });

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
