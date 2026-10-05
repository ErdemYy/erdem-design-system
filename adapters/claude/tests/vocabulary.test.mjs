import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hookLine } from '../lib/format.mjs';
import { lightStatus, verifiedStatus } from '../lib/intel.mjs';
import { ADAPTER, tmp, write } from './helpers.mjs';

// The canonical session-level states are defined once, in adapters/GENERIC.md section 3.
const STATES = ['current', 'stale', 'unverifiable', 'partial', 'missing', 'unavailable'];
const art = (graph, index) => [
  { path: '.ai/graph/graph.json', state: graph },
  { path: '.ai/AI_INDEX.md', state: index },
];
const counts = (CURRENT, STALE, UNVERIFIABLE, MISSING) => ({ CURRENT, STALE, UNVERIFIABLE, MISSING });

/** Engine results the table in GENERIC section 3 covers, with the state each must map to. */
const CASES = [
  ['all current', 0, { counts: counts(5, 0, 0, 0), artifacts: art('CURRENT', 'CURRENT') }, 'current'],
  ['unverifiable artifacts, nothing stale or missing', 0, { counts: counts(3, 0, 2, 0), artifacts: art('CURRENT', 'UNVERIFIABLE') }, 'unverifiable'],
  ['a stale artifact', 1, { counts: counts(4, 1, 0, 0), artifacts: art('STALE', 'CURRENT'), changes: { changed: ['a'], added: [], removed: [] } }, 'stale'],
  ['stale wins over missing and unverifiable', 1, { counts: counts(1, 1, 1, 1), artifacts: art('MISSING', 'STALE') }, 'stale'],
  ['everything missing', 1, { counts: counts(0, 0, 0, 3), artifacts: art('MISSING', 'MISSING') }, 'missing'],
  ['some missing, some current', 1, { counts: counts(3, 0, 0, 1), artifacts: art('MISSING', 'CURRENT') }, 'partial'],
  ['some missing, some unverifiable', 1, { counts: counts(0, 0, 2, 1), artifacts: art('MISSING', 'UNVERIFIABLE') }, 'partial'],
  ['engine error', 2, null, 'unavailable'],
  ['unexpected output', 0, { nope: true }, 'unavailable'],
];

/** A command that prints a fixed status result; verifiedStatus appends `status --json <root>`, which it ignores. */
const fake = (code, json) => {
  const dir = tmp('erdem-fake-');
  const file = path.join(dir, 'fake.mjs');
  write(file, `process.stdout.write(${JSON.stringify(json === null ? 'not json' : JSON.stringify(json))});process.exit(${code});`);
  return [process.execPath, file];
};

test('51 every engine status result maps to its canonical session state: nothing is renamed or folded into another state', () => {
  for (const [name, code, json, want] of CASES) {
    const v = verifiedStatus(tmp('erdem-proj-'), fake(code, json), { timeoutMs: 20000 });
    assert.equal(v.state, want, name);
    assert.ok(STATES.includes(v.state));
  }
  const timeout = verifiedStatus(tmp('erdem-proj-'), [process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 300 });
  assert.equal(timeout.state, 'unavailable', 'a timed-out status is unavailable, never a state of its own');
  assert.equal(verifiedStatus(tmp('erdem-proj-'), [path.join(tmp(), 'nope.exe')], { timeoutMs: 2000 }).state, 'unavailable');
});

test('52 the Claude mapping agrees with the Codex and Antigravity adapters on every case', async () => {
  for (const sibling of ['codex', 'antigravity']) {
    const file = path.join(ADAPTER, '..', sibling, 'lib', 'intelligence.mjs');
    if (!fs.existsSync(file)) continue;
    const { classifyStatus } = await import(pathToFileURL(file).href);
    for (const [name, code, json, want] of CASES) {
      const mine = verifiedStatus(tmp('erdem-proj-'), fake(code, json), { timeoutMs: 20000 }).state;
      assert.equal(classifyStatus({ exitCode: code, json }).state, mine, `${sibling}: ${name}`);
      assert.equal(mine, want);
    }
  }
});

test('53 the hook line shows the canonical state itself, with explanation added next to it, never instead of it', () => {
  const base = { system: true, config: { hookWhenUnavailable: 'line', autoSessionHandoff: false }, intelligence: { task: { present: false }, handoff: { present: false } } };
  const line = (v) => hookLine({ ...base, intelligence: { ...base.intelligence, intelligence: 'present', graph: 'present', verified: v } });
  for (const [state, graph] of [['current', 'CURRENT'], ['stale', 'STALE'], ['unverifiable', 'UNVERIFIABLE'], ['partial', 'MISSING'], ['missing', 'MISSING']]) {
    assert.match(line({ state, graph }), new RegExp(`intelligence=${state}`), state);
  }
  assert.match(line({ state: 'unverifiable', graph: 'CURRENT' }), /intelligence=unverifiable\(caution: provisional\)/);
  assert.match(line({ state: 'partial', graph: 'MISSING' }), /graph=missing/, 'a missing graph is called missing, not unavailable');
  assert.doesNotMatch(line({ state: 'unverifiable', graph: 'CURRENT' }), /intelligence=current/);
  const empty = hookLine({ ...base, intelligence: { ...base.intelligence, intelligence: 'missing', graph: 'missing', verified: null } });
  assert.match(empty, /intelligence=missing/);
});

test('54 light status words are hints: only "missing" is a canonical state, the rest say what they observed', () => {
  const dir = tmp('erdem-proj-');
  assert.equal(lightStatus(dir).intelligence, 'missing');
  assert.equal(lightStatus(dir).graph, 'missing');
  write(path.join(dir, '.ai', 'AI_INDEX.md'), '---\nindexProfile: lite\n---\n# index\n');
  const s = lightStatus(dir);
  assert.equal(s.intelligence, 'present');
  assert.ok(!STATES.includes(s.intelligence), '"present" is a hint word, not a session state');
});
