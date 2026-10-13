import test from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, applyCleanup } from '../lib/todoistCleanup.js';
import { runSync } from '../lib/todoistSync.js';
import { createMemoryStore } from '../lib/syncStore.js';
import { createFakeTodoist } from './helpers/fakeTodoist.mjs';

const OWNER = 'Victor';
const T = (id, name, o = {}) => ({ id, name, desc: '', assignee: OWNER, priority: 'med', status: 'todo', deadline: '2026-10-20', startDate: null, createdAt: '2026-10-01T00:00:00Z', ...o });

function env(chope) {
  const todoist = createFakeTodoist();
  const store = createMemoryStore({ tasks: chope });
  const clock = new Date('2026-10-14T04:00:00Z');
  const deps = { todoist, store, ownerName: OWNER, tz: 'Asia/Singapore', now: () => clock };
  const plan = async () => planCleanup({ chopeTasks: await store.loadTasks(), todoistTasks: await todoist.listActive({ projectId: 'p1' }), ownerName: OWNER, state: await store.loadState() });
  return { todoist, store, deps, plan };
}

test('keeps the duplicate with the latest date, deletes the rest, seeds the count from the extras', async () => {
  const { todoist, plan } = env([T('a', 'Draft investor letter')]);
  const old1 = todoist.userAdd({ content: 'Draft investor letter', deadline: { date: '2026-10-05' } });
  const old2 = todoist.userAdd({ content: 'Draft Investor Letter', deadline: { date: '2026-10-12' } });
  const latest = todoist.userAdd({ content: 'draft investor letter!', deadline: { date: '2026-10-20' } });
  const p = await plan();
  assert.equal(p.groups.length, 1);
  const g = p.groups[0];
  assert.equal(g.keep.id, latest);
  assert.deepEqual(g.deletable.map(d => d.id).sort(), [old1, old2].sort());
  assert.equal(g.seed, 2);
  assert.equal(g.newCount, 2);
  assert.equal(g.strikeLabel, 'strike-2');
  assert.equal(g.firstDate, '2026-10-05');   // the earliest date any duplicate carried
});

test('DRY RUN (planning) changes nothing; APPLY deletes, maps, seeds, labels', async () => {
  const { todoist, store, deps, plan } = env([T('a', 'Task a'), T('b', 'Task b')]);
  const ids = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'].map(d => todoist.userAdd({ content: 'Task a', deadline: { date: d } }));
  const bId = todoist.userAdd({ content: 'Task b', deadline: { date: '2026-10-20' } });
  todoist.resetCalls();
  const p = await plan();                                   // planning is read-only
  assert.deepEqual(todoist.writeCalls(), []);
  assert.equal(todoist.active().length, 5);

  const res = await applyCleanup(deps, p);
  assert.equal(res.deleted, 3);
  assert.equal(res.errors.length, 0);
  assert.deepEqual(todoist.active().map(t => t.id).sort(), [ids[3], bId].sort());
  const st = await store.loadState();
  assert.equal(st.tasks.a.todoistId, ids[3]);
  assert.equal(st.tasks.a.count, 3);                         // 3 extra duplicates
  assert.equal(st.tasks.b.todoistId, bId);
  assert.equal(st.tasks.b.count, 0);                         // single match: id backfilled only
  const kept = todoist._tasks.get(ids[3]);
  assert.ok(kept.labels.includes('strike-3') && kept.labels.includes('chope'));
  assert.ok((await store.loadChanges()).some(r => r.source === 'cleanup' && r.task_id === 'a'));
});

test('re-running is idempotent: a second plan has nothing to do and counts are not doubled', async () => {
  const { todoist, store, deps, plan } = env([T('a', 'Task a')]);
  todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-01' } });
  todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-09' } });
  await applyCleanup(deps, await plan());
  const second = await plan();
  assert.equal(second.groups.length, 0);
  assert.equal(second.untouched, 1);
  assert.equal((await store.loadState()).tasks.a.count, 1);
});

test('never guesses: ambiguous Chope titles and Todoist-only tasks are reported and left alone', async () => {
  const { todoist, plan } = env([T('a', 'Weekly report'), T('b', 'Weekly report')]);
  todoist.userAdd({ content: 'Weekly report' }); todoist.userAdd({ content: 'Weekly report' });
  todoist.userAdd({ content: 'Buy basketball shoes' });
  const p = await plan();
  assert.equal(p.groups.length, 0);
  assert.equal(p.ambiguous.length, 1);
  assert.equal(p.unmatched.length, 1);
  assert.equal(p.unmatched[0].title, 'Buy basketball shoes');
});

test('never deletes a duplicate that has subtasks (deleting would delete them too)', async () => {
  const { todoist, plan } = env([T('a', 'Task a')]);
  const keep = todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-20' } });
  const withKids = todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-01' } });
  const kid = todoist.userAdd({ content: 'Sub item' });
  todoist._tasks.get(kid).parent_id = withKids;
  const g = (await plan()).groups[0];
  assert.equal(g.keep.id, keep);
  assert.deepEqual(g.deletable, []);
  assert.deepEqual(g.blocked.map(b => b.id), [withKids]);
});

test('after cleanup, the first sync adopts the kept task instead of creating anything', async () => {
  const { todoist, store, deps, plan } = env([T('a', 'Task a', { startDate: null })]);
  todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-01' } });
  const keep = todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-20' } });
  await applyCleanup(deps, await plan());
  todoist.resetCalls();
  const r = await runSync(deps);
  assert.equal(r.created, 0);
  assert.equal(r.recreated, 0);
  assert.equal(todoist.active().length, 1);
  assert.equal(todoist.active()[0].id, keep);
  assert.equal((await store.loadState()).tasks.a.count, 1);          // strike seeded by the cleanup survives
  assert.ok(todoist.active()[0].labels.includes('chope'));
});
