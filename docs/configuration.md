# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `observational-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Pi reads settings from:

1. Global settings: `~/.pi/agent/settings.json`
2. Project settings: `<project>/.pi/settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "observational-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "compactAfterTokens": 81000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
		"reflectAfterObservationTokens": 2500,
		"reflectAfterObserverBatches": 2,
		"observerTimeoutMs": 180000,
		"reflectorTimeoutMs": 240000,
		"dropperTimeoutMs": 120000,
		"consolidationIdleDelayMs": 500,
		"consolidationCircuitBreakerFailures": 3,
		"consolidationCircuitBreakerMs": 900000,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

## Settings reference

| Setting | Type | Default | What it controls |
|---|---:|---:|---|
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Legacy raw/source safety threshold for reflector runs. |
| `reflectAfterObservationTokens` | positive integer | `2500` | Active observation-token delta since reflection that makes the reflector due. |
| `reflectAfterObserverBatches` | positive integer | `2` | Committed observer batches since reflection that make the reflector due. |
| `compactAfterTokens` | positive integer | `81000` | Raw/source token threshold for proactive auto-compaction. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Normal compaction-projection observation-token pressure that makes compaction do a full fold. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Folded active observation target used by post-reflection dropper maintenance. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, and dropper. |
| `observerTimeoutMs` | positive integer | `180000` | Observer stage deadline, including model resolution and provider queue wait. |
| `reflectorTimeoutMs` | positive integer | `240000` | Reflector stage deadline. |
| `dropperTimeoutMs` | positive integer | `120000` | Dropper stage deadline. |
| `consolidationIdleDelayMs` | positive integer | `500` | Delay after a successful `agent_end` before starting background work. |
| `consolidationCircuitBreakerFailures` | positive integer | `3` | Same-watermark failures before the stage circuit opens. |
| `consolidationCircuitBreakerMs` | positive integer | `900000` | Circuit-open duration. |
| `compactionWaitForConsolidationMs` | positive integer | `15000` | Fixed grace period for observer coverage recovery after an OM-owned proactive compaction is deferred. |
| `model` | object | unset | Optional model override for observer, reflector, and dropper. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer, reflector, and dropper progress notifications. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

`compactionWaitForConsolidationMs` starts when an OM-owned proactive compaction
is deferred for missing observer coverage. Ordinary proactive retries are
coalesced during that fixed window; new messages do not extend it. Observer
success retries immediately when Pi is idle. When the grace period expires, the
next idle retry fails open to Pi native compaction if coverage is still missing.
Native threshold/overflow compaction, passive mode, and explicit user compaction
are never held behind this grace period.

## `observeAfterTokens`

Default: `10000`.

The observer is scheduled only after a successful `agent_end` and the configured idle delay. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry. A deferred compaction can force an observer below the normal threshold when uncovered source entries would otherwise be removed.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer emits no observations, no ledger entry is written and the same range remains eligible for a later observer run.

## `reflectAfterTokens`

Default: `20000`.

Reflection normally becomes due from either `reflectAfterObservationTokens` or `reflectAfterObserverBatches`. `reflectAfterTokens` remains a raw/source safety clock for sessions whose observation metadata is sparse.

The dropper does not use `reflectAfterTokens`. It is an independent single-stage task that becomes due when committed reflections exist and the folded active observation ledger is over `observationsPoolTargetTokens`.

Lower values distill reflections more often and therefore create more opportunities for post-reflection dropper maintenance. Higher values reduce reflector model calls but leave more observations between reflection and dropper opportunities.

## `compactAfterTokens`

Default: `81000`.

The auto-compaction trigger runs from Pi's `agent_end` hook. It counts raw/source tokens after the latest compaction boundary. If the count reaches `compactAfterTokens`, the extension defers with `setTimeout(0)`, checks that Pi is idle, re-checks the threshold, and calls `ctx.compact()`.

This trigger does not wait for observer, reflector, or dropper work. Actual compaction summary creation happens later in `session_before_compact`, where V3 compaction is deterministic and model-free.

Pi's own window-pressure compaction and manual compaction can still happen independently of this proactive trigger.

## `observationsPoolMaxTokens`

Default: `20000`.

This controls V3's full-fold pressure. During compaction, the extension builds the normal compaction projection: observations whose `coversUpToId` reaches the compaction boundary, with reflection/drop effects held stable from the latest full fold. If there is no previous full fold, normal compaction includes observations only. If that projection's active observation tokens are at or above `observationsPoolMaxTokens`, compaction performs a full fold through the compaction boundary and applies observations, reflections, and drops by coverage marker. Otherwise, it keeps reflection/drop effects stable from the latest full fold and projects only observations through the new boundary.

This is not the active observation dropper target and not a scheduling threshold for the reflector. Use `observationsPoolTargetTokens` for dropper active observation maintenance and `reflectAfterTokens` for reflector cadence.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

This controls the folded active observation target used by the dropper. If folded active observation tokens are at or below this target, the dropper has no maintenance work. If they are over target, the dropper can run as a separate stage after at least one committed reflection is available.

With the defaults, `observationsPoolMaxTokens` is `20000` and `observationsPoolTargetTokens` is `10000`. If the active observation pool reaches about `20000` tokens, the dropper computes a maximum count intended to move it back toward about `10000` tokens, but the model may drop fewer or none.

When the dropper runs, it computes how many tokens are over target, converts that token excess to an approximate observation-count maximum using average active observation size, and passes that maximum to the model as a hard upper bound. The model may drop fewer or none, and code still rejects invalid or duplicate candidates.

Dropper input includes deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

This target does not affect compaction full-fold pressure. Visible compaction pressure remains based on `observationsPoolMaxTokens`.

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer, reflector, and dropper. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer, reflector, and dropper to use a cheaper or faster model than the main coding agent:

```json
{
  "observational-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. If no usable model or API key is available, the relevant background worker skips/fails safely rather than inventing memory.

## `showWorkerNotifications`

Default: `true`.

When `false`, the extension hides routine observer, reflector, and dropper progress notifications. Model fallback/unavailability, no-output warnings, worker failures, compaction notifications, and explicit `/om:*` command output remain visible.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om:status`, `/om:view`, and `recall` remain available.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper pass.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
|---|---|---|
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough proactive-compaction role. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3 calls the role the dropper. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "observational-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "observational-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Disable proactive work temporarily

```json
{
  "observational-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start and V2 migration summary.
