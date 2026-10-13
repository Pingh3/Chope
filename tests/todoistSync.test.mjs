// Run with: npm test   (node --test tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync, decide, buildStrikeView, evaluateDateChange, localDay, strikeLabelFor, idempotencyKey } from '../lib/todoistSync.js';
import { createMemoryStore } from '../lib/syncStore.js';
import { createFakeTodoist } from './helpers/fakeTodoist.mjs';
import { createTodoistClient, TodoistError } from '../lib/todoistClient.js';

const OWNER = 'Victor';
// Clock starts 12:00 Singapore time on Wed 14 Oct 2026; the strike rule's "calendar day" is SGT.
function setup(tasks = []) {
  const todoist = createFakeTodoist();
  const store = createMemoryStore({ tasks });
  const clock = { t: new Date('2026-10-14T04:00:00Z') };
  const deps = () => ({ todoist, store, ownerName: OWNER, tz: 'Asia/Singapore', now: () => clock.t });
  return {
    todoist, store, clock, deps,
    sync: opts => runSync(deps(), opts),
    advance: ms => { clock.t = new Date(clock.t.getTime() + ms); },
    day: n => { clock.t = new Date(clock.t.getTime() + n * 86400000); },
    patch: (id, p) => Object.assign(store._s.tasks.find(t => t.id === id), p),
    rec: id => store._s.state.tasks[id],
    onlyActive: () => todoist.active(),
  };
}
const T = (id, o = {}) => ({
  id, name: `Task ${id}`, desc: '', assignee: OWNER, priority: 'med', status: 'todo',
  deadline: '2026-10-20', startDate: '2026-10-15', createdAt: '2026-10-01T00:00:00Z', ...o,
});

test('creates open tasks assigned to the owner only, in the Chope project with the chope label', async () => {
  const { todoist, sync } = setup([T('a'), T('b', { assignee: 'Danial' }), T('c', { status: 'done' })]);
  const r = await sync();
  assert.equal(r.created, 1);
  const [t] = todoist.active();
  assert.equal(t.content, 'Task a');
  assert.equal(t.project_id, 'p1');
  assert.deepEqual(t.labels, ['chope']);
  assert.equal(t.deadline.date, '2026-10-20');  // Chope Due Date -> Todoist deadline
  assert.equal(t.due.date, '2026-10-15');       // Chope Start Date -> Todoist Date
  assert.equal(t.priority, 3);
});

test('ACCEPTANCE 1: changing the due date updates the SAME Todoist task, no duplicate', async () => {
  const { todoist, sync, patch } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  todoist.resetCalls();
  patch('a', { deadline: '2026-10-27' });
  await sync();
  assert.equal(todoist.active().length, 1);
  assert.equal(todoist.active()[0].id, id);
  assert.equal(todoist.active()[0].deadline.date, '2026-10-27');
  assert.ok(!todoist._calls.includes('createTask'));
});

test('unrelated edits never overwrite the Date the owner plans with in Todoist', async () => {
  const { todoist, sync, patch } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  todoist.userSetDue(id, '2026-10-18');               // owner re-plans in Todoist
  patch('a', { name: 'Task a renamed' });
  await sync();
  assert.equal(todoist.active()[0].content, 'Task a renamed');
  assert.equal(todoist.active()[0].due.date, '2026-10-18');
  assert.ok(!('due_date' in todoist.lastUpdateBody));
});

test('changing the start date in Chope does push to the Todoist Date, and is not counted as a reschedule', async () => {
  const { todoist, sync, patch, store } = setup([T('a')]);
  await sync();
  patch('a', { startDate: '2026-10-17' });
  await sync();
  assert.equal(todoist.active()[0].due.date, '2026-10-17');
  await sync();
  assert.equal(store._s.state.tasks.a.count, 0);
  assert.ok(!store._s.rows.some(r => r.source === 'todoist_due'));
});

test('ACCEPTANCE 2: completing in Chope closes the Todoist task', async () => {
  const { todoist, sync, patch } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  patch('a', { status: 'done' });
  const r = await sync();
  assert.equal(r.closed, 1);
  assert.equal(todoist._tasks.get(id).checked, true);
  assert.ok(todoist._calls.includes(`closeTask:${id}`));
});

test('reopening in Chope reopens the Todoist task instead of creating a new one', async () => {
  const { todoist, sync, patch } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  patch('a', { status: 'done' }); await sync();
  patch('a', { status: 'todo' });
  const r = await sync();
  assert.equal(r.reopened, 1);
  assert.equal(r.created, 0);
  assert.equal(todoist._tasks.get(id).checked, false);
});

test('ACCEPTANCE 3: deleted in Todoist, then edited in Chope -> recreated with a new id', async () => {
  const { todoist, sync, patch, rec } = setup([T('a')]);
  await sync();
  const oldId = todoist.active()[0].id;
  todoist.userDelete(oldId);
  patch('a', { name: 'Task a edited' });
  const r = await sync();
  assert.equal(r.recreated, 1);
  assert.equal(todoist.active().length, 1);
  assert.notEqual(todoist.active()[0].id, oldId);
  assert.equal(rec('a').todoistId, todoist.active()[0].id);
});

test('completed in Todoist while still open in Chope -> reopened, not duplicated', async () => {
  const { todoist, sync, rec } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  todoist.userComplete(id);
  const r = await sync();
  assert.equal(r.reopened, 1);
  assert.equal(r.created, 0);
  assert.equal(todoist.active().length, 1);
  assert.equal(rec('a').todoistId, id);
});

test('ACCEPTANCE 4: running sync twice in a row makes no changes the second time', async () => {
  const { todoist, sync } = setup([T('a'), T('b', { priority: 'high', desc: 'notes' }), T('c', { status: 'done' })]);
  await sync();
  todoist.resetCalls();
  const r = await sync();
  assert.deepEqual(todoist.writeCalls(), []);
  assert.equal(r.created + r.updated + r.closed + r.deleted + r.reopened, 0);
});

test('ACCEPTANCE 5: pushing the date later on 3 different days -> strike-2 then strike-3', async () => {
  const { todoist, sync, patch, day, rec } = setup([T('a')]);
  await sync();
  day(1); patch('a', { deadline: '2026-10-25' }); await sync();
  assert.equal(rec('a').count, 1);
  assert.deepEqual(todoist.active()[0].labels, ['chope']);
  day(1); patch('a', { deadline: '2026-10-30' }); await sync();
  assert.equal(rec('a').count, 2);
  assert.ok(todoist.active()[0].labels.includes('strike-2'));
  day(1); patch('a', { deadline: '2026-11-05' }); await sync();
  assert.equal(rec('a').count, 3);
  const labels = todoist.active()[0].labels;
  assert.ok(labels.includes('strike-3') && !labels.includes('strike-2') && labels.includes('chope'));
});

test('ACCEPTANCE 6: two pushes on the same day = 1 strike; moving earlier or first-time set = none', async () => {
  const { sync, patch, day, rec } = setup([T('a'), T('b', { deadline: null })]);
  await sync();
  day(1);
  patch('a', { deadline: '2026-10-22' }); await sync();
  patch('a', { deadline: '2026-10-24' }); await sync();   // same calendar day
  assert.equal(rec('a').count, 1);
  day(1);
  patch('a', { deadline: '2026-10-21' }); await sync();   // earlier
  assert.equal(rec('a').count, 1);
  patch('b', { deadline: '2026-10-30' }); await sync();   // first time a date is set
  assert.equal(rec('b').count, 0);
});

test('recurring tasks and completed tasks never collect strikes', async () => {
  const { sync, patch, day, rec } = setup([T('r', { recurrence: 'weekly' }), T('d')]);
  await sync();
  day(1); patch('r', { deadline: '2026-10-25' }); patch('d', { status: 'done', deadline: '2026-10-25' }); await sync();
  assert.equal(rec('r').count, 0);
  assert.equal(rec('d').count, 0);
});

test('Todoist-side push (read-only): a later Date counts once; the owner\'s Date and Chope data are left alone', async () => {
  const { todoist, sync, day, rec, store } = setup([T('a')]);
  await sync();
  const id = todoist.active()[0].id;
  day(1); todoist.userSetDue(id, '2026-10-19'); await sync();
  assert.equal(rec('a').count, 1);
  assert.ok(store._s.rows.some(r => r.source === 'todoist_due' && r.old_date === '2026-10-15' && r.new_date === '2026-10-19' && r.counted));
  assert.equal(todoist.active()[0].due.date, '2026-10-19');          // never written back
  assert.equal(store._s.tasks[0].startDate, '2026-10-15');           // Chope task untouched
  day(1); todoist.userSetDue(id, '2026-10-12'); await sync();        // earlier -> no strike
  assert.equal(rec('a').count, 1);
  day(1); todoist.userSetDue(id, '2026-10-30', true); await sync();  // recurring -> no strike
  assert.equal(rec('a').count, 1);
});

test('ACCEPTANCE 7: "Decided" resets the count, removes strike labels, logs the reset, keeps the dates', async () => {
  const { todoist, sync, patch, day, rec, store, deps } = setup([T('a')]);
  await sync();
  for (const d of ['2026-10-25', '2026-10-30', '2026-11-05']) { day(1); patch('a', { deadline: d }); await sync(); }
  assert.equal(rec('a').count, 3);
  const res = await decide(deps(), 'a');
  assert.deepEqual(res, { ok: true, before: 3 });
  assert.equal(rec('a').count, 0);
  assert.deepEqual(todoist.active()[0].labels, ['chope']);
  assert.ok(store._s.rows.some(r => r.source === 'reset' && r.count_before === 3));
  assert.equal(store._s.tasks[0].deadline, '2026-11-05');
  assert.equal(todoist.active()[0].deadline.date, '2026-11-05');
});

test('completing a struck task keeps its history but removes the strike labels', async () => {
  const { todoist, sync, patch, day, rec, store } = setup([T('a')]);
  await sync();
  for (const d of ['2026-10-25', '2026-10-30']) { day(1); patch('a', { deadline: d }); await sync(); }
  const id = todoist.active()[0].id;
  assert.ok(todoist.active()[0].labels.includes('strike-2'));
  patch('a', { status: 'done' }); await sync();
  assert.ok(!todoist._tasks.get(id).labels.includes('strike-2'));
  assert.equal(rec('a').count, 2);
  assert.ok(store._s.rows.filter(r => r.counted).length === 2);
});

test('deleting in Chope deletes in Todoist: immediately when hinted, after a grace period otherwise', async () => {
  const { todoist, sync, store, advance } = setup([T('a'), T('b')]);
  await sync();
  store._s.tasks.splice(0, 1);                       // 'a' deleted in Chope
  const noHint = await sync();
  assert.equal(noHint.deleted, 0);                   // could be a transient read, so wait
  advance(61000);
  const later = await sync();
  assert.equal(later.deleted, 1);
  assert.equal(todoist.active().length, 1);
  store._s.tasks.splice(0, 1);                       // 'b' deleted, with the browser's hint
  const hinted = await sync({ deleted: ['b'] });
  assert.equal(hinted.deleted, 1);
  assert.equal(todoist.active().length, 0);
});

test('adopts a single identical existing Todoist task instead of duplicating it', async () => {
  const { todoist, sync, rec } = setup([T('a')]);
  const existing = todoist.userAdd({ content: 'task a' });          // same title after normalising
  const r = await sync();
  assert.equal(r.adopted, 1);
  assert.equal(r.created, 0);
  assert.equal(rec('a').todoistId, existing);
  assert.equal(todoist.active().length, 1);
});

test('refuses to create when identical Todoist tasks already exist (run the cleanup script first)', async () => {
  const { todoist, sync } = setup([T('a')]);
  todoist.userAdd({ content: 'Task a' }); todoist.userAdd({ content: 'Task A' });
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(r.skipped[0].reason, 'ambiguous');
  assert.equal(todoist.active().length, 2);
});

test('keeps labels the owner added by hand', async () => {
  const { todoist, sync, patch } = setup([T('a')]);
  await sync();
  todoist.userAddLabel(todoist.active()[0].id, 'deep-work');
  patch('a', { priority: 'high' });
  await sync();
  assert.deepEqual([...todoist.active()[0].labels].sort(), ['chope', 'deep-work']);
});

test('a failure on one task is reported without aborting the rest', async () => {
  const { todoist, sync } = setup([T('a'), T('b')]);
  todoist._failOn.createTitles.add('Task a');
  const r = await sync();
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.created, 1);
  assert.equal(todoist.active()[0].content, 'Task b');
});

test('overlapping runs are blocked by the lock', async () => {
  const { sync, store, clock } = setup([T('a')]);
  const holder = await store.acquireLock(60000, clock.t.getTime()); // same clock the run uses
  assert.ok(holder);
  const r = await sync();
  assert.deepEqual(r.skipped, ['locked']);
  await store.releaseLock(holder);
  assert.equal((await sync()).created, 1);
});

test('legacy todoistId values on Chope tasks are adopted as the mapping (backfill)', async () => {
  const { todoist, sync, rec } = setup([T('a', { todoistId: 'legacy1' })]);
  todoist._tasks.set('legacy1', { id: 'legacy1', content: 'Task a', description: '', priority: 3, project_id: 'p1', labels: ['chope'], due: { date: '2026-10-15', is_recurring: false }, deadline: { date: '2026-10-20' }, checked: false });
  const r = await sync();
  assert.equal(r.created, 0);
  assert.equal(rec('a').todoistId, 'legacy1');
});

test('strike review lists tasks pushed 3+ times, worst first, with original/current date and age', async () => {
  const { sync, patch, day, deps } = setup([T('a'), T('b'), T('c')]);
  await sync();
  for (const d of ['2026-10-25', '2026-10-30', '2026-11-05']) { day(1); patch('a', { deadline: d }); await sync(); }
  for (const d of ['2026-10-25', '2026-10-30', '2026-11-05', '2026-11-09']) { day(1); patch('b', { deadline: d }); await sync(); }
  day(1); patch('c', { deadline: '2026-10-25' }); await sync();
  const view = await buildStrikeView(deps(), 3);
  assert.deepEqual(view.items.map(i => [i.taskId, i.count]), [['b', 4], ['a', 3]]);
  assert.equal(view.items[0].originalDate, '2026-10-20');
  assert.equal(view.items[0].currentDate, '2026-11-09');
  assert.ok(view.items[0].daysSinceFirstScheduled >= 13);
  assert.equal(view.counts.c, 1);
});

// ── pure helpers ──
test('evaluateDateChange follows the strike rules', () => {
  const base = { today: '2026-10-14', lastStrikeDay: null, recurring: false, done: false };
  assert.equal(evaluateDateChange({ ...base, prev: null, next: '2026-10-20' }).counted, false);        // first set
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: '2026-10-19' }).counted, false); // earlier
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: '2026-10-21' }).counted, true);
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: '2026-10-21', lastStrikeDay: '2026-10-14' }).counted, false);
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: '2026-10-21', recurring: true }).counted, false);
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: '2026-10-20' }).changed, false);
  assert.equal(evaluateDateChange({ ...base, prev: '2026-10-20', next: null }).counted, false);        // cleared
});

test('helpers: Singapore calendar day, strike labels, idempotency keys', () => {
  assert.equal(localDay(new Date('2026-10-14T17:00:00Z'), 'Asia/Singapore'), '2026-10-15'); // 01:00 SGT next day
  assert.equal(localDay(new Date('2026-10-14T15:59:00Z'), 'Asia/Singapore'), '2026-10-14');
  assert.deepEqual([0, 1, 2, 3, 7].map(strikeLabelFor), [null, null, 'strike-2', 'strike-3', 'strike-3']);
  assert.equal(idempotencyKey('x', 0), idempotencyKey('x', 0));
  assert.notEqual(idempotencyKey('x', 0), idempotencyKey('x', 1));
  assert.match(idempotencyKey('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ── client: retries, pagination, error status ──
test('client retries 429/5xx with backoff, paginates, and surfaces 404 as TodoistError', async () => {
  const seen = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (first) { first = false; return new Response('', { status: 429, headers: { 'retry-after': '1' } }); }
    if (url.includes('/tasks/gone')) return new Response('{}', { status: 404 });
    if (url.includes('cursor=c2')) return new Response(JSON.stringify({ results: [{ id: '2' }], next_cursor: null }), { status: 200 });
    return new Response(JSON.stringify({ results: [{ id: '1' }], next_cursor: 'c2' }), { status: 200 });
  };
  const sleeps = [];
  const c = createTodoistClient({ token: 't0k', fetchImpl, sleep: async ms => sleeps.push(ms) });
  const m = await c.getTasksByIds(['1', '2']);
  assert.deepEqual([...m.keys()], ['1', '2']);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1000);                       // honoured Retry-After: 1
  await assert.rejects(c.updateTask('gone', {}), e => e instanceof TodoistError && e.status === 404);
});
