/**
 * The receiving side of a handoff (ai/CONTINUITY.md → Resume): given everything that was read, decide whether the next session may continue,
 * must reconcile first, or must stop. Pure: it decides, nothing is read here and nothing is written, run or replayed.
 *
 * The order is the protocol's: handoff present → integrity → task state → task identity → ownership → state agrees with the handoff →
 * receiver → drift → intelligence → validation. Anything ambiguous, conflicting or unverifiable stops; a handoff is a claim, never authority.
 *
 *   resume     consistent: ownership may be taken (with the user's yes naming this handoff)
 *   reconcile  the project moved since the handoff: continue only after the drift is dealt with or acknowledged by exact digest
 *   stop       cannot continue (never acknowledgeable)
 *   noop       this handoff was already accepted by this agent: nothing to do
 *   no-handoff there is none: continue from the task state and source (ai/SESSION_HANDOFF.md → missing handoff)
 */
import { createHash } from 'node:crypto';
import { ownershipOf } from './continuity-state.mjs';

const sha = (t) => createHash('sha256').update(t).digest('hex');

/**
 * @param {object} f
 * @param {string|null} f.agent                 who is asking (the would-be owner), or null for a read-only look
 * @param {object|null} f.state                 parseTaskState() of the state file, or null when there is none
 * @param {{present: boolean, parsed: object|null}} f.handoff   the handoff file and parseHandoff() of it
 * @param {{files: object[], config: object[], refs: object[]}} f.drift   per path: { path, status: unchanged|modified|deleted|reappeared|unverifiable }
 * @param {string|null} f.intelligence          the intelligence state now (current, stale, ...), or null when it was not checked
 * @param {boolean} f.accept                    ownership is being asked for
 * @param {string|null} f.confirm               the yes: the handoff id it names
 * @param {string|null} f.acknowledge           the drift digest the user accepted
 */
export function decideResume(f) {
  const stops = [];
  const reconcile = [];
  const notes = [];
  const stop = (code, note) => stops.push({ code, note });
  const out = (verdict, extra = {}) => {
    const digest = reconcile.length ? sha(JSON.stringify(reconcile.map((r) => [r.code, r.items ?? null]))).slice(0, 16) : null;
    const id = f.handoff?.parsed?.ok ? f.handoff.parsed.id : null;
    const missing = [];
    if (f.accept) {
      if (!f.agent) missing.push('owner');
      if (f.confirm !== id || !id) missing.push('confirmation');
      if (reconcile.length && f.acknowledge !== digest) missing.push('acknowledgement');
    }
    const allowed = !!f.accept && (verdict === 'resume' || verdict === 'reconcile') && missing.length === 0;
    return {
      verdict, stops, reconcile, notes, driftDigest: digest, handoffId: id,
      task: f.handoff?.parsed?.ok ? { id: f.handoff.parsed.record.task.id, status: f.handoff.parsed.record.task.status } : null,
      ownership: f.state ? ownershipOf(f.state) : null,
      accept: { requested: !!f.accept, allowed, missing: f.accept ? missing : [] },
      ...extra,
    };
  };

  const state = f.state;
  const cont = state?.continuity && !state.continuity.malformed ? state.continuity : null;

  // 1. is there a handoff
  if (!f.handoff?.present) {
    if (cont?.ownership === 'handoff-pending') stop('handoff-missing', 'the state waits on a handoff that is not there: the owner issues it again');
    else notes.push('no handoff: continue from TASK_STATE.md and source (ai/SESSION_HANDOFF.md)');
    return out(stops.length ? 'stop' : 'no-handoff');
  }
  // 2. integrity
  const p = f.handoff.parsed;
  if (!p?.ok) {
    stop(p?.code === 'not-canonical' ? 'handoff-not-canonical' : 'handoff-integrity', p?.code === 'not-canonical'
      ? 'not a handoff this tool issued: nothing here can be verified; follow ai/SESSION_HANDOFF.md by hand'
      : `the handoff failed its checks (${p?.code ?? 'unreadable'}${p?.field ? `, ${p.field}` : ''})`);
    return out('stop');
  }
  const r = p.record;
  // 3. task state and identity
  if (!state) {
    stop('state-missing', 'TASK_STATE.md is missing: the handoff cannot be tied to a task');
    return out('stop');
  }
  if (state.continuity?.malformed) {
    stop('state-continuity-malformed', 'the continuity block of TASK_STATE.md cannot be read');
    return out('stop');
  }
  if (!cont) {
    stop('task-identity', 'TASK_STATE.md carries no task identity: it is not the task this handoff came from');
    return out('stop');
  }
  if (cont.taskId !== r.task.id) {
    stop('task-identity', 'the handoff belongs to another task than TASK_STATE.md');
    return out('stop');
  }
  // 4. ownership
  if (cont.ownership === 'owned') {
    if (cont.transferred?.via === p.id) {
      if (f.agent && f.agent === state.owner) {
        notes.push('already accepted by this agent: nothing to do');
        return out('noop');
      }
      stop('ownership-conflict', 'this handoff was accepted by another owner');
      return out('stop');
    }
    stop('handoff-not-current', 'TASK_STATE.md is not waiting on this handoff');
    return out('stop');
  }
  if (cont.handoff !== p.id) stop('handoff-not-current', 'TASK_STATE.md waits on a different handoff: this one is superseded or not the issued one');
  if (!state.owner) stop('ownership-ambiguous', 'TASK_STATE.md has no owner while a handoff is pending');
  else if (state.owner !== r.from) stop('ownership-conflict', 'the owner of TASK_STATE.md is not the agent that issued this handoff');
  if (state.status === 'done') stop('task-completed', 'the task is completed: a transfer after completion is refused');
  // 5. the state agrees with what was handed over
  const contradictions = [];
  if (state.status !== r.task.status) contradictions.push('status');
  if (state.class !== r.task.class) contradictions.push('class');
  if (state.risk !== r.task.risk) contradictions.push('risk');
  if (state.goal !== r.task.goal) contradictions.push('goal');
  if (contradictions.length) stop('state-contradiction', `TASK_STATE.md no longer agrees with the handoff on: ${contradictions.join(', ')}`);
  const lv = state.lastValidation;
  const hv = r.validation;
  const sameValidation = (!lv && !hv) || (lv && hv && lv.depth === hv.depth && lv.planId === hv.plan && lv.status === hv.status && (lv.contentKey ?? null) === (hv.content ?? null));
  if (!sameValidation) stop('validation-contradiction', 'the validation recorded in TASK_STATE.md is not the one the handoff states');
  // 6. receiver
  if (f.agent && r.to !== 'any' && r.to !== f.agent) stop('receiver-mismatch', 'the handoff names another receiver');
  if (!f.agent) notes.push('no --owner given: a read-only look; ownership cannot be taken');
  if (stops.length) return out('stop');

  // 7. drift: what moved since the handoff
  const moved = (list) => list.filter((d) => d.status !== 'unchanged').map((d) => `${d.path}:${d.status}`).sort();
  const files = moved(f.drift?.files ?? []);
  const config = moved(f.drift?.config ?? []);
  // A derived index regenerated by a refresh is the deterministic output of the existing mechanism, not a change by anyone: when intelligence is current again the
  // index is trustworthy by the engine's own status check, so its new bytes are not drift. A deleted or unverifiable index, and every other reference, still are.
  const refsAll = f.drift?.refs ?? [];
  const refreshed = refsAll.filter((d) => d.kind === 'index' && d.status === 'modified' && f.intelligence === 'current');
  const refs = moved(refsAll.filter((d) => !refreshed.includes(d)));
  if (refreshed.length) notes.push('derived index refreshed since the handoff and intelligence is current: not drift');
  if (files.length) reconcile.push({ code: 'drift-files', note: 'files of the change moved since the handoff', items: files });
  if (config.length) reconcile.push({ code: 'drift-configuration', note: 'project configuration moved since the handoff', items: config });
  if (refs.length) reconcile.push({ code: 'drift-context', note: 'referenced context moved since the handoff', items: refs });
  // 8. intelligence: never claim a current context that is no longer current
  const now = f.intelligence ?? null;
  if (r.intelligence.reliedOn) {
    if (now === null) reconcile.push({ code: 'intelligence-unchecked', note: 'the handoff relies on intelligence that was not checked', items: [] });
    else if (now === 'missing' || now === 'unavailable') stop('context-unavailable', `the handoff relies on intelligence that is now ${now}`);
    else if (now !== 'current') reconcile.push({ code: 'intelligence-not-current', note: `the handoff relies on intelligence that is now ${now}: route it through the existing refresh decision`, items: [now] });
  } else if (now && now !== 'current') notes.push(`intelligence is ${now}: the handoff did not rely on it`);
  // 9. validation assumptions: a PASS belongs to the content it passed for; when the changed files moved, it is not current truth
  if (hv && hv.status === 'PASS') {
    if (files.length) reconcile.push({ code: 'validation-stale', note: 'the files changed since the recorded PASS: validation is required again (a resume does not run it)', items: [] });
  } else if (hv) notes.push(`validation at handoff: ${hv.status}: carried as open, not as passed`);
  if (stops.length) return out('stop');
  return out(reconcile.length ? 'reconcile' : 'resume');
}
