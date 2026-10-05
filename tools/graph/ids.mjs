import { createHash } from 'node:crypto';
import { cmp } from '../lib/util.mjs';

/**
 * Stable, safe identifiers for diagram formats: a letter prefix plus a short hash of the node id.
 * Raw file paths never appear in identifiers. The hash is lengthened until the ids in a view are unique.
 */
export function makeSafeIds(ids, prefix = 'n') {
  const sorted = [...new Set(ids)].sort(cmp);
  const hashes = new Map(sorted.map((id) => [id, createHash('sha1').update(id).digest('hex')]));
  for (let len = 8; len <= 40; len += 4) {
    const seen = new Set();
    let ok = true;
    for (const id of sorted) {
      const s = hashes.get(id).slice(0, len);
      if (seen.has(s)) {
        ok = false;
        break;
      }
      seen.add(s);
    }
    if (ok) return new Map(sorted.map((id) => [id, `${prefix}${hashes.get(id).slice(0, len)}`]));
  }
  return new Map(sorted.map((id) => [id, `${prefix}${hashes.get(id)}`]));
}
