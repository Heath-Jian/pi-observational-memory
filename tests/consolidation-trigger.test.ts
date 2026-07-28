import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { registerConsolidationTrigger, selectObserverChunk } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	vi.useFakeTimers();
	mockAgents.runObserver.mockReset().mockResolvedValue(undefined);
	mockAgents.runReflector.mockReset().mockResolvedValue(undefined);
	mockAgents.runDropper.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

function setup(args: {
	entries: TestEntry[];
	passive?: boolean;
	observeAfterTokens?: number;
	observerChunkMaxTokens?: number;
	observerChunkOverlapEntries?: number;
	observerChunkOutputReserveTokens?: number;
	reflectAfterTokens?: number;
	reflectAfterObservationTokens?: number;
	reflectAfterObserverBatches?: number;
	observationsPoolTargetTokens?: number;
	compactAfterTokens?: number;
	compactionWaitForConsolidationMs?: number;
	showWorkerNotifications?: boolean;
}) {
	let entries = [...args.entries];
	const handlers: Record<string, ((event: any, ctx: any) => void) | undefined> = {};
	const eventHandlers: Record<string, Array<(event: any) => void>> = {};
	const pi = {
		on: vi.fn((eventName: string, handler: (event: any, ctx: any) => void) => {
			handlers[eventName] = handler;
		}),
		events: {
			on: vi.fn((eventName: string, handler: (event: any) => void) => {
				(eventHandlers[eventName] ??= []).push(handler);
				return () => undefined;
			}),
			emit: vi.fn((eventName: string, event: any) => {
				for (const handler of eventHandlers[eventName] ?? []) handler(event);
			}),
		},
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries = [...entries, {
				type: "custom",
				id: `appended-${pi.appendEntry.mock.calls.length}`,
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
		showWorkerNotifications: args.showWorkerNotifications ?? true,
		passive: args.passive ?? false,
		debugLog: false,
		observeAfterTokens: args.observeAfterTokens ?? 1,
		observerChunkMaxTokens: args.observerChunkMaxTokens ?? 0,
		observerChunkOverlapEntries: args.observerChunkOverlapEntries ?? 0,
		observerChunkOutputReserveTokens: args.observerChunkOutputReserveTokens ?? 8_000,
		reflectAfterTokens: args.reflectAfterTokens ?? 999,
		reflectAfterObservationTokens: args.reflectAfterObservationTokens ?? 999,
		reflectAfterObserverBatches: args.reflectAfterObserverBatches ?? 999,
		observationsPoolMaxTokens: 100,
		observationsPoolTargetTokens: args.observationsPoolTargetTokens ?? 50,
		compactAfterTokens: args.compactAfterTokens ?? 81_000,
		compactionWaitForConsolidationMs: args.compactionWaitForConsolidationMs ?? 15_000,
		agentMaxTurns: 3,
		consolidationIdleDelayMs: 1,
		observerTimeoutMs: 10_000,
		reflectorTimeoutMs: 10_000,
		dropperTimeoutMs: 10_000,
		model: { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "off" },
	};
	vi.spyOn(runtime, "resolveModel").mockResolvedValue({ ok: true, model: { reasoning: true }, apiKey: "key" });
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		model: { provider: "openai-codex", contextWindow: 272_000 },
		modelRegistry: {},
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		compact: vi.fn(),
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
	};
	registerConsolidationTrigger(pi as any, runtime);

	const fireAgentEnd = (stopReason = "stop") => handlers.agent_end?.({
		messages: [{ role: "assistant", content: [], stopReason }],
	}, ctx);
	const fireAgentStart = () => handlers.agent_start?.({}, ctx);
	const advance = async (ms = 1) => {
		await vi.advanceTimersByTimeAsync(ms);
		await Promise.resolve();
	};

	return { pi, runtime, ctx, handlers, eventHandlers, fireAgentEnd, fireAgentStart, advance, getEntries: () => entries };
}

describe("bounded observer chunk selection", () => {
	const select = (overrides: Partial<Parameters<typeof selectObserverChunk>[0]> = {}) => selectObserverChunk({
		entries: [
			textCustomMessage("raw-1", "a".repeat(20_000)),
			textCustomMessage("raw-2", "b".repeat(20_000)),
			textCustomMessage("raw-3", "c".repeat(20_000)),
		] as any,
		priorReflections: [],
		priorObservations: [],
		maxTokens: 12_000,
		overlapEntries: 0,
		outputReserveTokens: 1_000,
		...overrides,
	});

	it("keeps legacy full serialization and the last-entry watermark when disabled", () => {
		const selection = select({ maxTokens: 0 });
		expect(selection.allowedSourceEntryIds).toEqual(["raw-1", "raw-2", "raw-3"]);
		expect(selection.coversUpToId).toBe("raw-3");
		expect(selection.sourceEntryCount).toBe(3);
		expect(selection.configuredBudget).toBe(0);
	});

	it("selects oldest prefixes that can cover all entries over successive successful batches", () => {
		let remaining = [
			textCustomMessage("raw-1", "a".repeat(20_000)),
			textCustomMessage("raw-2", "b".repeat(20_000)),
			textCustomMessage("raw-3", "c".repeat(20_000)),
		] as any[];
		const covered: string[] = [];
		while (remaining.length > 0) {
			const selection = select({ entries: remaining as any });
			expect(selection.estimatedPromptTokens + selection.outputReserveTokens).toBeLessThanOrEqual(selection.budget);
			covered.push(selection.coversUpToId as string);
			remaining = remaining.slice(selection.sourceEntryCount);
		}
		expect(covered).toEqual(["raw-1", "raw-2", "raw-3"]);
	});

	it("keeps overlap read-only by excluding it from the coverage watermark", () => {
		const selection = select({
			entries: [
				textCustomMessage("raw-1", "a".repeat(10_000)),
				textCustomMessage("raw-2", "b".repeat(10_000)),
				textCustomMessage("raw-3", "c".repeat(40_000)),
			] as any,
			overlapEntries: 1,
		});
		expect(selection.coversUpToId).toBe("raw-1");
		expect(selection.allowedSourceEntryIds).toEqual(["raw-1"]);
		expect(selection.chunk).toContain("READ-ONLY OVERLAP CONTEXT");
		expect(selection.chunk).toContain("raw-2");
		expect(selection.sourceEntryCount).toBe(1);
		expect(selection.overlapEntryCount).toBe(1);
		expect(selection.promptSourceEntryCount).toBe(2);
	});

	it("forces one oldest entry and marks prior-memory budget exhaustion", () => {
		const selection = select({
			maxTokens: 5_000,
			priorObservations: ["p".repeat(30_000)],
		});
		expect(selection.sourceEntryCount).toBe(1);
		expect(selection.coversUpToId).toBe("raw-1");
		expect(selection.budgetExhaustedByPriorMemory).toBe(true);
	});

	it("forces one oversized source entry instead of shrinking forever", () => {
		const selection = select({
			entries: [textCustomMessage("huge", "x".repeat(80_000))] as any,
			maxTokens: 5_000,
		});
		expect(selection.sourceEntryCount).toBe(1);
		expect(selection.coversUpToId).toBe("huge");
		expect(selection.budgetExhaustedByPriorMemory).toBe(false);
		expect(selection.oversizedEntry).toBe(true);
		expect(selection.oversizedEntryTokens).toBeGreaterThan(selection.budget);
	});
});

describe("single-stage consolidation scheduler", () => {
	const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
	const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
	const refA = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);

	it("starts only after agent_end and never from turn_end", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		expect(subject.handlers.agent_start).toBeTypeOf("function");
		expect(subject.handlers.agent_end).toBeTypeOf("function");
		expect(subject.handlers.turn_end).toBeUndefined();

		subject.fireAgentStart();
		await subject.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
	});

	it("suppresses worker notifications when showWorkerNotifications is false", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const quiet = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], showWorkerNotifications: false });
		quiet.fireAgentEnd();
		await quiet.advance();
		await vi.waitFor(() => expect(quiet.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		));
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("runs observer as one durable stage", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		));
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
		expect(mockAgents.runDropper).not.toHaveBeenCalled();
	});

	it("advances bounded observer batches through each oldest prefix", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]).mockResolvedValueOnce([obsB]);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "a".repeat(20_000)),
				textCustomMessage("raw-2", "b".repeat(20_000)),
			],
			observerChunkMaxTokens: 12_000,
			observerChunkOutputReserveTokens: 1_000,
		});
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		));
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsB], coversUpToId: "raw-2" },
		));
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(2);
		expect(mockAgents.runObserver.mock.calls[0][0].chunk).toContain("raw-1");
		expect(mockAgents.runObserver.mock.calls[0][0].chunk).not.toContain("raw-2");
		expect(mockAgents.runObserver.mock.calls[1][0].chunk).toContain("raw-2");
	});

	it("does not advance past a bounded batch that fails midway", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]).mockResolvedValueOnce(undefined);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "a".repeat(20_000)),
				textCustomMessage("raw-2", "b".repeat(20_000)),
			],
			observerChunkMaxTokens: 12_000,
			observerChunkOutputReserveTokens: 1_000,
		});
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledTimes(1));
		await subject.advance();
		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		expect(subject.pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(subject.pi.appendEntry).toHaveBeenLastCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		);
		expect(mockAgents.runObserver.mock.calls[1][0].chunk).toContain("raw-2");
	});

	it("schedules reflector as a separate task after observer commits", async () => {
		const newReflection = reflection("ffffffffffff", ["aaaaaaaaaaaa"]);
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);
		const subject = setup({
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			reflectAfterObservationTokens: 1,
		});
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledTimes(1));
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_REFLECTIONS_RECORDED,
			{ reflections: [newReflection], coversUpToId: "raw-1" },
		));
		expect(mockAgents.runObserver.mock.invocationCallOrder[0]).toBeLessThan(mockAgents.runReflector.mock.invocationCallOrder[0]);
	});

	it("runs dropper independently from a prior reflection", async () => {
		mockAgents.runDropper.mockResolvedValueOnce(["aaaaaaaaaaaa"]);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
				reflectionsRecordedEntry("om-ref", { reflections: [refA], coversUpToId: "raw-1" }),
			],
			observeAfterTokens: 999,
			observationsPoolTargetTokens: 5,
		});
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_DROPPED,
			{ observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" },
		));
		expect(mockAgents.runReflector).not.toHaveBeenCalled();
	});

	it("uses observation batches rather than raw token resonance to trigger reflection", async () => {
		const newReflection = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		mockAgents.runReflector.mockResolvedValueOnce([newReflection]);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "a"),
				observationsRecordedEntry("om-obs-a", { observations: [obsA], coversUpToId: "raw-1" }),
				textCustomMessage("raw-2", "b"),
				observationsRecordedEntry("om-obs-b", { observations: [obsB], coversUpToId: "raw-2" }),
			],
			observeAfterTokens: 999,
			reflectAfterTokens: 999,
			reflectAfterObservationTokens: 999,
			reflectAfterObserverBatches: 2,
		});
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(mockAgents.runReflector).toHaveBeenCalledTimes(1));
	});

	it("records no-progress failure and does not immediately retry the same watermark", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		await subject.advance(10_000);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
	});

	it("foreground activity aborts a pending background result", async () => {
		let release: ((value: unknown) => void) | undefined;
		mockAgents.runObserver.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		subject.fireAgentStart();
		release?.([obsA]);
		await Promise.resolve();
		expect(subject.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("forces an observer below the normal threshold when compaction was deferred", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const subject = setup({
			entries: [textCustomMessage("raw-1", "a")],
			observeAfterTokens: 999,
		});
		subject.runtime.compactionDeferred = true;
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
	});

	it("does nothing in passive mode or after a failed foreground run", async () => {
		const passive = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], passive: true });
		passive.fireAgentEnd();
		await passive.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		const failed = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		failed.fireAgentEnd("error");
		await failed.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
	});

	it("invalidates scheduled work when the session changes", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		subject.fireAgentEnd();
		subject.handlers.session_before_switch?.({}, subject.ctx);
		await subject.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
	});

	it("retries a ready deferred compaction after pending messages clear", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const subject = setup({ entries, observeAfterTokens: 999, compactAfterTokens: 1 });
		subject.fireAgentEnd();
		subject.runtime.deferCompaction("raw-1", "root");
		subject.runtime.markCompactionReady();
		subject.ctx.hasPendingMessages.mockReturnValue(true);
		subject.pi.events.emit("observational-memory:compaction-deferred", {});

		await subject.advance(5);
		expect(subject.ctx.compact).not.toHaveBeenCalled();
		expect(subject.runtime.compactionDeferred).toBe(true);

		subject.ctx.hasPendingMessages.mockReturnValue(false);
		await subject.advance(5);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("cancels a recovery watchdog when the session changes", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obsA], coversUpToId: "raw-1" }),
		];
		const subject = setup({ entries, observeAfterTokens: 999, compactAfterTokens: 1 });
		subject.fireAgentEnd();
		subject.runtime.deferCompaction("raw-1", "root");
		subject.runtime.markCompactionReady();
		subject.pi.events.emit("observational-memory:compaction-deferred", {});
		subject.handlers.session_before_switch?.({}, subject.ctx);

		await subject.advance(20);
		expect(subject.ctx.compact).not.toHaveBeenCalled();
		expect(subject.runtime.pendingCompaction).toBeUndefined();
	});
});
