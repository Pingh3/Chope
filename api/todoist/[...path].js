// Proxy for Todoist API v1 — avoids browser CORS restrictions.
// Route: /api/todoist/* → https://api.todoist.com/api/v1/*

export default async function handler(req, res) {
  // Parse the path from req.url directly — more reliable than req.query.path
  // req.url looks like: /api/todoist/projects  or  /api/todoist/tasks/123
  const prefix = '/api/todoist/';
  const rawUrl = req.url || '';
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const queryString = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
  const todoistPath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';

  const todoistUrl = `https://api.todoist.com/api/v1/${todoistPath}${queryString}`;

  const headers = {};
  if (req.headers['authorization'])  headers['Authorization']  = req.headers['authorization'];
  if (req.headers['x-request-id'])   headers['X-Request-Id']   = req.headers['x-request-id'];
  if (!['GET', 'DELETE', 'HEAD'].includes(req.method.toUpperCase())) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOptions = { method: req.method, headers };

  if (req.body && !['GET', 'DELETE', 'HEAD'].includes(req.method.toUpperCase())) {
    fetchOptions.body = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);
  }

  try {
    const r = await fetch(todoistUrl, fetchOptions);
    const text = await r.text();
    res.status(r.status).send(text || '');
  } catch (e) {
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
}
