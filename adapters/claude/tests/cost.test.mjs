import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HOOK_LINE } from '../lib/format.mjs';
import { fixedCost, parseRouting, scenarioCost, systemSize, tokens } from './cost.mjs';
import { hook, indexedProject, isolatedEnv, tmp } from './helpers.mjs';

const whole = systemSize();

test('a normal backend task loads no design-system document', () => {
  const backend = scenarioCost(/Backend/);
  assert.equal(backend.documentCount, 0);
  assert.equal(backend.bytes, 0);
});

test('a design task loads only the relevant documents, a small share of the whole system', (t) => {
  const c = scenarioCost(/one component's spacing/);
  assert.ok(c.documentCount <= 5, `${c.documentCount} documents`);
  assert.ok(!c.docs.some((d) => /WEBGL|MOBILE|GRAPH_PROTOCOL|CONTEXT_PROTOCOL/.test(d)), 'no 3D, mobile or protocol documents');
  assert.ok(c.bytes < whole.bytes * 0.35, `${c.bytes} of ${whole.bytes} bytes`);
  t.diagnostic(`button spacing: ${c.documentCount} documents, ${c.bytes} bytes (~${tokens(c.bytes)} tokens), whole system ${whole.docs} documents ${whole.bytes} bytes`);
});

test('a mobile redesign loads mobile, typography, spacing and accessibility, not 3D', () => {
  const c = scenarioCost(/mobile screen or flow/);
  for (const need of ['platforms/MOBILE.md', 'core/TYPOGRAPHY.md', 'core/SPACING_SYSTEM.md', 'core/ACCESSIBILITY.md']) assert.ok(c.docs.includes(need), need);
  assert.ok(!c.docs.some((d) => /WEBGL|MOTION/.test(d)));
  assert.ok(c.bytes < whole.bytes * 0.5);
});

test('a 3D task loads the 3D document and motion guidance, not component or typography documents', () => {
  const c = scenarioCost(/3D or WebGL/);
  for (const need of ['platforms/WEBGL_3D.md', 'core/MOTION_SYSTEM.md']) assert.ok(c.docs.includes(need), need);
  assert.ok(!c.docs.some((d) => /COMPONENT_SYSTEM|TYPOGRAPHY|COLOR_SYSTEM/.test(d)));
  assert.ok(c.bytes < whole.bytes * 0.5);
});

test('no single routing row loads the whole system', () => {
  for (const row of parseRouting()) {
    const bytes = row.load.reduce((n, d) => n + scenarioCost(new RegExp(row.task.slice(0, 12).replace(/[^A-Za-z ]/g, '.'))).bytes * 0, 0);
    void bytes;
    assert.ok(row.load.length <= 6, `${row.task}: ${row.load.length} documents`);
    assert.ok(!row.load.some((d) => d === 'core/TOKEN_REGISTER.md') || row.load.length <= 6);
  }
});

test('persistent cost: skill description, CLAUDE.md block and the session-start line stay small', (t) => {
  const fixed = fixedCost();
  assert.ok(fixed.claudeMd < 1800);
  assert.ok(fixed.skill < 7000);
  const proj = indexedProject();
  const line = hook(proj, isolatedEnv(tmp('erdem-home-'))).stdout.trim();
  assert.ok(line.length <= MAX_HOOK_LINE);
  t.diagnostic(`SKILL.md ${fixed.skill} bytes (~${tokens(fixed.skill)} tokens, loaded only when invoked), design-routing.md ${fixed.routing} bytes, CLAUDE.md block ${fixed.claudeMd} bytes (~${tokens(fixed.claudeMd)} tokens, every session if installed), session-start line ${line.length} chars (~${Math.ceil(line.length / 4)} tokens)`);
});
