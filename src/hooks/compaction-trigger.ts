import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";

const COMPACTION_CANCEL_COOLDOWN_MS = 15_000;

type CompactionCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model?: { contextWindow?: number; provider?: string; id?: string };
	isIdle: () => boolean;
	hasPendingMessages?: () => boolean;
	compact: (options: {
		onComplete: () => void;
		onError: (error: { message: string }) => void;
	}) => void;
	sessionManager: { getBranch: () => unknown };
};

function latestCompactionBoundaryKey(entries: Entry[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index].type === "compaction") return entries[index].id;
	}
	return "root";
}

function compactionThreshold(runtime: Runtime, ctx: CompactionCtx): number {
	const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
	const model = {
		provider: typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined,
		id: typeof ctx.model?.id === "string" ? ctx.model.id : undefined,
	};
	return resolveCompactAfterTokens(runtime.config, contextWindow, model);
}

export function requestCompaction(
	runtime: Runtime,
	ctx: CompactionCtx,
	options: { force?: boolean; canRun?: () => boolean } = {},
): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || runtime.compactInFlight) return;
	if (options.canRun && !options.canRun()) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const boundaryKey = latestCompactionBoundaryKey(entries);
	const tokens = rawTokensSinceLastCompaction(entries);
	const threshold = compactionThreshold(runtime, ctx);
	const now = Date.now();
	const pending = runtime.pendingCompaction;

	if (pending && (
		pending.lifecycleGeneration !== runtime.lifecycleGeneration
		|| pending.boundaryKey !== boundaryKey
	)) {
		runtime.clearCompactionDeferral();
	}

	const currentPending = runtime.pendingCompaction;
	if (currentPending?.state === "blocked") return;
	const force = currentPending?.state === "ready"
		&& (options.force === true || !runtime.isDeferredGraceActive(now));

	if (options.force && !currentPending) return;
	if (options.force && currentPending?.state !== "ready") return;
	if (currentPending && !force) return;
	if (!force && runtime.compactionCancelCooldownUntil > now) return;
	if (!force && tokens < threshold) return;

	if (ctx.hasUI) ctx.ui?.notify(
		force
			? `Observational memory: retrying deferred compaction (~${tokens.toLocaleString()} tokens)`
			: `Observational memory: compaction threshold reached (~${tokens.toLocaleString()} tokens); triggering compaction`,
		"info",
	);
	runtime.compactInFlight = true;
	const lifecycleGeneration = runtime.lifecycleGeneration;
	setTimeout(() => {
		const releaseScheduledAttempt = () => {
			if (runtime.isLifecycleCurrent(lifecycleGeneration)) runtime.compactInFlight = false;
		};

		try {
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;
			if (options.canRun && !options.canRun()) {
				releaseScheduledAttempt();
				return;
			}
			if (runtime.config.passive) {
				runtime.clearCompactionState();
				return;
			}

			const currentEntries = ctx.sessionManager.getBranch() as Entry[];
			const currentBoundaryKey = latestCompactionBoundaryKey(currentEntries);
			if (currentBoundaryKey !== boundaryKey) {
				runtime.clearCompactionDeferral();
				releaseScheduledAttempt();
				return;
			}

			const deferred = runtime.pendingCompaction;
			if (force) {
				if (
					!deferred
					|| deferred.lifecycleGeneration !== lifecycleGeneration
					|| deferred.boundaryKey !== currentBoundaryKey
				) {
					releaseScheduledAttempt();
					return;
				}
			} else if (deferred || runtime.compactionCancelCooldownUntil > Date.now()) {
				releaseScheduledAttempt();
				return;
			}

			if (runtime.convergenceControlInFlight || !ctx.isIdle() || ctx.hasPendingMessages?.()) {
				releaseScheduledAttempt();
				if (ctx.hasUI) ctx.ui?.notify("Observational memory: compaction deferred — agent became busy before compaction", "info");
				return;
			}

			const currentTokens = rawTokensSinceLastCompaction(currentEntries);
			const currentThreshold = compactionThreshold(runtime, ctx);
			if (!force && currentTokens < currentThreshold) {
				releaseScheduledAttempt();
				if (ctx.hasUI) ctx.ui?.notify("Observational memory: compaction skipped — another compaction already ran before deferred compaction", "info");
				return;
			}

			const attempt = runtime.beginCompactionAttempt(force ? "force" : "proactive", currentBoundaryKey);
			ctx.compact({
				onComplete: () => {
					if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;
					runtime.finishCompactionAttempt(attempt.id);
					runtime.clearCompactionState();
					if (ctx.hasUI) ctx.ui?.notify("Observational memory: compaction complete", "info");
				},
				onError: (error) => {
					if (
						!runtime.isLifecycleCurrent(lifecycleGeneration)
						|| !runtime.isCompactionAttemptCurrent(attempt.id)
					) return;
					runtime.finishCompactionAttempt(attempt.id);
					runtime.compactInFlight = false;
					if (error.message === "Compaction cancelled") {
						if (attempt.kind === "force") {
							if (!runtime.pendingCompaction) {
								runtime.setCompactionCancelCooldown(COMPACTION_CANCEL_COOLDOWN_MS);
							}
						} else if (!runtime.compactionDeferred) {
							runtime.setCompactionCancelCooldown(COMPACTION_CANCEL_COOLDOWN_MS);
						}
						return;
					}
					if (attempt.kind === "force") {
						if (runtime.pendingCompaction?.strict) {
							runtime.blockCompactionRecovery(error.message);
						} else {
							runtime.clearCompactionDeferral();
							runtime.setCompactionCancelCooldown(COMPACTION_CANCEL_COOLDOWN_MS);
						}
					}
					if (ctx.hasUI) ctx.ui?.notify(`Observational memory: ${error.message}`, "error");
				},
			});
		} catch (error) {
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return;
			const activeAttempt = runtime.activeCompactionAttempt;
			if (activeAttempt) {
				runtime.finishCompactionAttempt(activeAttempt.id);
				if (activeAttempt.kind === "force") {
					if (runtime.pendingCompaction?.strict) {
						runtime.blockCompactionRecovery(error instanceof Error ? error.message : String(error));
					} else {
						runtime.clearCompactionDeferral();
						runtime.setCompactionCancelCooldown(COMPACTION_CANCEL_COOLDOWN_MS);
					}
				}
			}
			releaseScheduledAttempt();
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui?.notify(`Observational memory: compact threw: ${message}`, "error");
		}
	}, 0);
}

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	let compactWhenSettledGeneration: number | undefined;

	pi.events.on("pi-convergence:state", (event: any) => {
		const phase = event?.phase;
		if (phase === "aborted") {
			runtime.invalidateConsolidation();
			return;
		}
		runtime.convergenceControlInFlight = phase === "judging" || phase === "continuation";
	});

	pi.on("agent_end", (event: any) => {
		const lastAssistant = [...event.messages].reverse().find(
			(message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant",
		);
		compactWhenSettledGeneration = lastAssistant?.stopReason === "aborted"
			? undefined
			: runtime.lifecycleGeneration;
	});

	pi.on("agent_settled", (_event: any, ctx: CompactionCtx) => {
		const generation = compactWhenSettledGeneration;
		compactWhenSettledGeneration = undefined;
		if (generation === undefined || !runtime.isLifecycleCurrent(generation)) return;
		requestCompaction(runtime, ctx);
	});
}
