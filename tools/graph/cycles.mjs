import { cmp } from '../lib/util.mjs';

/**
 * Strongly connected components with more than one member, plus self-dependencies (iterative Tarjan).
 * adjacency: Map<id, Iterable<id>>. Returns sorted arrays of sorted ids.
 */
export function findCycles(adjacency) {
  const ids = [...adjacency.keys()].sort(cmp);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;

  for (const start of ids) {
    if (index.has(start)) continue;
    const work = [{ id: start, it: [...(adjacency.get(start) ?? [])].sort(cmp)[Symbol.iterator]() }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const next = frame.it.next();
      if (!next.done) {
        const w = next.value;
        if (!adjacency.has(w)) continue;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, it: [...(adjacency.get(w) ?? [])].sort(cmp)[Symbol.iterator]() });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].id;
          low.set(parent, Math.min(low.get(parent), low.get(frame.id)));
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const comp = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.id);
          if (comp.length > 1) result.push(comp.sort(cmp));
          else if (new Set(adjacency.get(comp[0]) ?? []).has(comp[0])) result.push(comp);
        }
      }
    }
  }
  return result.sort((a, b) => cmp(a[0], b[0]));
}
