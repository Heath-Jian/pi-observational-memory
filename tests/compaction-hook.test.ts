import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: {
	entries: TestEntry[];
	observationsPoolMaxTokens?: number;
	compactHookInFlight?: boolean;
	consolidationPromise?: Promise<void> | null;
	compactionWaitForConsolidationMs?: number;
	activeKind?: "proactive" | "force";
	passive?: boolean;
}) {
	const handlers: Record<string, ((event: any, ctx: any) => Promise<unknown> | unknown) | undefined> = {};
	const pi = {
		on: vi.fn((eventName: string, cb: (event: any, ctx: any) => Promise<unknown> | unknown) => {
			handlers[eventName] = cb;
		}),
		events: { emit: vi.fn() },
		appendEntry: vi.fn(),
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = {
		...runtime.config,
		passive: args.passive ?? false,
		observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
		compactionWaitForConsolidationMs: args.compactionWaitForConsolidationMs ?? 50,
	};
	runtime.compactHookInFlight = args.compactHookInFlight ?? false;
	runtime.consolidationPromise = args.consolidationPromise as any ?? null;
	vi.spyOn(runtime, "abortConsolidation");
	vi.spyOn(runtime, "deferCompaction");
	vi.spyOn(runtime, "clearCompactionDeferral");
	vi.spyOn(runtime, "resolveModel");
	if (args.activeKind) runtime.beginCompactionAttempt(args.activeKind, "root");
	registerCompactionHook(pi as any, runtime as any);
	const handler = handlers.session_before_compact;
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => args.entries) },
	};
	const run = (
		firstKeptEntryId = args.entries.at(-1)?.id ?? "missing",
		signal?: AbortSignal,
		reason = "manual",
	) => handler({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		signal,
		reason,
	}, ctx);
	return { pi, runtime, ctx, run, handlers };
}

describe("V3 compaction hook", () => {
	it("returns valid empty om.folded details when there is no V3 memory", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: "raw-1",
				tokensBefore: 123,
				summary: "",
				details: {
					type: "om.folded",
					version: 1,
					fullFold: false,
					observations: [],
					reflections: [],
				},
			},
		});
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-1") as any;

		expect(result.compaction.details.fullFold).toBe(false);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.compaction.details.reflections).toEqual([]);
		expect(result.compaction.summary).toContain("## Observations");
		expect(result.compaction.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.compaction.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(result.compaction.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("ignores old V2 memory entries and details", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];
		const { run } = setup({ entries });

		const result = await run("raw-1") as any;

		expect(result.compaction.details).toMatchObject({
			type: "om.folded",
			observations: [],
			reflections: [],
		});
	});

	it("uses committed observer coverage immediately and aborts stale background work", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 5 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
		];
		let release: (() => void) | undefined;
		const consolidationPromise = new Promise<void>((resolve) => { release = resolve; });
		const { run, runtime } = setup({ entries, consolidationPromise });
		runtime.consolidationInFlight = true;
		let settled = false;
		const resultPromise = run("raw-1").then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		expect(settled).toBe(true);
		const result = await resultPromise;

		expect(result).toMatchObject({ compaction: { details: { type: "om.folded" } } });
		expect(runtime.abortConsolidation).toHaveBeenCalledWith("compaction using committed memory");
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		release?.();
	});

	it("cancels promptly when compaction is already aborted", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const controller = new AbortController();
		const { run, runtime } = setup({ entries });

		controller.abort();
		await expect(run("raw-1", controller.signal)).resolves.toBeUndefined();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("defers once when observer coverage does not include the removal prefix", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		const { run, runtime, ctx } = setup({ entries, activeKind: "proactive" });

		await expect(run("raw-2")).resolves.toEqual({ cancel: true });
		expect(runtime.deferCompaction).toHaveBeenCalledWith("raw-2", "root");
		expect(runtime.compactionDeferred).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("deferred once"), "info");
	});

	it("falls back to Pi native compaction after the same coverage gap is deferred twice", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		const { run, runtime, ctx } = setup({ entries, activeKind: "proactive" });

		await expect(run("raw-2")).resolves.toEqual({ cancel: true });
		await expect(run("raw-2")).resolves.toBeUndefined();
		expect(runtime.clearCompactionDeferral).toHaveBeenCalledTimes(1);
		expect(runtime.compactHookInFlight).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pi native compaction"), "warning");
	});

	it("falls back after one prior deferral even when Pi moves the cut", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbb"),
			textCustomMessage("raw-3", "cccc"),
		];
		const { run, runtime } = setup({ entries, activeKind: "proactive" });

		await expect(run("raw-2")).resolves.toEqual({ cancel: true });
		await expect(run("raw-3")).resolves.toBeUndefined();
		expect(runtime.clearCompactionDeferral).toHaveBeenCalledTimes(1);
	});

	it("fails open when a duplicate compaction hook is already running", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction hook is already running; using Pi native compaction",
			"warning",
		);
	});

	it.each([
		["overflow", undefined],
		["threshold", undefined],
		["manual", undefined],
	] as const)("fails open for non-OM %s compaction when coverage is incomplete", async (reason) => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		const { run, runtime } = setup({ entries });

		await expect(run("raw-2", undefined, reason)).resolves.toBeUndefined();
		expect(runtime.compactionDeferred).toBe(false);
	});

	it("does not intercept compaction in passive mode", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		const { run, runtime } = setup({ entries, activeKind: "proactive", passive: true });

		await expect(run("raw-2")).resolves.toBeUndefined();
		expect(runtime.compactionDeferred).toBe(false);
	});

	it("clears all compaction state after any successful session compaction", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa"), textCustomMessage("raw-2", "bbbb")];
		const { run, runtime, handlers } = setup({ entries, activeKind: "proactive" });
		await expect(run("raw-2")).resolves.toEqual({ cancel: true });
		runtime.compactionCancelCooldownUntil = 123;

		await handlers.session_compact?.({}, {});

		expect(runtime.compactionDeferred).toBe(false);
		expect(runtime.activeCompactionAttempt).toBeUndefined();
		expect(runtime.compactionCancelCooldownUntil).toBe(0);
	});
});
