import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" }, allowCrossProvider: true };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("requires explicit permission before using a configured cross-provider model", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai", id: "session" };
		const registry = modelRegistry({ found: { provider: "anthropic", id: "configured" } });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" }, allowCrossProvider: false };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(registry.find).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("cross-provider model"), "warning");
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" }, allowCrossProvider: true };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("never falls back to the session model during strict recovery when no memory model is configured", async () => {
		const runtime = new Runtime();
		const registry = modelRegistry();
		runtime.deferCompaction("raw-2", "root", { origin: "manual", strict: true });

		const result = await runtime.resolveModel({
			model: { provider: "openai", id: "session" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({
			ok: false,
			reason: "strict compaction recovery requires a configured observational-memory model",
		});
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("never falls back to the session model when the configured strict recovery model is unavailable", async () => {
		const runtime = new Runtime();
		const registry = modelRegistry();
		runtime.config = {
			...runtime.config,
			model: { provider: "anthropic", id: "missing" },
			allowCrossProvider: true,
		};
		runtime.deferCompaction("raw-2", "root", { origin: "overflow", strict: true });

		const result = await runtime.resolveModel({
			model: { provider: "openai", id: "session" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({
			ok: false,
			reason: "configured strict recovery model anthropic/missing was not found",
		});
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("fails closed before lookup when strict recovery cross-provider access is disabled", async () => {
		const runtime = new Runtime();
		const registry = modelRegistry({ found: { provider: "anthropic", id: "memory" } });
		runtime.config = {
			...runtime.config,
			model: { provider: "anthropic", id: "memory" },
			allowCrossProvider: false,
		};
		runtime.deferCompaction("raw-2", "root", { origin: "threshold", strict: true });

		const result = await runtime.resolveModel({
			model: { provider: "openai", id: "session" },
			modelRegistry: registry,
			hasUI: false,
		});

		expect(result).toEqual({
			ok: false,
			reason: "strict compaction recovery cannot use cross-provider model anthropic/memory while allowCrossProvider is false",
		});
		expect(registry.find).not.toHaveBeenCalled();
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key for provider "anthropic"',
		});
	});

	it("aborts model authentication that never resolves", async () => {
		const runtime = new Runtime();
		const controller = new AbortController();
		const pending = runtime.resolveModel({
			model: { provider: "anthropic" },
			modelRegistry: modelRegistry({ auth: new Promise(() => undefined) }),
			hasUI: false,
		}, controller.signal);
		controller.abort("test abort");
		await expect(pending).resolves.toEqual({ ok: false, reason: "model resolution aborted" });
	});

	it("times out a consolidation task whose model stream never settles", async () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, observerTimeoutMs: 10 };
		let signal: AbortSignal | undefined;
		const promise = runtime.launchConsolidationTask({ hasUI: false }, "observer", "raw-1", async (activeSignal) => {
			signal = activeSignal;
			await new Promise<boolean>(() => undefined);
		});

		await expect(promise).resolves.toMatchObject({ status: "failed", phase: "observer", watermark: "raw-1" });
		expect(signal?.aborted).toBe(true);
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.stageFailureStatus("observer")?.failures).toBe(1);
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, "observer", "raw-1", async () => {
			await work;
			return true;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("invalidates and aborts stale consolidation without letting its finalizer clobber a new run", async () => {
		const runtime = new Runtime();
		let oldSignal: AbortSignal | undefined;
		let releaseOld: (() => void) | undefined;
		const oldWork = new Promise<void>((resolve) => { releaseOld = resolve; });
		const oldPromise = runtime.launchConsolidationTask({ hasUI: false }, "observer", "raw-1", async (signal) => {
			oldSignal = signal;
			await oldWork;
			return true;
		});

		runtime.invalidateConsolidation();
		expect(oldSignal?.aborted).toBe(true);
		expect(runtime.consolidationInFlight).toBe(false);

		let releaseNew: (() => void) | undefined;
		const newWork = new Promise<void>((resolve) => { releaseNew = resolve; });
		const newPromise = runtime.launchConsolidationTask({ hasUI: false }, "reflector", "raw-2", async () => {
			await newWork;
			return true;
		});
		releaseOld?.();
		await oldPromise;
		expect(runtime.consolidationPromise).toBe(newPromise);
		expect(runtime.consolidationInFlight).toBe(true);
		releaseNew?.();
		await newPromise;
		expect(runtime.consolidationInFlight).toBe(false);
	});

	it("invalidating a lifecycle aborts waiters and creates a fresh lifecycle signal", () => {
		const runtime = new Runtime();
		const oldSignal = runtime.lifecycleSignal;

		runtime.invalidateConsolidation();

		expect(oldSignal.aborted).toBe(true);
		expect(runtime.lifecycleSignal).not.toBe(oldSignal);
		expect(runtime.lifecycleSignal.aborted).toBe(false);
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("backs off failures by phase and watermark and resets after success", async () => {
		const runtime = new Runtime();
		const first = await runtime.launchConsolidationTask({ hasUI: false }, "observer", "raw-1", async () => false);
		expect(first.status).toBe("failed");
		expect(runtime.stageRetryAt("observer", "raw-1", Date.now())).toBeTypeOf("number");
		expect(runtime.stageRetryAt("observer", "raw-2", Date.now())).toBeUndefined();

		const success = await runtime.launchConsolidationTask({ hasUI: false }, "observer", "raw-2", async () => true);
		expect(success.status).toBe("success");
		expect(runtime.stageFailureStatus("observer")).toBeUndefined();
	});

	it("tracks compaction deferrals across changing cut ids until the cycle clears", () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, compactionWaitForConsolidationMs: 50 };
		expect(runtime.deferCompaction("cut-1", "root", 100)).toBe(1);
		expect(runtime.pendingCompaction).toMatchObject({
			boundaryKey: "root",
			cutKey: "cut-1",
			origin: "proactive",
			strict: false,
			startedAt: 100,
			deadlineAt: 150,
			state: "waiting_coverage",
		});
		expect(runtime.deferCompaction("cut-1", "root", 120)).toBe(2);
		expect(runtime.deferCompaction("cut-2", "root", 140)).toBe(3);
		expect(runtime.compactionDeferralKey).toBe("cut-2");
		expect(runtime.pendingCompaction?.deadlineAt).toBe(150);
		runtime.markCompactionReady();
		expect(runtime.pendingCompaction?.state).toBe("ready");
		runtime.clearCompactionDeferral();
		expect(runtime.compactionDeferred).toBe(false);
		expect(runtime.compactionDeferralCount).toBe(0);
		expect(runtime.deferCompaction("cut-3")).toBe(1);
	});

	it("charges the recovery budget only while explicitly resumed", () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, compactionWaitForConsolidationMs: 50 };
		runtime.deferCompaction("cut-1", "root", { now: 100, origin: "manual", strict: true });

		expect(runtime.compactionRecoveryBudgetRemaining(1_000)).toBe(50);
		expect(runtime.isCompactionRecoveryBudgetRunning()).toBe(false);
		expect(runtime.resumeCompactionRecoveryBudget(1_000)).toBe(true);
		expect(runtime.pendingCompaction?.deadlineAt).toBe(1_050);
		expect(runtime.compactionRecoveryBudgetRemaining(1_020)).toBe(30);

		expect(runtime.pauseCompactionRecoveryBudget(1_030)).toBe(20);
		expect(runtime.compactionRecoveryBudgetRemaining(10_000)).toBe(20);
		expect(runtime.isCompactionRecoveryBudgetExpired(10_000)).toBe(false);

		expect(runtime.resumeCompactionRecoveryBudget(10_000)).toBe(true);
		expect(runtime.isCompactionRecoveryBudgetExpired(10_019)).toBe(false);
		expect(runtime.isCompactionRecoveryBudgetExpired(10_020)).toBe(true);
	});

	it("blocks and explicitly restarts strict recovery without losing its target", () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, compactionWaitForConsolidationMs: 50 };
		runtime.deferCompaction("cut-1", "root", { now: 100, origin: "manual", strict: true });
		runtime.blockCompactionRecovery("observer unavailable", 500);

		expect(runtime.pendingCompaction).toMatchObject({
			cutKey: "cut-1",
			origin: "manual",
			strict: true,
			state: "blocked",
			lastError: "observer unavailable",
			retryAt: 500,
		});
		expect(runtime.restartCompactionRecovery(1_000)).toBe(true);
		expect(runtime.pendingCompaction).toMatchObject({
			cutKey: "cut-1",
			state: "waiting_coverage",
			startedAt: 1_000,
			deadlineAt: 1_050,
		});
		expect(runtime.pendingCompaction?.lastError).toBeUndefined();
	});

	it("starts a new recovery cycle when the compaction boundary changes", () => {
		const runtime = new Runtime();
		runtime.config = { ...runtime.config, compactionWaitForConsolidationMs: 50 };
		runtime.deferCompaction("cut-1", "root", { now: 100, origin: "manual", strict: true });
		runtime.deferCompaction("cut-2", "cmp-1", { now: 200, origin: "overflow", strict: true });

		expect(runtime.compactionDeferralCount).toBe(1);
		expect(runtime.pendingCompaction).toMatchObject({
			boundaryKey: "cmp-1",
			cutKey: "cut-2",
			origin: "overflow",
			startedAt: 200,
			deadlineAt: 250,
		});
	});

	it("uses attempt ids so stale callbacks cannot clear a newer compaction", () => {
		const runtime = new Runtime();
		const first = runtime.beginCompactionAttempt("proactive", "root");
		const second = runtime.beginCompactionAttempt("force", "root");

		runtime.finishCompactionAttempt(first.id);
		expect(runtime.activeCompactionAttempt?.id).toBe(second.id);
		runtime.finishCompactionAttempt(second.id);
		expect(runtime.activeCompactionAttempt).toBeUndefined();
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});
});
