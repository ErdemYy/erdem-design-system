// Runs the adapter test suites and proves the real Claude configuration was not touched by them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function snapshot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const out = {};
  const hashFile = (f) => {
    try {
      return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    } catch {
      return null;
    }
  };
  for (const f of ['settings.json', 'CLAUDE.md']) out[f] = hashFile(path.join(base, f));
  for (const root of [path.join(base, 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
    try {
      out[`skills:${root}`] = fs.readdirSync(root).sort().join(',');
    } catch {
      out[`skills:${root}`] = null;
    }
  }
  out.adapterState = fs.existsSync(path.join(base, 'erdem-adapter'));
  out.erdemSkill = fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'erdem'));
  return out;
}

const before = snapshot();
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('tests', f));
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: path.resolve(here, '..'), stdio: 'inherit' });
const after = snapshot();
const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
if (changed.length) {
  process.stderr.write(`GLOBAL CLAUDE CONFIGURATION CHANGED DURING TESTS: ${changed.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('real Claude configuration unchanged during the test run (settings.json, CLAUDE.md, skills, adapter state)\n');
process.exit(r.status ?? 1);
