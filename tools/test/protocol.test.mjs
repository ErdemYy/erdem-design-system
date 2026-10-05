import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_ROOT } from './helpers.mjs';

// Consistency checks for the written automation contract (ai/AUTOMATION_PROTOCOL.md). The contract is a
// specification: nothing here runs it, and nothing here simulates it.
const REPO = path.resolve(TOOLS_ROOT, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const spec = read('ai', 'AUTOMATION_PROTOCOL.md');
const lines = spec.split(/\r?\n/);

test('the contract invents no task class, uses the canonical six session states, and names no agent', () => {
  const canonical = read('ai', 'TASK_ROUTING.md');
  const classes = ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'ARCHITECTURAL'];
  for (const c of classes) assert.ok(canonical.includes(`| ${c} |`), `${c} is a canonical class`);
  const rows = lines.filter((l) => /^\| [A-Z]{4,}[A-Z-]* \|/.test(l)).map((l) => l.split('|')[1].trim());
  const classRows = rows.filter((r) => /^(TRIVIAL|SMALL|MEDIUM|LARGE|ARCHITECTURAL)$/.test(r));
  assert.deepEqual(classRows, classes, 'one row per canonical class, in order, in the task-class table');
  const generic = read('adapters', 'GENERIC.md');
  for (const state of ['current', 'stale', 'unverifiable', 'partial', 'missing', 'unavailable']) {
    assert.ok(generic.includes(`**${state}**`), `${state} is defined in GENERIC section 3`);
    assert.ok(new RegExp(`\\| ${state} \\|`).test(spec), `${state} has an Intelligence automation row`);
  }
  assert.ok(!/claude|codex|antigravity|gemini|anthropic|openai/i.test(spec), 'ai/ stays tool-agnostic');
});

test('every document and command the contract points to exists', () => {
  const targets = new Set([...spec.matchAll(/`((?:ai|core|adapters|tools|templates)\/[A-Za-z0-9_./-]+\.(?:md|mjs))`/g)].map((m) => m[1]));
  for (const f of ['ai/TASK_ROUTING.md', 'ai/CONTEXT_PROTOCOL.md', 'ai/CHANGE_IMPACT.md', 'ai/SESSION_HANDOFF.md', 'ai/VALIDATION_PROTOCOL.md', 'adapters/GENERIC.md', 'tools/analyze/README.md']) targets.add(f);
  for (const t of targets) assert.ok(fs.existsSync(path.join(REPO, t)), `${t} exists`);
  // bare protocol names written as `NAME.md` resolve to a file in ai/ (or templates/ or core/)
  for (const m of spec.matchAll(/`([A-Z_]+\.md)`/g)) {
    const found = ['ai', 'templates', 'core'].some((d) => fs.existsSync(path.join(REPO, d, m[1])));
    assert.ok(found || ['TASK_STATE.md', 'HANDOFF.md', 'DECISIONS.md', 'AI_INDEX.md'].includes(m[1]) || m[1] === 'TASK_STATE.md', `${m[1]} resolves`);
  }
});

test('automation levels, event names and action vocabulary are internally consistent', () => {
  for (const level of ['A0', 'A1', 'A2', 'A3']) assert.ok(new RegExp(`\\| ${level} \\|`).test(spec), `${level} is defined`);
  const eventNames = [...spec.matchAll(/^\| ([A-Z]+(?:_[A-Z]+)+) \|/gm)].map((m) => m[1]);
  assert.ok(eventNames.length >= 12);
  assert.equal(new Set(eventNames).size, eventNames.length, 'each event is defined once');
  for (const e of ['SESSION_START', 'TASK_RECEIVED', 'TASK_CLASSIFIED', 'CONTEXT_EXPANDED', 'INTELLIGENCE_CHECKED', 'CHANGE_STARTED', 'IMPACT_REQUIRED', 'CHANGE_COMPLETED', 'VALIDATION_REQUIRED', 'VALIDATION_COMPLETED', 'TASK_PAUSED', 'TASK_COMPLETED', 'HANDOFF_REQUIRED', 'SESSION_END']) assert.ok(eventNames.includes(e), e);
  const used = new Set([...spec.matchAll(/\b([A-Z]+(?:_[A-Z]+)+)\b/g)].map((m) => m[1]).filter((n) => /_(START|STARTED|RECEIVED|CLASSIFIED|EXPANDED|CHECKED|COMPLETED|REQUIRED|PAUSED|END)$/.test(n)));
  for (const u of used) assert.ok(eventNames.includes(u), `${u} is used but not defined`);
  // every action named in the observability section is an operation or a state/validation record in the contract
  for (const action of ['status-check', 'impact-query', 'incremental-refresh', 'state-update', 'validation']) assert.ok(spec.includes(action), action);
  assert.ok(/shortest/i.test(spec) === false || /library-only/.test(spec), 'shortest path is only ever described as library-only');
});

test('the safety boundaries cover every category the contract promises, and nothing lowers an A3', () => {
  const boundary = spec.slice(spec.indexOf('## Safety boundaries'), spec.indexOf('## Observability'));
  for (const word of ['secrets', '.env', 'private keys', 'credentials', 'agent and user configuration', 'installing', 'network', 'destructive', 'source deletion', 'migration', 'version-control history']) {
    assert.ok(boundary.toLowerCase().includes(word.toLowerCase()), `boundary covers ${word}`);
  }
  assert.match(spec, /Nothing may lower A3/);
  assert.match(spec, /Fail closed/);
});

test('the contract adds no state store, no runner and no dependency', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'ai', 'AUTOMATION_MATRIX.md')), 'one document holds the contract');
  assert.match(spec, /creates no other state store/);
  assert.match(spec, /Specification only/);
  const pkg = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('validation raising is defined once in the validation protocol; A2 proposals and persistence are specified', () => {
  const validation = read('ai', 'VALIDATION_PROTOCOL.md');
  assert.match(validation, /HIGH uses the validation of the next class up/);
  assert.match(validation, /CRITICAL uses the validation of ARCHITECTURAL/);
  assert.match(spec, /defined once, in `VALIDATION_PROTOCOL\.md`/);
  assert.ok(!/this contract's reading/.test(spec), 'the contract does not define its own reading of "raise"');
  const proposals = spec.slice(spec.indexOf('## Proposals (A2)'), spec.indexOf('## Operations'));
  for (const word of ['action', 'scope', 'reason', 'effect', 'alternative', 'adapter-specific', 'always allow']) assert.ok(proposals.includes(word), `proposal text covers ${word}`);
  const persistence = spec.slice(spec.indexOf('## Persistence of action records'), spec.indexOf('## Deferred'));
  assert.match(persistence, /not persisted by this contract/);
  assert.match(persistence, /opt-in per project/);
  assert.ok(!/\.ai\/state\/automation|\.jsonl/.test(persistence.replace('append-only', '')), 'no canonical location is defined');
  assert.ok(!/there are no generators or scanners yet/i.test(read('README.md')), 'the root README no longer claims there are no scanners');
});
