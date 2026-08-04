import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observer: vi.fn(), verifier: vi.fn() }));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mocks.observer,
	runCoverageVerifier: mocks.verifier,
}));

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	foldLedger,
	isSourceEntry,
	latestCoverageMarkerId,
	OM_OBSERVATIONS_RECORDED,
	rawTokensSinceObservationCoverage,
} from "../src/session-ledger/index.js";
import { observation, textCustomMessage, type TestEntry } from "./fixtures/session.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function setup(options: {
	entries?: TestEntry[];
	firstKeptEntryId?: string;
	observerChunkMaxTokens?: number;
	observerChunkOutputReserveTokens?: number;
	compactionWaitForConsolidationMs?: number;
} = {}) {
	let entries: TestEntry[] = options.entries ?? [
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
		allowNativeCompactionFallback: false,
		compactAfterTokens: 1,
		observeAfterTokens: 999,
		reflectAfterTokens: 999,
		reflectAfterObservationTokens: 999,
		reflectAfterObserverBatches: 999,
		consolidationIdleDelayMs: 1,
		compactionWaitForConsolidationMs: options.compactionWaitForConsolidationMs ?? 50,
		observerTimeoutMs: 1_000,
		observerChunkMaxTokens: options.observerChunkMaxTokens ?? 0,
		observerChunkOutputReserveTokens: options.observerChunkOutputReserveTokens ?? 8_000,
		debugLog: false,
		observerEmptyCoverageCommit: true,
		observerCoverageVerifyModel: { provider: "openai-codex", id: "coverage-verifier", thinking: "off" },
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
		modelRegistry: {
			find: vi.fn((provider: string, id: string) => ({ provider, id })),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "verifier-key" })),
		},
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
	ctx.compact = vi.fn((callbacks: { onComplete: () => void; onError: (error: Error) => void }) => {
		void (async () => {
			const result = await emitLifecycle("session_before_compact", {
				preparation: { firstKeptEntryId: options.firstKeptEntryId ?? "raw-2", tokensBefore: 10 },
				branchEntries: entries,
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			});
			if (result?.cancel) {
				callbacks.onError(new Error("Compaction cancelled"));
				return;
			}
			entries = [...entries, {
				type: "compaction",
				id: `cmp-${++compactionId}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				firstKeptEntryId: options.firstKeptEntryId ?? "raw-2",
				summary: result?.compaction?.summary ?? "native",
				details: result?.compaction?.details,
			}];
			await emitLifecycle("session_compact", {
				compactionEntry: entries.at(-1),
				reason: "manual",
				willRetry: false,
			});
			callbacks.onComplete();
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
		for (const handler of lifecycleHandlers.agent_settled ?? []) {
			await handler({ type: "agent_settled" }, ctx);
		}
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
		appendSource(id: string, text: string) {
			entries = [...entries, textCustomMessage(id, text)];
		},
		getEntries: () => entries,
	};
}

function expectNoUnrecoverableUncoveredBoundary(
	before: TestEntry[],
	after: TestEntry[],
	coverageMarkerId?: string,
): void {
	const markerIndex = coverageMarkerId ? before.findIndex((entry) => entry.id === coverageMarkerId) : -1;
	const uncovered = before.slice(markerIndex + 1).filter(isSourceEntry);
	const afterById = new Map(after.map((entry) => [entry.id, entry]));
	for (const source of uncovered) {
		// Covered history before the marker may be compacted normally. The oracle
		// only rejects crossing an uncovered boundary that would make replay impossible.
		expect(afterById.get(source.id)).toEqual(source);
	}
}

describe("compaction recovery integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.observer.mockReset();
		mocks.verifier.mockReset().mockResolvedValue({ stats: { toolCalls: 0, toolErrors: 0, stopReason: "stop" } });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps a bounded strict recovery waiting until the third batch covers the cut", async () => {
		const releases: Array<(value: unknown) => void> = [];
		mocks.observer.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "a".repeat(20_000)),
				textCustomMessage("raw-2", "b".repeat(20_000)),
				textCustomMessage("raw-3", "c".repeat(20_000)),
				textCustomMessage("raw-4", "d".repeat(20_000)),
			],
			firstKeptEntryId: "raw-4",
			observerChunkMaxTokens: 12_000,
			observerChunkOutputReserveTokens: 1_000,
			compactionWaitForConsolidationMs: 5_000,
		});

		await subject.fireAgentEnd();
		await subject.advance(1);
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		releases[0]([observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 })]);
		await subject.advance(2);
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		releases[1]([observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 })]);
		await subject.advance(2);
		await vi.waitFor(() => expect(releases).toHaveLength(3));
		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);

		releases[2]([observation("cccccccccccc", { sourceEntryIds: ["raw-3"], tokenCount: 10 })]);
		await subject.advance(5);
		await vi.waitFor(() => expect(subject.ctx.compact).toHaveBeenCalledTimes(2));
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(subject.runtime.pendingCompaction).toBeUndefined();
	});

	it("coalesces repeated agent_end events until observer coverage is ready", async () => {
		let releaseObserver: ((value: unknown) => void) | undefined;
		mocks.observer.mockImplementation(() => new Promise((resolve) => {
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
		mocks.observer.mockImplementation(() => new Promise((resolve) => {
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

	it("blocks strict recovery when its effective observer budget is exhausted without invoking native compaction (I1/I3)", async () => {
		mocks.observer.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup();
		const before = subject.getEntries();

		await subject.fireAgentEnd();
		await subject.advance(1);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.runtime.compactionDeferred).toBe(true);

		await subject.advance(60);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(subject.runtime.pendingCompaction?.state).toBe("blocked");
		expectNoUnrecoverableUncoveredBoundary(before, subject.getEntries());
		await subject.advance(100);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("blocks strict recovery when the observer circuit opens without invoking native compaction (I1/I3)", async () => {
		mocks.observer.mockRejectedValue(new Error("observer unavailable"));
		const subject = setup();
		const before = subject.getEntries();
		subject.runtime.config.consolidationCircuitBreakerFailures = 1;

		await subject.fireAgentEnd();
		await subject.advance(5);
		expect(mocks.observer).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(
			subject.runtime.stageFailureStatus("observer")?.circuitOpenUntil,
		).toBeTypeOf("number"));
		await subject.advance(5);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(subject.runtime.pendingCompaction?.state).toBe("blocked");
		expectNoUnrecoverableUncoveredBoundary(before, subject.getEntries());
		await subject.advance(100);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("restores a covered-empty marker after compaction and resumes strictly after it (I2/I3)", async () => {
		mocks.observer.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		mocks.verifier.mockResolvedValueOnce({
			verdict: { hasRecordableContent: false, reason: "No recordable content." },
			stats: { toolCalls: 1, toolErrors: 0, stopReason: "toolUse" },
		});
		const subject = setup();

		await subject.fireAgentEnd();
		await subject.advance(10);
		await vi.waitFor(() => expect(subject.getEntries().some((entry) => entry.type === "compaction")).toBe(true));

		const restartedEntries = subject.getEntries();
		expect(latestCoverageMarkerId(restartedEntries as any, OM_OBSERVATIONS_RECORDED)).toBe("raw-1");
		expect(foldLedger(restartedEntries as any).activeObservations).toEqual([]);
		expect(rawTokensSinceObservationCoverage(restartedEntries as any)).toBeGreaterThan(0);

		subject.appendSource("raw-3", "cccccccc");
		subject.runtime.config.observeAfterTokens = 1;
		const beforeReplay = subject.getEntries();
		expectNoUnrecoverableUncoveredBoundary(beforeReplay, subject.getEntries(), "raw-2");
		mocks.observer.mockResolvedValueOnce([
			observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-3"], tokenCount: 2 }),
		]);
		await subject.fireAgentEnd();
		await subject.advance(5);
		await vi.waitFor(() => expect(mocks.observer).toHaveBeenCalledTimes(2));
		const replayChunk = mocks.observer.mock.calls[1][0].chunk as string;
		expect(replayChunk).toContain("raw-3");
		expect(replayChunk).toContain("raw-2");
		expect(replayChunk).not.toContain("raw-1");
	});
});
