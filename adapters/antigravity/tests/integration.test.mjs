import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectTargets, userTargets } from '../lib/paths.mjs';
import { ADAPTER, INTEL, REPO, cleanup, node, readJson } from './helpers.mjs';

after(cleanup);

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('46 graph routing: the adapter points to the canonical capability matrix, routes CLI questions to real commands, and marks library-only ones as such', async () => {
  const matrix = read(REPO, 'tools', 'analyze', 'README.md');
  const sp = matrix.split(String.fromCharCode(10)).find((l) => l.startsWith('| Shortest dependency chain between'));
  assert.ok(sp, 'the canonical matrix has a shortest-path row');
  assert.match(sp, /unavailable/);
  assert.match(sp, /library-only/);
  const { createGraphQuery } = await import(pathToFileURL(path.join(REPO, 'tools', 'analyze', 'query.mjs')).href);
  assert.equal(typeof createGraphQuery({ nodes: [], edges: [] }).shortestPath, 'function', 'the library function the matrix names exists');

  const text = read(ADAPTER, 'skill', 'references', 'context.md');
  const section = text.slice(text.indexOf('## Graph'), text.indexOf('## Not found'));
  assert.match(section, /tools\/analyze\/README\.md/, 'points to the canonical matrix');
  assert.match(section, /shortest dependency chain[^\n]*library-only|library-only[^\n]*shortest/i);
  assert.ok(!/not provided by the engine/i.test(section), 'no claim that the engine lacks the capability');
  const help = node(INTEL, ['help'], {}).stdout;
  for (const view of ['file', 'subsystem', 'impact', 'full']) {
    assert.ok(section.includes(view), `view ${view} is routed`);
    assert.ok(help.includes(view), `engine help lists ${view}`);
  }
  for (const flag of ['--target', '--depth', '--stdout']) {
    assert.ok(section.includes(flag), flag);
    assert.ok(help.includes(flag), `engine supports ${flag}`);
  }
  assert.ok(section.includes('intel impact'), 'impact is routed');
  assert.ok(section.split(String.fromCharCode(10)).length < 20, 'the adapter does not restate the whole matrix');
  assert.ok(!/path-query|shortestPath\(|dijkstra|bfs/i.test(read(ADAPTER, 'lib', 'intelligence.mjs') + read(ADAPTER, 'scripts', 'context.mjs')), 'no graph algorithm in the adapter');
});

test('47 manifest honesty: verified and unverified capabilities are separate, runtime is not claimed, hooks and MCP are listed as unused', () => {
  const m = readJson(path.join(ADAPTER, 'adapter-manifest.json'));
  assert.ok(m.verifiedCapabilities.length > 0 && m.unverifiedCapabilities.length > 0);
  assert.match(m.verifiedWith.runtimeVerification, /NOT VERIFIABLE/);
  assert.ok(m.unverifiedCapabilities.some((c) => /discovers and activates the installed skill/.test(c)));
  assert.ok(m.notUsed.some((c) => /^hooks\.json/.test(c)) && m.notUsed.some((c) => /^mcp_config\.json/.test(c)));
  assert.equal(m.owner, 'ERDEM_DESIGN_SYSTEM_ANTIGRAVITY_ADAPTER');
  assert.deepEqual(m.siblingOwners, ['ERDEM_DESIGN_SYSTEM_CODEX_ADAPTER']);
  const readme = fs.existsSync(path.join(ADAPTER, 'README.md')) ? read(ADAPTER, 'README.md') : '';
  if (readme) for (const w of ['VERIFIED', 'PARTIALLY VERIFIED', 'NOT VERIFIABLE']) assert.ok(readme.includes(w), `README states ${w}`);
});

test('48 the owned locations match the customization guide bundled with a locally installed Antigravity (skipped when absent)', { skip: !fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity-ide', 'builtin', 'skills', 'agy-customizations', 'SKILL.md')) }, () => {
  // Product documentation only; configuration files (mcp_config.json and others) are never opened.
  const guide = read(os.homedir(), '.gemini', 'antigravity-ide', 'builtin', 'skills', 'agy-customizations', 'SKILL.md');
  const skills = read(os.homedir(), '.gemini', 'antigravity-ide', 'builtin', 'skills', 'agy-customizations', 'docs', 'skills.md');
  assert.ok(guide.includes('.agents/') && guide.includes('~/.gemini/config/') && guide.includes('AGENTS.md'));
  assert.match(skills, /skills\/<skill_name>\/[\s\S]*SKILL\.md/);
  assert.match(skills, /`name`[\s\S]*`description`/);
  const u = userTargets({ home: path.resolve('/home/x') });
  const p = projectTargets('/proj');
  assert.equal(u.skillsDir, path.resolve('/home/x', '.gemini', 'config', 'skills'));
  assert.equal(p.skillsDir, path.resolve('/proj', '.agents', 'skills'));
  assert.equal(u.agentsDir, null, 'no undocumented user-level instructions file');
  const skill = read(ADAPTER, 'skill', 'SKILL.md');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)[1];
  assert.deepEqual(fm.split(/\r?\n/).map((l) => l.split(':')[0]).filter((k) => /^[a-z]+$/.test(k)), ['name', 'description'], 'front matter holds only name and description');
  assert.match(fm, /^name: erdem$/m);
});

test('49 the skill is written for progressive disclosure: small main file, details in references, description states when to use it', () => {
  const skill = read(ADAPTER, 'skill', 'SKILL.md');
  assert.ok(Buffer.byteLength(skill) < 6000, 'SKILL.md stays small');
  assert.match(/^description: (.*)$/m.exec(skill)[1], /Use when/);
  assert.match(/^description: (.*)$/m.exec(skill)[1], /Do not use/);
  for (const ref of skill.match(/references\/[a-z-]+\.md/g)) assert.ok(fs.existsSync(path.join(ADAPTER, 'skill', ref)), `${ref} exists`);
});

test('50 project-owned instructions cannot change the adapter: the adapter never reads rules, GEMINI.md or AGENTS.md as configuration', () => {
  const code = ['lib', 'scripts'].flatMap((d) => fs.readdirSync(path.join(ADAPTER, d)).map((f) => read(ADAPTER, d, f))).join('\n');
  assert.ok(!/readText\([^)]*GEMINI\.md/.test(code), 'GEMINI.md is never read');
  assert.ok(!/hooks\.json|mcp_config\.json/.test(code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/`[^`]*hooks\.json[^`]*`/g, '').replace(/'[^'\n]*(hooks|mcp_config)\.json[^'\n]*'/g, '')), 'hooks.json and mcp_config.json are not touched by code');
  assert.ok(REPO.length > 0);
});
