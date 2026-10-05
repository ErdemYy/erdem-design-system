import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Forward slashes work for node, bash, cmd and PowerShell alike; use them in generated command strings. */
export const fwd = (p) => String(p).replace(/\\/g, '/');

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read at most `bytes` from the start of a file (front matter probes never read a whole file). */
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
    return { exists: true, data: JSON.parse(text.replace(/^﻿/, '')), error: null, raw: text };
  } catch (e) {
    return { exists: true, data: null, error: e.message, raw: text };
  }
}

/** Write via a temporary file and rename, so an interrupted write never leaves a half-written config. */
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.erdem-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Keep only a short, plain token from untrusted file content (hook output reaches the model). */
export function safeToken(value, pattern, max = 24) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length > 0 && v.length <= max && pattern.test(v) ? v : null;
}

function unquote(v) {
  return v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) ? v.slice(1, -1) : v;
}

export function parseFrontMatter(text) {
  if (!text) return {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = unquote(line.slice(i + 1).trim());
  }
  return out;
}

export function isoToAgeLabel(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Split a command string into argv, honoring simple single and double quotes. */
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
