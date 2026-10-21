// "Add to Chope" inbox: tasks created outside the app (the Gmail Chrome extension) wait here until
// the owner's Chope picks them up.
//
// Why an inbox instead of writing straight into the shared task array: every browser saves that
// whole array back with "the local copy wins", and a server write landing between a browser's read
// and its write would be silently erased — the same race that lost Todoist links. Here the server
// only ever writes its own document, and the app merges items into its task list itself, then
// acknowledges them.
//
//   chope/inbox   { items: { [taskId]: { email, task, createdAt } } }
import { createHash } from 'node:crypto';
import { localDay } from './todoistSync.js';

// Mirrors CATEGORIES in index.html (keys only). Unknown keys fall back to 'admin', which is also
// what the app's existing "add task from Gmail" uses.
export const CATEGORY_KEYS = ['portfolio', 'acq', 'debt', 'ir', 'fund', 'compliance', 'corp', 'projects', 'strategic', 'admin'];
const PRIORITIES = new Set(['high', 'med', 'low']);
export const MAX_PENDING_PER_USER = 200;
const MAX_AGE_MS = 30 * 86400000;

export class ValidationError extends Error {}

// Same (user, requestId) always yields the same task id, so a retry or double-click can't create two.
export function taskIdFor(email, requestId) {
  return 'em' + createHash('sha1').update(`${email.toLowerCase()}|${requestId}`).digest('hex').slice(0, 20);
}

const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// Only Gmail permalinks are kept — the link is rendered as a clickable "Open email" in the app, so
// it must not be able to point anywhere else.
export function cleanGmailLink(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).slice(0, 600));
    if (u.protocol !== 'https:' || u.hostname !== 'mail.google.com') return null;
    // Gmail keeps its route (and any ?compose=… style extras) inside the # part, so strip it there too.
    return u.origin + u.pathname + u.hash.split('?')[0];
  } catch { return null; }
}

export function buildInboxTask(payload, user, { now = new Date(), tz = 'Asia/Singapore' } = {}) {
  const p = payload || {};
  const name = String(p.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new ValidationError('A task name is required.');
  if (name.length > 200) throw new ValidationError('Task name is too long (200 characters max).');
  const requestId = String(p.requestId || '').trim().slice(0, 100);
  if (!requestId) throw new ValidationError('requestId is required.');
  let deadline = null;
  if (p.deadline) {
    if (!validDate(String(p.deadline))) throw new ValidationError('Due date must be a real date in YYYY-MM-DD format.');
    deadline = String(p.deadline);
  }
  if (!user?.name) throw new ValidationError('Your account has no Chope name set — ask your admin.');
  const link = cleanGmailLink(p.link);
  return {
    id: taskIdFor(user.email, requestId),
    name,
    desc: String(p.notes || '').trim().slice(0, 2000),
    cat: CATEGORY_KEYS.includes(p.cat) ? p.cat : 'admin',
    fund: '',
    assignee: user.name,
    priority: PRIORITIES.has(p.priority) ? p.priority : 'med',
    status: 'todo',
    startDate: localDay(now, tz),
    deadline,
    ws: '',
    createdAt: now.toISOString(),
    source: 'gmail-extension',
    ...(link ? { emailLink: link } : {}),
  };
}

// ── storage: in-memory (tests) and Firestore (production), same interface ──
function applyAdd(items, email, task, nowMs) {
  const mail = email.toLowerCase();
  for (const [id, it] of Object.entries(items)) if (nowMs - it.createdAt > MAX_AGE_MS) delete items[id];
  if (items[task.id]) return false; // already waiting: idempotent retry
  if (Object.values(items).filter(it => it.email === mail).length >= MAX_PENDING_PER_USER) {
    throw new ValidationError('Too many tasks are waiting — open Chope to pick them up first.');
  }
  items[task.id] = { email: mail, task, createdAt: nowMs };
  return true;
}
const mine = (items, email) => Object.values(items).filter(it => it.email === email.toLowerCase()).sort((a, b) => a.createdAt - b.createdAt).map(it => it.task);
function applyAck(items, email, ids) {
  const mail = email.toLowerCase();
  for (const id of ids) if (items[id] && items[id].email === mail) delete items[id];
}

export function createMemoryInbox() {
  const items = {};
  return {
    _items: items,
    async add(email, task, nowMs = Date.now()) { return applyAdd(items, email, task, nowMs); },
    async list(email) { return mine(items, email); },
    async ack(email, ids) { applyAck(items, email, ids); },
  };
}

export function createFirestoreInbox(db) {
  const ref = db.collection('chope').doc('inbox');
  const mutate = fn => db.runTransaction(async tx => {
    const d = await tx.get(ref);
    const items = d.exists ? (d.data().items || {}) : {};
    const out = fn(items);
    tx.set(ref, { items });
    return out;
  });
  return {
    add: (email, task, nowMs = Date.now()) => mutate(items => applyAdd(items, email, task, nowMs)),
    async list(email) { const d = await ref.get(); return mine(d.exists ? (d.data().items || {}) : {}, email); },
    ack: (email, ids) => mutate(items => applyAck(items, email, ids)),
  };
}
