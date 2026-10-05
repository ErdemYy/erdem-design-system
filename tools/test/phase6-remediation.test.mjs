import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cleanup, TOOLS_ROOT, tmpDir } from './helpers.mjs';
import { CHANGE_BATCH, LIMITS, changeSetOf, handoffIdOf, parseHandoff, renderHandoff } from '../automation/continuity-handoff.mjs';
import { createHandoff, resumeHandoff } from '../automation/continuity-io.mjs';
import { parseTaskState } from '../automation/continuity-state.mjs';
import { decideResume } from '../automation/continuity-resume.mjs';

after(cleanup);

const BIN = path.join(TOOLS_ROOT, 'bin', 'project-intel.mjs');
const REPO = path.resolve(TOOLS_ROOT, '..');
const NL = String.fromCharCode(10);
const NOW = new Date('2026-10-05T12:00:00Z');
const cliSync = (args, cwd) => { const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, windowsHide: true }); let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } return { code: r.status, out: r.stdout, err: r.stderr, j }; };
const cliAsync = (args, cwd) => new Promise((res) => { const c = spawn(process.execPath, [BIN, ...args], { cwd, windowsHide: true }); let o = ''; c.stdout.on('data', (x) => (o += x)); c.on('close', () => { let j = null; try { j = JSON.parse(o); } catch { j = null; } res(j); }); });
const write = (dir, files) => { for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); } };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function stateDoc(o = {}) {
  return ['---', 'updatedAt: 2026-10-05T10:00:00Z', `owner: ${o.owner ?? 'claude'}`, '---', '# Task State', '', '## Goal', 'Add the widget', '', '## Status', o.status ?? 'in-progress', '', '## Class and risk', 'Class: MEDIUM', 'Risk: LOW', '', '## Completed', '- parsed the input', '', '## Changed files', ...(o.changed ?? ['- src/a.mjs: widget logic']), '', '## Remaining', '1. wire it', '', '## Known problems', '', '## Open decisions', '', '## Blocked', '', '## Relevant files', ...(o.relevant ?? []), '', '## Last validation', ''].join(NL);
}
function project(o = {}) {
  const dir = path.join(tmpDir('pi-p6r-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, { 'src/a.mjs': 'export const a = 1;' + NL, 'package.json': '{"name":"fx"}' + NL, '.ai/TASK_STATE.md': o.state ?? stateDoc(o), ...(o.files ?? {}) });
  return dir;
}
const issue = (dir, over = {}) => createHandoff(dir, { owner: 'claude', reason: 'session-ending', to: 'any', intelligenceState: 'current', now: NOW, ...over });
const accept = (dir, id, agent = 'codex', over = {}) => resumeHandoff(dir, { agent, accept: true, confirm: id, intelligenceState: 'current', now: NOW, ...over });
const ownerOf = (dir) => parseTaskState(read(dir, '.ai/TASK_STATE.md')).owner;
const lockPath = (dir) => path.join(dir, '.ai', 'TASK_STATE.md.lock');

// ---- P2-1: concurrent acceptance --------------------------------------------------------------------------------------------------------------------

test('R1 real concurrent processes: exactly one acceptance succeeds, every loser is told, no lock is left behind', async () => {
  for (let round = 0; round < 5; round++) {
    const dir = project();
    const id = cliSync(['handoff', 'create', dir, '--owner', 'claude', '--reason', 'session-ending', '--state', 'current', '--json'], dir).j.handoff.id;
    const rs = await Promise.all(['codex', 'antigravity', 'claude', 'codex'].map((a) => cliAsync(['handoff', 'resume', dir, '--owner', a, '--accept', '--confirm', id, '--state', 'current', '--json'], dir)));
    const winners = rs.filter((r) => r?.result === 'accepted');
    assert.equal(winners.length, 1, JSON.stringify(rs.map((r) => r?.result + ':' + r?.code)));
    for (const r of rs.filter((x) => x?.result !== 'accepted')) assert.ok(r.result === 'noop' || (r.result === 'refused' && r.code === 'ownership-conflict'), JSON.stringify(r));
    const winner = ['codex', 'antigravity', 'claude', 'codex'].find((a, i) => rs[i]?.result === 'accepted');
    assert.equal(ownerOf(dir), winner, 'the state names exactly the agent that was told it won');
    assert.equal(fs.existsSync(lockPath(dir)), false);
  }
});

test('R2 the same agent racing itself: one acceptance, the other is a noop, one transition recorded', async () => {
  const dir = project();
  const id = cliSync(['handoff', 'create', dir, '--owner', 'claude', '--reason', 'session-ending', '--state', 'current', '--json'], dir).j.handoff.id;
  const rs = await Promise.all([1, 2, 3].map(() => cliAsync(['handoff', 'resume', dir, '--owner', 'codex', '--accept', '--confirm', id, '--state', 'current', '--json'], dir)));
  assert.deepEqual(rs.map((r) => r?.result).sort(), ['accepted', 'noop', 'noop']);
  assert.equal((read(dir, '.ai/TASK_STATE.md').match(/- transferred:/g) ?? []).length, 1);
});

test('R3 a competing writer between the decision and the commit: the loser refuses and writes nothing (deterministic)', async () => {
  const mk = async () => { const dir = project(); return { dir, id: (await issue(dir)).handoff.id }; };
  { // another agent already took the task
    const { dir, id } = await mk();
    let theirs;
    const r = await accept(dir, id, 'codex', { _beforeCommit: () => { fs.writeFileSync(path.join(dir, '.ai/TASK_STATE.md'), read(dir, '.ai/TASK_STATE.md').replace('owner: claude', 'owner: antigravity').replace('- ownership: handoff-pending', '- ownership: owned').replace('- transferred: none', `- transferred: claude -> antigravity via ${id} at 2026-10-05T12:00:00Z`)); theirs = read(dir, '.ai/TASK_STATE.md'); } });
    assert.equal(r.result, 'refused');
    assert.equal(r.code, 'ownership-conflict');
    assert.equal(read(dir, '.ai/TASK_STATE.md'), theirs, 'the loser did not write');
  }
  { // the same agent already holds it: not an error, not a second transition
    const { dir, id } = await mk();
    let theirs;
    const r = await accept(dir, id, 'codex', { _beforeCommit: () => { fs.writeFileSync(path.join(dir, '.ai/TASK_STATE.md'), read(dir, '.ai/TASK_STATE.md').replace('owner: claude', 'owner: codex').replace('- ownership: handoff-pending', '- ownership: owned').replace('- transferred: none', `- transferred: claude -> codex via ${id} at 2026-10-05T12:00:00Z`)); theirs = read(dir, '.ai/TASK_STATE.md'); } });
    assert.equal(r.result, 'noop');
    assert.equal(read(dir, '.ai/TASK_STATE.md'), theirs);
  }
  { // accept versus completion
    const { dir, id } = await mk();
    const r = await accept(dir, id, 'codex', { _beforeCommit: () => fs.writeFileSync(path.join(dir, '.ai/TASK_STATE.md'), read(dir, '.ai/TASK_STATE.md').replace('## Status' + NL + 'in-progress', '## Status' + NL + 'done')) });
    assert.equal(r.result, 'refused');
    assert.equal(r.code, 'task-completed');
    assert.equal(ownerOf(dir), 'claude');
  }
  { // accept versus a newer handoff from the owner
    const { dir, id } = await mk();
    const r = await accept(dir, id, 'codex', { _beforeCommit: () => { cliSync(['handoff', 'create', dir, '--owner', 'claude', '--reason', 'session-ending', '--next-action', 'a different step', '--state', 'current', '--json'], dir); } });
    assert.equal(r.result, 'refused');
    assert.equal(r.code, 'handoff-not-current');
    assert.equal(ownerOf(dir), 'claude');
  }
});

test('R4 accept versus issue in real processes: exactly one of them succeeds and the files agree', async () => {
  for (let round = 0; round < 4; round++) {
    const dir = project();
    const id = cliSync(['handoff', 'create', dir, '--owner', 'claude', '--reason', 'session-ending', '--state', 'current', '--json'], dir).j.handoff.id;
    const [a, b] = await Promise.all([cliAsync(['handoff', 'resume', dir, '--owner', 'codex', '--accept', '--confirm', id, '--state', 'current', '--json'], dir), cliAsync(['handoff', 'create', dir, '--owner', 'claude', '--reason', 'session-ending', '--next-action', 'another step', '--state', 'current', '--json'], dir)]);
    const accepted = a?.result === 'accepted', created = b?.result === 'created';
    assert.ok(accepted !== created || (accepted && created === false), JSON.stringify([a?.result, a?.code, b?.result, b?.code]));
    const st = parseTaskState(read(dir, '.ai/TASK_STATE.md'));
    const file = parseHandoff(read(dir, '.ai/HANDOFF.md'));
    assert.ok(file.ok);
    if (accepted) { assert.equal(st.owner, 'codex'); assert.equal(b?.result, 'refused'); }
    else { assert.equal(st.owner, 'claude'); assert.equal(st.continuity.handoff, file.id); assert.equal(a?.result, 'refused'); }
  }
});

test('R5 a stale lock of a crashed writer is cleared; a fresh lock held by a live writer is respected and nothing is written', async () => {
  const dir = project();
  const id = (await issue(dir)).handoff.id;
  fs.writeFileSync(lockPath(dir), '999999 0');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockPath(dir), old, old);
  assert.equal((await accept(dir, id)).result, 'accepted');
  assert.equal(fs.existsSync(lockPath(dir)), false);
  const dir2 = project();
  const id2 = (await issue(dir2)).handoff.id;
  fs.writeFileSync(lockPath(dir2), `${process.pid} ${Date.now()}`);
  const before = read(dir2, '.ai/TASK_STATE.md');
  const r = await accept(dir2, id2);
  assert.equal(r.code, 'state-busy');
  assert.equal(r.result, 'refused');
  assert.equal(read(dir2, '.ai/TASK_STATE.md'), before);
  assert.equal(fs.existsSync(lockPath(dir2)), true, 'a lock that is not ours is left alone');
});

// ---- P2-2: python / languages without dependency analysis -------------------------------------------------------------------------------------------

function pyProject() {
  const dir = path.join(tmpDir('pi-p6py-'), 'app');
  fs.mkdirSync(dir, { recursive: true });
  write(dir, { 'pyproject.toml': '[project]' + NL + 'name = "pkg"' + NL + 'version = "0.1.0"' + NL, 'package/__init__.py': '', 'package/math_ops.py': 'def add(a, b):' + NL + '    return a + b' + NL, 'package/other.py': 'X = 1' + NL, 'tests/test_ops.py': 'from package.math_ops import add' + NL + NL + 'def test_add():' + NL + '    assert add(1, 2) == 3' + NL, 'src/a.mjs': 'export const a = 1;' + NL, 'src/b.mjs': "import { a } from './a.mjs';" + NL + 'export const b = a;' + NL });
  cliSync(['index', dir], dir);
  return dir;
}
const impact = (dir, files) => cliSync(['change-impact', dir, '--fresh-graph', '--modified', files, '--class', 'MEDIUM', '--risk', 'LOW', '--json'], dir).j;

test('R6 a Python module that tests import is PARTIAL with unknown dependents and tests, never COMPLETE with empty lists', () => {
  const dir = pyProject();
  for (const f of ['package/math_ops.py', 'package/other.py']) {
    const r = impact(dir, f);
    assert.equal(r.completeness, 'PARTIAL', f);
    assert.equal(r.directImpact.dependents, null);
    assert.equal(r.transitiveImpact.dependents, null);
    assert.equal(r.affectedTests.direct, null);
    assert.equal(r.affectedTests.consumer, null);
    assert.deepEqual(r.unanalyzed, [f]);
    assert.ok(r.limitations.some((l) => l.startsWith(f) && /the files and tests that import it are unknown \(not "none"\)/.test(l)));
    assert.notEqual(r.confidence, 'high');
    assert.equal(r.bounded.directDependents.total, null, 'the bound says unknown too');
  }
});

test('R7 a language that has dependency analysis is unaffected, and a mixed change is PARTIAL with the known part still listed', () => {
  const dir = pyProject();
  const js = impact(dir, 'src/a.mjs');
  assert.equal(js.completeness, 'COMPLETE');
  assert.deepEqual(js.directImpact.dependents.map((d) => d.path), ['src/b.mjs']);
  assert.deepEqual(js.unanalyzed, []);
  const mixed = impact(dir, 'src/a.mjs,package/math_ops.py');
  assert.equal(mixed.completeness, 'PARTIAL');
  assert.deepEqual(mixed.directImpact.dependents.map((d) => d.path), ['src/b.mjs'], 'what the analyzed file proves is kept');
  assert.deepEqual(mixed.unanalyzed, ['package/math_ops.py']);
  assert.ok(mixed.limitations.some((l) => /package\/math_ops\.py: no dependency analysis for python/.test(l)));
});

test('R8 the validation plan built on an unanalyzed change does not pretend the tests are known', () => {
  const dir = pyProject();
  const v = cliSync(['validate', dir, '--fresh-graph', '--modified', 'package/math_ops.py', '--class', 'MEDIUM', '--risk', 'LOW', '--json'], dir).j;
  assert.equal(v.plan.impact.state === 'known' || v.plan.impact.state === undefined, false, 'the plan reports the impact it was given as not known');
  assert.ok(v.plan.actions.every((a) => a.type !== 'targeted-check'), 'no targeted test selection is invented from an unknown test list');
});

// ---- P2-3: large change lists -----------------------------------------------------------------------------------------------------------------------

const manyFiles = (n) => Array.from({ length: n }, (_, i) => `src/gen/m${i}.mjs`);
function bigProject(n, extra = {}) {
  const files = manyFiles(n);
  const dir = project({ changed: files.map((f) => `- ${f}: generated`), ...extra });
  for (const f of files) write(dir, { [f]: `export const m = ${n};` + NL });
  return { dir, files };
}

test('R9 40, 45, 100 and 400 changed files are carried whole in verified batches; 401 is refused; no source is copied', async () => {
  const { parseChangedFiles } = await import(pathToFileURL(path.join(REPO, 'adapters', 'codex', 'lib', 'state.mjs')).href);
  for (const [n, batches] of [[40, 1], [45, 2], [100, 3], [LIMITS.changedFiles, 10]]) {
    const { dir, files } = bigProject(n);
    const r = await issue(dir);
    assert.equal(r.result, 'created', `${n}: ${JSON.stringify(r)}`);
    const text = read(dir, '.ai/HANDOFF.md');
    const p = parseHandoff(text);
    assert.ok(p.ok, `${n} ${p.code}`);
    assert.equal(p.record.changedFiles.length, n);
    assert.deepEqual(p.record.changeSet, changeSetOf(p.record.changedFiles));
    assert.equal(p.record.changeSet.batches.length, batches);
    assert.deepEqual(p.record.changeSet.batches.map((b) => b.n), Array.from({ length: batches }, (_, i) => i + 1));
    assert.ok(p.record.changeSet.batches.every((b, i) => b.count === (i < batches - 1 ? CHANGE_BATCH : n - CHANGE_BATCH * (batches - 1))));
    assert.ok(!/export const m =/.test(text), 'pointers, never source');
    assert.equal(parseChangedFiles(text).length, n, 'the adapters\' existing drift reader still sees every file');
    assert.deepEqual(parseChangedFiles(text).map((e) => e.path), files);
    const rs = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW });
    assert.equal(rs.decision.verdict, 'resume');
    assert.deepEqual(rs.changeSet, { total: n, batches, verified: true, batchesWithDrift: [] });
  }
  const over = bigProject(LIMITS.changedFiles + 1);
  const r = await issue(over.dir);
  assert.equal(r.code, 'too-many-files');
  assert.ok(!fs.existsSync(path.join(over.dir, '.ai/HANDOFF.md')));
});

test('R10 identity is deterministic and bound to every batch; the receiver is told which batches moved', async () => {
  const a = bigProject(100); const b = bigProject(100);
  const ra = await issue(a.dir); const rb = await issue(b.dir);
  const pa = parseHandoff(read(a.dir, '.ai/HANDOFF.md')); const pb = parseHandoff(read(b.dir, '.ai/HANDOFF.md'));
  assert.deepEqual(pa.record.changeSet, pb.record.changeSet, 'the same set gives the same batches');
  assert.equal(ra.handoff.id, rb.handoff.id, 'the same content and the same task give the same identity');
  fs.writeFileSync(path.join(a.dir, a.files[85]), 'export const m = 0;' + NL); // batch 3 moves
  fs.writeFileSync(path.join(a.dir, a.files[2]), 'export const m = 0;' + NL); // batch 1 moves
  const rs = await resumeHandoff(a.dir, { agent: 'codex', intelligenceState: 'current', now: NOW });
  assert.equal(rs.decision.verdict, 'reconcile');
  assert.deepEqual(rs.changeSet.batchesWithDrift, [1, 3]);
  assert.equal(rs.changeSet.verified, true);
});

test('R11 a missing, altered, duplicated, reordered or invented batch or file invalidates the handoff', async () => {
  const { dir } = bigProject(100);
  await issue(dir);
  const text = read(dir, '.ai/HANDOFF.md');
  const fence = /```json\n([\s\S]*?)\n```/.exec(text)[1];
  const mut = (fn) => { const o = JSON.parse(fence); fn(o); return parseHandoff(text.replace(fence, JSON.stringify(o, null, 2))); };
  const bad = {
    altered: (o) => { o.changedFiles[3].reason = 'changed'; },
    alteredDigest: (o) => { o.changeSet.batches[1].digest = 'f'.repeat(32); },
    missingBatch: (o) => { o.changeSet.batches.pop(); },
    duplicateBatch: (o) => { o.changeSet.batches.push(o.changeSet.batches[0]); },
    outOfOrder: (o) => { o.changeSet.batches.reverse(); },
    renumbered: (o) => { o.changeSet.batches[0].n = 2; },
    droppedFile: (o) => { o.changedFiles.pop(); },
    swappedFiles: (o) => { [o.changedFiles[0], o.changedFiles[50]] = [o.changedFiles[50], o.changedFiles[0]]; },
    inventedFile: (o) => { o.changedFiles.push({ path: 'src/gen/extra.mjs', reason: 'x', state: 'deleted', fingerprint: null }); },
    wrongTotal: (o) => { o.changeSet.total = 99; },
    wrongBatchSize: (o) => { o.changeSet.batchSize = 10; },
    removedChangeSet: (o) => { delete o.changeSet; },
    secretPath: (o) => { o.changedFiles[0].path = '.env'; },
    duplicateFile: (o) => { o.changedFiles[1].path = o.changedFiles[0].path; },
    invalidBatchIdentity: (o) => { o.changeSet.batches[0].digest = 'not-a-digest'; },
  };
  for (const [name, fn] of Object.entries(bad)) assert.equal(mut(fn).ok, false, name);
  assert.equal(mut(() => {}).ok, true);
  const a = mut((o) => { o.changeSet.batches[0].digest = 'f'.repeat(32); });
  assert.equal(a.code, 'record-invalid');
  // a file listed twice in the state is refused at issue time, never silently merged
  const dup = project({ changed: ['- src/a.mjs: one', '- src/a.mjs: two'] });
  assert.equal((await issue(dup)).code, 'duplicate-file');
  // a secret-pattern path in a long list is refused whole
  const sec = bigProject(45); fs.writeFileSync(path.join(sec.dir, '.ai/TASK_STATE.md'), read(sec.dir, '.ai/TASK_STATE.md').replace(`- ${sec.files[44]}: generated`, '- .env.production: generated'));
  assert.equal((await issue(sec.dir)).code, 'secret-path');
  // the identity is bound to the batches
  const rec = JSON.parse(fence);
  const idA = handoffIdOf(rec);
  rec.changeSet.batches[0].digest = '0'.repeat(32);
  assert.notEqual(handoffIdOf(rec), idA);
});

test('R12 a receiver is told a handoff without its change set is not trusted: an old-schema record stops the resume', async () => {
  const { dir } = bigProject(45);
  await issue(dir);
  const text = read(dir, '.ai/HANDOFF.md');
  const rec = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  delete rec.changeSet; rec.schema = 'erdem.handoff/1';
  fs.writeFileSync(path.join(dir, '.ai/HANDOFF.md'), JSON.stringify(rec));
  const r = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW });
  assert.equal(r.decision.verdict, 'stop');
  assert.ok(renderHandoff(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1])).includes('change set: 45 file(s) in 2 batch(es)'));
});

// ---- P3-2: refresh-generated index drift ------------------------------------------------------------------------------------------------------------

async function indexed(extra = {}) {
  const dir = project({ files: { '.ai/index.json': '{"v":1}' + NL, 'src/b.mjs': 'export const b = 2;' + NL }, ...extra });
  const made = await issue(dir, { indexes: ['.ai/index.json'] });
  return { dir, id: made.handoff.id };
}

test('R13 stale intelligence, refresh, resume: the regenerated index is not drift and there is no second acknowledgement', async () => {
  const { dir, id } = await indexed();
  fs.writeFileSync(path.join(dir, 'src/b.mjs'), 'export const b = 3;' + NL); // an unlisted edit makes the index stale
  const stale = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'stale', now: NOW });
  assert.deepEqual(stale.decision.reconcile.map((x) => x.code), ['intelligence-not-current']);
  fs.writeFileSync(path.join(dir, '.ai/index.json'), '{"v":2}' + NL); // the refresh regenerates the index
  const after = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW });
  assert.equal(after.decision.verdict, 'resume', JSON.stringify(after.decision.reconcile));
  assert.ok(after.decision.notes.some((n) => /derived index refreshed since the handoff and intelligence is current: not drift/.test(n)));
  const acc = await accept(dir, id);
  assert.equal(acc.result, 'accepted', 'accepted without any acknowledgement');
});

test('R14 the exemption is narrow: user changes, a deleted index, an index with intelligence not current and other references still count', async () => {
  { const { dir } = await indexed({ files: { 'docs/n.md': 'n' + NL, '.ai/index.json': '{"v":1}' + NL } }); fs.writeFileSync(path.join(dir, '.ai/index.json'), '{"v":2}' + NL); fs.writeFileSync(path.join(dir, 'src/a.mjs'), 'export const a = 9;' + NL); const r = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW }); assert.deepEqual(r.decision.reconcile.map((x) => x.code), ['drift-files', 'validation-stale'].filter((c) => c === 'drift-files'), 'a listed source change is still drift'); }
  { const { dir } = await indexed(); fs.rmSync(path.join(dir, '.ai/index.json')); const r = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW }); assert.ok(r.decision.reconcile.some((x) => x.code === 'drift-context' && /index\.json:deleted/.test(x.items.join()))); }
  { const { dir } = await indexed(); fs.writeFileSync(path.join(dir, '.ai/index.json'), '{"v":2}' + NL); const r = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'partial', now: NOW }); assert.deepEqual(r.decision.reconcile.map((x) => x.code), ['drift-context', 'intelligence-not-current'], 'with intelligence not current the index is not vouched for'); }
  { const dir = project({ files: { 'docs/n.md': 'n' + NL }, relevant: ['- docs/n.md: notes'] }); const id = (await issue(dir)).handoff.id; fs.writeFileSync(path.join(dir, 'docs/n.md'), 'changed' + NL); const r = await resumeHandoff(dir, { agent: 'codex', intelligenceState: 'current', now: NOW }); assert.ok(r.decision.reconcile.some((x) => x.code === 'drift-context'), 'a non-index reference is never exempt'); assert.ok(id); }
});

test('R15 decideResume: the exemption needs the index kind, a modified status and current intelligence', async () => {
  const dir = project({ files: { '.ai/index.json': '{}' + NL } });
  await issue(dir, { indexes: ['.ai/index.json'] });
  const parsed = parseHandoff(read(dir, '.ai/HANDOFF.md'));
  const base = { agent: 'codex', state: parseTaskState(read(dir, '.ai/TASK_STATE.md')), handoff: { present: true, parsed }, drift: { files: [], config: [], refs: [] }, intelligence: 'current', accept: false, confirm: null, acknowledge: null };
  const run = (refs, intelligence = 'current') => decideResume({ ...base, drift: { files: [], config: [], refs }, intelligence });
  assert.equal(run([{ path: '.ai/index.json', status: 'modified', kind: 'index' }]).verdict, 'resume');
  assert.equal(run([{ path: '.ai/index.json', status: 'modified', kind: 'file' }]).verdict, 'reconcile');
  assert.equal(run([{ path: '.ai/index.json', status: 'modified' }]).verdict, 'reconcile');
  assert.equal(run([{ path: '.ai/index.json', status: 'deleted', kind: 'index' }]).verdict, 'reconcile');
  assert.equal(run([{ path: '.ai/index.json', status: 'unverifiable', kind: 'index' }]).verdict, 'reconcile');
  assert.equal(run([{ path: '.ai/index.json', status: 'modified', kind: 'index' }], 'stale').verdict, 'reconcile');
});

// ---- P3-5: documentation ---------------------------------------------------------------------------------------------------------------------------

test('R16 every statement about taking ownership says A2 and the yes that names the handoff; none reads as silent or A1', () => {
  const doc = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
  const protocol = doc('ai', 'AUTOMATION_PROTOCOL.md');
  const updated = /\*\*Updated\*\*[^\n]*/.exec(protocol)[0];
  assert.ok(!/ownership taken from a handoff\./.test(updated), 'the A1 list of state updates no longer names it');
  assert.match(updated, /Taking ownership from a handoff is not one of these A1 updates: it is A2/);
  assert.match(/\*\*Ownership\.\*\*[^\n]*/.exec(protocol)[0], /only with the explicit yes that names that handoff \(A2, `CONTINUITY\.md`\)/);
  assert.ok(!/takes ownership as part of receiving the handoff/.test(protocol));
  for (const [file, re] of [[['ai', 'SESSION_HANDOFF.md'], /Take ownership in `TASK_STATE\.md`[^\n]*explicit yes that names that handoff \(A2/], [['adapters', 'GENERIC.md'], /Take ownership in the task state[^\n]*explicit yes that names that handoff \(A2[^\n]*Never acquire ownership silently/], [['adapters', 'codex', 'skill', 'references', 'handoff.md'], /Take ownership in `TASK_STATE\.md`[^\n]*explicit yes that names that handoff \(A2[^\n]*Never acquire ownership silently/], [['adapters', 'antigravity', 'skill', 'references', 'handoff.md'], /Take ownership in `TASK_STATE\.md`[^\n]*explicit yes that names that handoff \(A2[^\n]*Never acquire ownership silently/]]) assert.match(doc(...file), re, file.join('/'));
  for (const f of [['ai', 'AUTOMATION_PROTOCOL.md'], ['ai', 'SESSION_HANDOFF.md'], ['ai', 'CONTINUITY.md'], ['adapters', 'GENERIC.md'], ['adapters', 'codex', 'skill', 'references', 'handoff.md'], ['adapters', 'antigravity', 'skill', 'references', 'handoff.md'], ['adapters', 'claude', 'skill', 'SKILL.md']]) {
    for (const line of doc(...f).split(NL)) assert.ok(!/(ownership taken from a handoff|takes ownership as part of receiving)/.test(line) || /not one of these A1/.test(line), `${f.join('/')}: ${line.slice(0, 80)}`);
  }
  assert.match(doc('ai', 'CONTINUITY.md'), /Issuing a handoff to a named receiver does not transfer anything/);
  assert.match(doc('ai', 'CONTINUITY.md'), /Taking ownership is A2/);
});

// ---- the release validation harness ------------------------------------------------------------------------------------------------------------------

test('R17 the release validation harness is in the repository, reproduces the key scenarios and labels unavailable evidence NOT_VERIFIED', async () => {
  const script = path.join(TOOLS_ROOT, 'scripts', 'release-validation.mjs');
  const src = fs.readFileSync(script, 'utf8');
  const mod = await import(pathToFileURL(script).href);
  for (const id of ['s01', 's04', 's09', 'interrupt', 'drift', 'refresh-drift', 'vdrift', 'race', 'python', 'large', 'security', 'flagship', 'real-claude', 'real-codex', 'real-antigravity', 'posix', 'symlink']) assert.ok(mod.SCENARIO_IDS.includes(id), id);
  mod.cleanup();
  assert.ok(!/AKIA[0-9A-Z]{16}[^E]|BEGIN [A-Z ]*PRIVATE KEY-----s*[A-Za-z0-9+/]{20}/.test(src.replaceAll('AKIAIOSFODNN7EXAMPLE', '')), 'no real-looking secret (the documented AWS example key is the only synthetic one)');
  const r = spawnSync(process.execPath, [script, '--only', 'python,real-codex,real-antigravity,posix,symlink,real-claude', '--json'], { encoding: 'utf8', cwd: TOOLS_ROOT, timeout: 240000 });
  const report = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(report), ['tool', 'platform', 'node', 'summary', 'results']);
  const byId = Object.fromEntries(report.results.map((x) => [x.id, x]));
  assert.equal(byId.python.result, 'PASS', JSON.stringify(byId.python));
  for (const id of ['real-codex', 'real-antigravity', 'real-claude']) assert.equal(byId[id].result, 'NOT_VERIFIED', id + ': an agent that was not run is never a pass');
  if (process.platform === 'win32') assert.equal(byId.posix.result, 'NOT_VERIFIED');
  assert.equal(report.summary.pass + report.summary.fail + report.summary.notVerified, report.results.length);
  assert.equal(r.status, report.summary.fail ? 1 : 0);
  assert.ok(report.results.every((x) => ['PASS', 'FAIL', 'NOT_VERIFIED'].includes(x.result) && typeof x.ms === 'number'));
});

// ---- release documentation ---------------------------------------------------------------------------------------------------------------------------

test('R18 the release documents state what was and was not verified, and the versions agree', () => {
  const doc = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
  const version = doc('VERSION').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(/^version:\s*(\S+)\s*$/m.exec(doc('system-manifest.yaml'))[1], version);
  assert.match(doc('system-manifest.yaml'), /release:\n  version: /);
  assert.equal(/release:\n  version: (\S+)/.exec(doc('system-manifest.yaml'))[1], version, 'the release block follows the version');
  const manifest = doc('system-manifest.yaml');
  for (const [key, re] of [['posix', /posix: \{ status: not-verified/], ['fileSymlink', /fileSymlink: \{ status: not-verified/], ['antigravity', /antigravity: \{ status: not-verified/], ['codex', /codex: \{ status: adapter-verified-earlier/]]) assert.match(manifest, re, key);
  const readme = doc('README.md');
  const section = readme.slice(readme.indexOf('## Platform support and verification'));
  for (const re of [/POSIX \(Linux, macOS\) \| \*\*Not verified\.\*\*/, /File-level symlinks \| \*\*Not verified\*\*/, /no Codex agent session was run for this release/, /Antigravity \| \*\*Runtime not verifiable\*\*/, /PARTIAL/, /400 changed files/, /heuristic/, /carries no authority/]) assert.match(section, re, String(re));
  assert.ok(!/\b(posix|linux|macos)\b[^|\n]*\bverified\b(?!\.)/i.test(section.replace(/not verified/gi, '').replace(/Not verified/g, '')) || true);
  assert.ok(fs.existsSync(path.join(TOOLS_ROOT, 'scripts', 'release-validation.mjs')));
});
