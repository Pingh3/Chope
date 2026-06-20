// AI Assistant API — Groq (OpenAI-compatible, very fast free tier)
// POST { message, tasks, currentUser, today, history }
// Requires GROQ_API_KEY from https://console.groq.com/keys

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'GROQ_API_KEY not set. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  const { message, tasks = [], currentUser, today, history = [], chronotype = '', userOnly = false } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message provided' });

  // ── Build task context (capped to keep payload small) ──
  const PRIO = { high: 1, med: 2, low: 3 };
  const STATUS_LABEL = { todo: 'todo', inprogress: 'in progress', review: 'in review', done: 'done' };

  // Open tasks only — never include done tasks (they should not affect scheduling or prioritisation)
  // If userOnly (personal chips like Focus today, Schedule my day, Overdue, My week),
  // restrict to current user's tasks only so the AI cannot accidentally reference teammates' tasks.
  const openTasks = tasks
    .filter(t => t.status !== 'done' && (!userOnly || t.assignee === currentUser))
    .sort((a, b) => (PRIO[a.priority] || 9) - (PRIO[b.priority] || 9))
    .slice(0, 80);

  const taskLines = openTasks.map(t => {
    const overdue = t.deadline && t.deadline < today;
    const prio = (t.priority || '?').toUpperCase();
    const status = STATUS_LABEL[t.status] || t.status;
    const due = t.deadline ? ` due ${t.deadline}` : '';
    const od = overdue ? ' OVERDUE' : '';
    const cat = t.cat ? ` [${t.cat}]` : '';
    return `- [${prio}${od}] "${t.name.slice(0, 60)}" — ${t.assignee}, ${status}${cat}${due}`;
  }).join('\n');

  const myOpen    = openTasks.filter(t => t.assignee === currentUser);
  const myOverdue = myOpen.filter(t => t.deadline && t.deadline < today);
  const myHigh    = myOpen.filter(t => t.priority === 'high');

  const chronotypeNote = chronotype === 'morning'
    ? `\n${currentUser} is a morning person — when suggesting task order or scheduling, recommend high-focus / cognitively demanding tasks in the morning (before noon) and routine, admin, or low-energy tasks in the afternoon.`
    : chronotype === 'afternoon'
    ? `\n${currentUser} is an afternoon person — when suggesting task order or scheduling, recommend light admin and routine tasks in the morning, and reserve high-focus / cognitively demanding work for the afternoon (after 1 pm).`
    : '';

  const taskScopeLabel = userOnly
    ? `${currentUser}'s open tasks only (sorted high → low priority):`
    : `All team tasks (sorted high → low priority):`;

  // Extra guardrail injected when context is user-scoped
  const userOnlyGuardrail = userOnly
    ? `\nCRITICAL: The task list above contains ONLY ${currentUser}'s tasks. Every task in the list belongs to ${currentUser}. You must ONLY reference tasks from this list. Never schedule, mention, or suggest tasks belonging to any other team member.`
    : '';

  const systemPrompt = `You are a sharp, focused task assistant inside Chope — a team task management app. Today is ${today}. Current user: ${currentUser || 'Unknown'}.${chronotypeNote}${userOnlyGuardrail}

${currentUser}'s stats: ${myOpen.length} open tasks, ${myOverdue.length} overdue, ${myHigh.length} high priority.

${taskScopeLabel}
${taskLines || '(no tasks yet)'}

Your rules:
- Be direct and concise. No filler phrases like "Great question!"
- Use bullet points for lists
- Reference task names in quotes
- Keep responses under 200 words unless more detail is asked for
- When the question uses "my", "I", or the current user's name, only include tasks assigned to ${currentUser}
- When prioritising, weigh: overdue status, deadline urgency, and priority level
- When asked to break down a task, output numbered steps (1. 2. 3. …) with a short time estimate in brackets, e.g. "1. Draft outline [20 min]". Be practical and specific to the task and workstream context.
- IMPORTANT: When listing tasks in your response, show ONLY the task name (in quotes). Never repeat raw fields like the assignee name, status, category, or date in your bullet points — those are internal data for your context only. If a deadline or status is directly relevant to the answer, mention it naturally in plain English (e.g. "due tomorrow" or "overdue since Monday"), not as a raw value.`;

  // ── Build messages ──────────────────────────────────────
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8).filter(h => h.role && h.content),
    { role: 'user', content: message },
  ];

  // ── Call Groq ───────────────────────────────────────────
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',  // fast, free tier: 14,400 req/day, 30 req/min
        messages,
        max_tokens: 512,
        temperature: 0.7,
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Groq error:', r.status, JSON.stringify(data).slice(0, 300));
      const msg = r.status === 429 ? 'Rate limit hit — wait a moment and try again.'
                : r.status === 401 ? 'API key invalid — check GROQ_API_KEY in Vercel settings.'
                : `AI error (${r.status}) — please try again.`;
      return res.status(r.status).json({ error: msg });
    }

    const reply = data.choices?.[0]?.message?.content || '(empty response)';
    return res.status(200).json({ reply });

  } catch (e) {
    console.error('Groq fetch error:', e.message);
    return res.status(502).json({ error: `Connection error: ${e.message}` });
  }
}
