#!/usr/bin/env node
/**
 * Runs the Antigravity adapter tests and proves they did not touch the real user configuration:
 * a listing of the real Antigravity skill and state folders is taken before and compared after.
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
  const cfg = path.join(os.homedir(), '.gemini', 'config');
  // Only what the adapter could ever write: its skill folder and state folder. Names, sizes and times only.
  return JSON.stringify({ skill: listing(path.join(cfg, 'skills', 'erdem')), state: listing(path.join(cfg, 'erdem-adapter')) });
};

const before = guarded();
const tests = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(here, f));
const r = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', windowsHide: true });
const after = guarded();
if (before !== after) {
  console.error('FAIL: the real Antigravity skill or state folder changed during the tests');
  process.exit(1);
}
console.log('guard: the real Antigravity home and skills folder are unchanged');
process.exit(r.status ?? 1);
