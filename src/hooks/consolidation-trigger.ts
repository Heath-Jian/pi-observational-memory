import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { getBackgroundBroker, withBackgroundLease } from "../background-broker.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { type ConsolidationPhase, type ResolveResult, type Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
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
	const coversUpToId = chunkEntries.at(-1)?.id;
	if (!coversUpToId) return true;
	const { text: chunk, sourceEntryIds } = serializeSourceAddressedBranchEntries(chunkEntries);
	if (!chunk.trim() || sourceEntryIds.length === 0) return true;

	const memory = fullProjection(entries);
	if (ctx.hasUI) ctx.ui?.notify(`Observational memory: observer running on ~${tokens.toLocaleString()}-token chunk`, "info");
	debugLog("observer.start", { tokens, coversUpToId, sourceEntryCount: sourceEntryIds.length });
	const resolved = await resolveModel("observer");
	if (!resolved || !isRunCurrent(runtime, ctx, run)) return false;
	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections: memory.reflections.map(reflectionToSummaryLine),
		priorObservations: memory.observations.map(observationToSummaryLine),
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		signal: run.signal,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
	});
	if (!isRunCurrent(runtime, ctx, run) || !observations?.length) return false;
	const data = buildObservationsRecordedData(observations, coversUpToId);
	if (!data) return false;
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	if (ctx.hasUI) ctx.ui?.notify(`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`, "info");
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
	if (ctx.hasUI) ctx.ui?.notify(
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
	if (ctx.hasUI) ctx.ui?.notify(
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
