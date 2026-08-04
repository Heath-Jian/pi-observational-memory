import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import { OM_COMPACTION_RECOVERY_REQUESTED_EVENT } from "../hooks/compaction-events.js";
import type { Entry } from "../session-ledger/index.js";

function latestCompactionBoundaryKey(entries: Entry[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index].type === "compaction") return entries[index].id;
	}
	return "root";
}

export function registerRecoverCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:recover", {
		description: "Resume an existing observational-memory compaction recovery",
		handler: async (_args, ctx) => {
			runtime.ensureConfig(ctx.cwd);
			let pending = runtime.pendingCompaction;
			if (!pending) {
				ctx.ui.notify("Observational memory: no compaction recovery is pending", "info");
				return;
			}
			if (runtime.config.passive) {
				ctx.ui.notify("Observational memory: recovery is unavailable while passive mode is enabled", "warning");
				return;
			}

			const lifecycleGeneration = runtime.lifecycleGeneration;
			const boundaryKey = pending.boundaryKey;
			await ctx.waitForIdle();
			pending = runtime.pendingCompaction;
			const currentBoundaryKey = latestCompactionBoundaryKey(ctx.sessionManager.getBranch() as Entry[]);
			if (
				!pending
				|| pending.lifecycleGeneration !== lifecycleGeneration
				|| pending.boundaryKey !== boundaryKey
				|| currentBoundaryKey !== boundaryKey
			) {
				if (pending && currentBoundaryKey !== pending.boundaryKey) runtime.clearCompactionDeferral();
				ctx.ui.notify("Observational memory: recovery target is stale for the current session branch", "warning");
				return;
			}

			const previousState = pending.state;
			if (previousState === "blocked") runtime.restartCompactionRecovery();
			pi.events.emit(OM_COMPACTION_RECOVERY_REQUESTED_EVENT, {
				ctx,
				lifecycleGeneration,
				boundaryKey,
			});
			ctx.ui.notify(
				previousState === "ready"
					? "Observational memory: retrying the covered compaction"
					: "Observational memory: compaction recovery resumed",
				"info",
			);
		},
	});
}
