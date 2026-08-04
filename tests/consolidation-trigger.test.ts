import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgents = vi.hoisted(() => ({
	runObserver: vi.fn(),
	runCoverageVerifier: vi.fn(),
	runReflector: vi.fn(),
	runDropper: vi.fn(),
}));

vi.mock("../src/agents/observer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/observer/agent.js")>()),
	runObserver: mockAgents.runObserver,
	runCoverageVerifier: mockAgents.runCoverageVerifier,
}));
vi.mock("../src/agents/reflector/agent.js", () => ({ runReflector: mockAgents.runReflector }));
vi.mock("../src/agents/dropper/agent.js", () => ({ runDropper: mockAgents.runDropper }));

import { registerConsolidationTrigger, selectObserverChunk } from "../src/hooks/consolidation-trigger.js";
import {
	CHECKPOINT_CANCEL_EVENT,
	CHECKPOINT_FINISH_EVENT,
	CHECKPOINT_GRANT_EVENT,
	CHECKPOINT_RELEASE_EVENT,
	CHECKPOINT_REQUEST_EVENT,
} from "../src/hooks/checkpoint-events.js";
import { OM_COMPACTION_CLEARED_EVENT, OM_COMPACTION_DEFERRED_EVENT } from "../src/hooks/compaction-events.js";
import { Runtime } from "../src/runtime.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/index.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

beforeEach(() => {
	vi.useFakeTimers();
	mockAgents.runObserver.mockReset().mockResolvedValue(undefined);
	mockAgents.runCoverageVerifier.mockReset().mockResolvedValue({ stats: { toolCalls: 0, toolErrors: 0, stopReason: "stop" } });
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
	observerEmptyCoverageCommit?: boolean;
	observerCoverageVerifyModel?: { provider: string; id: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" };
	configDiagnostics?: Array<{ level: "warning"; message: string }>;
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
		observerEmptyCoverageCommit: args.observerEmptyCoverageCommit ?? false,
		observerCoverageVerifyModel: args.observerCoverageVerifyModel,
		configDiagnostics: args.configDiagnostics,
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
		modelRegistry: {
			find: vi.fn((provider: string, id: string) => ({ provider, id })),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "verifier-key" })),
		},
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		compact: vi.fn(),
		sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
	};
	registerConsolidationTrigger(pi as any, runtime);

	const fireAgentEnd = (stopReason = "stop") => {
		handlers.agent_end?.({
			messages: [{ role: "assistant", content: [], stopReason }],
		}, ctx);
		handlers.agent_settled?.({ type: "agent_settled" }, ctx);
	};
	const fireAgentStart = () => handlers.agent_start?.({}, ctx);
	const advance = async (ms = 1) => {
		await vi.advanceTimersByTimeAsync(ms);
		await Promise.resolve();
	};

	return {
		pi,
		runtime,
		ctx,
		handlers,
		eventHandlers,
		fireAgentEnd,
		fireAgentStart,
		advance,
		getEntries: () => entries,
		appendSessionEntry: (entry: TestEntry) => { entries = [...entries, entry]; },
	};
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

	it("starts only after agent_settled and never from agent_end or turn_end", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		expect(subject.handlers.agent_start).toBeTypeOf("function");
		expect(subject.handlers.agent_end).toBeTypeOf("function");
		expect(subject.handlers.agent_settled).toBeTypeOf("function");
		expect(subject.handlers.turn_end).toBeUndefined();

		subject.fireAgentStart();
		await subject.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		subject.handlers.agent_end?.({
			messages: [{ role: "assistant", content: [], stopReason: "stop" }],
		}, subject.ctx);
		await subject.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		subject.handlers.agent_settled?.({ type: "agent_settled" }, subject.ctx);
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

	it("preserves non-empty progress without a finalize call in commit mode", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [obsA],
			covered: false,
			stats: { toolCalls: 1, added: 1, duplicate: 0, rejected: 0, stopReason: "stop", commitDiagnostic: "not-called" },
		});
		const subject = setup({
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier" },
		});

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [obsA], coversUpToId: "raw-1" },
		));
		expect(mockAgents.runCoverageVerifier).not.toHaveBeenCalled();
	});

	it("writes covered-empty progress only after the verifier accepts it", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		mockAgents.runCoverageVerifier.mockResolvedValueOnce({
			verdict: { hasRecordableContent: false, reason: "No recordable content." },
			stats: { toolCalls: 1, toolErrors: 0, stopReason: "toolUse" },
		});
		const subject = setup({
			entries: [textCustomMessage("raw-1", "routine")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier" },
		});

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.pi.appendEntry).toHaveBeenCalledWith(
			OM_OBSERVATIONS_RECORDED,
			{ observations: [], coversUpToId: "raw-1", covered: true },
		));
		expect(mockAgents.runCoverageVerifier).toHaveBeenCalledWith(expect.objectContaining({
			chunk: expect.stringContaining("raw-1"),
		}));
	});

	it("fails closed when the verifier finds recordable content", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		mockAgents.runCoverageVerifier.mockResolvedValueOnce({
			verdict: { hasRecordableContent: true, reason: "A user decision is present." },
			stats: { toolCalls: 1, toolErrors: 0, stopReason: "toolUse" },
		});
		const subject = setup({
			entries: [textCustomMessage("raw-1", "decision")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier" },
		});

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		expect(subject.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("fails closed on verifier structured-output parse failure", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		mockAgents.runCoverageVerifier.mockResolvedValueOnce({
			stats: { toolCalls: 1, toolErrors: 1, stopReason: "error" },
		});
		const subject = setup({
			entries: [textCustomMessage("raw-1", "routine")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier" },
		});

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		expect(subject.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("fails closed when the verifier call throws", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		mockAgents.runCoverageVerifier.mockRejectedValueOnce(new Error("verifier timeout"));
		const subject = setup({
			entries: [textCustomMessage("raw-1", "routine")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier" },
		});

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		expect(subject.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("fails closed when verifier config exists but the model cannot be resolved", async () => {
		mockAgents.runObserver.mockResolvedValueOnce({
			observations: [],
			covered: true,
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-coverage-commit" },
		});
		const subject = setup({
			entries: [textCustomMessage("raw-1", "routine")],
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "missing", id: "verifier" },
		});
		subject.ctx.modelRegistry.find.mockReturnValue(undefined);

		subject.fireAgentEnd();
		await subject.advance();

		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		expect(mockAgents.runCoverageVerifier).not.toHaveBeenCalled();
		expect(subject.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("surfaces config clamp warnings once at the first UI context", () => {
		const subject = setup({
			entries: [],
			configDiagnostics: [{ level: "warning", message: "bounded batching requires observerEmptyCoverageCommit; falling back to full-chunk" }],
		});

		subject.fireAgentStart();
		subject.fireAgentEnd();

		expect(subject.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(subject.ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: bounded batching requires observerEmptyCoverageCommit; falling back to full-chunk",
			"warning",
		);
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
		subject.runtime.deferCompaction("raw-1", "root", { strict: true, origin: "manual" });
		subject.fireAgentEnd();
		await subject.advance();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
	});

	it("starts manual recovery from the deferred event ctx without a prior agent_end", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 1_000,
		});
		subject.runtime.deferCompaction("raw-2", "root", { origin: "manual", strict: true });

		subject.pi.events.emit("observational-memory:compaction-deferred", { ctx: subject.ctx });
		await subject.advance();

		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
	});

	it("does not consume recovery budget while observer scheduling is unavailable", async () => {
		mockAgents.runObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 5,
		});
		subject.runtime.deferCompaction("raw-2", "root", { origin: "manual", strict: true });
		subject.ctx.isIdle.mockReturnValue(false);
		subject.pi.events.emit("observational-memory:compaction-deferred", { ctx: subject.ctx });

		await subject.advance(100);

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.runtime.compactionRecoveryBudgetRemaining()).toBe(5);

		subject.ctx.isIdle.mockReturnValue(true);
		subject.pi.events.emit("observational-memory:compaction-recovery-requested", { ctx: subject.ctx });
		await subject.advance(10);

		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
		expect(subject.runtime.pendingCompaction?.state).toBe("blocked");
	});

	it("pauses an active recovery budget when foreground work starts", async () => {
		mockAgents.runObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup({
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 20,
		});
		subject.runtime.deferCompaction("raw-1", "root", { origin: "manual", strict: true });
		subject.pi.events.emit("observational-memory:compaction-deferred", { ctx: subject.ctx });
		await subject.advance(5);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		subject.fireAgentStart();
		const pausedRemaining = subject.runtime.compactionRecoveryBudgetRemaining();
		await subject.advance(100);

		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.runtime.compactionRecoveryBudgetRemaining()).toBe(pausedRemaining);
		expect(subject.runtime.isCompactionRecoveryBudgetRunning()).toBe(false);

		subject.fireAgentEnd();
		await subject.advance((pausedRemaining ?? 0) + 5);
		expect(subject.runtime.pendingCompaction?.state).toBe("blocked");
	});

	it("does not consume recovery budget during observer retry backoff", async () => {
		mockAgents.runObserver.mockRejectedValue(new Error("observer unavailable"));
		const subject = setup({
			entries: [textCustomMessage("raw-1", "aaaaaaaa")],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 5,
		});
		subject.runtime.deferCompaction("raw-1", "root", { origin: "manual", strict: true });
		subject.pi.events.emit("observational-memory:compaction-deferred", { ctx: subject.ctx });

		await subject.advance(10);
		await vi.waitFor(() => expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1));
		const remainingAfterFailure = subject.runtime.compactionRecoveryBudgetRemaining();
		await subject.advance(100);

		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.runtime.compactionRecoveryBudgetRemaining()).toBe(remainingAfterFailure);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);
	});

	it("treats an unserializable strict recovery source as failure and blocks without a retry loop", async () => {
		const subject = setup({
			entries: [
				rawMessage("raw-empty", "", {
					message: { role: "assistant", content: [], stopReason: "error" },
				}),
				{
					type: "custom",
					id: "cut-marker",
					parentId: "raw-empty",
					timestamp: "2026-05-02T10:00:00.000Z",
					customType: "test.cut",
					data: {},
				},
			],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 5,
		});
		subject.runtime.deferCompaction("cut-marker", "root", { origin: "manual", strict: true });
		// This deterministic source failure is governed by the observer circuit;
		// paused retry/backoff time no longer burns the effective recovery budget.
		subject.runtime.config.consolidationCircuitBreakerFailures = 1;
		subject.pi.events.emit("observational-memory:compaction-deferred", { ctx: subject.ctx });

		await subject.advance(10);

		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1);
		expect(subject.runtime.pendingCompaction?.state).toBe("blocked");
		expect(subject.ctx.compact).not.toHaveBeenCalled();
		await subject.advance(100);
		expect(subject.runtime.stageFailureStatus("observer")?.failures).toBe(1);
	});

	it("does nothing in passive mode and resumes workers after a failed run settles", async () => {
		const passive = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")], passive: true });
		passive.fireAgentEnd();
		await passive.advance();
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		const failed = setup({ entries: [textCustomMessage("raw-1", "aaaaaaaa")] });
		mockAgents.runObserver.mockResolvedValueOnce([obsA]);
		failed.fireAgentEnd("error");
		await failed.advance();
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
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

	it("preserves fallback-enabled effective-budget fail-open behavior", async () => {
		mockAgents.runObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "aaaaaaaa"),
				textCustomMessage("raw-2", "bbbbbbbb"),
			],
			observeAfterTokens: 999,
			compactionWaitForConsolidationMs: 5,
		});
		subject.runtime.deferCompaction("raw-2", "root", { origin: "proactive", strict: false });
		subject.fireAgentEnd();

		await subject.advance(10);

		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
		expect(subject.runtime.pendingCompaction?.state).toBe("ready");
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

describe("cross-extension memory checkpoints", () => {
	it("holds a routine observer until convergence grants the immutable target", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 10 })]);
		const subject = setup({ entries: [textCustomMessage("raw-1", "a".repeat(20_000))] });
		const convergenceState = subject.eventHandlers["pi-convergence:state"]?.[0];
		expect(convergenceState).toBeTypeOf("function");
		convergenceState?.({ phase: "continuation" });

		subject.handlers.agent_end?.({ messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, subject.ctx);
		const request = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		expect(request).toMatchObject({
			purpose: "observational-memory:observe",
			urgency: "routine",
			boundaryKey: "root",
			targetEntryId: "raw-1",
		});

		subject.handlers.agent_settled?.({ type: "agent_settled" }, subject.ctx);
		await subject.advance(5);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "lease-routine",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10_000,
		});
		await subject.advance(5);
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_FINISH_EVENT,
			expect.objectContaining({ requestId: request.requestId, leaseId: "lease-routine", outcome: "observed" }),
		));
	});

	it("keeps a strict multi-batch lease through coverage ready until compaction commits", async () => {
		const obs1 = observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const obs2 = observation("dddddddddddd", { sourceEntryIds: ["raw-2"], tokenCount: 10 });
		mockAgents.runObserver.mockResolvedValueOnce([obs1]).mockResolvedValueOnce([obs2]);
		const subject = setup({
			entries: [
				textCustomMessage("raw-1", "a".repeat(20_000)),
				textCustomMessage("raw-2", "b".repeat(20_000)),
				textCustomMessage("raw-3", "c".repeat(20_000)),
			],
			observerChunkMaxTokens: 5_000,
			compactionWaitForConsolidationMs: 900_000,
		});
		subject.pi.events.on(CHECKPOINT_REQUEST_EVENT, (request: any) => {
			subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
				version: 1,
				requestId: request.requestId,
				leaseId: "lease-strict",
				requesterGeneration: request.requesterGeneration,
				boundaryKey: request.boundaryKey,
				targetEntryId: request.targetEntryId,
				branchHeadId: request.branchHeadId,
				grantedAt: Date.now(),
				expiresAt: Date.now() + 1_800_000,
			});
		});
		subject.runtime.deferCompaction("raw-3", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, {
			ctx: subject.ctx,
			lifecycleGeneration: subject.runtime.lifecycleGeneration,
			boundaryKey: "root",
			cutKey: "raw-3",
			strict: true,
		});
		subject.fireAgentEnd();
		await subject.advance(20);
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(subject.runtime.pendingCompaction?.state).toBe("ready"));
		expect(subject.pi.events.emit.mock.calls.some(([name]) => name === CHECKPOINT_FINISH_EVENT)).toBe(false);

		subject.pi.events.emit(OM_COMPACTION_CLEARED_EVENT, { reason: "session_compact" });
		expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_FINISH_EVENT,
			expect.objectContaining({ leaseId: "lease-strict", outcome: "compacted" }),
		);
	});

	it("ignores stale grants and preserves strict pending recovery when a lease is preempted", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "pending"), textCustomMessage("raw-2", "kept")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const request = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];

		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "stale",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: "different-target",
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10_000,
		});
		subject.fireAgentEnd();
		await subject.advance(5);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();

		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "current",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10_000,
		});
		subject.pi.events.emit(CHECKPOINT_RELEASE_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "current",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			reason: "preempted",
			releasedAt: Date.now(),
		});
		expect(subject.runtime.pendingCompaction).toMatchObject({ state: "waiting_coverage", cutKey: "raw-2" });
		expect(subject.runtime.observerCheckpointTargetEntryId).toBeUndefined();
	});

	it("never widens an immutable checkpoint to source entries appended after its target", async () => {
		mockAgents.runObserver.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 10 })]);
		const subject = setup({ entries: [textCustomMessage("raw-1", "leased-prefix")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const request = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.appendSessionEntry(textCustomMessage("raw-2", "new suffix must wait"));

		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "lease-prefix",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10_000,
		});
		subject.handlers.agent_settled?.({ type: "agent_settled" }, subject.ctx);
		await subject.advance(5);
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));
		expect(mockAgents.runObserver).toHaveBeenCalledWith(expect.objectContaining({
			allowedSourceEntryIds: ["raw-1"],
			chunk: expect.not.stringContaining("raw-2"),
		}));
	});

	it("requires a new grant after strict lease expiry instead of bypassing coordination", async () => {
		mockAgents.runObserver.mockResolvedValue([observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 10 })]);
		const subject = setup({ entries: [textCustomMessage("raw-1", "pending"), textCustomMessage("raw-2", "kept")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const first = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "expired-lease",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10_000,
		});
		subject.pi.events.emit(CHECKPOINT_RELEASE_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "expired-lease",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			reason: "expired",
			releasedAt: Date.now(),
		});
		subject.pi.events.emit("pi-convergence:state", { phase: "settled", mode: "enabled" });
		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(requests[1][1].requestId).not.toBe(first.requestId);

		subject.fireAgentEnd();
		await subject.advance(10);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(subject.runtime.pendingCompaction).toMatchObject({ state: "waiting_coverage", cutKey: "raw-2" });
	});

	it("cancels an ungranted routine request immediately when a newer strict cut arrives", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "routine")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const routine = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.appendSessionEntry(textCustomMessage("raw-2", "must be covered"));
		subject.appendSessionEntry(textCustomMessage("raw-3", "kept"));
		subject.runtime.deferCompaction("raw-3", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });

		expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_CANCEL_EVENT,
			expect.objectContaining({ requestId: routine.requestId, reason: "superseded" }),
		);
		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(1);
		await subject.advance(0);
		const updated = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(updated).toHaveLength(2);
		expect(updated[1][1]).toMatchObject({
			purpose: "observational-memory:compaction-recovery",
			targetEntryId: "raw-2",
		});
	});

	it("transfers a granted routine lease when a newer strict cut supersedes it", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "routine")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const routine = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: routine.requestId,
			leaseId: "lease-routine",
			requesterGeneration: routine.requesterGeneration,
			boundaryKey: routine.boundaryKey,
			targetEntryId: routine.targetEntryId,
			branchHeadId: routine.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});

		subject.appendSessionEntry(textCustomMessage("raw-2", "must be covered"));
		subject.appendSessionEntry(textCustomMessage("raw-3", "kept"));
		subject.runtime.deferCompaction("raw-3", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });

		expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_FINISH_EVENT,
			expect.objectContaining({
				requestId: routine.requestId,
				leaseId: "lease-routine",
				outcome: "aborted",
				reason: "superseded",
			}),
		);
		await subject.advance(0);
		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(requests[1][1]).toMatchObject({
			purpose: "observational-memory:compaction-recovery",
			urgency: "strict",
			targetEntryId: "raw-2",
		});
	});

	it("marks a granted checkpoint invalidated by a session change as session-changed", () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "routine")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const request = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "lease-before-switch",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});

		subject.handlers.session_before_switch?.({}, subject.ctx);

		expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_FINISH_EVENT,
			expect.objectContaining({
				requestId: request.requestId,
				leaseId: "lease-before-switch",
				outcome: "aborted",
				reason: "session-changed",
			}),
		);
	});

	it("rejects a grant whose lease already expired", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "routine")] });
		subject.eventHandlers["pi-convergence:state"]?.[0]?.({ phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const request = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: request.requestId,
			leaseId: "too-late",
			requesterGeneration: request.requesterGeneration,
			boundaryKey: request.boundaryKey,
			targetEntryId: request.targetEntryId,
			branchHeadId: request.branchHeadId,
			grantedAt: Date.now() - 20,
			expiresAt: Date.now() - 10,
		});
		subject.fireAgentEnd();
		await subject.advance(5);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
	});

	it("expires an accepted strict lease locally, pauses budget, and requests a replacement", async () => {
		mockAgents.runObserver.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}));
		const subject = setup({
			entries: [textCustomMessage("raw-1", "pending"), textCustomMessage("raw-2", "kept")],
			compactionWaitForConsolidationMs: 1_000,
		});
		subject.pi.events.emit("pi-convergence:state", { phase: "continuation", mode: "enabled" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const first = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "short-lease",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 10,
		});

		await subject.advance(15);

		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(requests[1][1].requestId).not.toBe(first.requestId);
		expect(subject.runtime.pendingCompaction?.state).toBe("waiting_coverage");
		expect(subject.runtime.isCompactionRecoveryBudgetRunning()).toBe(false);
		const paused = subject.runtime.compactionRecoveryBudgetRemaining();
		await subject.advance(100);
		expect(subject.runtime.compactionRecoveryBudgetRemaining()).toBe(paused);
	});

	it("retries a failed routine observer only through a new checkpoint grant", async () => {
		mockAgents.runObserver
			.mockRejectedValueOnce(new Error("provider unavailable"))
			.mockResolvedValueOnce([observation("cccccccccccc", { sourceEntryIds: ["raw-1"], tokenCount: 10 })]);
		const subject = setup({ entries: [textCustomMessage("raw-1", "routine")] });
		subject.pi.events.emit("pi-convergence:state", { phase: "continuation", mode: "enabled" });
		subject.handlers.agent_end?.({ messages: [] }, subject.ctx);
		const first = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "routine-1",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});
		await subject.advance(5);
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(1));

		await subject.advance(30_005);
		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(mockAgents.runObserver).toHaveBeenCalledTimes(1);

		const second = requests[1][1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: second.requestId,
			leaseId: "routine-2",
			requesterGeneration: second.requesterGeneration,
			boundaryKey: second.boundaryKey,
			targetEntryId: second.targetEntryId,
			branchHeadId: second.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});
		await subject.advance(5);
		await vi.waitFor(() => expect(mockAgents.runObserver).toHaveBeenCalledTimes(2));
	});

	it("automatically re-requests a timed-out strict grant without consuming recovery budget", async () => {
		const subject = setup({
			entries: [textCustomMessage("raw-1", "pending"), textCustomMessage("raw-2", "kept")],
			compactionWaitForConsolidationMs: 1_000,
		});
		subject.pi.events.emit("pi-convergence:state", { phase: "continuation", mode: "enabled" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const before = subject.runtime.compactionRecoveryBudgetRemaining();

		await subject.advance(60_005);

		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(requests[1][1].requestId).not.toBe(requests[0][1].requestId);
		expect(mockAgents.runObserver).not.toHaveBeenCalled();
		expect(subject.runtime.compactionRecoveryBudgetRemaining()).toBe(before);
		expect(subject.runtime.isCompactionRecoveryBudgetRunning()).toBe(false);
	});

	it("re-grants a ready recovery after release before allowing compaction commit", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "covered"), textCustomMessage("raw-2", "kept")] });
		subject.pi.events.emit("pi-convergence:state", { phase: "continuation", mode: "enabled" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.runtime.markCompactionReady();
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const first = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "ready-1",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});
		subject.pi.events.emit(CHECKPOINT_RELEASE_EVENT, {
			version: 1,
			requestId: first.requestId,
			leaseId: "ready-1",
			requesterGeneration: first.requesterGeneration,
			boundaryKey: first.boundaryKey,
			targetEntryId: first.targetEntryId,
			branchHeadId: first.branchHeadId,
			reason: "preempted",
			releasedAt: Date.now(),
		});
		await subject.advance(5);

		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
		expect(subject.ctx.compact).not.toHaveBeenCalled();

		const second = requests[1][1];
		subject.pi.events.emit(CHECKPOINT_GRANT_EVENT, {
			version: 1,
			requestId: second.requestId,
			leaseId: "ready-2",
			requesterGeneration: second.requesterGeneration,
			boundaryKey: second.boundaryKey,
			targetEntryId: second.targetEntryId,
			branchHeadId: second.branchHeadId,
			grantedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		});
		await subject.advance(5);
		expect(subject.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("upgrades a ready no-coordinator checkpoint when convergence mode is re-enabled", async () => {
		const subject = setup({ entries: [textCustomMessage("raw-1", "covered"), textCustomMessage("raw-2", "kept")] });
		subject.pi.events.emit("pi-convergence:state", { phase: "continuation", mode: "disabled" });
		subject.runtime.deferCompaction("raw-2", "root", { strict: true, origin: "manual" });
		subject.runtime.markCompactionReady();
		subject.pi.events.emit(OM_COMPACTION_DEFERRED_EVENT, { ctx: subject.ctx });
		const internal = subject.pi.events.emit.mock.calls.find(([name]) => name === CHECKPOINT_REQUEST_EVENT)?.[1];

		subject.pi.events.emit("pi-convergence:state", { phase: "settled", mode: "enabled" });
		await subject.advance(1);

		expect(subject.ctx.compact).not.toHaveBeenCalled();
		expect(subject.pi.events.emit).toHaveBeenCalledWith(
			CHECKPOINT_CANCEL_EVENT,
			expect.objectContaining({ requestId: internal.requestId, reason: "superseded" }),
		);
		const requests = subject.pi.events.emit.mock.calls.filter(([name]) => name === CHECKPOINT_REQUEST_EVENT);
		expect(requests).toHaveLength(2);
	});
});
