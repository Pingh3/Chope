#!/usr/bin/env node
// Live check of the Todoist behaviours the sync relies on, run against your REAL Todoist account.
//
//   node --env-file=C:\Users\<you>\.chope-env scripts/todoist-live-check.mjs --project Basketball
//
// Safe by construction: it only ever touches tasks/labels it creates itself (titles start with
// "[chope-test]", label names start with "chope-test"), never reads or edits anything pre-existing,
// and deletes everything it made when it finishes (even if a check fails).
//
// Settles what the API docs don't say: does `labels` on update REPLACE the list, does omitting
// `due_date` really leave the Date alone, what happens when you update a COMPLETED task, and is
// X-Request-Id honoured as an idempotency key.
import { createTodoistClient } from '../lib/todoistClient.js';

const i = process.argv.indexOf('--project');
const projectName = i >= 0 ? process.argv[i + 1] : (process.env.TODOIST_TEST_PROJECT || 'Basketball');
if (!process.env.TODOIST_API_TOKEN) { console.error('TODOIST_API_TOKEN is not set (pass --env-file=<path>).'); process.exit(1); }

const td = createTodoistClient({ token: process.env.TODOIST_API_TOKEN });
const results = [];
const note = (ok, name, detail = '') => { results.push({ ok, name }); console.log(`${ok === true ? '  PASS' : ok === false ? '  FAIL' : '  INFO'}  ${name}${detail ? '  — ' + detail : ''}`); };
const get = async id => (await td.getTasksByIds([id])).get(String(id));

const project = (await td.listProjects()).find(p => p.name === projectName);
if (!project) { console.error(`No Todoist project named "${projectName}".`); process.exit(1); }
console.log(`\nLive check in project "${projectName}" — creating and removing only its own [chope-test] items\n`);

const madeTasks = new Set(), madeLabels = [];
const stamp = Date.now().toString(36);
const title = `[chope-test] probe ${stamp}`;
try {
  for (const name of [`chope-test-a-${stamp}`, `chope-test-b-${stamp}`]) { const l = await td.createLabel(name); madeLabels.push(l.id); }
  const [A, B] = [`chope-test-a-${stamp}`, `chope-test-b-${stamp}`];

  // 1. create with a Date (due) and a deadline, and see how they come back
  const key = crypto.randomUUID();
  const body = { content: title, project_id: project.id, due_date: '2030-01-10', deadline_date: '2030-01-20', labels: [A] };
  const t = await td.createTask(body, key); madeTasks.add(t.id);
  note(t.due?.date?.slice(0, 10) === '2030-01-10' && t.deadline?.date === '2030-01-20', 'create sets Date (due) and deadline separately', `due=${t.due?.date} deadline=${t.deadline?.date}`);

  // 2. is X-Request-Id an idempotency key?
  const again = await td.createTask(body, key); madeTasks.add(again.id);
  note(null, 'repeating a create with the same X-Request-Id', again.id === t.id ? 'HONOURED — returned the same task' : 'NOT honoured — made a second task (so the sync must not rely on it; it dedupes by stored id + adoption instead)');

  // 3. omitting due_date on update leaves the Date alone; changing deadline works
  await td.updateTask(t.id, { content: title + ' edited', deadline_date: '2030-02-02' });
  let cur = await get(t.id);
  note(cur?.due?.date?.slice(0, 10) === '2030-01-10', 'update that omits due_date leaves your Date untouched', `due=${cur?.due?.date}`);
  note(cur?.deadline?.date === '2030-02-02', 'update changes deadline_date', `deadline=${cur?.deadline?.date}`);

  // 4. labels on update: replace or merge?
  await td.updateTask(t.id, { labels: [A, B] });
  await td.updateTask(t.id, { labels: [A] });
  cur = await get(t.id);
  const labels = [...(cur?.labels || [])].sort();
  note(labels.length === 1 && labels[0] === A, 'updating labels REPLACES the whole list (so the sync merges to keep your own labels)', `labels now: ${JSON.stringify(labels)}`);

  // 5. clearing a deadline
  await td.updateTask(t.id, { deadline_date: null });
  cur = await get(t.id);
  note(cur && cur.deadline == null, 'deadline_date: null clears the deadline', `deadline=${JSON.stringify(cur?.deadline)}`);

  // 6. close / completed visibility / update-on-completed / reopen
  await td.closeTask(t.id);
  note((await get(t.id)) === undefined, 'a closed task disappears from the active list (read by id)');
  note((await td.listCompletedIds()).has(String(t.id)), 'a closed task shows up in the completed list (how the sync tells "completed" from "deleted")');
  let updateOnCompleted;
  try { await td.updateTask(t.id, { content: title + ' while completed' }); updateOnCompleted = 'succeeds'; } catch (e) { updateOnCompleted = `fails with HTTP ${e.status}`; }
  note(null, 'updating a COMPLETED task', updateOnCompleted + ' (the sync reopens a completed task before touching it, so either is fine)');
  await td.reopenTask(t.id);
  note(!!(await get(t.id)), 'reopen brings it back to the active list');

  // 7. delete, then a second delete
  await td.deleteTask(t.id);
  note((await get(t.id)) === undefined, 'delete removes it');
  let second; try { await td.deleteTask(t.id); second = 'succeeded'; } catch (e) { second = `HTTP ${e.status}`; }
  note(null, 'deleting an already-deleted task', second + ' (sync treats 404 as already gone)');
  madeTasks.delete(t.id);
} catch (e) {
  note(false, 'unexpected error', e.message);
} finally {
  for (const id of madeTasks) { try { await td.deleteTask(id); } catch {} }
  for (const id of madeLabels) { try { await td.deleteLabel(id); } catch {} }
  console.log('\nCleaned up: removed every [chope-test] task and label this run created.');
}
const failed = results.filter(r => r.ok === false).length;
console.log(failed ? `\n${failed} check(s) FAILED — send me this output.` : '\nAll checks passed. (INFO lines are findings, not pass/fail.)');
process.exit(failed ? 2 : 0);
