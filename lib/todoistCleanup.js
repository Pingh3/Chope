// One-off cleanup for the duplicate Todoist tasks the old browser sync created.
//
//   planCleanup()   pure: works out exactly what would be kept / deleted / flagged
//   applyCleanup()  performs it (only ever called with --apply)
//
// Rules (agreed with the owner):
//  * Todoist tasks in the Chope project are matched to the owner's Chope tasks by normalised title.
//  * Where a title appears more than once, KEEP the one with the latest date (deadline or Date,
//    whichever is later), delete the rest, and backfill the kept task's id as the mapping.
//  * Each extra duplicate counts as one past reschedule, so repeat offenders are flagged from day
//    one (count is seeded with max(existing, duplicates) so re-running never double counts).
//  * Never guess: titles shared by several Chope tasks are reported and left alone; Todoist tasks
//    with no Chope counterpart are left alone; a duplicate that has subtasks is never deleted
//    (deleting a task deletes its subtasks).
import { norm, newRecord, mergeLabels, sameSet, dateOnly, LABEL_BASE, LABEL_S2, LABEL_S3 } from './todoistSync.js';

const dates = a => [a.deadline?.date, a.due?.date].filter(Boolean).map(d => String(d).slice(0, 10));
const latestDate = a => dates(a).sort().pop() || '';
const stamp = a => a.updated_at || a.added_at || '';
const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };
const brief = a => ({ id: String(a.id), deadline: a.deadline?.date || null, due: dateOnly(a.due?.date), addedAt: a.added_at || null });

export function planCleanup({ chopeTasks, todoistTasks, ownerName, state }) {
  const mine = chopeTasks.filter(t => t.assignee === ownerName);
  const chopeByTitle = groupBy(mine, t => norm(t.name));
  const hasChildren = new Set(todoistTasks.filter(a => a.parent_id).map(a => String(a.parent_id)));
  const plan = { groups: [], unmatched: [], ambiguous: [], untouched: 0 };

  for (const [key, list] of groupBy(todoistTasks, a => norm(a.content))) {
    const matches = chopeByTitle.get(key) || [];
    if (matches.length === 0) { plan.unmatched.push({ title: list[0].content, count: list.length, ids: list.map(a => String(a.id)) }); continue; }
    if (matches.length > 1) { plan.ambiguous.push({ title: list[0].content, choreCount: matches.length, todoistCount: list.length }); continue; }

    const task = matches[0];
    const ranked = [...list].sort((a, b) =>
      latestDate(b).localeCompare(latestDate(a)) || stamp(b).localeCompare(stamp(a)) || String(b.id).localeCompare(String(a.id)));
    const keep = ranked[0];
    const extras = ranked.slice(1);
    const deletable = extras.filter(a => !hasChildren.has(String(a.id)));
    const blocked = extras.filter(a => hasChildren.has(String(a.id)));
    const rec = state?.tasks?.[task.id];
    const currentCount = rec?.count || 0;
    const seed = extras.length;
    const newCount = Math.max(currentCount, seed);
    const alreadyMapped = rec?.todoistId === String(keep.id);

    if (!extras.length && alreadyMapped) { plan.untouched++; continue; }
    plan.groups.push({
      choreId: task.id, chopeTask: task, title: task.name,
      keep: brief(keep), keepLabels: keep.labels || [],
      deletable: deletable.map(brief), blocked: blocked.map(brief),
      seed, currentCount, newCount,
      firstDate: list.flatMap(dates).sort()[0] || task.deadline || null, // earliest date any duplicate carried = the original
      firstAddedAt: list.map(a => a.added_at).filter(Boolean).sort()[0] || null,
      remap: !!rec?.todoistId && rec.todoistId !== String(keep.id),
      strikeLabel: newCount >= 3 ? LABEL_S3 : newCount === 2 ? LABEL_S2 : null,
    });
  }
  return plan;
}

export async function applyCleanup({ todoist, store, now = () => new Date() }, plan) {
  const nowDate = now(), nowIso = nowDate.toISOString();
  const holder = await store.acquireLock(240000, nowDate.getTime());
  if (!holder) throw new Error('A sync is running right now — try again in a minute.');
  const result = { deleted: 0, mapped: 0, labelled: 0, seeded: 0, errors: [] };
  try {
    const state = await store.loadState();
    state.tasks = state.tasks || {};
    const have = new Set((await todoist.listLabels()).map(l => String(l.name).toLowerCase()));
    for (const name of [LABEL_BASE, LABEL_S2, LABEL_S3]) if (!have.has(name)) await todoist.createLabel(name);
    state.labelsReady = true;
    const rows = [];

    for (const g of plan.groups) {
      try {
        for (const d of g.deletable) {
          try { await todoist.deleteTask(d.id); result.deleted++; } catch (e) { if (e.status !== 404) throw e; }
        }
        const t = g.chopeTask;
        const rec = state.tasks[g.choreId] || newRecord(t, nowIso);
        rec.todoistId = g.keep.id; rec.closed = false; rec.missingSince = null; rec.ambiguous = false;
        rec.count = g.newCount;
        if (g.firstDate && (!rec.firstDate || g.firstDate < rec.firstDate)) rec.firstDate = g.firstDate;
        if (g.firstAddedAt && g.firstAddedAt < rec.firstSeenAt) rec.firstSeenAt = g.firstAddedAt;
        rec.lastChopeDeadline = t.deadline || null; rec.lastChopeStart = t.startDate || null;
        rec.todoistSeen = true; rec.lastSeenTodoistDue = g.keep.due;
        state.tasks[g.choreId] = rec;
        result.mapped++;

        const wanted = mergeLabels(g.keepLabels, g.newCount);
        if (!sameSet(wanted, g.keepLabels)) { await todoist.updateTask(g.keep.id, { labels: wanted }); result.labelled++; }
        if (g.seed > g.currentCount) {
          rows.push({ task_id: g.choreId, source: 'cleanup', old_date: null, new_date: null, changed_at: nowIso, counted: true,
            note: `seeded ${g.seed} from duplicate Todoist tasks` });
          result.seeded++;
        }
      } catch (e) { result.errors.push({ task: g.choreId, title: g.title, error: e.message }); }
    }
    await store.appendChanges(rows);
    await store.saveState(state);
  } finally {
    await store.releaseLock(holder);
  }
  return result;
}
