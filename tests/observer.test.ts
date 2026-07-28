import { describe, expect, it } from "vitest";

import {
	normalizeSourceEntryIds,
	OBSERVATION_TIMESTAMP_PATTERN,
	runCoverageVerifier,
	runObserver,
	runObserverObservations,
} from "../src/agents/observer/agent.js";
import { estimateStringTokens } from "../src/tokens.js";

function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
	stopReason = "stop",
): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context, config);
			return [{ role: "assistant", content: [], stopReason }];
		},
	})) as any;
}

describe("OBSERVATION_TIMESTAMP_PATTERN", () => {
	it("matches local minute timestamps without regex shorthand escapes", () => {
		expect(OBSERVATION_TIMESTAMP_PATTERN).not.toContain("\\d");
		const pattern = new RegExp(OBSERVATION_TIMESTAMP_PATTERN);
		expect(pattern.test("2026-05-02 10:30")).toBe(true);
		expect(pattern.test("2026-5-02 10:30")).toBe(false);
		expect(pattern.test("2026-05-02T10:30")).toBe(false);
		expect(pattern.test("2026-05-02 10:30:00")).toBe(false);
	});
});

describe("runObserver", () => {
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		priorReflections: [],
		priorObservations: [],
		chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
		allowedSourceEntryIds: ["entry-a"],
	};

	it("keeps core observer prompt rules and tool surface unchanged by default", async () => {
		let systemPrompt = "";
		let toolNames: string[] = [];
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
			toolNames = context.tools.map((tool: any) => tool.name);
		});

		await runObserver({ ...baseArgs, agentLoop: loop });

		expect(systemPrompt).toContain("Preserve user assertions exactly");
		expect(systemPrompt).toContain("Detail preservation");
		expect(systemPrompt).toContain("Frame state changes as supersession");
		expect(systemPrompt).toContain("sourceEntryIds");
		expect(systemPrompt).toContain("zero observations");
		expect(systemPrompt).toContain("The dropper will drop these first");
		expect(systemPrompt).toContain("highest-resistance, load-bearing observations");
		expect(systemPrompt).not.toContain("will NEVER be dropped");
		expect(systemPrompt).not.toContain("pruner");
		expect(systemPrompt).not.toContain("Empty-batch coverage protocol");
		expect(toolNames).toEqual(["record_observations"]);
	});

	it("records V3 observations with source ids and code-computed tokenCount", async () => {
		const content = "User asked for a memory update.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content, relevance: "high", sourceEntryIds: ["entry-a"] }],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			content,
			timestamp: "2026-05-02 10:30",
			relevance: "high",
			sourceEntryIds: ["entry-a"],
			tokenCount: estimateStringTokens(content),
		});
		expect(result.observations[0].id).toMatch(/^[a-f0-9]{12}$/);
		expect(result.stats).toEqual({ toolCalls: 1, added: 1, duplicate: 0, rejected: 0, stopReason: "stop" });
		expect(result.covered).toBe(false);
	});

	it("rejects invented source ids and returns no observations", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] }],
			});
		});

		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toMatchObject({
			observations: [],
			stats: { toolCalls: 1, added: 0, duplicate: 0, rejected: 1, stopReason: "stop" },
		});
	});

	it("dedupes deterministic ids", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{ timestamp: "2026-05-02 10:30", content: "Same content", relevance: "medium", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:31", content: "Same content", relevance: "high", sourceEntryIds: ["entry-a"] },
				],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].content).toBe("Same content");
		expect(result.stats).toMatchObject({ toolCalls: 1, added: 1, duplicate: 1, rejected: 0 });
	});

	it("aggregates structured stats across tool calls", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				observations: [
					{ timestamp: "2026-05-02 10:30", content: "First", relevance: "high", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:31", content: "Invalid", relevance: "low", sourceEntryIds: ["missing"] },
				],
			});
			await context.tools[0].execute("tool-2", {
				observations: [
					{ timestamp: "2026-05-02 10:32", content: "First", relevance: "high", sourceEntryIds: ["entry-a"] },
					{ timestamp: "2026-05-02 10:33", content: "Second", relevance: "medium", sourceEntryIds: ["entry-a"] },
				],
			});
		});

		const result = await runObserver({ ...baseArgs, agentLoop: loop });

		expect(result.observations.map((observation) => observation.content)).toEqual(["First", "Second"]);
		expect(result.stats).toEqual({ toolCalls: 2, added: 2, duplicate: 1, rejected: 1, stopReason: "stop" });
	});

	it("returns structured empty stats and keeps the legacy undefined wrapper", async () => {
		const loop = fakeAgentLoop(() => {});
		await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toMatchObject({
			observations: [],
			stats: { toolCalls: 0, added: 0, duplicate: 0, rejected: 0, stopReason: "stop" },
		});
		await expect(runObserverObservations({ ...baseArgs, agentLoop: loop })).resolves.toBeUndefined();
	});

	it("accepts an explicit empty commit and ignores provider stopReason for coverage", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await commit.execute("commit-1", {});
		}, "toolUse");

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.observations).toEqual([]);
		expect(result.covered).toBe(true);
		expect(result.stats).toMatchObject({
			toolCalls: 1,
			added: 0,
			rejected: 0,
			stopReason: "empty-coverage-commit",
			commitCalls: 1,
			toolErrors: 0,
			commitDiagnostic: "accepted",
		});
	});

	it("rejects a commit after valid observations without changing the observations", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const record = context.tools.find((tool: any) => tool.name === "record_observations");
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await record.execute("record-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Keep me", relevance: "high", sourceEntryIds: ["entry-a"] }],
			});
			await commit.execute("commit-1", {});
		});

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.observations.map((observation) => observation.content)).toEqual(["Keep me"]);
		expect(result.covered).toBe(false);
		expect(result.stats).toMatchObject({ commitCalls: 1, commitDiagnostic: "commit-after-observations" });
	});

	it("locks immediately after commit and rejects same-turn queued record and duplicate commit calls", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const record = context.tools.find((tool: any) => tool.name === "record_observations");
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await commit.execute("commit-1", {});
			await record.execute("record-after", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Must not be added", relevance: "high", sourceEntryIds: ["entry-a"] }],
			});
			await commit.execute("commit-2", {});
		});

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.observations).toEqual([]);
		expect(result.covered).toBe(true);
		expect(result.stats).toMatchObject({
			commitCalls: 2,
			duplicateCommits: 1,
			postCommitRejected: 1,
			commitDiagnostic: "duplicate-commit",
		});
	});

	it("keeps coverage false when rejected observations remain unresolved", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const record = context.tools.find((tool: any) => tool.name === "record_observations");
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await record.execute("record-1", {
				observations: [{ timestamp: "2026-05-02 10:30", content: "Bad source", relevance: "medium", sourceEntryIds: ["missing"] }],
			});
			await commit.execute("commit-1", {});
		});

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.covered).toBe(false);
		expect(result.stats).toMatchObject({ rejected: 1, commitDiagnostic: "commit-with-unresolved-errors" });
	});

	it("treats tool validation or execution errors as fail-closed", async () => {
		const loop = fakeAgentLoop(async (_prompts, context, config) => {
			await config.afterToolCall({
				toolCall: { id: "invalid-record", name: "record_observations" },
				result: { content: [], details: undefined },
				isError: true,
				context,
				args: undefined,
				assistantMessage: { role: "assistant", content: [] },
			});
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await commit.execute("commit-1", {});
		});

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.covered).toBe(false);
		expect(result.stats).toMatchObject({ rejected: 1, toolErrors: 1, commitDiagnostic: "commit-with-unresolved-errors" });
	});

	it("keeps coverage false when commit parameters are invalid", async () => {
		const loop = fakeAgentLoop(async (_prompts, context, config) => {
			await config.afterToolCall({
				toolCall: { id: "invalid-commit", name: "commit_empty_coverage" },
				result: { content: [], details: undefined },
				isError: true,
				context,
				args: undefined,
				assistantMessage: { role: "assistant", content: [] },
			});
		});

		const result = await runObserver({ ...baseArgs, emptyCoverageCommit: true, agentLoop: loop });

		expect(result.covered).toBe(false);
		expect(result.stats).toMatchObject({ commitCalls: 1, toolErrors: 1, commitDiagnostic: "tool-error" });
	});

	it("invalidates an accepted commit when the run is interrupted", async () => {
		const controller = new AbortController();
		const loop = fakeAgentLoop(async (_prompts, context) => {
			const commit = context.tools.find((tool: any) => tool.name === "commit_empty_coverage");
			await commit.execute("commit-1", {});
			controller.abort("timeout");
		});

		const result = await runObserver({
			...baseArgs,
			emptyCoverageCommit: true,
			signal: controller.signal,
			agentLoop: loop,
		});

		expect(result.covered).toBe(false);
		expect(result.stats).toMatchObject({ commitDiagnostic: "interrupted-after-commit" });
	});

	it("uses maxTurns as an observer turn cap", async () => {
		let shouldStopAfterTurn: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			shouldStopAfterTurn = config.shouldStopAfterTurn;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxTurns: 2 });

		expect(shouldStopAfterTurn).toBeTypeOf("function");
		expect(shouldStopAfterTurn({})).toBe(false);
		expect(shouldStopAfterTurn({})).toBe(true);
	});

	it("caps bounded observer output to the reserved allowance", async () => {
		let seenMaxTokens: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenMaxTokens = config.maxTokens;
		});

		await runObserver({ ...baseArgs, agentLoop: loop, maxOutputTokens: 1_234 });

		expect(seenMaxTokens).toBe(1_234);
	});

	it("uses configured observer thinking level for reasoning models", async () => {
		let seenReasoning: unknown;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "minimal" });

		expect(seenReasoning).toBe("minimal");
	});

	it("omits observer reasoning when thinkingLevel is off", async () => {
		let seenReasoning: unknown = "unset";
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			seenReasoning = config.reasoning;
		});

		await runObserver({ ...baseArgs, model: { reasoning: true } as any, agentLoop: loop, thinkingLevel: "off" });

		expect(seenReasoning).toBeUndefined();
	});
});

describe("runCoverageVerifier", () => {
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		chunk: "[Source entry id: raw-1] routine acknowledgement",
	};

	it("returns the dedicated tool's structured verdict", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("verifier-1", {
				hasRecordableContent: false,
				reason: "Only a routine acknowledgement is present.",
			});
		});

		await expect(runCoverageVerifier({ ...baseArgs, agentLoop: loop })).resolves.toMatchObject({
			verdict: { hasRecordableContent: false, reason: "Only a routine acknowledgement is present." },
			stats: { toolCalls: 1, toolErrors: 0 },
		});
	});

	it("returns no verdict when structured tool parsing fails", async () => {
		const loop = fakeAgentLoop(async (_prompts, context, config) => {
			await config.afterToolCall({
				toolCall: { id: "invalid-verdict", name: "report_coverage_verification" },
				result: { content: [], details: undefined },
				isError: true,
				context,
				args: undefined,
				assistantMessage: { role: "assistant", content: [] },
			});
		});

		const result = await runCoverageVerifier({ ...baseArgs, agentLoop: loop });
		expect(result.verdict).toBeUndefined();
		expect(result.stats.toolErrors).toBe(1);
	});
});

describe("normalizeSourceEntryIds", () => {
	const allowed = ["entry-a", "entry-b", "entry-c"];

	it("accepts source ids from the allowed chunk and orders them by branch order", () => {
		expect(normalizeSourceEntryIds(["entry-c", "entry-a"], allowed)).toEqual(["entry-a", "entry-c"]);
	});

	it("dedupes repeated source ids", () => {
		expect(normalizeSourceEntryIds(["entry-b", "entry-b", "entry-a"], allowed)).toEqual(["entry-a", "entry-b"]);
	});

	it("rejects missing, empty, or hallucinated source ids", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a", "not-in-the-chunk"], allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds(["entry-a"], [])).toBeUndefined();
	});
});
