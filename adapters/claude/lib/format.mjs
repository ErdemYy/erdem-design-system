/**
 * The one line the SessionStart hook adds to Claude's context. Everything here comes from fixed vocabularies,
 * enumerated values and numbers: no free text from the repository is ever echoed (the output reaches the model).
 */
export const MAX_HOOK_LINE = 240;

export function hookLine(state) {
  const { system, intelligence, config } = state;
  if (intelligence.intelligence === 'missing' && !intelligence.verified) {
    if (config.hookWhenUnavailable === 'silent') return null;
    return `ERDEM: system=${system ? 'found' : 'missing'} intelligence=missing (no .ai/ index here; inspect source directly)`;
  }
  const v = intelligence.verified;
  const parts = [`system=${system ? 'found' : 'missing'}`];
  if (v) {
    // The canonical state is always shown as is; explanatory words may follow it, never replace it.
    const note = v.state === 'unverifiable' ? '(caution: provisional)' : '';
    parts.push(`intelligence=${v.state}${note}`, `graph=${String(v.graph ?? 'unknown').toLowerCase()}`);
  } else {
    const detail = [intelligence.profile, intelligence.age ? `${intelligence.age} old` : null].filter(Boolean).join(', ');
    const hint = intelligence.hint ? `, ${intelligence.hint.newer}${intelligence.hint.capped ? '+' : ''} files newer than index` : '';
    parts.push(`intelligence=${intelligence.intelligence}${detail || hint ? `(${detail}${hint})` : ''}`, `graph=${intelligence.graph}`);
  }
  parts.push(`task=${intelligence.task.present ? intelligence.task.status ?? 'present' : 'absent'}`);
  parts.push(`handoff=${intelligence.handoff.present ? 'present' : 'absent'}`);
  if (config.autoSessionHandoff) parts.push('handoff-on-finish');
  const tail = v ? '' : ' (unverified; /erdem context to check)';
  return `ERDEM: ${parts.join(' ')}${tail}`.slice(0, MAX_HOOK_LINE);
}
