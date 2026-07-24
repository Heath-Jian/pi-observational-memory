import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	observationCoverageIncludesCompactionPrefix,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";
import {
	OM_COMPACTION_CLEARED_EVENT,
	OM_COMPACTION_DEFERRED_EVENT,
} from "./compaction-events.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive) {
			runtime.clearCompactionState();
			pi.events.emit(OM_COMPACTION_CLEARED_EVENT, { reason: "passive" });
			return undefined;
		}

		const activeAttempt = runtime.activeCompactionAttempt;
		const omOwnedAttempt = event.reason === "manual"
			&& activeAttempt?.lifecycleGeneration === runtime.lifecycleGeneration;

		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("Observational memory: another compaction hook is already running; using Pi native compaction", "warning");
			return undefined;
		}

		runtime.compactHookInFlight = true;
		const lifecycleGeneration = runtime.lifecycleGeneration;
		try {
			if (event.signal?.aborted) return undefined;
			const { preparation } = event;
			const branchEntries = (typeof ctx.sessionManager?.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: event.branchEntries) as Entry[];
			const firstKeptEntryId = preparation.firstKeptEntryId as string;

			if (!observationCoverageIncludesCompactionPrefix(branchEntries, firstKeptEntryId)) {
				const canDeferForCoverage = omOwnedAttempt
					&& activeAttempt.kind === "proactive"
					&& !runtime.compactionDeferred;

				if (!canDeferForCoverage) {
					runtime.clearCompactionDeferral();
					pi.events.emit(OM_COMPACTION_CLEARED_EVENT, { reason: `fail-open:${event.reason}` });
					if (runtime.consolidationInFlight) runtime.abortConsolidation("native compaction fallback");
					if (ctx.hasUI) ctx.ui.notify(
						"Observational memory: observer coverage is incomplete; using Pi native compaction",
						"warning",
					);
					return undefined;
				}

				const deferralKey = firstKeptEntryId ?? "unknown-cut";
				runtime.deferCompaction(deferralKey, activeAttempt.boundaryKey);
				pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, {
					lifecycleGeneration,
					boundaryKey: activeAttempt.boundaryKey,
				});
				if (ctx.hasUI) ctx.ui.notify(
					"Observational memory: compaction deferred once — observer has not covered the history selected for removal",
					"info",
				);
				return { cancel: true };
			}

			if (runtime.consolidationInFlight) runtime.abortConsolidation("compaction using committed memory");
			if (!runtime.isLifecycleCurrent(lifecycleGeneration)) return undefined;
			const projection = buildCompactionProjection(
				branchEntries,
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			if (runtime.isLifecycleCurrent(lifecycleGeneration)) runtime.compactHookInFlight = false;
		}
	});

	pi.on("session_compact", () => {
		runtime.clearCompactionState();
		pi.events.emit(OM_COMPACTION_CLEARED_EVENT, { reason: "session_compact" });
	});
}
