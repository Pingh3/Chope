// Chope -> Todoist sync engine. Pure logic: the Todoist client and the state store are injected,
// so the same code runs in production (real client + Firestore) and in tests (fakes).
//
// Rules this encodes (agreed with the owner):
//  * One-way: Chope is the source of truth for task data. Nothing from Todoist is ever written
//    back into Chope's tasks. The only thing read from Todoist is the `due` date, purely to
//    detect reschedules, and it only ever lands in the tracking state.
//  * Chope's Due Date (stored as `deadline`) -> Todoist `deadline_date`.
//  * Chope's Start Date -> Todoist's own Date (`due_date`), but ONLY when the start date changed
//    in Chope (or on first create). Unrelated edits never re-assert it, so the dates the owner
//    plans with in Todoist are not clobbered on every sync.
//  * Only tasks assigned to `ownerName` are synced; they live in the owner's project (default
//    "Chope") with a `chope` label.
//  * Three strikes: a date moved LATER (not first set, not earlier, not recurring, once per
//    calendar day per task, never on completed tasks) is a strike. 2 -> `strike-2`, 3+ ->
//    `strike-3`. Flag only: nothing is ever auto-deleted, reassigned or re-dated.

import { createHash } from 'node:crypto';

export const LABEL_BASE = 'chope';
export const LABEL_S2 = 'strike-2';
export const LABEL_S3 = 'strike-3';
const MANAGED = new Set([LABEL_BASE, LABEL_S2, LABEL_S3]);

export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// 'YYYY-MM-DD' for the given instant in the given IANA timezone (calendar day for the strike rule).
export function localDay(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export const priorityToTodoist = p => (p === 'high' ? 4 : p === 'med' ? 3 : p === 'low' ? 2 : 1);

export function strikeLabelFor(count) {
  return count >= 3 ? LABEL_S3 : count === 2 ? LABEL_S2 : null;
}

// Deterministic UUID-shaped key per (task, create attempt). Sent as X-Request-Id on creates; the
// attempt counter changes it after a deliberate re-create so it can't collide with the old one.
export function idempotencyKey(taskId, attempt = 0) {
  const h = createHash('sha1').update(`chope-td-${taskId}:${attempt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// A strike is a date moved strictly LATER than its previous value. `changed` is logged either way.
export function evaluateDateChange({ prev, next, recurring, done, today, lastStrikeDay }) {
  prev = prev || null; next = next || null;
  if (prev === next) return { changed: false, counted: false };
  const later = !!(prev && next && next > prev);
  return { changed: true, counted: later && !recurring && !done && lastStrikeDay !== today };
}

export function newRecord(t, nowIso) {
  return {
    todoistId: t.todoistId ? String(t.todoistId) : null, // legacy id from the old browser sync
    lastChopeDeadline: t.deadline || null,
    lastChopeStart: t.startDate || null,
    todoistSeen: false, lastSeenTodoistDue: null,
    count: 0, lastStrikeDay: null,
    firstDate: t.deadline || null, firstSeenAt: nowIso,
    closed: false, createCount: 0, missingSince: null, ambiguous: false, lastError: null,
  };
}

// Strike tracking is TEAM-WIDE: every open task gets a record, whoever owns it. Only the owner's tasks
// are ever synced to Todoist, so everyone else's get this light record (no Todoist fields). If such a
// task is later reassigned to the owner, fillDefaults() completes it — without adopting the task's
// legacy todoistId, which belongs to someone else's Todoist, not the owner's.
export function lightRecord(t, nowIso) {
  return { lastChopeDeadline: t.deadline || null, count: 0, lastStrikeDay: null, firstDate: t.deadline || null, firstSeenAt: nowIso };
}
export function fillDefaults(rec, t, nowIso) {
  const d = newRecord(t, nowIso);
  d.todoistId = null;
  for (const k of Object.keys(d)) if (!(k in rec)) rec[k] = d[k];
  return rec;
}

export const sameSet = (a, b) => {
  const k = x => [...x].map(s => String(s).toLowerCase()).sort().join('|');
  return a.length === b.length && k(a) === k(b);
};

// Keeps labels the owner added by hand; only the three managed ones are controlled here.
export function mergeLabels(current, count, withStrikes = true) {
  const kept = (current || []).filter(l => !MANAGED.has(String(l).toLowerCase()));
  const out = [...kept, LABEL_BASE];
  const s = withStrikes ? strikeLabelFor(count) : null;
  if (s) out.push(s);
  return out;
}

export const dateOnly = v => (v ? String(v).slice(0, 10) : null);

export async function runSync(deps, opts = {}) {
  const {
    todoist, store, ownerName, tz = 'Asia/Singapore', projectName = 'Chope',
    now = () => new Date(), lockTtlMs = 240000, deleteGraceMs = 60000,
  } = deps;
  const trackOnly = !todoist; // no Todoist configured: still track pushes for everyone, touch nothing
  const hintedDeletes = new Set(opts.deleted || []);
  const nowDate = now(), nowIso = nowDate.toISOString(), today = localDay(nowDate, tz);
  const report = {
    ok: true, created: 0, updated: 0, closed: 0, reopened: 0, deleted: 0, adopted: 0, recreated: 0,
    strikes: 0, skipped: [], errors: [],
  };

  const holder = await store.acquireLock(lockTtlMs, nowDate.getTime());
  if (!holder) return { ...report, skipped: ['locked'] };

  try {
    const allTasks = await store.loadTasks();
    // "Waiting on" tasks don't need the owner, so they are NOT synced (and not strike-tracked):
    // they leave Todoist and come back if the status changes. Their history is kept (step 6).
    const mine = allTasks.filter(t => t.assignee === ownerName && t.status !== 'waiting');
    const waitingById = new Map(allTasks.filter(t => t.assignee === ownerName && t.status === 'waiting').map(t => [t.id, t]));
    const mineById = new Map(mine.map(t => [t.id, t]));
    const existsAnywhere = new Set(allTasks.map(t => t.id));
    const taskById = new Map(allTasks.map(t => [t.id, t]));
    const state = await store.loadState();
    state.tasks = state.tasks || {};
    const rows = [];
    const logRow = (taskId, source, oldDate, newDate, counted, extra = {}) =>
      rows.push({ task_id: taskId, source, old_date: oldDate, new_date: newDate, changed_at: nowIso, counted, ...extra });

    // 1. A record per owned task. First sight never counts as a strike.
    //    One Todoist task may belong to only ONE Chope task. Copies made by an older version of the
    //    app carried the original's todoistId, which made two Chope tasks edit/close the same
    //    Todoist task. The OLDEST claimant keeps the link; the rest start unmapped and get their own.
    const claimed = new Map(); // todoistId -> chope task id that owns it
    for (const [id, rec] of Object.entries(state.tasks)) if (rec.todoistId && !claimed.has(rec.todoistId)) claimed.set(rec.todoistId, id);
    const byAge = [...mine].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || (a.id < b.id ? -1 : 1));
    for (const t of byAge) {
      const legacy = !state.tasks[t.id] && t.todoistId ? String(t.todoistId) : null;
      if (legacy && claimed.has(legacy) && claimed.get(legacy) !== t.id) t.todoistId = null; // already someone else's
      else if (legacy) claimed.set(legacy, t.id);
    }
    const fresh = new Set();
    for (const t of mine) {
      if (!state.tasks[t.id]) { state.tasks[t.id] = newRecord(t, nowIso); fresh.add(t.id); }
    }
    // Team-wide tracking: a light record for every other open task. First sight never counts.
    const others = allTasks.filter(t => !mineById.has(t.id) && !waitingById.has(t.id) && t.status !== 'done');
    const freshOthers = new Set();
    for (const t of others) if (!state.tasks[t.id]) { state.tasks[t.id] = lightRecord(t, nowIso); freshOthers.add(t.id); }
    // A task reassigned TO the owner arrives with a light record: complete it.
    for (const t of mine) { const r = state.tasks[t.id]; if (r && r.closed === undefined) fillDefaults(r, t, nowIso); }
    // Same guarantee for links already stored in the sync state.
    const seenLink = new Map();
    for (const t of byAge) {
      const rec = state.tasks[t.id];
      if (!rec?.todoistId) continue;
      if (seenLink.has(rec.todoistId)) { rec.todoistId = null; rec.todoistSeen = false; rec.lastSeenTodoistDue = null; rec.closed = false; }
      else seenLink.set(rec.todoistId, t.id);
    }

    // 2. Chope-side reschedule detection (covers every edit path: modal, bulk, drag, Revise Plan).
    for (const t of [...mine, ...others]) {
      if (fresh.has(t.id) || freshOthers.has(t.id)) continue;
      const rec = state.tasks[t.id];
      const r = evaluateDateChange({
        prev: rec.lastChopeDeadline, next: t.deadline, recurring: !!t.recurrence,
        done: t.status === 'done', today, lastStrikeDay: rec.lastStrikeDay,
      });
      if (r.changed) {
        logRow(t.id, 'chope_deadline', rec.lastChopeDeadline || null, t.deadline || null, r.counted);
        if (r.counted) { rec.count++; rec.lastStrikeDay = today; report.strikes++; }
        if (!rec.firstDate && t.deadline) rec.firstDate = t.deadline;
        rec.lastChopeDeadline = t.deadline || null;
      }
    }

    // 3. One batched read of the Todoist side for every mapped, not-yet-closed task.
    const readIds = (trackOnly ? [] : mine)
      .filter(t => state.tasks[t.id].todoistId && !(t.status === 'done' && state.tasks[t.id].closed))
      .map(t => state.tasks[t.id].todoistId);
    const active = readIds.length ? await todoist.getTasksByIds(readIds) : new Map();

    // 4. Todoist-side reschedule detection (read-only: `due` is never written by detection).
    for (const t of mine) {
      const rec = state.tasks[t.id];
      const a = rec.todoistId ? active.get(rec.todoistId) : null;
      if (!a) continue;
      const dueDate = dateOnly(a.due?.date);
      if (!rec.todoistSeen) { rec.todoistSeen = true; rec.lastSeenTodoistDue = dueDate; continue; }
      const r = evaluateDateChange({
        prev: rec.lastSeenTodoistDue, next: dueDate, recurring: !!(a.due?.is_recurring || t.recurrence),
        done: t.status === 'done', today, lastStrikeDay: rec.lastStrikeDay,
      });
      if (r.changed) {
        logRow(t.id, 'todoist_due', rec.lastSeenTodoistDue || null, dueDate, r.counted);
        if (r.counted) { rec.count++; rec.lastStrikeDay = today; report.strikes++; }
        rec.lastSeenTodoistDue = dueDate;
      }
    }

    // Lazily-resolved helpers so a quiet run makes as few API calls as possible.
    let projectId = null, labelsReady = !!state.labelsReady;
    const getProjectId = async () => {
      if (projectId) return projectId;
      const found = (await todoist.listProjects()).find(p => p.name === projectName);
      projectId = (found || await todoist.createProject(projectName)).id;
      return projectId;
    };
    const ensureLabels = async () => {
      if (labelsReady) return;
      const have = new Set((await todoist.listLabels()).map(l => String(l.name).toLowerCase()));
      for (const name of [LABEL_BASE, LABEL_S2, LABEL_S3]) if (!have.has(name)) await todoist.createLabel(name);
      labelsReady = state.labelsReady = true;
    };
    let completedIds = null;
    const wasCompletedInTodoist = async id => {
      if (!completedIds) completedIds = await todoist.listCompletedIds(89, nowDate.getTime());
      return completedIds.has(String(id));
    };
    let projectTasks = null;
    const getProjectTasks = async () => (projectTasks ||= await todoist.listActive({ projectId: await getProjectId() }));

    // Titles shared by several unmapped open owned tasks can't be adopted/matched safely.
    const unmappedTitleCount = new Map();
    for (const t of mine) {
      if (t.status !== 'done' && !state.tasks[t.id].todoistId) {
        const k = norm(t.name); unmappedTitleCount.set(k, (unmappedTitleCount.get(k) || 0) + 1);
      }
    }

    const persistState = () => store.saveState(state);

    async function reconcileFields(t, rec, a) {
      const body = {};
      if (a.content !== t.name) body.content = t.name;
      if ((a.description || '').trim() !== (t.desc || '').trim()) body.description = t.desc || '';
      if (a.priority !== priorityToTodoist(t.priority)) body.priority = priorityToTodoist(t.priority);
      const wantDeadline = t.deadline || null, haveDeadline = a.deadline?.date || null;
      if (wantDeadline !== haveDeadline) body.deadline_date = wantDeadline;
      const wantLabels = mergeLabels(a.labels, rec.count);
      if (!sameSet(wantLabels, a.labels || [])) body.labels = wantLabels;
      // Start date -> Todoist's Date, only when it changed in Chope and Todoist doesn't already match.
      const startChanged = !!t.startDate && t.startDate !== rec.lastChopeStart;
      if (startChanged && dateOnly(a.due?.date) !== t.startDate) body.due_date = t.startDate;
      // Start date REMOVED in Chope: clear the Todoist Date too — but only if it still holds the date Chope
      // last sent. If the owner has since re-planned it in Todoist, that Date is theirs and is left alone.
      // (Recurring Todoist dates are never touched.)
      if (!t.startDate && rec.lastChopeStart && !a.due?.is_recurring && dateOnly(a.due?.date) === rec.lastChopeStart) body.due_date = null;
      if (Object.keys(body).length) {
        if (body.labels) await ensureLabels();
        await todoist.updateTask(rec.todoistId, body);
        report.updated++;
        if ('due_date' in body) rec.lastSeenTodoistDue = body.due_date; // our own write (set or cleared) is not a reschedule
      }
      rec.lastChopeStart = t.startDate || null;
    }

    async function createInTodoist(t, rec) {
      await ensureLabels();
      const body = {
        content: t.name, description: t.desc || '', priority: priorityToTodoist(t.priority),
        project_id: await getProjectId(), labels: mergeLabels([], rec.count),
      };
      if (t.deadline) body.deadline_date = t.deadline;
      if (t.startDate) body.due_date = t.startDate;
      const created = await todoist.createTask(body, idempotencyKey(t.id, rec.createCount || 0));
      rec.createCount = (rec.createCount || 0) + 1;
      rec.todoistId = String(created.id);
      rec.closed = false; rec.ambiguous = false;
      rec.lastChopeStart = t.startDate || null;
      rec.todoistSeen = true;
      rec.lastSeenTodoistDue = dateOnly(created.due?.date) ?? (t.startDate || null);
      report.created++;
      await persistState(); // record the id immediately: a crash after this point can't orphan it
    }

    // 5. Per-task actions. One task failing never aborts the run.
    for (const t of (trackOnly ? [] : mine)) {
      const rec = state.tasks[t.id];
      try {
        if (t.status === 'done') {
          if (rec.todoistId && !rec.closed) {
            const a = active.get(rec.todoistId);
            if (a) {
              const labels = mergeLabels(a.labels, 0, false); // completing removes strike labels
              if (!sameSet(labels, a.labels || [])) await todoist.updateTask(rec.todoistId, { labels });
              await todoist.closeTask(rec.todoistId);
              report.closed++;
            }
            rec.closed = true;
          }
          continue;
        }

        if (rec.todoistId) {
          let a = active.get(rec.todoistId);
          if (!a) {
            // Not active in Todoist: it was either completed there (reopen it, Chope says open)
            // or deleted there (recreate it). Telling them apart is why completed ids are read.
            if (rec.closed || await wasCompletedInTodoist(rec.todoistId)) {
              try {
                await todoist.reopenTask(rec.todoistId);
                rec.closed = false; report.reopened++;
                a = (await todoist.getTasksByIds([rec.todoistId])).get(rec.todoistId);
              } catch (e) { if (e.status !== 404) throw e; }
            }
            if (!a) {
              rec.todoistId = null; report.recreated++;
              await createInTodoist(t, rec);
              continue;
            }
            const due = dateOnly(a.due?.date);
            rec.todoistSeen = true; rec.lastSeenTodoistDue = due;
          }
          await reconcileFields(t, rec, a);
          continue;
        }

        // Unmapped open task: adopt an existing identical Todoist task rather than duplicating it,
        // but refuse to guess when the match is ambiguous.
        const mappedIds = new Set(Object.values(state.tasks).map(r => r.todoistId).filter(Boolean));
        const cands = (await getProjectTasks()).filter(x => !mappedIds.has(String(x.id)) && norm(x.content) === norm(t.name));
        if (cands.length === 0) { await createInTodoist(t, rec); continue; }
        if (cands.length === 1 && unmappedTitleCount.get(norm(t.name)) === 1) {
          const a = cands[0];
          rec.todoistId = String(a.id); rec.ambiguous = false; report.adopted++;
          rec.todoistSeen = true; rec.lastSeenTodoistDue = dateOnly(a.due?.date);
          await ensureLabels();
          await reconcileFields(t, rec, a);
          await persistState();
          continue;
        }
        rec.ambiguous = true;
        report.skipped.push({ task: t.id, reason: 'ambiguous', detail: `${cands.length} Todoist task(s) share the title "${t.name}"` });
      } catch (e) {
        rec.lastError = e.message;
        report.errors.push({ task: t.id, error: e.message });
      }
    }

    // 6. Records for tasks that are not in the owner's Todoist scope right now.
    for (const [id, rec] of Object.entries(state.tasks)) {
      if (mineById.has(id)) { rec.missingSince = null; continue; }
      const parked = waitingById.get(id);
      if (parked) {
        // Keep the record (and its push count). Track dates silently so a date changed while parked
        // isn't counted as a push the moment the task comes back.
        rec.lastChopeDeadline = parked.deadline || null; rec.lastChopeStart = parked.startDate || null; rec.missingSince = null;
        if (rec.todoistId && !trackOnly) {
          try {
            if (!rec.closed) { try { await todoist.deleteTask(rec.todoistId); } catch (e) { if (e.status !== 404) throw e; } report.deleted++; }
            rec.todoistId = null; rec.todoistSeen = false; rec.lastSeenTodoistDue = null; rec.closed = false;
          } catch (e) { report.errors.push({ task: id, error: e.message }); }
        }
        continue;
      }
      const elsewhere = taskById.get(id); // still in Chope: someone else's task, or reassigned away from the owner
      if (elsewhere) {
        if (rec.todoistId && !trackOnly) { // it has a Todoist task it shouldn't: remove it after the usual grace period
          const since = rec.missingSince ? Date.parse(rec.missingSince) : null;
          if (!(since && nowDate.getTime() - since >= deleteGraceMs)) rec.missingSince ||= nowIso;
          else {
            try {
              if (!rec.closed) { try { await todoist.deleteTask(rec.todoistId); } catch (e) { if (e.status !== 404) throw e; } report.deleted++; }
              rec.todoistId = null; rec.todoistSeen = false; rec.lastSeenTodoistDue = null; rec.closed = false; rec.missingSince = null;
            } catch (e) { report.errors.push({ task: id, error: e.message }); }
          }
        }
        // The push history outlives the Todoist link. A finished task nobody pushed has nothing worth keeping.
        if (elsewhere.status === 'done' && !(rec.count > 0)) delete state.tasks[id];
        continue;
      }
      // Gone from Chope entirely.
      if (!rec.todoistId) { delete state.tasks[id]; continue; }
      if (trackOnly) continue; // its Todoist task is removed by the next full sync
      const hinted = hintedDeletes.has(id) && !existsAnywhere.has(id);
      const since = rec.missingSince ? Date.parse(rec.missingSince) : null;
      if (!hinted && !(since && nowDate.getTime() - since >= deleteGraceMs)) { rec.missingSince ||= nowIso; continue; }
      try {
        if (!rec.closed) {
          try { await todoist.deleteTask(rec.todoistId); } catch (e) { if (e.status !== 404) throw e; }
          report.deleted++;
        }
        delete state.tasks[id];
      } catch (e) { report.errors.push({ task: id, error: e.message }); }
    }

    state.lastRunAt = nowIso;
    state.lastReport = { created: report.created, updated: report.updated, closed: report.closed, reopened: report.reopened,
      deleted: report.deleted, adopted: report.adopted, recreated: report.recreated, strikes: report.strikes,
      errors: report.errors.length, skipped: report.skipped.length };
    await store.appendChanges(rows);
    await persistState();
    report.ok = report.errors.length === 0;
    report.counts = Object.fromEntries(Object.entries(state.tasks).filter(([id, r]) => r.count > 0 && taskById.has(id)).map(([id, r]) => [id, r.count]));
    return report;
  } finally {
    await store.releaseLock(holder);
  }
}

// "Decided": the owner re-scoped, split or delegated the task, so the strike count starts over.
export async function decide(deps, taskId, actor) {
  const { todoist, store, ownerName, now = () => new Date(), lockTtlMs = 240000 } = deps;
  const nowDate = now(), nowIso = nowDate.toISOString();
  const holder = await store.acquireLock(lockTtlMs, nowDate.getTime());
  if (!holder) return { ok: false, error: 'busy' };
  try {
    // The person who owns the task decides what happens to it — and the owner (team lead) can for anyone.
    if (actor && actor !== ownerName) {
      const t = (await store.loadTasks()).find(x => x.id === taskId);
      if (!t || t.assignee !== actor) return { ok: false, error: 'forbidden' };
    }
    const state = await store.loadState();
    const rec = state.tasks?.[taskId];
    if (!rec) return { ok: false, error: 'unknown task' };
    const before = rec.count || 0;
    rec.count = 0; rec.lastStrikeDay = null;
    if (todoist && rec.todoistId && !rec.closed) {
      const a = (await todoist.getTasksByIds([rec.todoistId])).get(rec.todoistId);
      if (a) {
        const labels = mergeLabels(a.labels, 0);
        if (!sameSet(labels, a.labels || [])) await todoist.updateTask(rec.todoistId, { labels });
      }
    }
    await store.appendChanges([{ task_id: taskId, source: 'reset', old_date: null, new_date: null, changed_at: nowIso, counted: false, count_before: before }]);
    await store.saveState(state);
    return { ok: true, before };
  } finally {
    await store.releaseLock(holder);
  }
}

// Data for the Friday review: everything pushed `minCount`+ times, worst first.
export async function buildStrikeView({ store, ownerName, now = () => new Date(), tz = 'Asia/Singapore' }, minCount = 3) {
  const tasks = await store.loadTasks();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = await store.loadState();
  const today = localDay(now(), tz);
  const days = (fromIso) => fromIso ? Math.max(0, Math.round((Date.parse(today) - Date.parse(String(fromIso).slice(0, 10))) / 86400000)) : null;
  const items = [], counts = {};
  for (const [id, rec] of Object.entries(state.tasks || {})) {
    const t = byId.get(id);
    if (!t || !(rec.count > 0)) continue;
    counts[id] = rec.count;
    if (rec.count < minCount || t.status === 'done') continue;
    items.push({
      taskId: id, title: t.name, assignee: t.assignee || '', count: rec.count,
      originalDate: rec.firstDate || null, currentDate: t.deadline || null,
      daysSinceFirstScheduled: days(t.createdAt || rec.firstSeenAt),
    });
  }
  items.sort((a, b) => b.count - a.count || (b.daysSinceFirstScheduled || 0) - (a.daysSinceFirstScheduled || 0));
  return { items, counts, lastRunAt: state.lastRunAt || null };
}

// Strike tracking with no Todoist at all (token not set / sync switched off): records date pushes for
// everyone and nothing else. Same engine, Todoist steps skipped.
export const runTracking = (deps, opts) => runSync({ ...deps, todoist: null }, opts);
