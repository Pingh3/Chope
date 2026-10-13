// Persistence for the Todoist sync engine. Two interchangeable implementations of one small
// interface: an in-memory store (tests, dry runs) and a Firestore store (production).
//
// Why sync state lives in its OWN documents instead of on the task objects: every task sits in a
// single array inside chope/main, and each browser writes the whole array back with "the local
// copy wins" (see _mergeById in the app). A todoist id or strike count stored on a task is
// therefore silently erased whenever a device holding an older copy saves. These documents are
// written only by the server, under a lease lock, and the browsers only ever read them through
// the API.
//
//   chope/todoistSync      { tasks: { [choreTaskId]: record }, lastRunAt, lastReport, v }
//   chope/dateChanges      { rows: [ { task_id, source, old_date, new_date, changed_at, counted } ] }
//   chope/todoistSyncLock  { holder, expiresAt }   (lease, so overlapping runs can't double-create)

const MAX_ROWS = 3000;

export function emptyState() { return { v: 1, tasks: {} }; }

export function createMemoryStore({ tasks = [], state = emptyState(), rows = [] } = {}) {
  const s = { tasks, state: JSON.parse(JSON.stringify(state)), rows: [...rows], lock: null, saves: 0 };
  return {
    _s: s,
    async loadTasks() { return JSON.parse(JSON.stringify(s.tasks)); },
    async loadState() { return JSON.parse(JSON.stringify(s.state)); },
    async saveState(st) { s.state = JSON.parse(JSON.stringify(st)); s.saves++; },
    async appendChanges(newRows) { s.rows.push(...newRows); if (s.rows.length > MAX_ROWS) s.rows.splice(0, s.rows.length - MAX_ROWS); },
    async loadChanges() { return [...s.rows]; },
    async acquireLock(ttlMs, nowMs = Date.now()) {
      if (s.lock && s.lock.expiresAt > nowMs) return null;
      s.lock = { holder: Math.random().toString(36).slice(2), expiresAt: nowMs + ttlMs };
      return s.lock.holder;
    },
    async releaseLock(holder) { if (s.lock && s.lock.holder === holder) s.lock = null; },
  };
}

export function createFirestoreStore(db) {
  const main = db.collection('chope').doc('main');
  const stateRef = db.collection('chope').doc('todoistSync');
  const rowsRef = db.collection('chope').doc('dateChanges');
  const lockRef = db.collection('chope').doc('todoistSyncLock');
  return {
    async loadTasks() { const d = await main.get(); return d.exists ? (d.data().tasks || []) : []; },
    async loadState() { const d = await stateRef.get(); return d.exists ? { ...emptyState(), ...d.data() } : emptyState(); },
    async saveState(st) { await stateRef.set(JSON.parse(JSON.stringify(st))); },
    async appendChanges(newRows) {
      if (!newRows.length) return;
      const d = await rowsRef.get();
      const rows = [...(d.exists ? (d.data().rows || []) : []), ...newRows];
      await rowsRef.set({ rows: rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows });
    },
    async loadChanges() { const d = await rowsRef.get(); return d.exists ? (d.data().rows || []) : []; },
    async acquireLock(ttlMs, nowMs = Date.now()) {
      const holder = Math.random().toString(36).slice(2);
      const ok = await db.runTransaction(async tx => {
        const cur = await tx.get(lockRef);
        if (cur.exists && cur.data().expiresAt > nowMs) return false;
        tx.set(lockRef, { holder, expiresAt: nowMs + ttlMs });
        return true;
      });
      return ok ? holder : null;
    },
    async releaseLock(holder) {
      await db.runTransaction(async tx => {
        const cur = await tx.get(lockRef);
        if (cur.exists && cur.data().holder === holder) tx.delete(lockRef);
      });
    },
  };
}
