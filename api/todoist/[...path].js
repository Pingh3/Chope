// Proxy for Todoist API v1 — avoids browser CORS restrictions.
// Route: /api/todoist/* → https://api.todoist.com/api/v1/*

export default async function handler(req, res) {
  const pathParts = Array.isArray(req.query.path)
    ? req.query.path
    : [req.query.path].filter(Boolean);

  const todoistUrl = `https://api.todoist.com/api/v1/${pathParts.join('/')}`;

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

  // Debug: log to Vercel function logs
  const authHeader = headers['Authorization'] || '(none)';
  console.log(`[todoist-proxy] ${req.method} ${todoistUrl}`);
  console.log(`[todoist-proxy] Auth header present: ${authHeader !== '(none)'}, length: ${authHeader.length}, starts with "Bearer ": ${authHeader.startsWith('Bearer ')}`);

  try {
    const r = await fetch(todoistUrl, fetchOptions);
    const text = await r.text();
    console.log(`[todoist-proxy] Response: ${r.status} — ${text.slice(0, 200)}`);
    res.status(r.status).send(text || '');
  } catch (e) {
    console.log(`[todoist-proxy] Fetch error: ${e.message}`);
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
}
