import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const fwd = (p) => String(p).replace(/\\/g, '/');

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Only the first bytes of a file (front-matter probes never read a whole file). */
export function readHead(file, bytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readJson(file) {
  const text = readText(file);
  if (text === null) return { exists: false, data: null, error: null };
  try {
    return { exists: true, data: JSON.parse(text.replace(/^﻿/, '')), error: null };
  } catch (e) {
    return { exists: true, data: null, error: e.message };
  }
}

/** Write through a temporary file and rename, so an interrupted write never leaves half a file. */
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.erdem-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

export const jsonText = (v) => JSON.stringify(v, null, 2) + '\n';

/** A short plain token from untrusted file content: anything else is dropped (output reaches the model). */
export function safeToken(value, pattern, max = 24) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length > 0 && v.length <= max && pattern.test(v) ? v : null;
}

/** A printable project-relative path from untrusted content, or null. */
export function safePath(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length > 0 && v.length <= 200 && /^[\p{L}\p{N}_@.,()+ \-/\\]+$/u.test(v) ? v : null;
}

function unquote(v) {
  return v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) ? v.slice(1, -1) : v;
}

export function parseFrontMatter(text) {
  if (!text) return {};
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = unquote(line.slice(i + 1).trim());
  }
  return out;
}

export function splitCommand(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export function isMain(metaUrl) {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export class UsageError extends Error {}

export function parseArgs(argv, { flags = [], values = [] }) {
  const out = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) out.opts[a.slice(2)] = true;
    else if (values.includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      out.opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

export const makeIo = (stream = process) => ({
  out: (t) => stream.stdout.write(t.endsWith('\n') ? t : t + '\n'),
  err: (t) => stream.stderr.write(t.endsWith('\n') ? t : t + '\n'),
});

/* ------------------------------------------------------------------------------------------------
 * Child processes. Never `shell: true`: arguments are passed as an array, so quoting, spaces and
 * metacharacters in paths cannot change what runs. Windows command shims (.cmd, .bat) can only be
 * started through a shell, so they are refused rather than run; use `node <script>` or a real .exe.
 * ---------------------------------------------------------------------------------------------- */

const SHIM = /\.(cmd|bat)$/i;

/** Find an executable on PATH (and PATHEXT on Windows) without running anything. */
export function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const isWin = platform === 'win32';
  const exts = isWin ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasSep = /[\\/]/.test(name);
  const dirs = hasSep ? [''] : String(env.PATH ?? env.Path ?? '').split(isWin ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const base = hasSep ? name : path.join(dir.replace(/^"|"$/g, ''), name);
    const candidates = isWin && !path.extname(base) ? exts.map((e) => base + e.toLowerCase()) : [base];
    for (const c of isWin && path.extname(base) ? [base] : candidates) {
      try {
        if (fs.statSync(c).isFile()) return { path: c, shim: SHIM.test(c) };
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/**
 * Run argv without a shell. Returns {ok, status, stdout, stderr, timedOut, refused}.
 * `refused` explains why nothing was started (unresolvable command, or a Windows shim).
 */
export function runSafe(argv, { cwd, timeoutMs = 10000, env = process.env, input, inherit = false } = {}) {
  const [cmd, ...args] = argv;
  const found = path.isAbsolute(cmd) && !SHIM.test(cmd) && exists(cmd) ? { path: cmd, shim: false } : resolveExecutable(cmd, { env });
  if (!found) return { ok: false, status: null, stdout: '', stderr: '', timedOut: false, refused: 'not-found' };
  if (found.shim) return { ok: false, status: null, stdout: '', stderr: '', timedOut: false, refused: 'windows-shim' };
  const r = spawnSync(found.path, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    stdio: inherit ? 'inherit' : 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.error?.code === 'ETIMEDOUT',
    refused: r.error && r.error.code !== 'ETIMEDOUT' ? 'spawn-failed' : null,
  };
}
