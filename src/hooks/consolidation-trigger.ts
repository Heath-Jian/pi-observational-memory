import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import {
	estimateObserverPromptTokens,
	estimateObserverPromptTokensForChunkCharacters,
	runObserver,
	type ObserverRunResult,
	type ObserverRunStats,
} from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { getBackgroundBroker, withBackgroundLease } from "../background-broker.js";
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
} from "./compaction-events.js";
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
	if (phase === "observer") return runtime.compactionDeferred ? 350 : 200;
	if (phase === "reflector") return 100;
	return 50;
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
	const observationTokens = rawTokensSinceObservationCoverage(entries);
	if (observationTokens >= runtime.config.observeAfterTokens || runtime.compactionDeferred) {
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

	const clearSchedule = () => {
		if (scheduleTimer) clearTimeout(scheduleTimer);
		scheduleTimer = undefined;
	};
	const clearRecovery = () => {
		if (recoveryTimer) clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
	};

	let scheduleRecovery!: (ctx: ConsolidationCtx, delayMs?: number) => void;

	const schedule = (ctx: ConsolidationCtx, delayMs = runtime.config.consolidationIdleDelayMs) => {
		clearSchedule();
		const lifecycleGeneration = runtime.lifecycleGeneration;
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;
			maybeLaunchStage(pi, runtime, ctx, schedule, scheduleRecovery);
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

			const entries = ctx.sessionManager.getBranch() as Entry[];
			if (latestCompactionBoundaryKey(entries) !== pending.boundaryKey) {
				runtime.clearCompactionDeferral();
				return;
			}

			if (
				runtime.convergenceControlInFlight
				|| runtime.compactInFlight
				|| runtime.compactHookInFlight
				|| !isContextIdle(ctx)
			) {
				scheduleRecovery(ctx);
				return;
			}

			const deadlineReached = Date.now() >= pending.deadlineAt;
			if (pending.state === "ready" || deadlineReached) {
				runtime.markCompactionReady();
				if (runtime.consolidationInFlight) {
					runtime.abortConsolidation(deadlineReached
						? "compaction coverage grace expired"
						: "observer coverage ready");
				}
				requestCompaction(runtime, ctx as any, { force: true });
				if (runtime.pendingCompaction) scheduleRecovery(ctx);
				return;
			}

			if (!runtime.consolidationInFlight) {
				maybeLaunchStage(pi, runtime, ctx, schedule, scheduleRecovery);
			}
			if (runtime.pendingCompaction) {
				const remaining = Math.max(0, pending.deadlineAt - Date.now());
				scheduleRecovery(ctx, Math.min(runtime.config.consolidationIdleDelayMs, remaining));
			}
		}, Math.max(0, delayMs));
	};

	pi.on("agent_start", () => {
		getBackgroundBroker().setForegroundActive(true);
		clearSchedule();
		if (runtime.consolidationInFlight) runtime.abortConsolidation("foreground activity");
	});
	pi.on("agent_end", (event: any, rawCtx: any) => {
		const ctx = rawCtx as ConsolidationCtx;
		lastCtx = ctx;
		const lastAssistant = [...event.messages].reverse().find((message: any) => message?.role === "assistant");
		if (lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error") {
			clearSchedule();
			if (runtime.consolidationInFlight) runtime.abortConsolidation("foreground run ended unsuccessfully");
			return;
		}
		getBackgroundBroker().setForegroundActive(false);
		runtime.ensureConfig(ctx.cwd);
		schedule(ctx);
		if (runtime.pendingCompaction) scheduleRecovery(ctx);
	});

	pi.events.on(OM_COMPACTION_DEFERRED_EVENT, () => {
		if (lastCtx && runtime.pendingCompaction) scheduleRecovery(lastCtx, 0);
	});
	pi.events.on(OM_COMPACTION_CLEARED_EVENT, () => clearRecovery());
	pi.events.on("pi-convergence:state", (event: any) => {
		const phase = event?.phase;
		if (
			phase !== "judging"
			&& phase !== "continuation"
			&& lastCtx
			&& runtime.pendingCompaction
		) scheduleRecovery(lastCtx, 0);
	});

	const invalidate = () => {
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
): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || runtime.consolidationInFlight) return;
	if (runtime.compactInFlight || runtime.compactHookInFlight || runtime.convergenceControlInFlight) return;
	if (!isContextIdle(ctx)) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const due = findDueStage(entries, runtime);
	if (!due) return;
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
		return runStage(pi, runtime, ctx, due.phase, {
			generation,
			signal: leaseSignal,
			sessionId: sessionMetadata.sessionId,
		});
	}))).then((result) => {
		if (result.status === "aborted") {
			if (runtime.pendingCompaction) scheduleRecovery(ctx);
			return;
		}
		if (result.status === "success" && result.phase === "observer" && runtime.compactionDeferred) {
			runtime.markCompactionReady();
			scheduleRecovery(ctx, 0);
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
		if (
			result.phase === "observer"
			&& runtime.compactionDeferred
			&& ((failure?.failures ?? 0) >= 2 || failure?.circuitOpenUntil !== undefined)
		) {
			runtime.markCompactionReady();
			scheduleRecovery(ctx, 0);
			return;
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
	if (!runtime.compactionDeferred && tokens < runtime.config.observeAfterTokens) return true;
	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const chunkEntries = sourceEntriesAfter(entries, lastCoverageIdx);
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
	});
	const coversUpToId = selection.coversUpToId;
	if (!coversUpToId || !selection.chunk.trim() || selection.allowedSourceEntryIds.length === 0) return true;

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
