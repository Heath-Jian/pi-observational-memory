import { describe, expect, it, vi } from "vitest";

import { registerRecoverCommand } from "../src/commands/recover.js";
import { OM_COMPACTION_RECOVERY_REQUESTED_EVENT } from "../src/hooks/compaction-events.js";

type PendingState = "waiting_coverage" | "ready" | "blocked";

function pendingCompaction(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		boundaryKey: "cmp-1",
		cutKey: "raw-2",
		origin: "manual",
		strict: true,
		lifecycleGeneration: 7,
		startedAt: 100,
		deadlineAt: 200,
		state: "blocked" as PendingState,
		lastError: "observer unavailable",
		...overrides,
	};
}

function setup(args: {
	pending?: ReturnType<typeof pendingCompaction>;
	passive?: boolean;
	branchBoundary?: string;
} = {}) {
	let handler: ((commandArgs: string, ctx: any) => Promise<void>) | undefined;
	const emit = vi.fn();
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:recover");
			handler = command.handler;
		}),
		events: { emit },
	};
	const runtime: any = {
		ensureConfig: vi.fn(),
		config: { passive: args.passive ?? false },
		pendingCompaction: args.pending,
		lifecycleGeneration: 7,
		restartCompactionRecovery: vi.fn(() => {
			if (!runtime.pendingCompaction) return false;
			runtime.pendingCompaction.state = "waiting_coverage";
			runtime.pendingCompaction.lastError = undefined;
			return true;
		}),
		clearCompactionDeferral: vi.fn(() => {
			runtime.pendingCompaction = undefined;
		}),
		deferCompaction: vi.fn(),
	};

	registerRecoverCommand(pi as any, runtime);
	if (!handler) throw new Error("recover handler not registered");

	const notify = vi.fn();
	const waitForIdle = vi.fn(async () => undefined);
	const boundary = args.branchBoundary;
	const entries = boundary
		? [{ type: "compaction", id: boundary, parentId: null, timestamp: "2026-08-02T00:00:00.000Z" }]
		: [];
	const ctx = {
		cwd: "/tmp/project",
		ui: { notify },
		waitForIdle,
		sessionManager: { getBranch: () => entries },
	};
	const run = () => handler!("", ctx);

	return { ctx, emit, notify, pi, run, runtime, waitForIdle };
}

describe("/om:recover", () => {
	it("reports when no compaction recovery is pending", async () => {
		const subject = setup();

		await subject.run();

		expect(subject.runtime.ensureConfig).toHaveBeenCalledWith("/tmp/project");
		expect(subject.notify).toHaveBeenCalledWith(
			"Observational memory: no compaction recovery is pending",
			"info",
		);
		expect(subject.waitForIdle).not.toHaveBeenCalled();
		expect(subject.emit).not.toHaveBeenCalled();
	});

	it("rejects recovery while passive mode is enabled", async () => {
		const subject = setup({
			pending: pendingCompaction(),
			passive: true,
			branchBoundary: "cmp-1",
		});

		await subject.run();

		expect(subject.notify).toHaveBeenCalledWith(
			"Observational memory: recovery is unavailable while passive mode is enabled",
			"warning",
		);
		expect(subject.waitForIdle).not.toHaveBeenCalled();
		expect(subject.runtime.restartCompactionRecovery).not.toHaveBeenCalled();
		expect(subject.emit).not.toHaveBeenCalled();
	});

	it("restarts a blocked current recovery and emits the current context", async () => {
		const pending = pendingCompaction();
		const subject = setup({ pending, branchBoundary: "cmp-1" });

		await subject.run();

		expect(subject.waitForIdle).toHaveBeenCalledTimes(1);
		expect(subject.runtime.restartCompactionRecovery).toHaveBeenCalledTimes(1);
		expect(pending.state).toBe("waiting_coverage");
		expect(subject.emit).toHaveBeenCalledWith(
			OM_COMPACTION_RECOVERY_REQUESTED_EVENT,
			{
				ctx: subject.ctx,
				lifecycleGeneration: 7,
				boundaryKey: "cmp-1",
			},
		);
		expect(subject.notify).toHaveBeenCalledWith(
			"Observational memory: compaction recovery resumed",
			"info",
		);
	});

	it("clears a stale boundary without restarting or emitting recovery", async () => {
		const subject = setup({
			pending: pendingCompaction({ boundaryKey: "cmp-old" }),
			branchBoundary: "cmp-current",
		});

		await subject.run();

		expect(subject.waitForIdle).toHaveBeenCalledTimes(1);
		expect(subject.runtime.clearCompactionDeferral).toHaveBeenCalledTimes(1);
		expect(subject.runtime.pendingCompaction).toBeUndefined();
		expect(subject.runtime.restartCompactionRecovery).not.toHaveBeenCalled();
		expect(subject.emit).not.toHaveBeenCalled();
		expect(subject.notify).toHaveBeenCalledWith(
			"Observational memory: recovery target is stale for the current session branch",
			"warning",
		);
	});

	it("only wakes an existing waiting recovery without rebuilding it", async () => {
		const pending = pendingCompaction({
			state: "waiting_coverage",
			lastError: undefined,
		});
		const subject = setup({ pending, branchBoundary: "cmp-1" });

		await subject.run();

		expect(subject.runtime.pendingCompaction).toBe(pending);
		expect(subject.runtime.restartCompactionRecovery).not.toHaveBeenCalled();
		expect(subject.runtime.deferCompaction).not.toHaveBeenCalled();
		expect(subject.emit).toHaveBeenCalledWith(
			OM_COMPACTION_RECOVERY_REQUESTED_EVENT,
			expect.objectContaining({
				ctx: subject.ctx,
				lifecycleGeneration: 7,
				boundaryKey: "cmp-1",
			}),
		);
	});
});
