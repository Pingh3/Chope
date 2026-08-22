// AI Assistant API — Groq (OpenAI-compatible, very fast free tier)
// POST { message, tasks, currentUser, today, history }
// Requires GROQ_API_KEY from https://console.groq.com/keys

// Groq periodically deprecates/removes models outright (llama-3.1-8b-instant and
// llama-3.3-70b-versatile were both pulled June 2026 — see console.groq.com/docs/deprecations),
// which shows up here as a plain 404 from the chat completions endpoint. Hardcoding one model
// name with no fallback means every deprecation is a hard outage until someone notices and ships
// a fix. GROQ_MODEL_PRIMARY/FALLBACK are two currently-supported models (Aug 2026); if the
// primary ever gets pulled again, callGroq() retries once against the fallback before giving up,
// so this doesn't have to be a fire-drill next time.
const GROQ_MODEL_PRIMARY = 'openai/gpt-oss-20b';
const GROQ_MODEL_FALLBACK = 'openai/gpt-oss-120b';

// Shared Groq call used by every mode below — handles the primary→fallback retry on a 404
// (model not found/decommissioned) and shapes error responses consistently. Returns
// { reply } on success, or throws an object shaped like { status, message } for the caller
// to turn into an HTTP response.
//
// openai/gpt-oss-20b and -120b are REASONING models — before writing the actual answer they
// spend some of the token budget on an internal reasoning pass (returned separately in a
// `reasoning` field we never read). If max_completion_tokens is too tight, the model can burn
// the whole budget reasoning and get cut off before emitting any answer text at all, which
// showed up here as a silent "(empty response)" rather than an error — nothing was wrong with
// the request, the model just never got to the answer. reasoning_effort: 'low' keeps that pass
// short (we want fast, direct answers here, not deep chain-of-thought), include_reasoning:
// false skips returning a field we don't use, and the token budgets below have real headroom
// past what a non-reasoning model needed.
async function callGroq(apiKey, { messages, maxTokens, temperature = 0.7 }) {
  const attempt = async model => {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, temperature,
        max_completion_tokens: maxTokens,
        reasoning_effort: 'low',
        include_reasoning: false,
      }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  };

  let result = await attempt(GROQ_MODEL_PRIMARY);
  if (!result.ok && result.status === 404) {
    console.warn(`Groq model "${GROQ_MODEL_PRIMARY}" returned 404 (likely decommissioned) — retrying with "${GROQ_MODEL_FALLBACK}"`);
    result = await attempt(GROQ_MODEL_FALLBACK);
  }

  if (!result.ok) {
    console.error('Groq error:', result.status, JSON.stringify(result.data).slice(0, 300));
    const message = result.status === 429 ? 'Rate limit hit — wait a moment and try again.'
                   : result.status === 401 ? 'API key invalid — check GROQ_API_KEY in Vercel settings.'
                   : result.status === 413 ? 'Too much data for one request — try again.'
                   : result.status === 404 ? 'AI model unavailable — please tell your admin (both configured Groq models returned 404).'
                   : `AI error (${result.status}) — please try again.`;
    throw { status: result.status, message };
  }

  const choice = result.data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // Ran out of token budget before producing any answer text (finish_reason "length" is the
    // usual signature) — a real failure, not a normal empty reply, so surface it as an error
    // instead of silently returning a placeholder string the user can't act on.
    console.error('Groq returned no content:', JSON.stringify({ finish_reason: choice?.finish_reason, maxTokens }).slice(0, 300));
    throw { status: 502, message: 'AI ran out of room to answer — try a shorter question, or try again.' };
  }
  return { reply: content };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'GROQ_API_KEY not set. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  const emptyBucket = { items: [], total: 0 };
  const {
    message, tasks = [], currentUser, today, history = [], chronotype = '', userOnly = false, mode = '',
    completedTasks = [], stats = {},
    quarterLabels = {},
    completedLastQ = emptyBucket, completedThisQ = emptyBucket, plannedThisQ = emptyBucket,
    pipelineNextQ = emptyBucket, openNoDeadline = emptyBucket,
  } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message provided' });

  // ── Insights mode: write a productivity/workload narrative from a completed-task history ──
  if (mode === 'insights') {
    const lines = completedTasks.slice(0, 80).map(t => {
      const tags = [t.cat, t.fund, t.ws].filter(Boolean).join(', ');
      return `- "${(t.name || '').slice(0, 70)}"${tags ? ` [${tags}]` : ''} — completed ${(t.completedAt || '').slice(0, 16).replace('T', ' ')}`;
    }).join('\n');

    const overdueLines = (stats.overdueList || []).map(t => `- "${t.name}" [${t.priority || '?'}] — ${t.daysOverdue}d overdue`).join('\n');
    const atRiskLines = (stats.atRiskHighPriority || []).map(t => `- "${t.name}"${t.deadline ? ` — due ${t.deadline}` : ' — no deadline set'}`).join('\n');

    const calendarNote = (stats.calendarHoursThisWeek != null)
      ? `\n${currentUser}'s calendar this week: ${stats.calendarHoursThisWeek}h in meetings across ${stats.calendarMeetingCountThisWeek ?? '?'} meetings (last week: ${stats.calendarHoursLastWeek}h). Use this only if it plausibly explains a pace or focus pattern (e.g. a heavy meeting week coinciding with fewer completions) — don't force a connection if there isn't one.`
      : '';

    const blindSpotSignals = `
Deadline reliability signals for ${currentUser} (use these to judge whether deadlines/priorities are a blind spot — don't mention any of them if they all look healthy):
- On-time completion rate (last 60 days, tasks with a deadline): ${stats.onTimeCompletionRate != null ? stats.onTimeCompletionRate + '%' : 'not enough data'} (${stats.lateCompletions60d ?? 0} completed late)
- Deadline pushed/rescheduled ${stats.deadlinePushes30d ?? 0} time(s) in the last 30 days
- Currently overdue (${(stats.overdueList || []).length}):
${overdueLines || '(none)'}
- High-priority tasks not yet overdue but worth watching (${(stats.atRiskHighPriority || []).length}):
${atRiskLines || '(none)'}`;

    const insightsPrompt = `You are writing a short productivity & workload insights summary for ${currentUser || 'a team member'} inside Chope, a work task manager. Today is ${today}. This covers WORK tasks only — there is no personal-life data here, so don't speculate about work/life balance.

${currentUser}'s current stats: ${stats.openTasks ?? '?'} open tasks, ${stats.overdueTasks ?? '?'} overdue.${calendarNote}

Tasks ${currentUser} completed in the last 30 days (chronological signal — use timestamps to spot patterns like batch-clearing, single-day sweeps, or steady daily work):
${lines || '(no completions in the last 30 days)'}
${blindSpotSignals}

Write in the style of a sharp, friendly analyst — direct, specific, references real task names in quotes, uses actual numbers. Structure:
1. A short paragraph on completion volume/pace patterns (steady vs bursty, any streak or batch-clearing behavior visible from the timestamps; mention meeting load only if it's plausibly relevant).
2. A short paragraph identifying the 2-4 clearest focus themes/projects from the task names and tags — name them specifically using real task names as evidence.
3. One or two short, concrete observations if something stands out (e.g. duplicate-looking tasks, a cluster of tasks closed within minutes of each other suggesting a cleanup sweep rather than active work, an unusually quiet or unusually busy stretch).
4. A closing paragraph naming one genuine strength AND one potential blind spot, grounded in the deadline reliability signals and task list above — e.g. a recurring overdue pattern, high-priority tasks stalling, or frequent deadline pushes, with one concrete, practical suggestion. If the deadline signals all look healthy, say so briefly instead of inventing a problem — don't manufacture a blind spot that isn't there.

Keep it under 260 words, plain prose in short paragraphs (no headers, no bullet lists, no markdown formatting). Be honest and specific, not generic or falsely encouraging.`;

    try {
      const { reply } = await callGroq(apiKey, {
        messages: [{ role: 'system', content: insightsPrompt }, { role: 'user', content: message }],
        maxTokens: 900,
      });
      return res.status(200).json({ reply });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Groq fetch error (insights):', e.message);
      return res.status(502).json({ error: `Connection error: ${e.message}` });
    }
  }

  // ── Quarterly mode: team-wide past-quarter summary, this-quarter plan, next-quarter forecast ──
  if (mode === 'quarterly') {
    // Each bucket is { items: [...capped sample], total: <true count> } — the model only ever
    // sees the capped sample (keeps the request well under Groq's payload limit), but the prompt
    // states the true total so the narrative doesn't imply the sample is the whole picture.
    const fmtBucket = (bucket, noun) => {
      const { items = [], total = 0 } = bucket || {};
      const lines = items.map(t => {
        const tags = [t.assignee, t.cat, t.fund, t.ws].filter(Boolean).join(', ');
        const when = t.completedAt ? `completed ${t.completedAt.slice(0,10)}` : (t.deadline ? `due ${t.deadline}` : 'no deadline');
        return `- "${(t.name || '').slice(0, 60)}"${tags ? ` [${tags}]` : ''} — ${when}`;
      }).join('\n');
      const truncNote = total > items.length ? ` (showing a sample of ${items.length} — treat the total of ${total} as the real figure)` : '';
      return { count: total, lines: lines || '(none)', truncNote };
    };

    const bLast = fmtBucket(completedLastQ);
    const bThis = fmtBucket(completedThisQ);
    const bPlanned = fmtBucket(plannedThisQ);
    const bPipeline = fmtBucket(pipelineNextQ);
    const bNoDeadline = fmtBucket(openNoDeadline);

    const quarterlyPrompt = `You are writing a quarterly business review, to be read by ${currentUser || 'a team member'}, for a small investment team using Chope, a work task manager. Today is ${today}. This is a team-wide view across everyone's tasks, visible to the whole team.

Quarters: last = ${quarterLabels.last || '?'}, current = ${quarterLabels.current || '?'}, next = ${quarterLabels.next || '?'}.

Completed in ${quarterLabels.last || 'last quarter'} (${bLast.count} tasks total${bLast.truncNote}):
${bLast.lines}

Completed so far in ${quarterLabels.current || 'this quarter'} (${bThis.count} tasks total${bThis.truncNote}):
${bThis.lines}

Still open, with a deadline falling in ${quarterLabels.current || 'this quarter'} (${bPlanned.count} tasks total${bPlanned.truncNote} — this is the tentative plan for the rest of the quarter):
${bPlanned.lines}

Still open, with a deadline already falling in ${quarterLabels.next || 'next quarter'} (${bPipeline.count} tasks total${bPipeline.truncNote} — early pipeline visibility):
${bPipeline.lines}

Open tasks with no deadline set at all (${bNoDeadline.count} total${bNoDeadline.truncNote} — a blind spot: work that exists but isn't scheduled into any quarter):
${bNoDeadline.lines}

Write a quarterly business review in three short sections, using real task names in quotes, real numbers, and grouping by theme/fund/workstream where the data supports it (not by individual task) — don't just list every task:
1. "${quarterLabels.last || 'Last quarter'}" — what actually happened: the main themes of completed work, which people/funds/workstreams saw the most activity, and any notable deal or project progress.
2. "${quarterLabels.current || 'This quarter'}" — the tentative plan for the rest of the quarter based on what's already scheduled with a deadline this quarter, organized by theme.
3. "${quarterLabels.next || 'Next quarter'} forecast" — a forward-looking projection: what's already on the books for next quarter, plus a brief, honest read on capacity/risk (e.g. if a lot of undated work exists, note that it isn't yet scheduled and could slip into future quarters unplanned).

Plain prose in short paragraphs under a bold-free heading per section (use the quarter label as the heading text, no markdown # or ** formatting — just the label on its own line followed by the paragraph). Keep the whole thing under 380 words. Be honest and specific — call out gaps (e.g. no deadline set, a quiet quarter) rather than writing generic filler.`;

    try {
      const { reply } = await callGroq(apiKey, {
        messages: [{ role: 'system', content: quarterlyPrompt }, { role: 'user', content: message }],
        maxTokens: 1200,
      });
      return res.status(200).json({ reply });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Groq fetch error (quarterly):', e.message);
      return res.status(502).json({ error: `Connection error: ${e.message}` });
    }
  }

  // ── Forecast-suggestions mode: discrete, actionable next-quarter to-do suggestions as JSON ──
  // (distinct from 'quarterly' — that writes prose; this returns structured items Victor can
  // individually review and turn into real tasks, rather than a paragraph to read.)
  if (mode === 'forecast-suggestions') {
    const fmtBucket = (bucket) => {
      const { items = [], total = 0 } = bucket || {};
      const lines = items.map(t => {
        const tags = [t.assignee, t.cat, t.fund, t.ws].filter(Boolean).join(', ');
        return `- "${(t.name || '').slice(0, 60)}"${tags ? ` [${tags}]` : ''}${t.deadline ? ` — due ${t.deadline}` : ''}`;
      }).join('\n');
      const truncNote = total > items.length ? ` (sample of ${items.length} of ${total})` : '';
      return { count: total, lines: lines || '(none)', truncNote };
    };
    const bPipeline = fmtBucket(pipelineNextQ);
    const bPlanned = fmtBucket(plannedThisQ);

    const suggestPrompt = `You help ${currentUser || 'a team member'} plan ahead for a small investment team using Chope. Today is ${today}. Quarters: current = ${quarterLabels.current || '?'}, next = ${quarterLabels.next || '?'}.

Already scheduled with a deadline in ${quarterLabels.next || 'next quarter'} (${bPipeline.count} total${bPipeline.truncNote} — the existing pipeline):
${bPipeline.lines}

Still open with a deadline in ${quarterLabels.current || 'this quarter'} (${bPlanned.count} total${bPlanned.truncNote} — ongoing threads likely to continue into next quarter):
${bPlanned.lines}

Based on this, suggest 6-10 concrete, specific action items ${currentUser} should consider adding as tasks for ${quarterLabels.next || 'next quarter'}. Favor: natural follow-ups to work already scheduled or in progress, recurring quarterly admin/reporting work implied by the data, and gaps you notice (e.g. a fund or workstream with pipeline activity but no explicit next step scheduled). Do not just restate existing pipeline items verbatim — add value by identifying what's NOT yet scheduled but implied.

Respond with ONLY a raw JSON array, no markdown code fences, no prose before or after. Exact format:
[{"name": "Verb-first task name, under 80 chars", "reason": "One short sentence, under 20 words, on why this is suggested"}]`;

    try {
      const { reply: raw } = await callGroq(apiKey, {
        messages: [{ role: 'system', content: suggestPrompt }, { role: 'user', content: message }],
        maxTokens: 1000,
        temperature: 0.6,
      });
      // Strip common LLM formatting quirks (markdown code fences) before handing back to the
      // client, which expects to JSON.parse this directly.
      const reply = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      return res.status(200).json({ reply });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Groq fetch error (forecast-suggestions):', e.message);
      return res.status(502).json({ error: `Connection error: ${e.message}` });
    }
  }

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
    const { reply } = await callGroq(apiKey, { messages, maxTokens: 900 });
    return res.status(200).json({ reply });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('Groq fetch error:', e.message);
    return res.status(502).json({ error: `Connection error: ${e.message}` });
  }
}
