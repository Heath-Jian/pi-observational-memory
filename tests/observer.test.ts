import { describe, expect, it } from "vitest";

import {
	normalizeSourceEntryIds,
	OBSERVATION_TIMESTAMP_PATTERN,
	runObserver,
	runObserverObservations,
} from "../src/agents/observer/agent.js";
import { estimateStringTokens } from "../src/tokens.js";

function fakeAgentLoop(handler: (prompts: any[], context: any, config: any) => Promise<void> | void): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			// No streaming events needed for these tests.
		},
		result: async () => {
			await handler(prompts, context, config);
			return [{ role: "assistant", content: [], stopReason: "stop" }];
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

	it("keeps core observer prompt rules", async () => {
		let systemPrompt = "";
		const loop = fakeAgentLoop((_prompts, context) => {
			systemPrompt = context.systemPrompt;
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
		expect(result.covered).toBe(true);
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
