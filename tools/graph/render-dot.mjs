import { makeSafeIds } from './ids.mjs';
import { cmp } from '../lib/util.mjs';

/** Escape text for a double-quoted DOT string. */
export function dotString(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

function nodeAttrs(n) {
  const attrs = [`label="${dotString(n.kind === 'subsystem' ? `${n.label} (${n.count})` : n.label)}"`];
  const styles = [];
  if (n.kind === 'external') {
    attrs.push('shape=ellipse');
    styles.push('dashed');
  } else if (n.kind === 'subsystem') attrs.push('shape=folder');
  if (n.publicSurface && n.kind !== 'external') attrs.push('peripheries=2');
  if (n.entryPoint) styles.push('bold');
  if (n.outside) styles.push('dashed');
  if (n.target) {
    styles.push('filled');
    attrs.push('fillcolor="#fff3b0"');
  }
  if (styles.length) attrs.push(`style="${[...new Set(styles)].join(',')}"`);
  return attrs.join(', ');
}

function edgeAttrs(e) {
  if (e.weight !== undefined) return ` [label="${e.weight}"]`;
  switch (e.style) {
    case 'reexport':
      return ' [penwidth=2]';
    case 'dynamic':
      return ' [style=dashed]';
    case 'type':
      return ' [style=dashed, label="type"]';
    case 'reference':
      return ' [style=dotted, label="ref"]';
    default:
      return '';
  }
}

/** Render a view as Graphviz DOT. Valid without Graphviz installed; identifiers are hashes, never paths. */
export function renderDot(view) {
  const ids = makeSafeIds(view.nodes.map((n) => n.id));
  const lines = [];
  lines.push(`digraph "project_intel" {`);
  lines.push(`  graph [rankdir=LR, fontname="Helvetica", labelloc=t, label="${dotString(view.title)}"];`);
  lines.push('  node [shape=box, fontname="Helvetica", fontsize=10];');
  lines.push('  edge [fontname="Helvetica", fontsize=9];');
  for (const note of view.notes) lines.push(`  // ${note.replace(/[\r\n]+/g, ' ')}`);

  const subsystems = new Set(view.nodes.filter((n) => n.kind === 'file').map((n) => n.subsystem));
  const clusters = view.level === 'file' && subsystems.size >= 2;
  const bySub = new Map();
  const loose = [];
  for (const n of view.nodes) {
    if (clusters && n.kind === 'file' && !n.outside) {
      if (!bySub.has(n.subsystem)) bySub.set(n.subsystem, []);
      bySub.get(n.subsystem).push(n);
    } else loose.push(n);
  }
  const subIds = makeSafeIds([...bySub.keys()], 'cluster_');
  for (const key of [...bySub.keys()].sort(cmp)) {
    lines.push(`  subgraph ${subIds.get(key)} {`);
    lines.push(`    label="${dotString(key === '.' ? '(root)' : key)}"; style=rounded;`);
    for (const n of bySub.get(key)) lines.push(`    ${ids.get(n.id)} [${nodeAttrs(n)}];`);
    lines.push('  }');
  }
  for (const n of loose) lines.push(`  ${ids.get(n.id)} [${nodeAttrs(n)}];`);
  if (view.truncated) {
    lines.push(`  note_truncated [shape=note, label="+${view.truncated.omitted} more ${view.truncated.unit} omitted: see graph.json"];`);
  }
  for (const e of view.edges) lines.push(`  ${ids.get(e.source)} -> ${ids.get(e.target)}${edgeAttrs(e)};`);
  lines.push('}');
  return lines.join('\n') + '\n';
}
