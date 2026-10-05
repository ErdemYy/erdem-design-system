/**
 * What continuity means for the one canonical task state (ai/CONTINUITY.md): reading TASK_STATE.md and the single owned block that records
 * the task's identity and its ownership. There is no second state store and no second state machine: the owner stays the `owner:` field of
 * the front matter (single writer), and this module only adds ONE block, `## Continuity`, delimited by two comment markers.
 *
 * Pure text transformations: no file access, no process, no clock (the caller passes `now`). Only what is between the markers is ever written
 * or replaced; every other byte (user text, numbering, other sections, the line endings the file already uses) is left as it was, except the
 * `updatedAt` value and, when ownership is taken, the `owner` value.
 */
import { createHash } from 'node:crypto';
import { CLASS_VALUES, RISK_VALUES, TASK_STATUSES, agentNameOk } from './continuity-handoff.mjs';
import { parseLastValidation } from './validation-state.mjs';

export const CONTINUITY_BEGIN = '<!-- erdem:continuity:begin (generated; only this block is rewritten) -->';
export const CONTINUITY_END = '<!-- erdem:continuity:end -->';
const BLOCK_RE = /<!-- erdem:continuity:begin[^\r\n]*?-->[\s\S]*?<!-- erdem:continuity:end -->/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const eolOf = (text) => {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
};

/** The bullet or numbered items of one section, in order. Comments and blank lines are not items. */
function items(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/.exec(l);
    if (m && !/^<!--/.test(m[1])) out.push(m[1]);
  }
  return out;
}

function sectionsOf(text) {
  const map = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1].toLowerCase();
      if (!map.has(cur)) map.set(cur, []);
      continue;
    }
    if (cur) map.get(cur).push(line);
  }
  return map;
}

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*?)\s*$/.exec(l);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const continuityOf = (text) => {
  const m = BLOCK_RE.exec(text);
  if (!m) return null;
  const get = (k) => new RegExp(`^- ${k}:[ \\t]*(.*?)\\s*$`, 'm').exec(m[0])?.[1];
  const task = get('task');
  const ownership = get('ownership');
  const handoff = get('handoff');
  const receiver = get('receiver');
  const tr = get('transferred');
  const t = tr && tr !== 'none' ? /^(\S+) -> (\S+) via ([0-9a-f]{32}) at (\S+?)(?: acknowledged ([0-9a-f]{16}))?$/.exec(tr) : null;
  const valid = /^[0-9a-f]{12}$/.test(task ?? '') && ['owned', 'handoff-pending'].includes(ownership) && (handoff === 'none' || /^[0-9a-f]{32}$/.test(handoff ?? ''))
    && (receiver === 'none' || receiver === 'any' || agentNameOk(receiver)) && (tr === 'none' || (t && agentNameOk(t[1]) && agentNameOk(t[2]) && ISO.test(t[4])));
  if (!valid) return { malformed: true };
  return {
    taskId: task,
    ownership,
    handoff: handoff === 'none' ? null : handoff,
    receiver: receiver === 'none' ? null : receiver,
    transferred: t ? { from: t[1], to: t[2], via: t[3], at: t[4], acknowledged: t[5] ?? null } : null,
  };
};

/**
 * TASK_STATE.md as the continuity layer reads it. Only recognised values leave this function: an enumerated status, class and risk, a
 * validated agent name, short bullet texts. Repository content is data.
 */
export function parseTaskState(text) {
  const src = String(text ?? '');
  const fm = frontMatter(src);
  const sec = sectionsOf(src);
  const first = (name) => (sec.get(name) ?? []).map((l) => l.trim()).find((l) => l && !/^<!--/.test(l)) ?? null;
  const statusLine = first('status');
  const status = TASK_STATUSES.includes(statusLine) ? statusLine : null;
  const cr = (sec.get('class and risk') ?? []).join('\n');
  const cls = /^Class:[ \t]*(\S+)/m.exec(cr)?.[1];
  const risk = /^Risk:[ \t]*(\S+)/m.exec(cr)?.[1];
  const pairs = (name) => items(sec.get(name) ?? []).map((s) => {
    const i = s.indexOf(': ');
    return i > 0 ? { path: s.slice(0, i).trim(), text: s.slice(i + 2).trim() } : { path: null, text: s };
  });
  const owner = (fm.owner ?? '').trim();
  const bullets = (name) => items(sec.get(name) ?? []).filter((s) => !/^(none|n\/a|-)$/i.test(s));
  return {
    owner: agentNameOk(owner) ? owner : null,
    ownerRaw: owner,
    updatedAt: ISO.test(fm.updatedAt ?? '') ? fm.updatedAt : null,
    status,
    goal: first('goal'),
    class: CLASS_VALUES.includes(cls) ? cls : null,
    risk: RISK_VALUES.includes(risk) ? risk : null,
    completed: bullets('completed'),
    remaining: bullets('remaining'),
    knownProblems: bullets('known problems'),
    openDecisions: bullets('open decisions'),
    blocked: bullets('blocked'),
    changedFiles: pairs('changed files').filter((p) => p.path),
    relevantFiles: pairs('relevant files').filter((p) => p.path),
    lastValidation: parseLastValidation(src),
    continuity: continuityOf(src),
    eol: eolOf(src),
  };
}

/**
 * The ownership of a task, read from the state alone. The six words of the continuity model, derived and never stored twice:
 * completed (status done), handoff-pending (a handoff was issued and not accepted), unowned (no owner), blocked (status blocked, owned),
 * transferred (owned by the agent that accepted the last handoff), owned.
 */
export function ownershipOf(parsed) {
  const c = parsed.continuity && !parsed.continuity.malformed ? parsed.continuity : null;
  const ownership = c?.ownership === 'handoff-pending' ? 'handoff-pending' : parsed.owner ? 'owned' : 'unowned';
  const transferred = !!(c?.transferred && c.transferred.to === parsed.owner);
  let label;
  if (parsed.status === 'done') label = 'completed';
  else if (ownership === 'handoff-pending') label = 'handoff-pending';
  else if (ownership === 'unowned') label = 'unowned';
  else if (parsed.status === 'blocked') label = 'blocked';
  else label = transferred ? 'transferred' : 'owned';
  return { label, ownership, owner: parsed.owner, status: parsed.status, transferred, malformed: parsed.continuity?.malformed === true };
}

/** A task identity minted once, when the first handoff is issued; afterwards it is only read. */
export const mintTaskId = (goal, nowIso) => createHash('sha256').update(`erdem.task\0${goal}\0${nowIso}`).digest('hex').slice(0, 12);

const lines = (c) => [
  CONTINUITY_BEGIN,
  `- task: ${c.taskId}`,
  `- ownership: ${c.ownership}`,
  `- handoff: ${c.handoff ?? 'none'}`,
  `- receiver: ${c.receiver ?? 'none'}`,
  `- transferred: ${c.transferred ? `${c.transferred.from} -> ${c.transferred.to} via ${c.transferred.via} at ${c.transferred.at}${c.transferred.acknowledged ? ` acknowledged ${c.transferred.acknowledged}` : ''}` : 'none'}`,
  CONTINUITY_END,
];

const stamp = (now) => now.toISOString().replace(/\.\d+Z$/, 'Z');

/** Apply a replacement to the front matter only (the owner and updatedAt values live there, nowhere else). */
function inFront(text, fn) {
  const m = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
  if (!m) return null;
  const changed = fn(m[0]);
  return changed === null ? null : text.slice(0, m.index) + changed + text.slice(m.index + m[0].length);
}

function touch(text, now) {
  return inFront(text, (fm) => fm.replace(/^(updatedAt:[ \t]*).*$/m, (_, k) => `${k}${stamp(now)}`)) ?? text;
}

/** The text with the continuity block replaced (or added at the end of the file). Nothing else changes except `updatedAt`. */
export function withContinuity(text, c, now) {
  const eol = eolOf(text);
  const block = lines(c).join(eol);
  let next;
  if (BLOCK_RE.test(text)) next = text.replace(BLOCK_RE, () => block);
  else {
    const body = text.replace(/(\r?\n)*$/, '');
    next = `${body}${eol}${eol}## Continuity${eol}${block}${eol}`;
  }
  return touch(next, now);
}

/** The text with the owner value replaced (ownership taken). Null when the front matter has no owner line. */
export function withOwner(text, owner) {
  return inFront(text, (fm) => (/^owner:[ \t]*.*$/m.test(fm) ? fm.replace(/^(owner:[ \t]*).*$/m, (_, k) => `${k}${owner}`) : null));
}
