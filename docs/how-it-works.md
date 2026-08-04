# How it works

This is the V3 technical reference for `pi-observational-memory`.

V3 is ledger-centered: memory state is reconstructed by folding V3 ledger entries on the current branch. Compaction is model-free and renders a projection of that ledger into the summary the agent sees.

## Runtime entry points

`src/index.ts` registers one shared runtime and these Pi surfaces:

| Surface | Purpose |
|---|---|
| `agent_start` foreground gate | Abort background model work so it cannot compete with the active response. |
| `agent_settled` single-stage scheduler | After Pi finishes retry/compaction/continuation work and an idle delay, run at most one due observer, reflector, or dropper stage. |
| `agent_settled` compaction trigger | Maybe call `ctx.compact()` when idle and over `compactAfterTokens`. |
| `session_before_compact` hook | Build the V3 compaction payload deterministically. |
| `/om:status` | Show ledger counts, drift, progress clocks, and worker state. |
| `/om:recover` | Explicitly restart or wake an existing pending compaction recovery. |
| `/om:view` | Show visible or full memory content and attempt to copy the rendered memory text. |
| `recall` tool | Recover source evidence for a memory id. |

## Lifecycle overview

```mermaid
flowchart TD
    AS[agent_start]
    Settled[agent_settled]
    SBC[session_before_compact]

    Abort[Abort active background lease]
    Idle[Wait for idle delay]
    Due{Highest-priority stage due?}
    Observer[Observer<br/>commit observation checkpoint]
    Reflector[Reflector<br/>commit reflection checkpoint]
    Dropper[Dropper<br/>commit drop checkpoint]
    Backoff[Retry/backoff/circuit by watermark]

    CompactDue{raw tokens since compaction<br/>≥ compactAfterTokens<br/>and idle?}
    CompactCall[ctx.compact]
    Covered{Observer covers source prefix<br/>selected for removal?}
    Defer[Create or merge pending cut and force observer]
    Blocked[Strict recovery blocked<br/>raw history retained]
    Native[Pi native compaction fallback]

    Fold[fold/project V3 ledger]
    Render[render deterministic summary]
    Details[return om.folded details]

    AS --> Abort
    Settled --> Idle --> Due
    Due -- observer --> Observer --> Idle
    Due -- reflector --> Reflector --> Idle
    Due -- dropper --> Dropper --> Idle
    Observer -. failure .-> Backoff
    Reflector -. failure .-> Backoff
    Dropper -. failure .-> Backoff

    Settled --> CompactDue
    CompactDue -- yes --> CompactCall
    CompactCall --> SBC --> Covered
    Covered -- yes --> Fold --> Render --> Details
    Covered -- miss --> Defer --> Idle
    Defer -. fallback enabled effective budget .-> Native
    Defer -. strict effective budget or circuit .-> Blocked
```

The observer has priority, followed by reflector and dropper. Each stage commits separately;
later stages are discovered from the updated ledger on a new scheduler pass.

## Source entries and progress

V3 raw-token progress counts only source entries:

- `message`
- `custom_message`
- `branch_summary`

Memory ledger entries and compaction entries do not add raw-token progress.

Every V3 ledger entry has `data.coversUpToId`. That field is a progress and projection watermark. Worker clocks count raw/source tokens after the latest valid watermark for that worker's ledger type:

| Worker/trigger | Progress source |
|---|---|
| Observer | latest `om.observations.recorded.data.coversUpToId` |
| Reflector | latest `om.reflections.recorded.data.coversUpToId` |
| Dropper | latest `om.observations.dropped.data.coversUpToId` |
| Auto-compaction | latest compaction boundary |

The watermark is also used to decide whether a memory ledger entry belongs to a bounded projection. It is not provenance. Provenance lives in `sourceEntryIds` and `supportingObservationIds`.

## Ledger data shapes

### Observations recorded

```ts
customType: "om.observations.recorded"
data: {
  observations: Observation[];
  coversUpToId: string;
}
```

Each observation:

```ts
type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}
```

The builder rejects empty observation arrays, so no empty progress entries are written.

### Reflections recorded

```ts
customType: "om.reflections.recorded"
data: {
  reflections: Reflection[];
  coversUpToId: string;
}
```

Each reflection:

```ts
type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}
```

The reflector must cite valid active observation ids.

### Observations dropped

```ts
customType: "om.observations.dropped"
data: {
  observationIds: string[];
  coversUpToId: string;
}
```

Drops are tombstones. They remove ids from active observations but do not delete ledger history.

### Folded compaction details

```ts
details: {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

These details are what later visible projections read. The ledger remains the source of truth.

## Observer flow

The observer trigger is evaluated after `agent_settled` and the idle delay.

1. Load config if needed.
2. Skip if `passive` is true.
3. Skip if another consolidation stage is active or foreground work resumed.
4. Count raw/source tokens since latest observation coverage.
5. Skip if below `observeAfterTokens`.
6. Select source entries after the latest observation coverage marker.
7. Serialize those source entries for the observer prompt.
8. Resolve the memory model.
9. Acquire the shared background provider lease and run `runObserver()`.
10. Validate source ids returned by the model.
11. Compute deterministic 12-character ids and per-observation token counts in code.
12. Append `om.observations.recorded` only if at least one observation was accepted.

If no observations are generated, the worker normally writes no entry and does not advance coverage. When empty-coverage commit is enabled, a dedicated verifier may instead approve a covered-empty marker; otherwise a later eligible observer run sees a larger range.

## Reflect/drop flow

Reflector and dropper are independent single-stage tasks evaluated after observer priority.

1. Load config if needed.
2. Skip if `passive` is true.
3. Skip if another consolidation stage is active or foreground work resumed.
4. Reflector is due when observation-token delta, observer-batch count, or the raw safety clock reaches its configured threshold.
5. Fold current ledger state and run only the reflector. Append non-empty `om.reflections.recorded` with `coversUpToId` set to the latest observation coverage marker.
6. On the next scheduler pass, dropper is due only when committed reflections exist and the folded active observation pool exceeds `observationsPoolTargetTokens`.
7. Run only the dropper and append non-empty `om.observations.dropped` using committed observation and reflection coverage.

No-output and failures are retryable stage failures. They do not roll back prior checkpoints and do not cause the scheduler to spin on the same watermark.

When `pi-convergence` is active and observation work is due, observational memory uses
the neutral `pi-coordination:checkpoint-*` event protocol to reserve a stable ledger
prefix. The request binds the OM lifecycle generation, compaction boundary, immutable
target entry, and a coordinator-issued lease. Convergence holds new control messages
until the observer covers that target. Routine observation releases immediately after
the target is covered; strict recovery holds the lease through the successful
`session_compact` event so a continuation cannot interrupt the final force compaction.
User input or session/branch changes preempt the lease and abort background work without
discarding the strict pending target.

## Auto-compaction trigger

The auto-compaction trigger records the latest low-level outcome on `agent_end`
and runs on `agent_settled`, after automatic retry, automatic compaction/retry,
and queued continuations are exhausted.

It skips when:

- `passive` is true;
- compaction is already in flight;
- raw/source tokens since last compaction are below `compactAfterTokens`;
- Pi is not idle after the deferred check;
- the threshold is no longer met after the deferred check.

When all checks pass, it calls `ctx.compact()`.

This trigger does not wait for reflector or dropper. The compaction hook requires only enough observer coverage to preserve source entries that will be removed.

## Compaction hook

The compaction hook runs on `session_before_compact` and is the critical V3 latency path.

It does only deterministic work:

1. Guard against duplicate concurrent compaction hooks.
2. Load config if needed.
3. Read the current branch and `event.preparation.firstKeptEntryId`.
4. Verify that committed observation coverage includes every source entry before the cut.
5. If coverage is missing, create or merge a boundary-scoped pending target for
   proactive, manual, threshold, or overflow compaction.
6. Recovery bypasses the ordinary observation threshold. After every bounded
   observer batch it verifies the pending cut; partial success remains waiting.
7. When coverage is complete and Pi is idle, retry compaction even when raw
   tokens are below the automatic compaction threshold.
8. With native fallback enabled, the existing fail-open recovery-budget behavior is
   preserved for the proactive trigger, while native manual/threshold/overflow
   gaps fail open immediately. With fallback disabled, all four origins use
   strict recovery; effective-budget exhaustion or circuit failure becomes `blocked`, preserves raw
   history, and stops automatic retries. Strict recovery never substitutes the
   active session model for an unavailable configured memory model.
9. If coverage is sufficient, abort stale background work and build the projection immediately.
10. Render and return `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` where `details.type` is `om.folded`.

It does not:

- call a model;
- run a sync observer;
- run reflector/dropper;
- wait for worker promises;
- append ledger entries.

If another compaction hook is already in flight, it returns `{ cancel: true }`.

## Projections

V3 uses projection helpers so commands, compaction, and recall do not each invent their own truth.

### Full projection

Full projection folds valid V3 observations, reflections, and drops from branch root through the requested boundary. Memory entries are included by resolving their `data.coversUpToId` marker against the boundary, not by the physical position of the `om.*` custom entry. Old V2 entries/details, invalid V3-shaped entries, and dangling coverage markers are ignored.

### Visible projection

Visible projection without a boundary reads the latest V3 `om.folded` compaction details. This is what the agent currently sees.

### Compaction projection

When compaction runs, the projection helper decides whether this compaction is a full fold. It first builds the normal compaction projection: observations whose `coversUpToId` reaches `firstKeptEntryId`, with reflection/drop effects held stable from the latest full-fold boundary. If there is no previous full-fold boundary, normal compaction includes observations only and excludes reflections/drops. It sums that projection's active observation `tokenCount`; if the total is at or above `observationsPoolMaxTokens`, it performs a full fold through `firstKeptEntryId`, applying observations, reflections, and drops by coverage marker. Otherwise, it keeps the normal projection.

### Diff projection

Diff projection compares visible memory with full memory. `/om:status` uses this to show recorded-vs-visible drift. `/om:status` also reports the visible observation pool separately from the folded active observation pool because compaction pressure and dropper maintenance intentionally use different projections and thresholds.

## Summary rendering

The renderer returns an empty string when there are no visible observations or reflections. Otherwise it starts with deterministic usage instructions that tell the agent how to treat the memory, how to handle conflicts, and when to use `recall` for exact source context. It then renders reflection and observation sections when those entries exist:

```md
These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.

## Reflections
[id] durable reflection

## Observations
[id] YYYY-MM-DD HH:MM [relevance] timestamped observation
```

The renderer is deterministic. It does not call a model and does not rewrite memory content.

## Commands

### `/om:status`

Shows:

- recorded/dropped/visible observation counts, with plain `+N` / `-N` visible-vs-full drift suffixes when drift exists;
- recorded/visible reflection counts, with a plain `+N` drift suffix when full memory has extra reflections;
- next observation/reflection/compaction token progress and drop coverage since the last successful drop;
- visible observation pool pressure against `observationsPoolMaxTokens` from the current compaction projection;
- active observation pool pressure against `observationsPoolTargetTokens` from folded active observations;
- dropper state explaining whether the active pool is under target or waiting for the next successful reflection;
- reflection pool token total;
- passive mode;
- worker in-flight flags;
- last observer and reflect/drop errors.

Blocked compaction recovery also shows its origin, cut, boundary, last error,
and the `/om:recover` action.

### `/om:recover`

Restarts or wakes only the existing recovery target on the current lifecycle
and compaction boundary. It does not infer a new cut, change fallback policy, or
call native compaction directly.

### `/om:view`

Default mode shows visible memory and attempts to copy the rendered memory text to the clipboard. If no V3 compaction has happened yet, visible memory can be empty because nothing has been folded into `om.folded` details; use `/om:view full` to inspect recorded branch memory before the first compaction.

Clipboard copy uses platform clipboard commands (`pbcopy`, `clip`, `wl-copy`, `xclip`, `xsel`, or `termux-clipboard-set`). If copying succeeds, Pi shows `Copied /om:view output to clipboard.` If copying fails, the command still prints the memory view and shows a warning. The clipboard text is only the rendered memory content; it does not include the success/failure line.

### `/om:view full`

Shows full V3 ledger truth at branch tip and attempts to copy the rendered memory text to the clipboard using the same success/failure behavior as default `/om:view`.

## Recall flow

The agent-facing `recall` tool accepts a 12-character lowercase hex id.

1. Validate id shape.
2. Read the current branch.
3. Index V3 observations, reflections, and drops from ledger history.
4. Match the id against observations and reflections.
5. For observations, mark status as `active` or `dropped`.
6. Resolve observation source entries from `sourceEntryIds`.
7. For reflections, resolve supporting observations and their sources.
8. Return exact evidence plus diagnostics for missing/non-source entries.

Recall ignores old V2 memory by construction because it indexes only V3 ledger entry types.

## Error and race handling

- Worker in-flight flags prevent duplicate observer or reflect/drop runs.
- Observer priority prevents reflect/drop from advancing while source text is due for observation.
- No-output workers append no empty ledger entries.
- Invalid source/support/drop ids are filtered or rejected by code.
- Background worker errors are recorded on runtime state and surfaced in `/om:status`.
- Compaction does not wait for background workers; it folds whatever ledger state is already present.
- Historical or invalid coverage markers are tolerated by progress helpers instead of throwing.

## V2 behavior

V3 does not use V2 state shapes. Old V2 custom memory entries, old V2 compaction details, and old V2 config keys are ignored. Existing old visible compaction text in a continued session may remain visible until a V3 compaction replaces it. The recommended upgrade path is to update settings and start a new clean session.

## Invariants

- The branch-local V3 ledger is the memory source of truth.
- Pi compaction summaries represent what the agent sees.
- Compaction is deterministic and model-free.
- Observer input is raw/source entries only.
- `coversUpToId` is a progress/projection watermark, not provenance.
- Kept observations and reflections are rendered without paraphrase.
- Dropped observations remain recallable from ledger history.
- Old V2 memory is ignored rather than migrated.
