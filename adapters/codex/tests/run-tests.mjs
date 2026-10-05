#!/usr/bin/env node
/**
 * Runs the Codex adapter tests and proves they did not touch the real user configuration:
 * a fingerprint of the real Codex home and agents-skills folder is taken before and compared after.
 * Only file names, sizes and modification times are read; contents (which may hold credentials) never are.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function listing(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['sessions', 'log', 'logs', 'cache', 'tmp', 'node_modules'].includes(e.name)) walk(abs);
      } else {
        try {
          const s = fs.statSync(abs);
          out.push(`${path.relative(dir, abs)}|${s.size}|${s.mtimeMs}`);
        } catch {
          /* vanished */
        }
      }
    }
  })(dir);
  return out.sort();
}

const guarded = () => {
  const codex = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  // Only the files the adapter could ever write: its own skill folder, ledger folder and the AGENTS files.
  const files = [path.join(codex, 'AGENTS.md'), path.join(codex, 'AGENTS.override.md'), path.join(codex, 'config.toml')];
  return JSON.stringify({
    skill: listing(path.join(os.homedir(), '.agents', 'skills', 'erdem')),
    ledger: listing(path.join(codex, 'erdem-adapter')),
    files: files.map((f) => (fs.existsSync(f) ? `${path.basename(f)}|${fs.statSync(f).size}|${fs.statSync(f).mtimeMs}` : `${path.basename(f)}|absent`)),
  });
};

const before = guarded();
const tests = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(here, f));
const r = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', windowsHide: true });
const after = guarded();
if (before !== after) {
  console.error('FAIL: the real Codex configuration or the real skill folder changed during the tests');
  process.exit(1);
}
console.log('guard: the real Codex home and skills folder are unchanged');
process.exit(r.status ?? 1);
