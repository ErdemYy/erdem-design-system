# Session Continuity

How work survives the end of a session and moves between agents. This document defines continuity once, for every agent and every direction. It adds no state store and no event: it fixes the responsibilities of the artifacts that already exist (`SESSION_HANDOFF.md`), the ownership rules, and the checks a receiver makes before it continues. Triggers and levels are the contract's (`AUTOMATION_PROTOCOL.md`); the reference implementation is `tools/automation/` (`project-intel handoff`, `tools/automation/README.md`).

A handoff is a claim, not a fact. A receiver never trusts the previous session: it verifies, reconstructs the minimum context, takes ownership explicitly, and only then continues. Where the state is ambiguous, conflicting or unverifiable it stops. Correctness before convenience.

## Two artifacts, two jobs

| | `TASK_STATE.md` | `HANDOFF.md` |
|---|---|---|
| Role | the current, mutable, authoritative state of the task: what is true now | an immutable snapshot for the next session or agent: what it needs to know |
| Writer | the current owner only (single writer) | its issuer, once; never edited afterwards |
| Lifetime | one per task; replaced when the task ends | one per transfer; the latest is the one the state waits on; older ones are superseded, linked by id and not copied |
| When | at milestones, and when validation completes | only when a real continuity need exists |

A handoff never replaces the state and never becomes a second source of truth. There is no second task state, no agent-specific state and no copy of derived intelligence inside a handoff: it points to canonical artifacts.

## Ownership

An active task has at most one owner: the `owner` of `TASK_STATE.md`. The state also carries one generated block, `## Continuity` (between two comment markers; the only thing continuity writes into the state besides `updatedAt` and, on acceptance, `owner`): the task's identity, whether a handoff is pending, which handoff, for whom, and the last transfer.

The words, derived from that one state and never stored twice:

| Word | Holds when |
|---|---|
| unowned | the state has no owner: ownership is taken first |
| owned | an owner exists and nothing is pending |
| handoff-pending | a handoff was issued and not yet accepted; the issuer stays the single writer until it is |
| transferred | the owner is the agent that accepted the last handoff |
| blocked | the task status is blocked (the state is authoritative; the handoff explains) |
| completed | the task status is done |

**Transfer is explicit.** Reading a task or a handoff grants no ownership. Issuing a handoff to a named receiver does not transfer anything: it makes the handoff pending. Ownership changes only when the receiver accepts, with an explicit yes that names that handoff (A2, `AUTOMATION_PROTOCOL.md`), after the checks below pass. The acceptance records the previous owner, the new owner, the handoff identity, the time and any drift that was acknowledged. A document that exists is never authority.

## Triggers

A handoff is issued when there is a real continuity need and no other time: the session ends with unfinished work; ownership is being transferred; the task is blocked and another session or agent, or a person, is needed; the context is too large to continue safely; the user asks. Not for a completed task (the state with status done is enough, except an explicit follow-up), not for a task that was not started, not for a pause within a continuing session, not per tool call or per context expansion. The state is updated first (a blocked handoff needs a blocked state that says what it waits on); the handoff follows.

## What a handoff holds

The task identity and goal, the issuer, the receiver (or any), the reason, the status, class and risk, an objective, what is completed, what is active, the blockers, one next action, the decisions only a person can make, the validation state and its caveats, the changed files with the fingerprint each had (carried whole, in ordered batches each bound by a digest, so a missing or altered batch invalidates the handoff and a receiver knows whether every batch is present), the project configuration manifests with theirs, the intelligence state and whether the handoff relies on it, the context level reached and the context it points to (path and fingerprint, never content), and the link to the previous handoff.

It never holds conversation, source text, logs, graph data, secrets, environment values, credentials or commands. Every field is one line of plain text, validated when written and again when read back, because a handoff found in a repository is untrusted input. A field that contains a secret, an environment assignment, a command or a structure marker is refused, not redacted; a path that matches a secret pattern is not named. Security-sensitive things are referred to by their canonical artifact, never copied.

## Identity and integrity

The identity is a SHA-256 over every semantic field: task, state, owner, receiver, reason, objective, completed and active work, blockers, next action, decisions, caveats, the referenced files, configuration and context with their fingerprints, intelligence, validation and the previous handoff. Only the creation time is left out. Changing what is transferred changes the identity. The readable text must equal what the canonical record renders to, so no sentence can say what the record does not. The identity is integrity, not authentication: the state records which identity it waits on, and a different, even self-consistent, handoff is not the one it waits on.

## Resume

SESSION_START → locate the state and the latest handoff → verify, in this order, and stop at the first stop:

1. the handoff exists and passes its integrity checks (a handoff that was not issued by the tool cannot be verified: follow `SESSION_HANDOFF.md` by hand);
2. the state exists and carries the task identity, and it is the task of the handoff;
3. ownership: the state waits on exactly this handoff, its owner is the issuer, the task is not completed, and the asking agent is the named receiver (or any);
4. the state still agrees with what was handed over: status, class, risk, goal and the recorded validation;
5. drift: the changed files, the configuration manifests and the referenced context still have the fingerprints the handoff recorded (modified, deleted, reappeared, added or unverifiable is drift); the intelligence state now, using the existing states (current, stale, unverifiable, partial, missing, unavailable): a handoff that relies on intelligence is never allowed to claim a context that is no longer current; a validation PASS is current truth only while the files it covered are unchanged.

The result is one of **resume** (consistent), **reconcile** (the project moved: continue only after the drift is dealt with, or acknowledged by the exact digest of what moved), **stop** (never acknowledged away), **no handoff** (continue from the state and source) or **noop** (this agent already accepted this handoff).

Context is rebuilt through the existing router, one level at a time: the receiver reads the state and the handoff (level 0); the handoff level is the minimum already known, not a jump; the router decides the next level. The receiver deepens only when the task requires it, a sufficiency check fails, drift invalidated an assumption, or the router says so. A resume does not rebuild the index, does not run a validation and does not replay a command: it reconstructs context and ownership. Where a validation or a refresh is needed, the existing rules (and their A2 and A3 limits) decide, as for any other action.

Stop conditions: the handoff or the state is invalid, the task identity is ambiguous, ownership conflicts or is ambiguous, the task is completed, the state contradicts the handoff, relied-on intelligence is missing or unavailable, or a security-sensitive assumption cannot be verified.

## Idempotency

Presenting the same handoff twice changes nothing: issuing an unchanged transfer is a noop, repeating a verification writes nothing, and a second acceptance by the same agent is a noop (no second transition, not even a new timestamp). A different agent presenting an accepted handoff is a conflict. Nothing is replayed, revalidated or rerun because a handoff was consumed again.

## Failure modes

| Situation | Behavior |
|---|---|
| issuing for a task that does not need it | not required; nothing is written |
| issuing while not the owner, or for an unowned task | refused: ask the owner, or take ownership first |
| a field would hold a secret, an environment value, a command or a structure marker | refused, nothing written, the content is not echoed |
| a handoff the tool did not issue is already in place | refused: it is not overwritten |
| the state is written and the handoff is not (a partial write) | the state waits on a handoff that is not there: stop; issuing again repairs it |
| no handoff | continue from the state and source |
| the owner stopped writing while a handoff is pending | the receiver may accept; the owner must not write again |
| two agents accept the same handoff at once | exactly one is told it has the task; the other is told it lost (`ownership-conflict`, or `noop` for the same agent) and writes nothing: the state is re-read under a short-lived lock before it is written. A person editing the file by hand is not covered: single-writer remains the protocol |
| a derived index was regenerated by a refresh | not drift while intelligence is current again; a deleted index, or an index while intelligence is not current, still is |

## Levels

Issuing a handoff, checking one and reading the state are A1. Taking ownership is A2: it needs a yes that names the handoff, and, when something moved, the digest of what moved. Nothing here lowers an A2 or an A3, and nothing here lets a receiver gain authority from a document: a handoff carries validation caveats, never authorizations.
