import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionTrigger, requestCompaction } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import { compactionEntry, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function captureHandler(args: { compactAfterTokens?: number; compactAfterTokensMode?: "calibrated" | "ratio"; compactAfterTokensRatio?: number; passive?: boolean; compactInFlight?: boolean } = {}) {
	let agentEndHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let agentSettledHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let convergenceHandler: ((event: unknown) => void) | undefined;
	const pi = {
		on: vi.fn((name: string, cb: typeof agentEndHandler) => {
			if (name === "agent_end") agentEndHandler = cb;
			if (name === "agent_settled") agentSettledHandler = cb;
		}),
		events: {
			on: vi.fn((name: string, cb: typeof convergenceHandler) => {
				expect(name).toBe("pi-convergence:state");
				convergenceHandler = cb;
			}),
		},
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		compactAfterTokens: args.compactAfterTokens ?? 3,
		compactAfterTokensMode: args.compactAfterTokensMode ?? "calibrated",
		compactAfterTokensRatio: args.compactAfterTokensRatio ?? 0.68,
		passive: args.passive ?? false,
	};
	runtime.compactInFlight = args.compactInFlight ?? false;
	vi.spyOn(runtime, "invalidateConsolidation");
	registerCompactionTrigger(pi as any, runtime as any);
	if (!agentEndHandler || !agentSettledHandler) throw new Error("agent lifecycle handlers were not registered");
	return {
		fireAgentEndOnly(event: unknown, ctx: unknown) {
			agentEndHandler?.(event, ctx);
		},
		fireAgentSettled(ctx: unknown) {
			agentSettledHandler?.({ type: "agent_settled" }, ctx);
		},
		handler(event: unknown, ctx: unknown) {
			agentEndHandler?.(event, ctx);
			agentSettledHandler?.({ type: "agent_settled" }, ctx);
		},
		runtime,
		convergenceState(phase: string) {
			convergenceHandler?.({ phase });
		},
	};
}

function agentEnd(errorMessage?: string) {
	return {
		type: "agent_end",
		messages: [
			{ role: "user", content: "hello" },
			errorMessage
				? { role: "assistant", content: [], stopReason: "error", errorMessage }
				: { role: "assistant", content: "done", stopReason: "end_turn" },
		],
	};
}

function fakeCtx(branches: TestEntry[][], overrides: Record<string, unknown> = {}) {
	let branchIndex = 0;
	const getBranch = vi.fn(() => branches[Math.min(branchIndex++, branches.length - 1)]);
	return {
		cwd: "/tmp/project",
		sessionManager: { getBranch },
		hasUI: true,
		ui: { notify: vi.fn() },
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		compact: vi.fn(),
		model: undefined,
		...overrides,
	};
}

const dueBranch = [textCustomMessage("raw-1", "aaaaaaaaaaaa")]; // 3 tokens
const belowBranch = [textCustomMessage("raw-1", "aaaa")]; // 1 token

describe("V3 compaction trigger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does nothing below compactAfterTokens", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([belowBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("calls compact when compactAfterTokens is reached", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		expect(runtime.compactInFlight).toBe(true);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction threshold reached (~3 tokens); triggering compaction",
			"info",
		);
	});

	it("cancels deferred compaction after lifecycle generation changes", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		runtime.lifecycleGeneration = 1;
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips passive mode", async () => {
		const { handler, runtime } = captureHandler({ passive: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("skips when compaction is already in flight", async () => {
		const { handler } = captureHandler({ compactInFlight: true });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("coalesces ordinary agent_end retries while coverage recovery is pending", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		runtime.deferCompaction("raw-1", "root");
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactionDeferralCount).toBe(1);
	});

	it("re-checks deferred state inside the zero-delay callback", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		runtime.deferCompaction("raw-1", "root");
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("drops a forced retry if another compaction changed the boundary first", async () => {
		const { runtime } = captureHandler({ compactAfterTokens: 3 });
		runtime.deferCompaction("raw-1", "root");
		runtime.markCompactionReady();
		const afterNative = [
			...dueBranch,
			compactionEntry("cmp-native", { firstKeptEntryId: "raw-1" }),
			textCustomMessage("raw-2", "aaaaaaaaaaaa"),
		];
		const ctx = fakeCtx([dueBranch, afterNative]);

		requestCompaction(runtime, ctx as any, { force: true });
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactionDeferred).toBe(false);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("applies cancellation cooldown only to ordinary requests and lets force bypass it", async () => {
		const { runtime } = captureHandler({ compactAfterTokens: 3 });
		const ordinaryCtx = fakeCtx([dueBranch]);
		runtime.setCompactionCancelCooldown(60_000);
		requestCompaction(runtime, ordinaryCtx as any);
		await vi.runAllTimersAsync();
		expect(ordinaryCtx.compact).not.toHaveBeenCalled();

		runtime.deferCompaction("raw-1", "root");
		runtime.markCompactionReady();
		const forceCtx = fakeCtx([dueBranch]);
		requestCompaction(runtime, forceCtx as any, { force: true });
		await vi.runAllTimersAsync();
		expect(forceCtx.compact).toHaveBeenCalledTimes(1);
	});

	it("retries a covered manual recovery below the automatic compaction threshold", async () => {
		const { runtime } = captureHandler({ compactAfterTokens: 100 });
		runtime.deferCompaction("raw-1", "root", { origin: "manual", strict: true });
		runtime.markCompactionReady();
		const ctx = fakeCtx([belowBranch]);

		requestCompaction(runtime, ctx as any, { force: true });
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(runtime.pendingCompaction?.state).toBe("ready");
	});

	it("rechecks the checkpoint lease gate in the deferred compact timer", async () => {
		const { runtime } = captureHandler({ compactAfterTokens: 100 });
		runtime.deferCompaction("raw-1", "root", { origin: "manual", strict: true });
		runtime.markCompactionReady();
		const ctx = fakeCtx([belowBranch]);
		let leaseValid = true;

		requestCompaction(runtime, ctx as any, { force: true, canRun: () => leaseValid });
		expect(runtime.compactInFlight).toBe(true);
		leaseValid = false;
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.pendingCompaction?.state).toBe("ready");
	});

	it("never force-retries a blocked strict recovery", async () => {
		const { runtime } = captureHandler({ compactAfterTokens: 1 });
		runtime.deferCompaction("raw-1", "root", { origin: "manual", strict: true });
		runtime.blockCompactionRecovery("observer unavailable");
		const ctx = fakeCtx([dueBranch]);

		requestCompaction(runtime, ctx as any, { force: true });
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.pendingCompaction?.state).toBe("blocked");
	});

	it("waits for agent_settled, then evaluates compaction after a final retryable error", async () => {
		const { fireAgentEndOnly, fireAgentSettled, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		fireAgentEndOnly(agentEnd("fetch failed: connection lost"), ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();

		fireAgentSettled(ctx);
		await vi.runAllTimersAsync();
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("does not carry an agent_end compaction latch across lifecycle invalidation", async () => {
		const { fireAgentEndOnly, fireAgentSettled, runtime } = captureHandler();
		const ctx = fakeCtx([dueBranch]);

		fireAgentEndOnly(agentEnd(), ctx);
		runtime.invalidateConsolidation();
		fireAgentSettled(ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("does not await observer or reflect/drop promises before compacting", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("defers compaction if context is no longer idle", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { isIdle: vi.fn(() => false) });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction deferred — agent became busy before compaction",
			"info",
		);
	});

	it("defers compaction while a convergence follow-up is pending", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch], { hasPendingMessages: vi.fn(() => true) });

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("defers compaction while convergence is awaiting its Judge", async () => {
		const { handler, runtime, convergenceState } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler(agentEnd(), ctx);
		convergenceState("judging");
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
	});

	it("invalidates memory work when convergence reports an abort outside agent_end", () => {
		const { runtime, convergenceState } = captureHandler({ compactAfterTokens: 3 });

		convergenceState("aborted");

		expect(runtime.invalidateConsolidation).toHaveBeenCalledTimes(1);
	});

	it("never compacts an explicitly aborted run", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch]);

		handler({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
		}, ctx);
		await vi.runAllTimersAsync();

		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});

	it("re-checks threshold after deferral and skips if another compaction already reduced pressure", async () => {
		const { handler, runtime } = captureHandler({ compactAfterTokens: 3 });
		const ctx = fakeCtx([dueBranch, belowBranch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(runtime.compactInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
			"info",
		);
	});

	it("counts raw tokens since the latest Pi compaction using V3 progress helpers", async () => {
		const { handler } = captureHandler({ compactAfterTokens: 3 });
		const branch = [
			textCustomMessage("raw-1", "aaaaaaaaaaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			textCustomMessage("raw-2", "aaaa"),
			textCustomMessage("raw-3", "bbbbbbbb"),
		];
		const ctx = fakeCtx([branch]);

		handler(agentEnd(), ctx);
		await vi.runAllTimersAsync();

		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	describe("ratio mode", () => {
		it("scales the compaction threshold by model.contextWindow", async () => {
			// 3 tokens raw; ratio 0.5 of 4-token window = 2 -> threshold 2, so 3 >= 2 fires.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 4 } });

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).toHaveBeenCalledTimes(1);
		});

		it("does not compact when raw tokens are below the scaled threshold", async () => {
			// 1 token raw (belowBranch); ratio 0.5 of 4 = 2 -> threshold 2, so 1 < 2 does not fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([belowBranch], { model: { contextWindow: 4 } });

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when model.contextWindow is unavailable", async () => {
			// ratio mode but no model -> falls back to compactAfterTokens=81000, so 3 tokens won't fire.
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: undefined });

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("falls back to calibrated value when contextWindow is zero", async () => {
			const { handler } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch], { model: { contextWindow: 0 } });

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
		});

		it("uses the same resolved threshold on deferred re-check", async () => {
			// threshold = 0.5 * 4 = 2; first branch has 3 (fires, deferred), isIdle=false defers,
			// second branch has 1 (< 2) -> skipped because another compaction reduced pressure.
			const { handler, runtime } = captureHandler({
				compactAfterTokens: 81000,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
			const ctx = fakeCtx([dueBranch, belowBranch], {
				model: { contextWindow: 4 },
				isIdle: vi.fn(() => false),
			});

			handler(agentEnd(), ctx);
			await vi.runAllTimersAsync();

			expect(ctx.compact).not.toHaveBeenCalled();
			expect(runtime.compactInFlight).toBe(false);
		});
	});
});
