import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/todoist-sync.js';
import { planCleanup, summarizePlan } from '../lib/todoistCleanup.js';
import { createFakeTodoist } from './helpers/fakeTodoist.mjs';

// Minimal req/res doubles. Requests authenticate with the shared secret, so Firebase is never touched.
const call = async (method, body, { auth = 'Bearer s3cret' } = {}) => {
  let out;
  const res = { _h: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { out = o; return this; } };
  await handler({ method, headers: auth ? { authorization: auth } : {}, body }, res);
  return { code: res.code, body: out };
};
const env = (vars, fn) => async () => {
  const keys = ['TODOIST_API_TOKEN', 'TODOIST_SYNC_ENABLED', 'CRON_SECRET', 'TODOIST_OWNER'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  keys.forEach(k => delete process.env[k]);
  Object.assign(process.env, { CRON_SECRET: 's3cret', ...vars });
  try { await fn(); } finally { keys.forEach(k => saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); }
};

test('a token alone does NOT switch Todoist syncing on (push tracking is always on, though)', env({ TODOIST_API_TOKEN: 'tok' }, async () => {
  assert.deepEqual((await call('POST', { action: 'status' })).body, { enabled: false, tracking: true, owner: 'Victor' });
}));

test('with no token at all, Todoist is off but team-wide push tracking still reports as available', env({}, async () => {
  assert.deepEqual((await call('POST', { action: 'status' })).body, { enabled: false, tracking: true, owner: 'Victor' });
}));

test('token + TODOIST_SYNC_ENABLED=1 reports syncing as on', env({ TODOIST_API_TOKEN: 'tok', TODOIST_SYNC_ENABLED: '1' }, async () => {
  assert.deepEqual((await call('POST', { action: 'status' })).body, { enabled: true, tracking: true, owner: 'Victor' });
}));

test('the flag without a token is still off', env({ TODOIST_SYNC_ENABLED: '1' }, async () => {
  assert.equal((await call('POST', { action: 'status' })).body.enabled, false);
}));

test('cleanup needs the token, the owner, and real credentials', env({}, async () => {
  assert.equal((await call('POST', { action: 'cleanup' })).code, 400);                          // no token yet
  assert.equal((await call('POST', { action: 'cleanup' }, { auth: 'Bearer wrong' })).code, 401); // wrong secret
  assert.equal((await call('POST', { action: 'cleanup' }, { auth: null })).code, 401);
  assert.equal((await call('GET', undefined, { auth: 'Bearer wrong' })).code, 401);
  assert.equal((await call('PUT')).code, 405);
}));

test('a dry-run sync reads for real but changes nothing — in Todoist or in the saved state', async () => {
  const { runSync } = await import('../lib/todoistSync.js');
  const { createDryRun, createDryStore } = await import('../lib/dryRun.js');
  const { createMemoryStore } = await import('../lib/syncStore.js');
  const todoist = createFakeTodoist();
  const existing = todoist.userAdd({ content: 'Task a', deadline: { date: '2026-10-01' } });   // will be adopted
  const store = createMemoryStore({ tasks: [
    { id: 'a', name: 'Task a', assignee: 'Victor', priority: 'high', status: 'todo', deadline: '2026-10-20', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', name: 'Task b', assignee: 'Victor', priority: 'low', status: 'todo', deadline: '2026-10-25', createdAt: '2026-10-02T00:00:00Z' },
  ] });
  const dry = createDryRun(todoist);
  const r = await runSync({ todoist: dry.todoist, store: createDryStore(store), ownerName: 'Victor', tz: 'Asia/Singapore', now: () => new Date('2026-10-14T04:00:00Z') });
  assert.equal(r.created, 1);                                  // it reports what it WOULD do…
  assert.equal(r.adopted, 1);
  assert.deepEqual(dry.writes.filter(w => w.kind === 'createTask').map(w => w.body.content), ['Task b']);
  assert.deepEqual(todoist.writeCalls(), []);                  // …but Todoist was never written to
  assert.equal(todoist.active().length, 1);
  assert.equal(todoist._tasks.get(existing).deadline.date, '2026-10-01');
  assert.equal(store._s.saves, 0);                             // and no sync state was saved
  assert.deepEqual(store._s.state.tasks, {});
});

test('summarizePlan returns a JSON-safe view without full task objects', () => {
  const todoist = createFakeTodoist();
  const a = todoist.userAdd({ content: 'Draft letter', deadline: { date: '2026-10-01' } });
  const b = todoist.userAdd({ content: 'Draft letter', deadline: { date: '2026-10-20' } });
  const chope = [{ id: 'c1', name: 'Draft letter', assignee: 'Victor', status: 'todo', secretNotes: 'do not leak', deadline: '2026-10-20' }];
  const plan = planCleanup({ chopeTasks: chope, todoistTasks: [...todoist._tasks.values()], ownerName: 'Victor', state: { tasks: {} } });
  const sum = summarizePlan(plan);
  assert.deepEqual(sum.totals, { toMap: 1, toDelete: 1, flagged: 0, ambiguous: 0, unmatched: 0 });
  assert.equal(sum.groups[0].keep.id, b);
  assert.deepEqual(sum.groups[0].delete.map(d => d.id), [a]);
  assert.ok(!JSON.stringify(sum).includes('do not leak'));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(sum)));
});
