// Dry-run wrappers: run the REAL sync engine against the REAL Todoist and Firestore data, but turn
// every write into a recorded "would do this" line. Reads are real (so adoption, matching and the
// completed/deleted checks behave exactly as they will live); nothing is created, changed, deleted
// or saved anywhere.
export function createDryRun(real) {
  const writes = [];
  let n = 0;
  const rec = (kind, id, body) => writes.push({ kind, id: id ?? null, body: body ?? null });
  const todoist = {
    listProjects: () => real.listProjects(),
    listLabels: () => real.listLabels(),
    listActive: o => real.listActive(o),
    getTasksByIds: ids => real.getTasksByIds(ids),
    listCompletedIds: (...a) => real.listCompletedIds(...a),
    createProject: async name => { rec('createProject', null, { name }); return { id: 'dry-project', name }; },
    createLabel: async name => { rec('createLabel', null, { name }); return { name }; },
    createTask: async body => { rec('createTask', null, body); return { id: `dry-${++n}`, due: body.due_date ? { date: body.due_date } : null }; },
    updateTask: async (id, body) => { rec('updateTask', id, body); return null; },
    closeTask: async id => { rec('closeTask', id); return null; },
    reopenTask: async id => { rec('reopenTask', id); return null; },
    deleteTask: async id => { rec('deleteTask', id); return null; },
  };
  return { todoist, writes };
}

export function createDryStore(real) {
  return {
    loadTasks: () => real.loadTasks(),
    loadState: () => real.loadState(),
    loadChanges: () => real.loadChanges(),
    saveState: async () => {},
    appendChanges: async () => {},
    acquireLock: async () => 'dry-run', // a preview must not block, or be blocked by, a real run
    releaseLock: async () => {},
  };
}
