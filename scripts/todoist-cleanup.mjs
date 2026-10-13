#!/usr/bin/env node
// One-off cleanup of duplicate Todoist tasks left behind by the old browser sync.
//
//   DRY RUN (default — changes nothing, just prints the plan):
//     node --env-file=C:\Users\<you>\.chope-env scripts/todoist-cleanup.mjs
//   APPLY (deletes duplicates, backfills ids, seeds reschedule counts, adds labels):
//     node --env-file=C:\Users\<you>\.chope-env scripts/todoist-cleanup.mjs --apply
//
// Options:  --project "Name"   Todoist project to clean (default: TODOIST_PROJECT_NAME or "Chope")
//           --owner "Name"     whose Chope tasks to match (default: TODOIST_OWNER or "Victor")
//
// Needs (in the env file — keep it OUTSIDE the OneDrive-synced project folder): TODOIST_API_TOKEN,
// FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY. See .env.example.
import { adminDb } from '../lib/firebaseAdmin.js';
import { createFirestoreStore } from '../lib/syncStore.js';
import { createTodoistClient } from '../lib/todoistClient.js';
import { planCleanup, applyCleanup } from '../lib/todoistCleanup.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const apply = flag('--apply');
const projectName = opt('--project', process.env.TODOIST_PROJECT_NAME || 'Chope');
const ownerName = opt('--owner', process.env.TODOIST_OWNER || 'Victor');

const missing = ['TODOIST_API_TOKEN', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}\nPass them with: node --env-file=<path-to-env-file> scripts/todoist-cleanup.mjs`);
  process.exit(1);
}

const todoist = createTodoistClient({ token: process.env.TODOIST_API_TOKEN });
const store = createFirestoreStore(adminDb());

const project = (await todoist.listProjects()).find(p => p.name === projectName);
if (!project) { console.error(`No Todoist project named "${projectName}". Nothing to clean.`); process.exit(1); }

const [chopeTasks, state, todoistTasks] = await Promise.all([
  store.loadTasks(), store.loadState(), todoist.listActive({ projectId: project.id }),
]);
const plan = planCleanup({ chopeTasks, todoistTasks, ownerName, state });

const fmt = a => `${a.id}  deadline ${a.deadline || '—'}  date ${a.due || '—'}`;
console.log(`\n${apply ? 'APPLYING' : 'DRY RUN'} — Todoist project "${projectName}" (${todoistTasks.length} active tasks), ${ownerName}'s Chope tasks\n${'─'.repeat(78)}`);
for (const g of plan.groups) {
  console.log(`\n• "${g.title}"   (Chope task ${g.choreId})`);
  console.log(`    KEEP    ${fmt(g.keep)}${g.remap ? '   (changes the existing mapping)' : ''}`);
  g.deletable.forEach(d => console.log(`    DELETE  ${fmt(d)}`));
  g.blocked.forEach(d => console.log(`    SKIP    ${fmt(d)}   (has subtasks — not deleted, check by hand)`));
  const flags = [];
  if (g.newCount > g.currentCount) flags.push(`reschedule count ${g.currentCount} → ${g.newCount}`);
  if (g.strikeLabel) flags.push(`label ${g.strikeLabel}`);
  console.log(`    ${g.deletable.length || g.blocked.length ? 'FLAG    ' : 'MAP     '}${flags.join(', ') || 'backfill id only'}`);
}
if (plan.ambiguous.length) {
  console.log(`\nAMBIGUOUS — left alone (several Chope tasks share the title):`);
  plan.ambiguous.forEach(a => console.log(`    "${a.title}"  ${a.choreCount} Chope tasks, ${a.todoistCount} Todoist task(s)`));
}
if (plan.unmatched.length) {
  console.log(`\nNO CHOPE TASK — left alone (probably added in Todoist directly):`);
  plan.unmatched.forEach(u => console.log(`    "${u.title}"  ×${u.count}`));
}
const toDelete = plan.groups.reduce((n, g) => n + g.deletable.length, 0);
const flagged = plan.groups.filter(g => g.newCount >= 2).length;
console.log(`\n${'─'.repeat(78)}\nSummary: ${plan.groups.length} task(s) to map, ${toDelete} duplicate(s) to delete, ${flagged} flagged (strike-2/3), ` +
  `${plan.untouched} already clean, ${plan.ambiguous.length} ambiguous, ${plan.unmatched.length} without a Chope task.`);

if (!apply) {
  console.log('\nDRY RUN — nothing was changed. Review the list above, then re-run with --apply to perform it.');
  process.exit(0);
}
const res = await applyCleanup({ todoist, store }, plan);
console.log(`\nDone: ${res.deleted} deleted, ${res.mapped} mapped, ${res.labelled} label update(s), ${res.seeded} reschedule count(s) seeded.`);
if (res.errors.length) { console.error('Errors:'); res.errors.forEach(e => console.error(`  ${e.title}: ${e.error}`)); process.exit(2); }
