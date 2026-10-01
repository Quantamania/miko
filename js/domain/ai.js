/* The assistant.
 *
 * Two engines behind one interface:
 *
 *   local  — deterministic heuristics over the real task data. Always
 *            available, works offline, costs nothing, and never invents a
 *            number. This is the default.
 *   claude — the Anthropic API, called directly from the browser with a key
 *            the user supplies in Settings. Opt-in.
 *
 * On the key: a key held in the browser is readable by anything running in
 * this browser profile. Settings says so plainly. The right long-term answer
 * is a small server-side proxy that holds the key and is the only thing that
 * talks to Anthropic — at which point `endpoint` below points at the proxy and
 * `apiKey` goes away entirely.
 */

import * as store from '../core/store.js';
import * as analytics from './analytics.js';
import * as rules from './rules.js';
import * as db from '../core/db.js';
import {
  dayKey,
  todayKey,
  fmtDue,
  fmtDuration,
  plural,
  esc,
  stripHTML,
  addDaysKey,
  emitter,
} from '../core/util.js';

export const bus = emitter();

export const DEFAULT_MODEL = 'claude-opus-5';
export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Faster, lower cost' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fastest' },
];

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/* ------------------------------ credentials ------------------------------ */

let cachedKey = null;

export async function getKey() {
  if (cachedKey !== null) return cachedKey;
  cachedKey = (await db.get('meta', 'ai:key'))?.value || '';
  return cachedKey;
}

export async function setKey(key) {
  cachedKey = String(key || '').trim();
  if (cachedKey) await db.put('meta', { key: 'ai:key', value: cachedKey });
  else await db.del('meta', 'ai:key');
  bus.emit('key', !!cachedKey);
  return !!cachedKey;
}

export async function isConfigured() {
  return Boolean(store.getSetting('aiEnabled', false) && (await getKey()));
}

/* -------------------------------- context -------------------------------- */

/** A compact, factual snapshot of the workspace. Kept small on purpose: a
 *  focused context produces better answers than dumping every task. */
export function buildContext({ limit = 60 } = {}) {
  const s = analytics.summary({ days: 30 });
  const review = analytics.dailyReview();
  const open = store
    .allTasks()
    .filter((t) => t.status !== 'done')
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return store.PRIORITY_RANK[a.priority] - store.PRIORITY_RANK[b.priority];
    })
    .slice(0, limit);

  const line = (t) =>
    [
      `- [${t.id.slice(-6)}] ${t.title}`,
      t.priority !== 'none' ? `(${t.priority})` : '',
      t.due_at ? `due ${fmtDue(t.due_at)}` : 'no due date',
      store.projectById(t.project_id)?.name ? `· ${store.projectById(t.project_id).name}` : '',
      t.estimate_min ? `· est ${fmtDuration(t.estimate_min)}` : '',
      store.isBlocked(t) ? '· BLOCKED' : '',
      t.status === 'in_progress' ? '· in progress' : '',
    ]
      .filter(Boolean)
      .join(' ');

  return [
    `Today is ${todayKey()} (${store.state.user?.timezone || 'local time'}).`,
    `Workspace "${store.state.workspace?.name}" has ${s.open} open tasks, ${s.overdue} overdue, ${s.dueToday} due today.`,
    `Over the last 30 days: ${s.completed} completed, ${s.completionRate}% completion rate, ${
      s.avgCycleDays != null ? `${s.avgCycleDays}d average cycle time` : 'cycle time unknown'
    }.`,
    store.state.projects.length
      ? `Projects: ${store.state.projects.map((p) => p.name).join(', ')}.`
      : '',
    review.blocked.length ? `${review.blocked.length} tasks are blocked by dependencies.` : '',
    '',
    'Open tasks, soonest first:',
    open.length ? open.map(line).join('\n') : '(none)',
  ]
    .filter(Boolean)
    .join('\n');
}

const SYSTEM = `You are MIKŌ's assistant, embedded in a task manager. You are talking to the person whose tasks these are.

Ground every answer in the task data you are given. Refer to tasks by their title, never by id. If the data does not support an answer, say so rather than estimating.

Keep responses short — two or three sentences for a question, a tight list when a list is genuinely clearer. No preamble, no restating the question, no offers of further help at the end. Prefer a concrete recommendation over a survey of options.

When you propose concrete changes (new subtasks, a priority change, a schedule), end your message with a single fenced json block:

\`\`\`json
{"actions":[{"type":"create_task","title":"...","due":"YYYY-MM-DD","priority":"high"}]}
\`\`\`

Supported action types: create_task (title, due, priority, project, estimate_min, parent), set_priority (task, priority), set_due (task, due), set_status (task, status). Reference an existing task by its exact title. Only include the block when you are actually proposing changes.`;

/* ------------------------------ Claude call ------------------------------ */

/**
 * Streaming call to the Messages API.
 * `onDelta(textChunk)` fires as tokens arrive; the promise resolves with the
 * full text. Errors are translated into something a person can act on.
 */
export async function askClaude(messages, { onDelta, signal, maxTokens = 1400 } = {}) {
  const key = await getKey();
  if (!key) throw new Error('Add an Anthropic API key in Settings to use Claude.');

  const model = store.getSetting('aiModel', DEFAULT_MODEL);

  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      // Required for browser-originated calls; without it the request is
      // rejected before it reaches the model.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: buildContext() }],
      // Effort trades depth for latency. `low` keeps an in-app assistant
      // responsive; thinking stays on (the default on Opus 5).
      output_config: { effort: 'low' },
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = JSON.parse(body)?.error?.message || '';
    } catch {
      detail = body.slice(0, 200);
    }
    if (res.status === 401) throw new Error('That API key was rejected. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API. Try again shortly.');
    if (res.status >= 500) throw new Error('The API is having trouble. Try again shortly.');
    throw new Error(detail || `Request failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        text += evt.delta.text;
        onDelta?.(evt.delta.text);
      } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
        stopReason = evt.delta.stop_reason;
      } else if (evt.type === 'error') {
        throw new Error(evt.error?.message || 'Stream error');
      }
    }
  }

  // A refusal is a successful HTTP response with no usable content — handle it
  // before treating `text` as an answer.
  if (stopReason === 'refusal') {
    throw new Error('Claude declined to answer that one. Try rephrasing.');
  }

  return text.trim();
}

/* ---------------------------- action extraction ---------------------------- */

/** Pull the optional trailing JSON action block out of a reply. */
export function extractActions(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return { text, actions: [] };
  let actions = [];
  try {
    const parsed = JSON.parse(m[1]);
    actions = Array.isArray(parsed) ? parsed : parsed.actions || [];
  } catch {
    return { text, actions: [] };
  }
  return { text: text.replace(m[0], '').trim(), actions: actions.filter((a) => a && a.type) };
}

function findTaskByTitle(title) {
  if (!title) return null;
  const needle = String(title).trim().toLowerCase();
  const open = store.allTasks();
  return (
    open.find((t) => t.title.toLowerCase() === needle) ||
    open.find((t) => t.title.toLowerCase().includes(needle)) ||
    null
  );
}

/** Apply proposed actions. Always user-initiated — the assistant proposes,
 *  a click disposes. */
export async function applyActions(actions) {
  const applied = [];
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'create_task': {
          const project = a.project
            ? store.state.projects.find(
                (p) => p.name.toLowerCase() === String(a.project).toLowerCase()
              )
            : null;
          const parent = a.parent ? findTaskByTitle(a.parent) : null;
          const task = await store.createTask({
            title: a.title,
            priority: store.PRIORITIES.includes(a.priority) ? a.priority : 'none',
            due_at: a.due ? new Date(`${a.due}T09:00:00`).toISOString() : null,
            project_id: project?.id ?? parent?.project_id ?? null,
            parent_id: parent?.id ?? null,
            estimate_min: a.estimate_min ?? null,
          });
          applied.push({ action: a, id: task.id });
          break;
        }
        case 'set_priority': {
          const t = findTaskByTitle(a.task);
          if (t && store.PRIORITIES.includes(a.priority)) {
            await store.updateTask(t.id, { priority: a.priority });
            applied.push({ action: a, id: t.id });
          }
          break;
        }
        case 'set_due': {
          const t = findTaskByTitle(a.task);
          if (t) {
            await store.updateTask(t.id, {
              due_at: a.due ? new Date(`${a.due}T09:00:00`).toISOString() : null,
            });
            applied.push({ action: a, id: t.id });
          }
          break;
        }
        case 'set_status': {
          const t = findTaskByTitle(a.task);
          if (t && store.STATUSES.includes(a.status)) {
            await store.updateTask(t.id, { status: a.status });
            applied.push({ action: a, id: t.id });
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn('[miko] could not apply action', a, err);
    }
  }
  if (applied.length) {
    await store.audit('ai.actions_applied', { payload: { count: applied.length } });
  }
  return applied;
}

/* ------------------------------ local engine ------------------------------ */
/* Deterministic answers derived from the data. These run with no key, no
   network, and no invented facts. */

const BREAKDOWN_PATTERNS = [
  {
    match: /\b(write|draft|author|blog|article|report|post|essay|proposal)\b/i,
    steps: ['Outline the structure', 'Draft the first pass', 'Edit and tighten', 'Proofread', 'Publish or send'],
  },
  {
    match: /\b(launch|release|ship|deploy|rollout)\b/i,
    steps: ['Define the scope and success criteria', 'Build it', 'Test end to end', 'Prepare the announcement', 'Ship', 'Watch for problems'],
  },
  {
    match: /\b(design|mockup|wireframe|prototype|ui|ux)\b/i,
    steps: ['Gather references', 'Sketch the layout', 'Build the high-fidelity version', 'Get feedback', 'Revise and hand off'],
  },
  {
    match: /\b(research|investigate|explore|evaluate|compare)\b/i,
    steps: ['Define the question', 'Gather sources', 'Take structured notes', 'Summarise the findings', 'Decide and record why'],
  },
  {
    match: /\b(meet|meeting|call|interview|sync|standup|review)\b/i,
    steps: ['Set the agenda', 'Confirm the time with everyone', 'Prepare materials', 'Run it', 'Send notes and next steps'],
  },
  {
    match: /\b(fix|bug|debug|issue|error|broken)\b/i,
    steps: ['Reproduce it reliably', 'Find the root cause', 'Write a failing test', 'Fix it', 'Verify and close'],
  },
  {
    match: /\b(plan|strategy|roadmap|budget)\b/i,
    steps: ['Collect the inputs', 'Draft the first version', 'Pressure-test the assumptions', 'Circulate for input', 'Finalise'],
  },
];

const GENERIC_STEPS = [
  'Clarify what "done" looks like',
  'Gather what you need to start',
  'Do the main work',
  'Review the result',
  'Close it out',
];

export function localBreakdown(title) {
  const hit = BREAKDOWN_PATTERNS.find((p) => p.match.test(title));
  return (hit?.steps || GENERIC_STEPS).map((s) => `${s}`);
}

export function localPrioritise() {
  const today = todayKey();
  const open = store.allTasks().filter((t) => t.status !== 'done');
  if (!open.length) return { text: 'Nothing open. Enjoy it.', actions: [] };

  const scored = open
    .map((t) => {
      let score = 0;
      const reasons = [];
      if (t.due_at) {
        const d = dayKey(t.due_at);
        if (d < today) {
          score += 100;
          reasons.push('overdue');
        } else if (d === today) {
          score += 60;
          reasons.push('due today');
        } else {
          score += Math.max(0, 40 - Math.abs(new Date(t.due_at) - Date.now()) / 86400000);
        }
      }
      score += { urgent: 45, high: 30, medium: 15, low: 5, none: 0 }[t.priority] || 0;
      if (t.priority === 'urgent' || t.priority === 'high') reasons.push(`${t.priority} priority`);
      if (store.isBlocked(t)) {
        score -= 50;
        reasons.push('blocked');
      }
      if (store.blockedByThis(t.id).length) {
        score += 25;
        reasons.push(`unblocks ${plural(store.blockedByThis(t.id).length, 'task')}`);
      }
      const age = (Date.now() - new Date(t.created_at)) / 86400000;
      if (age > 14) {
        score += 8;
        reasons.push('been sitting a while');
      }
      return { task: t, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5);
  const lines = top.map(
    (s, i) => `${i + 1}. **${esc(s.task.title)}**${s.reasons.length ? ` — ${s.reasons.join(', ')}` : ''}`
  );

  const blocked = scored.filter((s) => store.isBlocked(s.task));
  const tail = blocked.length
    ? `\n\n${plural(blocked.length, 'task is', 'tasks are')} waiting on something else — clear those blockers first if you can.`
    : '';

  return {
    text: `Work in this order:\n\n${lines.join('\n')}${tail}`,
    actions: [],
  };
}

export function localPlan() {
  const open = store.allTasks().filter((t) => t.status !== 'done');
  const plan = rules.suggestSchedule(open.slice(0, 20));
  const capacity = store.getSetting('dailyCapacityMin', 360);

  const today = plan.filter((p) => p.key === todayKey());
  const totalMin = today.reduce((n, p) => n + p.minutes, 0);
  const unplaced = plan.filter((p) => !p.at);

  if (!today.length) {
    return {
      text: `Nothing is scheduled for today. ${
        open.length ? 'Give a few tasks a due date and I can lay out a day.' : 'Your list is empty.'
      }`,
      actions: [],
    };
  }

  const lines = today.map(
    (p) => `- **${esc(p.task.title)}** — ${fmtDuration(p.minutes)}`
  );
  const load = Math.round((totalMin / capacity) * 100);

  return {
    text: [
      `Today, at ${fmtDuration(capacity)} of capacity:`,
      '',
      lines.join('\n'),
      '',
      `That is ${fmtDuration(totalMin)} — about ${load}% of your day.` +
        (load > 100 ? ' More than fits; move something.' : ''),
      unplaced.length ? `\n${plural(unplaced.length, 'task')} could not be placed before its deadline.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    actions: [],
  };
}

export function localSummary() {
  const s = analytics.summary({ days: 30 });
  const st = analytics.streak();
  const wl = analytics.workload();
  const over = wl.filter((w) => w.band === 'over');

  const parts = [
    `${s.open} open, ${s.completed} finished in the last 30 days — a ${s.completionRate}% completion rate.`,
  ];
  if (s.overdue) parts.push(`${plural(s.overdue, 'task is', 'tasks are')} overdue.`);
  if (s.avgCycleDays != null) parts.push(`Tasks take ${s.avgCycleDays} days on average from created to done.`);
  if (st.current > 1) parts.push(`You have finished something ${st.current} days running.`);
  if (over.length) parts.push(`${over.map((o) => o.name).join(' and ')} ${over.length === 1 ? 'is' : 'are'} over capacity this week.`);
  if (!s.open && !s.completed) parts.push('Nothing here yet — add a task and this fills in.');

  return { text: parts.join(' '), actions: [] };
}

export function localAnswer(question) {
  const q = question.toLowerCase();
  if (/\b(priorit|what.*first|where.*start|what should i do)\b/.test(q)) return localPrioritise();
  if (/\b(plan|schedule|today|my day)\b/.test(q)) return localPlan();
  if (/\b(summar|overview|how.*doing|status|progress)\b/.test(q)) return localSummary();
  if (/\b(overdue|late|behind)\b/.test(q)) {
    const late = analytics.dailyReview().overdue;
    if (!late.length) return { text: 'Nothing is overdue.', actions: [] };
    return {
      text: `${plural(late.length, 'task is', 'tasks are')} overdue:\n\n${late
        .slice(0, 8)
        .map((t) => `- **${esc(t.title)}** — ${fmtDue(t.due_at)}`)
        .join('\n')}`,
      actions: [],
    };
  }
  if (/\b(blocked|waiting|stuck)\b/.test(q)) {
    const blocked = analytics.dailyReview().blocked;
    if (!blocked.length) return { text: 'Nothing is blocked.', actions: [] };
    return {
      text: blocked
        .slice(0, 8)
        .map(
          (t) =>
            `- **${esc(t.title)}** — waiting on ${store
              .blockersOf(t)
              .filter((b) => b.status !== 'done')
              .map((b) => esc(b.title))
              .join(', ')}`
        )
        .join('\n'),
      actions: [],
    };
  }
  if (/\b(break.*down|subtask|split)\b/.test(q)) {
    return {
      text: 'Open a task and use **Break down** in the detail panel — I will suggest subtasks for that specific task.',
      actions: [],
    };
  }

  return {
    text:
      'Without an API key I answer from your data directly. Try "what should I do first", "plan my day", "what\'s overdue", or "summarise my progress" — or add a Claude key in Settings for open-ended questions.',
    actions: [],
  };
}

/* -------------------------------- facade -------------------------------- */

/**
 * One entry point for the chat panel. Routes to Claude when configured,
 * otherwise answers locally. Never throws for the caller — a failed remote
 * call degrades to the local engine with a note.
 */
export async function ask(question, history = [], { onDelta, signal } = {}) {
  if (await isConfigured()) {
    try {
      const messages = [
        ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: question },
      ];
      const raw = await askClaude(messages, { onDelta, signal });
      const { text, actions } = extractActions(raw);
      return { text, actions, engine: 'claude' };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const local = localAnswer(question);
      return {
        text: `${local.text}\n\n_(Claude was unreachable: ${esc(err.message)})_`,
        actions: local.actions,
        engine: 'local',
        error: err.message,
      };
    }
  }
  const local = localAnswer(question);
  return { ...local, engine: 'local' };
}

/** Subtask suggestions for one task. Uses Claude when available. */
export async function breakdown(task) {
  if (await isConfigured()) {
    try {
      const raw = await askClaude(
        [
          {
            role: 'user',
            content: `Break this task into 3-6 concrete subtasks: "${task.title}"${
              task.description ? `\n\nContext: ${stripHTML(task.description).slice(0, 600)}` : ''
            }\n\nReply with the subtask list only, one per line, no numbering.`,
          },
        ],
        { maxTokens: 400 }
      );
      const lines = raw
        .split('\n')
        .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
        .filter((l) => l && l.length < 160)
        .slice(0, 8);
      if (lines.length) return { steps: lines, engine: 'claude' };
    } catch (err) {
      console.warn('[miko] breakdown via Claude failed, using local', err);
    }
  }
  return { steps: localBreakdown(task.title), engine: 'local' };
}
