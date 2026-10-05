import { createHash } from 'node:crypto';
import { HASH_ALGO, NORMALIZATION } from './constants.mjs';
import { cmp } from './util.mjs';

/**
 * Fingerprint strategy (schema v1):
 * - algorithm: SHA-256, recorded in every fingerprint;
 * - text files: UTF-8 BOM removed and CRLF converted to LF before hashing, so checkout settings do not change identity;
 * - binary files (NUL byte in the first 8000 bytes): raw bytes;
 * - the hash is authoritative for content identity; size and mtime are cheap pre-checks only.
 */

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function normalizeText(buf) {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  let hasCr = false;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) return start === 0 ? buf : buf.subarray(start);
  const out = Buffer.allocUnsafe(buf.length - start);
  let j = 0;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

export function hashContent(buf) {
  const binary = looksBinary(buf);
  const data = binary ? buf : normalizeText(buf);
  return {
    hash: createHash(HASH_ALGO).update(data).digest('hex'),
    normalization: binary ? NORMALIZATION.binary : NORMALIZATION.text,
  };
}

export function makeFingerprint({ hash, normalization, size, mtime, reason }) {
  const fp = { algo: HASH_ALGO, hash: hash ?? null, size, normalization: normalization ?? null };
  if (mtime) fp.mtime = mtime;
  if (!hash && reason) fp.reason = reason;
  return fp;
}

/** The part of a fingerprint stored inside graph nodes (no timestamps). */
export function fingerprintRef(fp) {
  if (!fp) return null;
  const ref = { algo: fp.algo, hash: fp.hash, size: fp.size, normalization: fp.normalization };
  if (!fp.hash && fp.reason) ref.reason = fp.reason;
  return ref;
}

/**
 * Fingerprint of a set of files: SHA-256 over sorted "path\0hash\n" lines.
 * Unverifiable (null hash) when any member lacks a hash.
 */
export function setFingerprint(members) {
  const sorted = [...members].sort((a, b) => cmp(a.path, b.path));
  const unverifiable = sorted.some((m) => !m.hash);
  const base = { algo: HASH_ALGO, count: sorted.length, normalization: 'set-path-hash-v1' };
  if (unverifiable) return { ...base, hash: null, reason: 'member-unverifiable' };
  const h = createHash(HASH_ALGO);
  for (const m of sorted) h.update(`${m.path}\0${m.hash}\n`);
  return { ...base, hash: h.digest('hex') };
}
