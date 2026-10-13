// Thin Todoist API v1 client. Endpoints and field names were checked against the official
// OpenAPI spec (https://developer.todoist.com/openapi.json), not memory:
//   POST /tasks, POST /tasks/{id} (update), POST /tasks/{id}/close|reopen, DELETE /tasks/{id},
//   GET /tasks (paginated, ?ids=a,b,c / ?project_id=), GET /tasks/completed/by_completion_date
//   (items[], since/until RFC 3339, max 3-month window), GET|POST /projects, GET|POST /labels.
// 429 and 5xx responses are retried with exponential backoff (honouring Retry-After); anything
// else surfaces as a TodoistError carrying the HTTP status so callers can branch on 404.

export class TodoistError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'TodoistError';
    this.status = status;
    this.body = body;
  }
}

const sleepDefault = ms => new Promise(r => setTimeout(r, ms));

export function createTodoistClient({
  token,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://api.todoist.com/api/v1',
  maxAttempts = 4,
  sleep = sleepDefault,
} = {}) {
  if (!token) throw new Error('Todoist token missing');

  async function request(method, path, { query, body, requestId } = {}) {
    const qs = query
      ? '?' + Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['X-Request-Id'] = requestId;

    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${path}${qs}`, {
          method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        lastErr = new TodoistError(0, `Network error: ${e.message}`);
        if (attempt < maxAttempts - 1) { await sleep(Math.min(8000, 500 * 2 ** attempt)); continue; }
        throw lastErr;
      }
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastErr = new TodoistError(res.status, `Todoist ${res.status} on ${method} ${path}`, text);
        if (attempt < maxAttempts - 1) {
          const ra = Number(res.headers?.get?.('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000)
                                                    : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
          continue;
        }
        throw lastErr;
      }
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new TodoistError(res.status, `Todoist ${res.status} on ${method} ${path}: ${text.slice(0, 160)}`, text);
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    }
    throw lastErr || new TodoistError(0, 'request failed');
  }

  // Follows next_cursor until exhausted. Response list key is `results` for most endpoints and
  // `items` for the completed-tasks endpoint.
  async function paged(path, query = {}) {
    const out = [];
    let cursor = null, guard = 0;
    do {
      const page = await request('GET', path, { query: { ...query, limit: 200, cursor } });
      out.push(...(page?.results || page?.items || []));
      cursor = page?.next_cursor || null;
    } while (cursor && ++guard < 100);
    return out;
  }

  return {
    listProjects: () => paged('/projects'),
    createProject: name => request('POST', '/projects', { body: { name } }),
    listLabels: () => paged('/labels'),
    createLabel: name => request('POST', '/labels', { body: { name } }),
    listActive: ({ projectId } = {}) => paged('/tasks', { project_id: projectId }),

    // Batch read by id (comma-separated). Completed/deleted ids are simply absent from the
    // result, which is how the engine tells "still active" from "needs a closer look".
    async getTasksByIds(ids) {
      const map = new Map();
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const list = await paged('/tasks', { ids: chunk.join(',') });
        list.forEach(t => map.set(String(t.id), t));
      }
      return map;
    },

    createTask: (body, requestId) => request('POST', '/tasks', { body, requestId }),
    updateTask: (id, body) => request('POST', `/tasks/${id}`, { body }),
    closeTask: id => request('POST', `/tasks/${id}/close`),
    reopenTask: id => request('POST', `/tasks/${id}/reopen`),
    deleteTask: id => request('DELETE', `/tasks/${id}`),

    // Ids of tasks completed in the last `days` days (API caps the window at 3 months).
    async listCompletedIds(days = 89, nowMs = Date.now()) {
      const until = new Date(nowMs).toISOString();
      const since = new Date(nowMs - days * 86400000).toISOString();
      const items = await paged('/tasks/completed/by_completion_date', { since, until });
      return new Set(items.map(t => String(t.id)));
    },
  };
}
