// In-memory stand-in for Todoist, implementing the same interface as lib/todoistClient.js.
// It mimics the real API where it matters to the sync: reads return ACTIVE tasks only, deleted
// tasks 404, completed tasks are listed separately, `labels` on update replaces the whole list,
// and omitting `due_date` on update leaves the due date untouched.
import { TodoistError } from '../../lib/todoistClient.js';

export function createFakeTodoist({ projectName = 'Chope' } = {}) {
  let nextId = 1000;
  const projects = [{ id: 'p1', name: projectName }];
  const labels = new Set();
  const tasks = new Map(); // id -> task (includes checked ones; deleted ones are removed)
  const calls = [];
  const failOn = { createTitles: new Set() };
  const rec = (name, id) => calls.push(id ? `${name}:${id}` : name);
  const WRITES = ['createTask', 'updateTask', 'closeTask', 'reopenTask', 'deleteTask', 'createLabel', 'createProject'];

  const view = t => JSON.parse(JSON.stringify(t));
  const notFound = () => new TodoistError(404, 'Todoist 404');

  const api = {
    _calls: calls, _tasks: tasks, _labels: labels, _failOn: failOn,
    writeCalls: () => calls.filter(c => WRITES.includes(c.split(':')[0])),
    resetCalls: () => { calls.length = 0; },
    active: () => [...tasks.values()].filter(t => !t.checked),

    // ── simulate things the owner does directly in Todoist ──
    userSetDue(id, date, is_recurring = false) { tasks.get(id).due = date ? { date, is_recurring } : null; },
    userComplete(id) { tasks.get(id).checked = true; },
    userDelete(id) { tasks.delete(id); },
    userAddLabel(id, name) { const t = tasks.get(id); t.labels = [...t.labels, name]; },
    userAdd({ content, project_id = 'p1', due = null, deadline = null, labels: l = [] }) {
      const id = String(nextId++);
      tasks.set(id, { id, content, description: '', priority: 1, project_id, labels: l, due, deadline, checked: false });
      return id;
    },

    // ── the client interface ──
    async listProjects() { rec('listProjects'); return projects.map(view); },
    async createProject(name) { rec('createProject'); const p = { id: 'p' + (projects.length + 1), name }; projects.push(p); return p; },
    async listLabels() { rec('listLabels'); return [...labels].map(name => ({ name })); },
    async createLabel(name) { rec('createLabel'); labels.add(name.toLowerCase()); return { name }; },
    async listActive({ projectId } = {}) { rec('listActive'); return api.active().filter(t => !projectId || t.project_id === projectId).map(view); },
    async getTasksByIds(ids) {
      rec('getTasksByIds');
      const m = new Map();
      ids.forEach(id => { const t = tasks.get(String(id)); if (t && !t.checked) m.set(String(id), view(t)); });
      return m;
    },
    async createTask(body, requestId) {
      if (failOn.createTitles.has(body.content)) throw new TodoistError(500, 'boom');
      rec('createTask');
      const id = String(nextId++);
      tasks.set(id, {
        id, content: body.content, description: body.description || '', priority: body.priority || 1,
        project_id: body.project_id, labels: [...(body.labels || [])],
        due: body.due_date ? { date: body.due_date, is_recurring: false } : null,
        deadline: body.deadline_date ? { date: body.deadline_date } : null,
        checked: false, _requestId: requestId, _createBody: body,
      });
      return view(tasks.get(id));
    },
    async updateTask(id, body) {
      rec('updateTask', id);
      const t = tasks.get(String(id));
      if (!t || t.checked) throw notFound();
      api.lastUpdateBody = body;
      if ('content' in body) t.content = body.content;
      if ('description' in body) t.description = body.description;
      if ('priority' in body) t.priority = body.priority;
      if ('labels' in body) t.labels = [...body.labels];
      if ('deadline_date' in body) t.deadline = body.deadline_date ? { date: body.deadline_date } : null;
      if ('due_date' in body) t.due = body.due_date ? { date: body.due_date, is_recurring: false } : null;
      return view(t);
    },
    async closeTask(id) { rec('closeTask', id); const t = tasks.get(String(id)); if (!t) throw notFound(); t.checked = true; return null; },
    async reopenTask(id) { rec('reopenTask', id); const t = tasks.get(String(id)); if (!t) throw notFound(); t.checked = false; return null; },
    async deleteTask(id) { rec('deleteTask', id); if (!tasks.delete(String(id))) throw notFound(); return null; },
    async listCompletedIds() { rec('listCompletedIds'); return new Set([...tasks.values()].filter(t => t.checked).map(t => t.id)); },
  };
  return api;
}
