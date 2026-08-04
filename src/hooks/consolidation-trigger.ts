import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import {
	estimateObserverPromptTokens,
	estimateObserverPromptTokensForChunkCharacters,
	runCoverageVerifier,
	runObserver,
	type CoverageVerifierRunResult,
	type ObserverRunResult,
	type ObserverRunStats,
} from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { getBackgroundBroker, withBackgroundLease } from "../background-broker.js";
import type { ConfiguredModel } from "../config.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { type ConsolidationPhase, type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import { estimateStringTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationCoverageIncludesCompactionPrefix,
	observationToSummaryLine,
	observationTokensSinceReflectionCoverage,
	observerBatchesSinceReflectionCoverage,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
} from "../session-ledger/index.js";
import {
	OM_COMPACTION_CLEARED_EVENT,
	OM_COMPACTION_DEFERRED_EVENT,
	OM_COMPACTION_RECOVERY_REQUESTED_EVENT,
} from "./compaction-events.js";
import {
	CHECKPOINT_CANCEL_EVENT,
	CHECKPOINT_FINISH_EVENT,
	CHECKPOINT_GRANT_EVENT,
	CHECKPOINT_RELEASE_EVENT,
	CHECKPOINT_REQUEST_EVENT,
	isCheckpointGrant,
	isCheckpointRelease,
	type CheckpointFinishOutcome,
	type CheckpointFinishReason,
	type CheckpointGrantV1,
	type CheckpointRequestV1,
} from "./checkpoint-events.js";
import { requestCompaction } from "./compaction-trigger.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	compact?: (options: unknown) => void;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
	};
};

type ConsolidationRun = {
	generation: number;
	signal: AbortSignal;
	sessionId?: string;
};

type DueStage = {
	phase: ConsolidationPhase;
	watermark: string;
};

function stagePriority(phase: ConsolidationPhase, runtime: Runtime): number {
	if (phase === "observer") return isCoverageRecoveryWaiting(runtime) ? 350 : 200;
	if (phase === "reflector") return 100;
	return 50;
}

function isCoverageRecoveryWaiting(runtime: Runtime): boolean {
	const pending = runtime.pendingCompaction;
	return !!pending
		&& pending.lifecycleGeneration === runtime.lifecycleGeneration
		&& pending.state === "waiting_coverage";
}

function isStrictRecovery(runtime: Runtime): boolean {
	return runtime.pendingCompaction?.strict === true
		|| runtime.config.allowNativeCompactionFallback === false;
}

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

const OBSERVER_BUDGET_SAFETY_FACTOR = 0.9;

export type ObserverChunkSelection = {
	chunk: string;
	allowedSourceEntryIds: string[];
	coversUpToId?: string;
	sourceEntryCount: number;
	overlapEntryCount: number;
	promptSourceEntryCount: number;
	estimatedPromptTokens: number;
	priorMemoryTokens: number;
	configuredBudget: number;
	budget: number;
	outputReserveTokens: number;
	budgetExhaustedByPriorMemory: boolean;
	oversizedEntry: boolean;
	oversizedEntryTokens?: number;
};

/**
 * Select the oldest uncovered source prefix for one observer request. Bounded
 * mode budgets the complete estimated prompt plus output allowance against 90%
 * of the configured limit; the margin absorbs tokenizer/model accounting error.
 */
export function selectObserverChunk(args: {
	entries: Entry[];
	priorReflections: string[];
	priorObservations: string[];
	maxTokens: number;
	overlapEntries: number;
	outputReserveTokens: number;
	emptyCoverageCommit?: boolean;
}): ObserverChunkSelection {
	const configuredBudget = Number.isFinite(args.maxTokens) && args.maxTokens > 0
		? Math.floor(args.maxTokens)
		: 0;
	const outputReserveTokens = Number.isFinite(args.outputReserveTokens) && args.outputReserveTokens > 0
		? Math.floor(args.outputReserveTokens)
		: 0;
	const overlapEntries = Number.isFinite(args.overlapEntries) && args.overlapEntries > 0
		? Math.floor(args.overlapEntries)
		: 0;

	if (configuredBudget === 0) {
		const serialized = serializeSourceAddressedBranchEntries(args.entries);
		const estimate = estimateObserverPromptTokens({
			priorReflections: args.priorReflections,
			priorObservations: args.priorObservations,
			chunk: serialized.text,
			emptyCoverageCommit: args.emptyCoverageCommit,
		});
		return {
			chunk: serialized.text,
			allowedSourceEntryIds: serialized.sourceEntryIds,
			coversUpToId: args.entries.at(-1)?.id,
			sourceEntryCount: serialized.sourceEntryIds.length,
			overlapEntryCount: 0,
			promptSourceEntryCount: serialized.sourceEntryIds.length,
			estimatedPromptTokens: estimate.promptTokens,
			priorMemoryTokens: estimate.priorMemoryTokens,
			configuredBudget: 0,
			budget: 0,
			outputReserveTokens,
			budgetExhaustedByPriorMemory: false,
			oversizedEntry: false,
		};
	}

	const units = args.entries.flatMap((entry) => {
		const serialized = serializeSourceAddressedBranchEntries([entry]);
		const id = serialized.sourceEntryIds[0];
		return id && serialized.text.trim() ? [{ id, text: serialized.text }] : [];
	});
	const budget = Math.max(1, Math.floor(configuredBudget * OBSERVER_BUDGET_SAFETY_FACTOR));
	const overlapMarker = "[READ-ONLY OVERLAP CONTEXT — do not record observations from these entries]";
	const prefixCharacterCounts = [0];
	for (const unit of units) {
		const separatorCharacters = prefixCharacterCounts.length > 1 ? 2 : 0;
		prefixCharacterCounts.push(prefixCharacterCounts.at(-1)! + separatorCharacters + unit.text.length);
	}
	const estimateChunk = (sourceCount: number, promptCount = sourceCount) => {
		const overlapMarkerCharacters = promptCount > sourceCount ? overlapMarker.length + 1 : 0;
		return estimateObserverPromptTokensForChunkCharacters({
			priorReflections: args.priorReflections,
			priorObservations: args.priorObservations,
			chunkCharacters: prefixCharacterCounts[promptCount] + overlapMarkerCharacters,
			emptyCoverageCommit: args.emptyCoverageCommit,
		});
	};
	const buildChunk = (sourceCount: number, promptCount: number): string => {
		const sourceChunk = units.slice(0, sourceCount).map((unit) => unit.text).join("\n\n");
		const overlapChunk = units.slice(sourceCount, promptCount).map((unit) => unit.text).join("\n\n");
		return overlapChunk ? `${sourceChunk}\n\n${overlapMarker}\n${overlapChunk}` : sourceChunk;
	};
	const emptyEstimate = estimateChunk(0);
	const budgetExhaustedByPriorMemory = emptyEstimate.promptTokens + outputReserveTokens > budget;
	if (units.length === 0) {
		return {
			chunk: "",
			allowedSourceEntryIds: [],
			sourceEntryCount: 0,
			overlapEntryCount: 0,
			promptSourceEntryCount: 0,
			estimatedPromptTokens: emptyEstimate.promptTokens,
			priorMemoryTokens: emptyEstimate.priorMemoryTokens,
			configuredBudget,
			budget,
			outputReserveTokens,
			budgetExhaustedByPriorMemory,
			oversizedEntry: false,
		};
	}

	const firstEstimate = estimateChunk(1);
	const firstEntryTokens = estimateStringTokens(units[0].text);
	const oversizedEntry = firstEntryTokens > budget
		|| (!budgetExhaustedByPriorMemory && firstEstimate.promptTokens + outputReserveTokens > budget);
	let sourceEntryCount = 0;
	let promptEntryCount = 0;

	if (budgetExhaustedByPriorMemory || oversizedEntry) {
		// There is no smaller source unit to submit. Force one entry so batching
		// cannot stall in an infinite shrink loop; diagnostics expose the breach.
		sourceEntryCount = 1;
		promptEntryCount = 1;
	} else {
		for (let candidateSourceCount = 1; candidateSourceCount <= units.length; candidateSourceCount++) {
			const candidatePromptCount = Math.min(units.length, candidateSourceCount + overlapEntries);
			const candidate = estimateChunk(candidateSourceCount, candidatePromptCount);
			if (candidate.promptTokens + outputReserveTokens <= budget) {
				sourceEntryCount = candidateSourceCount;
				promptEntryCount = candidatePromptCount;
			}
		}

		if (sourceEntryCount === 0) {
			// Requested overlap did not fit, but the first source entry does. Keep
			// the oldest prefix and append only the overlap entries that still fit.
			sourceEntryCount = 1;
			promptEntryCount = 1;
			while (promptEntryCount < Math.min(units.length, 1 + overlapEntries)) {
				const candidate = estimateChunk(sourceEntryCount, promptEntryCount + 1);
				if (candidate.promptTokens + outputReserveTokens > budget) break;
				promptEntryCount++;
			}
		}
	}

	const selected = estimateChunk(sourceEntryCount, promptEntryCount);
	return {
		chunk: buildChunk(sourceEntryCount, promptEntryCount),
		allowedSourceEntryIds: units.slice(0, sourceEntryCount).map((unit) => unit.id),
		coversUpToId: units[sourceEntryCount - 1]?.id,
		sourceEntryCount,
		overlapEntryCount: promptEntryCount - sourceEntryCount,
		promptSourceEntryCount: promptEntryCount,
		estimatedPromptTokens: selected.promptTokens,
		priorMemoryTokens: selected.priorMemoryTokens,
		configuredBudget,
		budget,
		outputReserveTokens,
		budgetExhaustedByPriorMemory,
		oversizedEntry,
		...(oversizedEntry ? { oversizedEntryTokens: firstEntryTokens } : {}),
	};
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function findDueStage(entries: Entry[], runtime: Runtime): DueStage | undefined {
	const checkpointTarget = runtime.observerCheckpointTargetEntryId;
	if (checkpointTarget) {
		const targetIndex = entries.findIndex((entry) => entry.id === checkpointTarget);
		if (targetIndex >= 0 && latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) < targetIndex) {
			return { phase: "observer", watermark: checkpointTarget };
		}
	}
	const observationTokens = rawTokensSinceObservationCoverage(entries);
	if (observationTokens >= runtime.config.observeAfterTokens || isCoverageRecoveryWaiting(runtime)) {
		const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
		const watermark = sourceEntriesAfter(entries, lastCoverageIdx).at(-1)?.id;
		if (watermark) return { phase: "observer", watermark };
	}

	const folded = foldLedger(entries);
	const observationDeltaTokens = observationTokensSinceReflectionCoverage(entries, folded.activeObservations);
	const observerBatches = observerBatchesSinceReflectionCoverage(entries);
	const rawReflectionTokens = rawTokensSinceReflectionCoverage(entries);
	const reflectionWatermark = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (
		reflectionWatermark
		&& (
			observationDeltaTokens >= runtime.config.reflectAfterObservationTokens
			|| observerBatches >= runtime.config.reflectAfterObserverBatches
			|| rawReflectionTokens >= runtime.config.reflectAfterTokens
		)
	) {
		return { phase: "reflector", watermark: reflectionWatermark };
	}

	const reflectionCoverageId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
	if (!reflectionCoverageId) return undefined;
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) return undefined;
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return undefined;
	return {
		phase: "dropper",
		watermark: `${observationCoverageId}:${reflectionCoverageId}:${metrics.observationTokens}`,
	};
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string } {
	try {
		return { sessionId: ctx.sessionManager.getSessionId?.() };
	} catch {
		return {};
	}
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function isRunCurrent(runtime: Runtime, ctx: ConsolidationCtx, run: ConsolidationRun): boolean {
	if (run.signal.aborted || !runtime.isConsolidationCurrent(run.generation)) return false;
	if (!run.sessionId) return true;
	try {
		return ctx.sessionManager.getSessionId?.() === run.sessionId;
	} catch {
		return false;
	}
}

function isContextIdle(ctx: ConsolidationCtx): boolean {
	return (ctx.isIdle?.() ?? true) && !(ctx.hasPendingMessages?.() ?? false);
}

function latestCompactionBoundaryKey(entries: Entry[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index].type === "compaction") return entries[index].id;
	}
	return "root";
}

function compactionCheckpointTarget(entries: Entry[], cutKey: string | undefined): string | undefined {
	const cutIndex = cutKey ? entries.findIndex((entry) => entry.id === cutKey) : -1;
	if (cutIndex <= 0) return undefined;
	for (let index = cutIndex - 1; index >= 0; index -= 1) {
		if (isSourceEntry(entries[index])) return entries[index].id;
	}
	return undefined;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx, run: ConsolidationRun) {
	return async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		const resolved = await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		}, run.signal);
		if (resolved.ok) {
			runtime.resolveFailureNotified = false;
			return resolved;
		}
		debugLog(`${stage}.model_unavailable`, { reason: resolved.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${resolved.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
	let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ConsolidationCtx | undefined;
	let convergenceSeen = false;
	let configDiagnosticsNotified = false;
	let checkpointSequence = 0;
	const checkpointNonce = Math.random().toString(36).slice(2, 10);
	type ActiveCheckpoint = {
		request: CheckpointRequestV1;
		strict: boolean;
		ctx: ConsolidationCtx;
		requiresGrant: boolean;
		lease?: CheckpointGrantV1;
		grantTimer?: ReturnType<typeof setTimeout>;
		leaseTimer?: ReturnType<typeof setTimeout>;
	};
	let checkpoint: ActiveCheckpoint | undefined;

	const notifyConfigDiagnostics = (ctx: ConsolidationCtx) => {
		runtime.ensureConfig(ctx.cwd);
		if (configDiagnosticsNotified || !ctx.hasUI || !ctx.ui) return;
		for (const diagnostic of runtime.config.configDiagnostics ?? []) {
			ctx.ui.notify(`Observational memory: ${diagnostic.message}`, diagnostic.level);
		}
		configDiagnosticsNotified = true;
	};

	const clearSchedule = () => {
		if (scheduleTimer) clearTimeout(scheduleTimer);
		scheduleTimer = undefined;
	};
	const clearRecovery = () => {
		if (recoveryTimer) clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
	};

	const targetIsCovered = (entries: Entry[], targetEntryId: string): boolean => {
		const targetIndex = entries.findIndex((entry) => entry.id === targetEntryId);
		return targetIndex >= 0 && latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) >= targetIndex;
	};

	const clearCheckpointTimers = (active: ActiveCheckpoint): void => {
		if (active.grantTimer) clearTimeout(active.grantTimer);
		if (active.leaseTimer) clearTimeout(active.leaseTimer);
		active.grantTimer = undefined;
		active.leaseTimer = undefined;
	};

	const checkpointLeaseIsUsable = (
		active = checkpoint,
		now = Date.now(),
	): active is ActiveCheckpoint & { lease: CheckpointGrantV1 } => {
		if (!active?.lease) return false;
		const { request, lease } = active;
		return request.requesterGeneration === runtime.lifecycleGeneration
			&& lease.requestId === request.requestId
			&& lease.requesterGeneration === request.requesterGeneration
			&& lease.boundaryKey === request.boundaryKey
			&& lease.targetEntryId === request.targetEntryId
			&& lease.branchHeadId === request.branchHeadId
			&& lease.expiresAt > now;
	};

	const checkpointMatchesRecovery = (
		entries: Entry[],
		pending: NonNullable<Runtime["pendingCompaction"]>,
	): boolean => {
		const targetEntryId = compactionCheckpointTarget(entries, pending.cutKey);
		return !!targetEntryId
			&& checkpoint?.strict === true
			&& checkpoint.request.requesterGeneration === runtime.lifecycleGeneration
			&& checkpoint.request.boundaryKey === pending.boundaryKey
			&& checkpoint.request.targetEntryId === targetEntryId
			&& checkpointLeaseIsUsable(checkpoint);
	};

	const finishCheckpoint = (
		outcome: CheckpointFinishOutcome,
		error?: string,
		coversUpToId?: string,
		reason?: CheckpointFinishReason,
	): ActiveCheckpoint | undefined => {
		const active = checkpoint;
		if (!active) return undefined;
		clearCheckpointTimers(active);
		checkpoint = undefined;
		runtime.observerCheckpointTargetEntryId = undefined;
		if (active.lease) {
			pi.events.emit(CHECKPOINT_FINISH_EVENT, {
				version: 1,
				requestId: active.request.requestId,
				leaseId: active.lease.leaseId,
				requesterGeneration: active.request.requesterGeneration,
				boundaryKey: active.request.boundaryKey,
				targetEntryId: active.request.targetEntryId,
				branchHeadId: active.request.branchHeadId,
				outcome,
				...(coversUpToId ? { coversUpToId } : {}),
				...(error ? { error } : {}),
				...(reason ? { reason } : {}),
				finishedAt: Date.now(),
			});
		}
		return active;
	};

	const cancelPendingCheckpoint = (reason: "superseded" | "session-changed" | "grant-timeout"): ActiveCheckpoint | undefined => {
		const active = checkpoint;
		if (!active || active.lease) return undefined;
		clearCheckpointTimers(active);
		checkpoint = undefined;
		runtime.observerCheckpointTargetEntryId = undefined;
		pi.events.emit(CHECKPOINT_CANCEL_EVENT, {
			version: 1,
			requestId: active.request.requestId,
			requesterGeneration: active.request.requesterGeneration,
			boundaryKey: active.request.boundaryKey,
			targetEntryId: active.request.targetEntryId,
			branchHeadId: active.request.branchHeadId,
			reason,
			cancelledAt: Date.now(),
		});
		return active;
	};

	const checkpointLeaseMs = (strict: boolean): number => {
		if (!strict) return Math.max(60_000, runtime.config.observerTimeoutMs + 60_000);
		const remaining = runtime.compactionRecoveryBudgetRemaining()
			?? runtime.config.compactionWaitForConsolidationMs;
		return Math.max(
			runtime.config.observerTimeoutMs + 60_000,
			remaining + runtime.config.consolidationCircuitBreakerMs + 60_000,
		);
	};

	const requestCheckpoint = (
		ctx: ConsolidationCtx,
		strict: boolean,
		targetOverride?: string,
	): void => {
		if (runtime.config.passive) return;
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const pending = runtime.pendingCompaction;
		const due = findDueStage(entries, runtime);
		const targetEntryId = targetOverride
			?? (strict
				? compactionCheckpointTarget(entries, pending?.cutKey)
				: due?.phase === "observer" ? due.watermark : undefined);
		if (!targetEntryId) return;
		const boundaryKey = latestCompactionBoundaryKey(entries);
		if (strict && (!pending || pending.boundaryKey !== boundaryKey)) return;

		if (checkpoint) {
			checkpoint.ctx = ctx;
			if (!strict) return;
			if (checkpoint.strict && checkpoint.request.targetEntryId === targetEntryId) {
				if (!convergenceSeen || checkpointLeaseIsUsable(checkpoint)) return;
				if (checkpoint.requiresGrant && !checkpoint.lease) return;
				if (checkpoint.lease) {
					if (runtime.consolidationInFlight) runtime.abortConsolidation("checkpoint lease no longer usable");
					finishCheckpoint("failed", "checkpoint lease expired before recovery completed", undefined, "lease-expired");
				} else {
					cancelPendingCheckpoint("superseded");
				}
				setTimeout(() => requestCheckpoint(ctx, true, targetEntryId), 0);
				return;
			}
			if (checkpoint.lease) {
				if (runtime.consolidationInFlight) runtime.abortConsolidation("checkpoint target superseded");
				finishCheckpoint("aborted", "routine checkpoint upgraded to a newer strict compaction target", undefined, "superseded");
			} else {
				cancelPendingCheckpoint("superseded");
			}
			setTimeout(() => requestCheckpoint(ctx, true, targetEntryId), 0);
			return;
		}

		const request: CheckpointRequestV1 = {
			version: 1,
			requestId: `om:${checkpointNonce}:${++checkpointSequence}`,
			requester: "observational-memory",
			requesterGeneration: runtime.lifecycleGeneration,
			purpose: strict
				? "observational-memory:compaction-recovery"
				: "observational-memory:observe",
			urgency: strict ? "strict" : "routine",
			boundaryKey,
			targetEntryId,
			branchHeadId: entries.at(-1)?.id ?? targetEntryId,
			requestedAt: Date.now(),
			maxLeaseMs: checkpointLeaseMs(strict),
		};
		checkpoint = { request, strict, ctx, requiresGrant: false };
		runtime.observerCheckpointTargetEntryId = targetEntryId;
		pi.events.emit(CHECKPOINT_REQUEST_EVENT, request);
		if (checkpoint?.request === request) {
			checkpoint.requiresGrant = convergenceSeen;
			if (checkpoint.requiresGrant && !checkpoint.lease) {
				const active = checkpoint;
				active.grantTimer = setTimeout(() => {
					if (checkpoint !== active || active.lease) return;
					const strictRequest = active.strict;
					const fallbackCtx = active.ctx;
					cancelPendingCheckpoint("grant-timeout");
					if (strictRequest && runtime.pendingCompaction?.state !== "blocked") {
						scheduleRecovery(fallbackCtx, 0);
					} else {
						schedule(fallbackCtx, 0);
					}
				}, Math.min(60_000, request.maxLeaseMs));
			}
		}
	};

	const onObserverProgress = (entries: Entry[]): boolean => {
		const active = checkpoint;
		if (!active || active.strict || !targetIsCovered(entries, active.request.targetEntryId)) return false;
		finishCheckpoint("observed", undefined, active.request.targetEntryId);
		return true;
	};

	const onObserverFailure = (error?: string): boolean => {
		if (!checkpoint || checkpoint.strict) return false;
		finishCheckpoint("failed", error ?? "routine observer checkpoint failed");
		return true;
	};

	let scheduleRecovery!: (ctx: ConsolidationCtx, delayMs?: number) => void;
	const blockRecovery = (
		ctx: ConsolidationCtx,
		reason: string,
		retryAt?: number,
	) => {
		const pending = runtime.pendingCompaction;
		if (!pending || pending.state === "blocked") return;
		runtime.blockCompactionRecovery(reason, retryAt);
		clearSchedule();
		clearRecovery();
		if (runtime.consolidationInFlight) runtime.abortConsolidation(reason);
		if (checkpoint?.strict) finishCheckpoint("failed", reason);
		debugLog("compaction.recovery_blocked", {
			reason,
			retryAt,
			cutKey: pending.cutKey,
			boundaryKey: pending.boundaryKey,
			origin: pending.origin,
		});
		if (ctx.hasUI) ctx.ui?.notify(
			`Observational memory: compaction recovery blocked — ${reason}`,
			"warning",
		);
	};

	const schedule = (ctx: ConsolidationCtx, delayMs = runtime.config.consolidationIdleDelayMs) => {
		clearSchedule();
		const lifecycleGeneration = runtime.lifecycleGeneration;
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;
			const due = findDueStage(ctx.sessionManager.getBranch() as Entry[], runtime);
			if (convergenceSeen && due?.phase === "observer" && !checkpointLeaseIsUsable()) {
				requestCheckpoint(ctx, isCoverageRecoveryWaiting(runtime));
				return;
			}
			maybeLaunchStage(
				pi,
				runtime,
				ctx,
				schedule,
				scheduleRecovery,
				blockRecovery,
				onObserverProgress,
				onObserverFailure,
				() => !convergenceSeen || checkpointLeaseIsUsable(),
				() => !convergenceSeen || checkpointLeaseIsUsable(),
			);
		}, Math.max(0, delayMs));
	};

	scheduleRecovery = (ctx: ConsolidationCtx, delayMs = runtime.config.consolidationIdleDelayMs) => {
		clearRecovery();
		const lifecycleGeneration = runtime.lifecycleGeneration;
		recoveryTimer = setTimeout(() => {
			recoveryTimer = undefined;
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;

			const pending = runtime.pendingCompaction;
			if (!pending || pending.lifecycleGeneration !== lifecycleGeneration) return;
			if (pending.state === "blocked") return;

			const entries = ctx.sessionManager.getBranch() as Entry[];
			if (latestCompactionBoundaryKey(entries) !== pending.boundaryKey) {
				runtime.clearCompactionDeferral();
				return;
			}
			const schedulingBlocked = runtime.convergenceControlInFlight
				|| runtime.compactInFlight
				|| runtime.compactHookInFlight
				|| !isContextIdle(ctx);
			if (convergenceSeen && !checkpointMatchesRecovery(entries, pending)) {
				runtime.pauseCompactionRecoveryBudget();
				if (!schedulingBlocked) requestCheckpoint(ctx, true);
				if (checkpoint?.requiresGrant && !checkpointLeaseIsUsable()) return;
				scheduleRecovery(ctx);
				return;
			}

			if (pending.state === "ready") {
				if (schedulingBlocked) {
					scheduleRecovery(ctx);
					return;
				}
				if (runtime.consolidationInFlight) runtime.abortConsolidation("observer coverage ready");
				requestCompaction(runtime, ctx as any, {
					force: true,
					canRun: () => {
						if (!convergenceSeen) return true;
						const current = runtime.pendingCompaction;
						return !!current
							&& checkpointMatchesRecovery(ctx.sessionManager.getBranch() as Entry[], current);
					},
				});
				if (runtime.pendingCompaction) scheduleRecovery(ctx);
				return;
			}

			const recoveryBudgetExhausted = runtime.isCompactionRecoveryBudgetExpired();
			if (recoveryBudgetExhausted) {
				if (isStrictRecovery(runtime)) {
					blockRecovery(ctx, "effective observer recovery budget was exhausted before the compaction cut was covered");
					return;
				}
				runtime.markCompactionReady();
				if (runtime.consolidationInFlight) runtime.abortConsolidation("compaction coverage grace expired");
				requestCompaction(runtime, ctx as any, {
					force: true,
					canRun: () => {
						if (!convergenceSeen) return true;
						const current = runtime.pendingCompaction;
						return !!current
							&& checkpointMatchesRecovery(ctx.sessionManager.getBranch() as Entry[], current);
					},
				});
				if (runtime.pendingCompaction) scheduleRecovery(ctx);
				return;
			}

			if (schedulingBlocked) {
				scheduleRecovery(ctx);
				return;
			}

			if (!runtime.consolidationInFlight) {
				maybeLaunchStage(
					pi,
					runtime,
					ctx,
					schedule,
					scheduleRecovery,
					blockRecovery,
					onObserverProgress,
					onObserverFailure,
					() => !convergenceSeen || checkpointLeaseIsUsable(),
					() => !convergenceSeen || checkpointLeaseIsUsable(),
				);
			}
			if (runtime.pendingCompaction) {
				const remaining = runtime.compactionRecoveryBudgetRemaining() ?? 0;
				scheduleRecovery(ctx, Math.min(runtime.config.consolidationIdleDelayMs, remaining));
			}
		}, Math.max(0, delayMs));
	};

	pi.on("agent_start", (_event: any, rawCtx: any) => {
		const ctx = rawCtx as ConsolidationCtx | undefined;
		if (ctx) notifyConfigDiagnostics(ctx);
		getBackgroundBroker().setForegroundActive(true);
		runtime.pauseCompactionRecoveryBudget();
		clearSchedule();
		if (runtime.consolidationInFlight) runtime.abortConsolidation("foreground activity");
	});
	pi.on("agent_end", (_event: any, rawCtx: any) => {
		const ctx = rawCtx as ConsolidationCtx;
		lastCtx = ctx;
		notifyConfigDiagnostics(ctx);
		if (convergenceSeen && !checkpoint) {
			const pending = runtime.pendingCompaction;
			if (pending && pending.state !== "blocked") requestCheckpoint(ctx, true);
			else if (findDueStage(ctx.sessionManager.getBranch() as Entry[], runtime)?.phase === "observer") {
				requestCheckpoint(ctx, false);
			}
		}
	});
	pi.on("agent_settled", (_event: any, rawCtx: any) => {
		const ctx = (rawCtx as ConsolidationCtx | undefined) ?? lastCtx;
		getBackgroundBroker().setForegroundActive(false);
		if (!ctx) return;
		lastCtx = ctx;
		notifyConfigDiagnostics(ctx);
		if (runtime.pendingCompaction?.state === "blocked") return;
		if (convergenceSeen && !checkpoint) {
			const pending = runtime.pendingCompaction;
			if (pending && pending.state !== "blocked") requestCheckpoint(ctx, true);
			else if (findDueStage(ctx.sessionManager.getBranch() as Entry[], runtime)?.phase === "observer") {
				requestCheckpoint(ctx, false);
			}
		}
		schedule(ctx);
		if (runtime.pendingCompaction) scheduleRecovery(ctx);
	});

	const handleRecoveryRequest = (event: any) => {
		const ctx = (event?.ctx as ConsolidationCtx | undefined) ?? lastCtx;
		if (!ctx || !runtime.pendingCompaction || runtime.pendingCompaction.state === "blocked") return;
		lastCtx = ctx;
		requestCheckpoint(ctx, true);
		scheduleRecovery(ctx, 0);
	};
	pi.events.on(OM_COMPACTION_DEFERRED_EVENT, handleRecoveryRequest);
	pi.events.on(OM_COMPACTION_RECOVERY_REQUESTED_EVENT, handleRecoveryRequest);
	pi.events.on(OM_COMPACTION_CLEARED_EVENT, (event: any) => {
		clearRecovery();
		if (!checkpoint) return;
		finishCheckpoint(event?.reason === "session_compact" ? "compacted" : "not-needed", event?.reason);
	});
	pi.events.on(CHECKPOINT_GRANT_EVENT, (event: unknown) => {
		if (!checkpoint || !isCheckpointGrant(event)) return;
		const request = checkpoint.request;
		if (
			event.requestId !== request.requestId
			|| event.requesterGeneration !== runtime.lifecycleGeneration
			|| event.requesterGeneration !== request.requesterGeneration
			|| event.boundaryKey !== request.boundaryKey
			|| event.targetEntryId !== request.targetEntryId
			|| event.branchHeadId !== request.branchHeadId
		) return;
		const entries = checkpoint.ctx.sessionManager.getBranch() as Entry[];
		const targetIndex = entries.findIndex((entry) => entry.id === request.targetEntryId);
		if (latestCompactionBoundaryKey(entries) !== request.boundaryKey || targetIndex < 0) {
			checkpoint.lease = event;
			finishCheckpoint("aborted", "checkpoint target is stale for the current branch");
			return;
		}
		checkpoint.lease = event;
		if (checkpoint.grantTimer) {
			clearTimeout(checkpoint.grantTimer);
			checkpoint.grantTimer = undefined;
		}
		const active = checkpoint;
		active.leaseTimer = setTimeout(() => {
			if (checkpoint !== active || checkpoint.lease !== event) return;
			const ctx = active.ctx;
			const strict = active.strict;
			runtime.pauseCompactionRecoveryBudget();
			if (runtime.consolidationInFlight) runtime.abortConsolidation("coordination lease expired");
			finishCheckpoint("failed", "coordination lease expired before checkpoint completion", undefined, "lease-expired");
			if (strict && runtime.pendingCompaction?.state !== "blocked") scheduleRecovery(ctx, 0);
			else schedule(ctx, 0);
		}, Math.max(0, event.expiresAt - Date.now()));
		if (checkpoint.strict && runtime.pendingCompaction) scheduleRecovery(checkpoint.ctx, 0);
		else schedule(checkpoint.ctx, 0);
	});
	pi.events.on(CHECKPOINT_RELEASE_EVENT, (event: unknown) => {
		if (!checkpoint || !isCheckpointRelease(event)) return;
		const request = checkpoint.request;
		if (
			event.requestId !== request.requestId
			|| event.requesterGeneration !== runtime.lifecycleGeneration
			|| event.requesterGeneration !== request.requesterGeneration
			|| event.boundaryKey !== request.boundaryKey
			|| event.targetEntryId !== request.targetEntryId
			|| event.branchHeadId !== request.branchHeadId
			|| (checkpoint.lease ? event.leaseId !== checkpoint.lease.leaseId : event.leaseId !== undefined)
		) return;
		const ctx = checkpoint.ctx;
		const strict = checkpoint.strict;
		clearCheckpointTimers(checkpoint);
		checkpoint = undefined;
		runtime.observerCheckpointTargetEntryId = undefined;
		clearSchedule();
		clearRecovery();
		runtime.pauseCompactionRecoveryBudget();
		if (runtime.consolidationInFlight) runtime.abortConsolidation(`checkpoint ${event.reason}`);
		if (event.reason === "coordinator-disabled") {
			convergenceSeen = false;
			if (strict && runtime.pendingCompaction?.state !== "blocked") scheduleRecovery(ctx);
			else schedule(ctx);
		} else if (event.reason !== "session-changed") {
			if (strict && runtime.pendingCompaction?.state !== "blocked") scheduleRecovery(ctx, 0);
			else schedule(ctx, 0);
		}
	});
	pi.events.on("pi-convergence:state", (event: any) => {
		convergenceSeen = event?.mode === undefined || event.mode === "enabled";
		const phase = event?.phase;
		if (
			phase !== "judging"
			&& phase !== "continuation"
			&& lastCtx
			&& runtime.pendingCompaction
			&& runtime.pendingCompaction.state !== "blocked"
		) {
			if (convergenceSeen && !checkpoint) {
				requestCheckpoint(lastCtx, true);
			}
			if (!checkpoint || !checkpoint.requiresGrant || checkpointLeaseIsUsable()) scheduleRecovery(lastCtx, 0);
		}
	});

	const invalidate = () => {
		if (checkpoint?.lease) finishCheckpoint("aborted", "session or branch changed", undefined, "session-changed");
		else if (checkpoint) cancelPendingCheckpoint("session-changed");
		clearSchedule();
		clearRecovery();
		runtime.invalidateConsolidation();
	};
	pi.on("session_before_tree", invalidate);
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_tree", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_shutdown", () => getBackgroundBroker().setForegroundActive(false));
}

function maybeLaunchStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	schedule: (ctx: ConsolidationCtx, delayMs?: number) => void,
	scheduleRecovery: (ctx: ConsolidationCtx, delayMs?: number) => void,
	blockRecovery: (ctx: ConsolidationCtx, reason: string, retryAt?: number) => void,
	onObserverProgress: (entries: Entry[]) => boolean,
	onObserverFailure: (error?: string) => boolean,
	checkpointCanRun: () => boolean,
	shouldRescheduleAfterAbort: () => boolean,
): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || runtime.consolidationInFlight) return;
	if (runtime.pendingCompaction?.state === "blocked") return;
	if (runtime.compactInFlight || runtime.compactHookInFlight || runtime.convergenceControlInFlight) return;
	if (!isContextIdle(ctx)) return;
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const due = findDueStage(entries, runtime);
	if (!due) return;
	if (due.phase === "observer" && !checkpointCanRun()) return;
	const retryAt = runtime.stageRetryAt(due.phase, due.watermark);
	if (retryAt !== undefined) {
		schedule(ctx, retryAt - Date.now());
		return;
	}

	const sessionMetadata = debugSessionMetadata(ctx);
	const runId = `${due.phase}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	void runtime.launchConsolidationTask(ctx, due.phase, due.watermark, async (signal, generation) => withBackgroundLease({
		owner: `observational-memory:${due.phase}`,
		priority: stagePriority(due.phase, runtime),
		signal,
	}, async (leaseSignal, waitedMs) => withDebugLogContext({
		enabled: runtime.config.debugLog,
		...sessionMetadata,
		runId,
	}, async () => {
		debugLog("background_lease_acquired", { phase: due.phase, waitedMs });
		const recoveryBudgetRunning = due.phase === "observer"
			&& runtime.resumeCompactionRecoveryBudget();
		try {
			return await runStage(pi, runtime, ctx, due.phase, {
				generation,
				signal: leaseSignal,
				sessionId: sessionMetadata.sessionId,
			});
		} finally {
			if (recoveryBudgetRunning) runtime.pauseCompactionRecoveryBudget();
		}
	}))).then((result) => {
		if (result.status === "aborted") {
			if (runtime.pendingCompaction && shouldRescheduleAfterAbort()) scheduleRecovery(ctx);
			return;
		}
		if (result.status === "success" && result.phase === "observer") {
			const entries = ctx.sessionManager.getBranch() as Entry[];
			if (onObserverProgress(entries)) {
				return;
			}
		}
		if (result.status === "success" && result.phase === "observer" && runtime.compactionDeferred) {
			const pending = runtime.pendingCompaction;
			if (!pending || pending.state === "blocked") return;
			const entries = ctx.sessionManager.getBranch() as Entry[];
			if (latestCompactionBoundaryKey(entries) !== pending.boundaryKey) {
				runtime.clearCompactionDeferral();
				return;
			}
			const checkpointTarget = runtime.observerCheckpointTargetEntryId;
			const checkpointTargetCovered = !checkpointTarget || (() => {
				const targetIndex = entries.findIndex((entry) => entry.id === checkpointTarget);
				return targetIndex >= 0 && latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED) >= targetIndex;
			})();
			if (observationCoverageIncludesCompactionPrefix(entries, pending.cutKey) && checkpointTargetCovered) {
				runtime.markCompactionReady();
				scheduleRecovery(ctx, 0);
				return;
			}
			if (runtime.isCompactionRecoveryBudgetExpired()) {
				if (isStrictRecovery(runtime)) {
					blockRecovery(ctx, "effective observer recovery budget was exhausted before the compaction cut was covered");
				} else {
					runtime.markCompactionReady();
					scheduleRecovery(ctx, 0);
				}
				return;
			}
			// A bounded observer batch may make durable progress without covering
			// the requested cut. Keep recovery active and consume the next prefix.
			maybeLaunchStage(pi, runtime, ctx, schedule, scheduleRecovery, blockRecovery, onObserverProgress, onObserverFailure, checkpointCanRun, shouldRescheduleAfterAbort);
			scheduleRecovery(ctx);
			return;
		}
		if (!isContextIdle(ctx)) {
			if (runtime.pendingCompaction) scheduleRecovery(ctx);
			return;
		}
		if (result.status === "success") {
			schedule(ctx);
			return;
		}

		const failure = runtime.stageFailureStatus(result.phase);
			const checkpointFailureHandled = result.phase === "observer"
				&& result.status === "failed"
				&& onObserverFailure(result.error);
			if (checkpointFailureHandled) {
				const retryAt = runtime.stageRetryAt(result.phase, result.watermark) ?? result.retryAt;
				if (retryAt !== undefined) schedule(ctx, retryAt - Date.now());
				return;
			}
		if (
			result.phase === "observer"
			&& runtime.compactionDeferred
			&& ((failure?.failures ?? 0) >= 2 || failure?.circuitOpenUntil !== undefined)
		) {
			if (isStrictRecovery(runtime)) {
				if (failure?.circuitOpenUntil !== undefined) {
					blockRecovery(
						ctx,
						`observer recovery circuit opened before the compaction cut was covered: ${failure.lastError}`,
						failure.circuitOpenUntil,
					);
					return;
				}
			} else {
				runtime.markCompactionReady();
				scheduleRecovery(ctx, 0);
				return;
			}
		}
		const retryAt = runtime.stageRetryAt(result.phase, result.watermark) ?? result.retryAt;
		if (retryAt !== undefined) schedule(ctx, retryAt - Date.now());
	});
}

async function runStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	phase: ConsolidationPhase,
	run: ConsolidationRun,
): Promise<boolean> {
	if (!isRunCurrent(runtime, ctx, run)) return false;
	const resolveModel = makeModelResolver(runtime, ctx, run);
	if (phase === "observer") return runObserverStage(pi, runtime, ctx, resolveModel, run);
	if (phase === "reflector") return runReflectorStage(pi, runtime, ctx, resolveModel, run);
	return runDropperStage(pi, runtime, ctx, resolveModel, run);
}

function normalizeObserverRunResult(value: ObserverRunResult | unknown): ObserverRunResult {
	if (Array.isArray(value)) {
		return {
			observations: value as ObserverRunResult["observations"],
			stats: {
				toolCalls: value.length > 0 ? 1 : 0,
				added: value.length,
				duplicate: 0,
				rejected: 0,
				stopReason: "legacy-result",
			},
		};
	}
	if (value && typeof value === "object" && Array.isArray((value as ObserverRunResult).observations)) {
		return value as ObserverRunResult;
	}
	return {
		observations: [],
		stats: { toolCalls: 0, added: 0, duplicate: 0, rejected: 0, stopReason: "no-result" },
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isContextOverflowError(error: unknown): boolean {
	return /context[_ -]?length|maximum context|context window|too many (?:input )?tokens|token limit|input.{0,30}exceed/i.test(errorText(error));
}

async function resolveCoverageVerifierModel(
	ctx: ConsolidationCtx,
	configured: ConfiguredModel | undefined,
	signal: AbortSignal,
): Promise<ResolvedModel | { ok: false; reason: string }> {
	if (!configured) return { ok: false, reason: "observerCoverageVerifyModel is not configured" };
	let model: unknown;
	try {
		model = ctx.modelRegistry?.find?.(configured.provider, configured.id);
	} catch (error) {
		return { ok: false, reason: `verifier model lookup failed: ${errorText(error)}` };
	}
	if (!model) return { ok: false, reason: `verifier model ${configured.provider}/${configured.id} not found` };
	if (signal.aborted) return { ok: false, reason: "verifier model resolution aborted" };
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (signal.aborted) return { ok: false, reason: "verifier model resolution aborted" };
		if (!auth?.ok || !auth.apiKey) {
			return { ok: false, reason: `no API key for verifier provider "${configured.provider}"` };
		}
		return {
			ok: true,
			model,
			apiKey: auth.apiKey as string,
			headers: auth.headers as Record<string, string> | undefined,
		};
	} catch (error) {
		return { ok: false, reason: `verifier model authentication failed: ${errorText(error)}` };
	}
}

function observerFailureSubtypes(stats: ObserverRunStats): string[] {
	if (stats.toolCalls === 0) return ["zero-calls"];
	const subtypes = ["all-rejected"];
	if (stats.rejected > 0) subtypes.push("invalid-ids");
	return subtypes;
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>,
	run: ConsolidationRun,
): Promise<boolean> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (
		!isCoverageRecoveryWaiting(runtime)
		&& !runtime.observerCheckpointTargetEntryId
		&& tokens < runtime.config.observeAfterTokens
	) return true;
	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const checkpointTargetIndex = runtime.observerCheckpointTargetEntryId
		? entries.findIndex((entry) => entry.id === runtime.observerCheckpointTargetEntryId)
		: -1;
	const checkpointEndIndex = checkpointTargetIndex >= 0 ? checkpointTargetIndex + 1 : entries.length;
	// A checkpoint leases an immutable prefix, not the live branch tail. New
	// suffix entries may exist by the time the provider starts, but they must be
	// left for a later request instead of widening this lease implicitly.
	const chunkEntries = entries.slice(lastCoverageIdx + 1, checkpointEndIndex).filter(isSourceEntry);
	if (chunkEntries.length === 0) return true;

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);
	const selection = selectObserverChunk({
		entries: chunkEntries,
		priorReflections,
		priorObservations,
		maxTokens: runtime.config.observerChunkMaxTokens,
		overlapEntries: runtime.config.observerChunkOverlapEntries,
		outputReserveTokens: runtime.config.observerChunkOutputReserveTokens,
		emptyCoverageCommit: runtime.config.observerEmptyCoverageCommit,
	});
	const coversUpToId = selection.coversUpToId;
	if (!coversUpToId || !selection.chunk.trim() || selection.allowedSourceEntryIds.length === 0) {
		return !isCoverageRecoveryWaiting(runtime);
	}

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`, "info");
	const resolved = await resolveModel("observer");
	if (!resolved || !isRunCurrent(runtime, ctx, run)) return false;
	const model = resolved.model as { provider?: string; id?: string };
	const diagnostics = {
		tokens,
		coversUpToId,
		provider: model.provider ?? runtime.config.model?.provider,
		model: model.id ?? runtime.config.model?.id,
		estimatedPromptTokens: selection.estimatedPromptTokens,
		estimatedRequestTokens: selection.estimatedPromptTokens + selection.outputReserveTokens,
		configuredBudget: selection.configuredBudget,
		budget: selection.budget,
		outputReserveTokens: selection.outputReserveTokens,
		sourceEntryCount: selection.sourceEntryCount,
		overlapEntryCount: selection.overlapEntryCount,
		promptSourceEntryCount: selection.promptSourceEntryCount,
		priorMemoryTokens: selection.priorMemoryTokens,
		budgetExhaustedByPriorMemory: selection.budgetExhaustedByPriorMemory,
		oversizedEntry: selection.oversizedEntry,
		oversizedEntryTokens: selection.oversizedEntryTokens,
	};
	debugLog("observer.start", diagnostics);

	let result: ObserverRunResult;
	try {
		const rawResult = await runObserver({
			model: resolved.model as any,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			priorReflections,
			priorObservations,
			chunk: selection.chunk,
			allowedSourceEntryIds: selection.allowedSourceEntryIds,
			signal: run.signal,
			maxTurns: runtime.config.agentMaxTurns,
			thinkingLevel: runtime.config.model?.thinking ?? "low",
			emptyCoverageCommit: runtime.config.observerEmptyCoverageCommit,
			...(selection.configuredBudget > 0
				? { maxOutputTokens: selection.outputReserveTokens }
				: {}),
		});
		result = normalizeObserverRunResult(rawResult);
	} catch (error) {
		const contextOverflow = isContextOverflowError(error);
		const timeout = run.signal.aborted && /timeout/i.test(String(run.signal.reason ?? errorText(error)));
		const failureSubtype = contextOverflow ? "context-overflow" : timeout ? "timeout" : "error";
		debugLog("observer.empty", {
			...diagnostics,
			failureSubtype,
			contextOverflow,
			timeout,
			error: errorText(error),
		});
		throw error;
	}

	if (!isRunCurrent(runtime, ctx, run)) return false;
	if (result.observations.length === 0) {
		if (result.covered !== true || !runtime.config.observerEmptyCoverageCommit) {
			const failureSubtypes = observerFailureSubtypes(result.stats);
			debugLog("observer.empty", {
				...diagnostics,
				...result.stats,
				covered: result.covered,
				failureSubtype: result.stats.rejected > 0 ? "invalid-ids" : failureSubtypes[0],
				failureSubtypes,
				allRejected: true,
				invalidIds: result.stats.rejected > 0,
				contextOverflow: false,
			});
			return false;
		}

		const verifierConfig = runtime.config.observerCoverageVerifyModel;
		const verificationAudit = {
			coversUpToId,
			mainProvider: diagnostics.provider,
			mainModel: diagnostics.model,
			verifierProvider: verifierConfig?.provider,
			verifierModel: verifierConfig?.id,
			mainStats: result.stats,
		};
		const verifierResolved = await resolveCoverageVerifierModel(ctx, verifierConfig, run.signal);
		if (!verifierResolved.ok) {
			debugLog("observer.coverage_verification", {
				...verificationAudit,
				conclusion: "fail-closed",
				error: verifierResolved.reason,
			});
			debugLog("observer.empty", {
				...diagnostics,
				...result.stats,
				covered: false,
				failureSubtype: "verifier-model-unavailable",
				error: verifierResolved.reason,
				contextOverflow: false,
			});
			return false;
		}

		let verification: CoverageVerifierRunResult | undefined;
		let verificationError: string | undefined;
		try {
			verification = await runCoverageVerifier({
				model: verifierResolved.model as any,
				apiKey: verifierResolved.apiKey,
				headers: verifierResolved.headers,
				chunk: selection.chunk,
				signal: run.signal,
				thinkingLevel: verifierConfig?.thinking ?? "low",
			});
		} catch (error) {
			verificationError = errorText(error);
		}
		const verdict = verification?.verdict;
		const accepted = verdict?.hasRecordableContent === false;
		debugLog("observer.coverage_verification", {
			...verificationAudit,
			verifierStats: verification?.stats,
			conclusion: accepted
				? "accepted-empty"
				: verdict?.hasRecordableContent === true ? "disagreement" : "fail-closed",
			hasRecordableContent: verdict?.hasRecordableContent,
			reason: verdict?.reason,
			error: verificationError ?? (!verdict ? "verifier produced no valid structured verdict" : undefined),
		});
		if (!isRunCurrent(runtime, ctx, run)) return false;
		if (!accepted) {
			debugLog("observer.empty", {
				...diagnostics,
				...result.stats,
				covered: false,
				failureSubtype: verdict?.hasRecordableContent === true ? "verifier-disagreement" : "verifier-failed",
				verifierStats: verification?.stats,
				reason: verdict?.reason,
				error: verificationError,
				contextOverflow: false,
			});
			return false;
		}
		const data = buildObservationsRecordedData([], coversUpToId, true);
		if (!data) return false;
		appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
		if (shouldNotifyWorker(runtime, ctx)) {
			ctx.ui?.notify("Observational memory: empty observer batch verified and covered", "info");
		}
		return true;
	}
	const data = buildObservationsRecordedData(result.observations, coversUpToId);
	if (!data) {
		debugLog("observer.empty", {
			...diagnostics,
			...result.stats,
			covered: result.covered,
			failureSubtype: "all-rejected",
			contextOverflow: false,
		});
		return false;
	}
	debugLog("observer.records", {
		...diagnostics,
		observationCount: result.observations.length,
		...result.stats,
		covered: result.covered,
		invalidIds: result.stats.rejected > 0,
		contextOverflow: false,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`Observational memory: ${result.observations.length} observation${result.observations.length === 1 ? "" : "s"} recorded`, "info");
	return true;
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>,
	run: ConsolidationRun,
): Promise<boolean> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return true;
	const folded = foldLedger(entries);
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running on ${folded.activeObservations.length.toLocaleString()} active observations`,
		"info",
	);
	const resolved = await resolveModel("reflector");
	if (!resolved || !isRunCurrent(runtime, ctx, run)) return false;
	const reflections = await runReflector({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		signal: run.signal,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!isRunCurrent(runtime, ctx, run) || !reflections?.length) return false;
	const data = buildReflectionsRecordedData(reflections, observationCoverageId);
	if (!data) return false;
	appendEntry(pi, OM_REFLECTIONS_RECORDED, data);
	return true;
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>,
	run: ConsolidationRun,
): Promise<boolean> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	const reflectionCoverageId = latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
	if (!observationCoverageId || !reflectionCoverageId) return true;
	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) return true;
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens`,
		"info",
	);
	const resolved = await resolveModel("dropper");
	if (!resolved || !isRunCurrent(runtime, ctx, run)) return false;
	const droppedIds = await runDropper({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		reflections: folded.reflections,
		observations: folded.activeObservations,
		targetTokens: runtime.config.observationsPoolTargetTokens,
		signal: run.signal,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!isRunCurrent(runtime, ctx, run) || !droppedIds?.length) return false;
	const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, reflectionCoverageId);
	const data = coversUpToId ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
	if (!data) return false;
	appendEntry(pi, OM_OBSERVATIONS_DROPPED, data);
	return true;
}
