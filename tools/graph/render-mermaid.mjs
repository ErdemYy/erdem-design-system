import { makeSafeIds } from './ids.mjs';
import { cmp } from '../lib/util.mjs';

/** Escape a label for use inside a double-quoted Mermaid string. */
export function mermaidLabel(text) {
  return String(text)
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;')
    .replace(/[\r\n]+/g, ' ');
}

function nodeLine(n, safe) {
  const label = mermaidLabel(n.kind === 'subsystem' ? `${n.label} (${n.count})` : n.label);
  if (n.kind === 'external') return `${safe}(["${label}"])`;
  if (n.kind === 'subsystem') return `${safe}[["${label}"]]`;
  return `${safe}["${label}"]`;
}

function edgeLine(e, from, to) {
  if (e.weight !== undefined) return `${from} -->|${e.weight}| ${to}`;
  switch (e.style) {
    case 'reexport':
      return `${from} ==> ${to}`;
    case 'dynamic':
      return `${from} -.-> ${to}`;
    case 'type':
      return `${from} -.->|type| ${to}`;
    case 'reference':
      return `${from} -.->|ref| ${to}`;
    default:
      return `${from} --> ${to}`;
  }
}

/** Render a view as a Mermaid `flowchart TD`. Node identifiers are hashes, never paths. */
export function renderMermaid(view) {
  const lines = [];
  lines.push(`%% project-intel graph view: ${view.title.replace(/[\r\n]+/g, ' ')}`);
  lines.push(`%% mode=${view.mode} level=${view.level} nodes=${view.nodes.length} edges=${view.edges.length}`);
  for (const note of view.notes) lines.push(`%% ${note.replace(/[\r\n]+/g, ' ')}`);
  lines.push('flowchart TD');

  if (view.nodes.length === 0) {
    lines.push('  empty["no nodes to show"]');
    lines.push('  classDef note stroke-dasharray:4 3;');
    lines.push('  class empty note;');
    return lines.join('\n') + '\n';
  }

  const ids = makeSafeIds(view.nodes.map((n) => n.id));
  const bySub = new Map();
  const loose = [];
  const subsystems = new Set(view.nodes.filter((n) => n.kind === 'file').map((n) => n.subsystem));
  const clusters = view.level === 'file' && subsystems.size >= 2;
  for (const n of view.nodes) {
    if (clusters && n.kind === 'file' && !n.outside) {
      if (!bySub.has(n.subsystem)) bySub.set(n.subsystem, []);
      bySub.get(n.subsystem).push(n);
    } else loose.push(n);
  }
  const subIds = makeSafeIds([...bySub.keys()], 'sg');
  for (const key of [...bySub.keys()].sort(cmp)) {
    lines.push(`  subgraph ${subIds.get(key)}["${mermaidLabel(key === '.' ? '(root)' : key)}"]`);
    for (const n of bySub.get(key)) lines.push(`    ${nodeLine(n, ids.get(n.id))}`);
    lines.push('  end');
  }
  for (const n of loose) lines.push(`  ${nodeLine(n, ids.get(n.id))}`);
  if (view.truncated) {
    lines.push(`  note_truncated["+${view.truncated.omitted} more ${view.truncated.unit} omitted: see graph.json"]`);
  }
  for (const e of view.edges) lines.push(`  ${edgeLine(e, ids.get(e.source), ids.get(e.target))}`);

  const cls = { surface: [], entry: [], external: [], target: [], outside: [] };
  for (const n of view.nodes) {
    const id = ids.get(n.id);
    if (n.kind === 'external') cls.external.push(id);
    if (n.target) cls.target.push(id);
    if (n.outside) cls.outside.push(id);
    if (n.publicSurface && n.kind !== 'external') cls.surface.push(id);
    if (n.entryPoint) cls.entry.push(id);
  }
  lines.push('  classDef surface stroke-width:3px;');
  lines.push('  classDef entry stroke-width:3px,stroke-dasharray:6 2;');
  lines.push('  classDef external stroke-dasharray:4 3;');
  lines.push('  classDef outside stroke-dasharray:2 2;');
  lines.push('  classDef target fill:#fff3b0,stroke:#555555;');
  lines.push('  classDef note stroke-dasharray:4 3;');
  for (const [name, list] of Object.entries(cls)) if (list.length) lines.push(`  class ${list.sort(cmp).join(',')} ${name};`);
  if (view.truncated) lines.push('  class note_truncated note;');
  return lines.join('\n') + '\n';
}
