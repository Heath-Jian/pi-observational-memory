import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockObserver = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/observer/agent.js", () => ({ runObserver: mockObserver }));

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { observation, textCustomMessage, type TestEntry } from "./fixtures/session.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function setup() {
	let entries: TestEntry[] = [
		textCustomMessage("raw-1", "aaaaaaaa"),
		textCustomMessage("raw-2", "bbbbbbbb"),
	];
	const lifecycleHandlers: Record<string, Handler[]> = {};
	const eventHandlers: Record<string, Array<(event: any) => void>> = {};
	const pi = {
		on: vi.fn((name: string, handler: Handler) => {
			(lifecycleHandlers[name] ??= []).push(handler);
		}),
		events: {
			on: vi.fn((name: string, handler: (event: any) => void) => {
				(eventHandlers[name] ??= []).push(handler);
				return () => undefined;
			}),
			emit: vi.fn((name: string, event: any) => {
				for (const handler of eventHandlers[name] ?? []) handler(event);
			}),
		},
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				id: `om-${pi.appendEntry.mock.calls.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-05-02T10:00:00.000Z",
				customType,
				data,
			}];
		}),
	};

	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		compactAfterTokens: 1,
		observeAfterTokens: 999,
		reflectAfterTokens: 999,
		reflectAfterObservationTokens: 999,
		reflectAfterObserverBatches: 999,
		consolidationIdleDelayMs: 1,
		compactionWaitForConsolidationMs: 50,
		observerTimeoutMs: 1_000,
		debugLog: false,
		model: { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "off" },
	};
	vi.spyOn(runtime, "resolveModel").mockResolvedValue({
		ok: true,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		apiKey: "key",
	});

	let pendingMessages = false;
	const ctx: any = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "openai-codex", contextWindow: 272_000 },
		modelRegistry: {},
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => pendingMessages),
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "session-1",
		},
	};

	const emitLifecycle = async (name: string, event: any) => {
		let result: any;
		for (const handler of lifecycleHandlers[name] ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
			if (result?.cancel) break;
		}
		return result;
	};

	let compactionId = 0;
	ctx.compact = vi.fn((options: { onComplete: () => void; onError: (error: Error) => void }) => {
		void (async () => {
			const result = await emitLifecycle("session_before_compact", {
				preparation: { firstKeptEntryId: "raw-2", tokensBefore: 10 },
				branchEntries: entries,
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			});
			if (result?.cancel) {
				options.onError(new Error("Compaction cancelled"));
				return;
			}
			entries = [...entries, {
				type: "compaction",
				id: `cmp-${++compactionId}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				firstKeptEntryId: "raw-2",
				summary: result?.compaction?.summary ?? "native",
				details: result?.compaction?.details,
			}];
			await emitLifecycle("session_compact", {
				compactionEntry: entries.at(-1),
				reason: "manual",
				willRetry: false,
			});
			options.onComplete();
		})();
	});

	registerConsolidationTrigger(pi as any, runtime);
	registerCompactionTrigger(pi as any, runtime);
	registerCompactionHook(pi as any, runtime);

	const fireAgentEnd = async () => {
		const event = {
			messages: [{ role: "assistant", content: [], stopReason: "stop" }],
		};
		for (const handler of lifecycleHandlers.agent_end ?? []) await handler(event, ctx);
	};
	const advance = async (ms: number) => {
		await vi.advanceTimersByTimeAsync(ms);
		await Promise.resolve();
		await Promise.resolve();
	};

	return {
		runtime,
		ctx,
		fireAgentEnd,
		advance,
		setPendingMessages(value: boolean) {
			pendingMessages = value;
		},
		getEntries: () => entries,
	};
}

describe("compaction recovery integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockObserver.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces repeated agent_end events until observer coverage is ready", async () => {
		let releaseObserver: ((value: unknown) => void) | undefined;
		mockObserver.mockImplementation(() => new Promise((resolve) => {
			releaseObserver = resolve;
		}));
		const subject = setup();

		await subject.fireAgentEnd();
		await subject.advance(1);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.runtime.compactionDeferred).toBe(true);

		await subject.fireAgentEnd();
		await subject.advance(1);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		releaseObserver?.([
			observation("aaaaaaaaaaaa", {
				sourceEntryIds: ["raw-1", "raw-2"],
				tokenCount: 10,
			}),
		]);
		await subject.advance(5);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(2);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(subject.runtime.pendingCompaction).toBeUndefined();
	});

	it("keeps a ready retry alive while follow-up messages are pending", async () => {
		let releaseObserver: ((value: unknown) => void) | undefined;
		mockObserver.mockImplementation(() => new Promise((resolve) => {
			releaseObserver = resolve;
		}));
		const subject = setup();

		await subject.fireAgentEnd();
		await subject.advance(1);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		subject.setPendingMessages(true);
		releaseObserver?.([
			observation("aaaaaaaaaaaa", {
				sourceEntryIds: ["raw-1", "raw-2"],
				tokenCount: 10,
			}),
		]);
		await subject.advance(5);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		subject.setPendingMessages(false);
		await subject.advance(5);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(2);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("fails open exactly once when the coverage grace deadline expires", async () => {
		mockObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup();

		await subject.fireAgentEnd();
		await subject.advance(1);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.runtime.compactionDeferred).toBe(true);

		await subject.advance(60);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(2);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(subject.runtime.pendingCompaction).toBeUndefined();
		await subject.advance(100);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(2);
	});

	it("fails open when the observer circuit opens", async () => {
		mockObserver.mockRejectedValue(new Error("observer unavailable"));
		const subject = setup();
		subject.runtime.config.consolidationCircuitBreakerFailures = 1;

		await subject.fireAgentEnd();
		await subject.advance(5);
		expect(mockObserver).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(
			subject.runtime.stageFailureStatus("observer")?.circuitOpenUntil,
		).toBeTypeOf("number"));
		await subject.advance(5);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(2);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(subject.runtime.pendingCompaction).toBeUndefined();
	});
});
