import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import {
	DEBUG_LOG_RELATIVE_PATH,
	debugLog,
	debugLogRelativePath,
	safeDebugLogSessionId,
	withDebugLogContext,
} from "../src/debug-log.js";

describe("debug logging", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-debug-log-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function readJsonLines(path: string): any[] {
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("writes enabled events to a private hashed session file without local paths", () => {
		withDebugLogContext({
			enabled: true,
			sessionId: "session-123",
			runId: "run-1",
		}, () => {
			debugLog("dropper.result", { reason: "no_tool_call" });
		});

		const sessionKey = safeDebugLogSessionId("session-123")!;
		const logPath = join(agentDir, "observational-memory", "debug", `${sessionKey}.ndjson`);
		expect(existsSync(logPath)).toBe(true);
		expect(existsSync(join(agentDir, DEBUG_LOG_RELATIVE_PATH))).toBe(false);
		expect(readJsonLines(logPath)).toMatchObject([
			{
				event: "dropper.result",
				sessionKey,
				runId: "run-1",
				data: { reason: "no_tool_call" },
			},
		]);
		expect(readFileSync(logPath, "utf8")).not.toContain("session-123");
		expect(statSync(logPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentDir, "observational-memory", "debug")).mode & 0o777).toBe(0o700);
	});

	it("appends multiple runs for the same session to the same debug file", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-abc", runId: "run-1" }, () => debugLog("one"));
		withDebugLogContext({ enabled: true, sessionId: "session-abc", runId: "run-2" }, () => debugLog("two"));

		const logPath = join(agentDir, debugLogRelativePath({ sessionId: "session-abc" }));
		expect(readJsonLines(logPath).map((row) => row.runId)).toEqual(["run-1", "run-2"]);
	});

	it("uses different debug files for different sessions", () => {
		withDebugLogContext({ enabled: true, sessionId: "session-a" }, () => debugLog("event"));
		withDebugLogContext({ enabled: true, sessionId: "session-b" }, () => debugLog("event"));

		expect(existsSync(join(agentDir, debugLogRelativePath({ sessionId: "session-a" })))).toBe(true);
		expect(existsSync(join(agentDir, debugLogRelativePath({ sessionId: "session-b" })))).toBe(true);
	});

	it("falls back to the legacy global debug file without a usable session id", () => {
		withDebugLogContext({ enabled: true, runId: "run-1" }, () => debugLog("observer.start"));
		withDebugLogContext({ enabled: true, sessionId: "---" }, () => debugLog("observer.start"));

		const logPath = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
		expect(readJsonLines(logPath)).toMatchObject([
			{ event: "observer.start", runId: "run-1" },
			{ event: "observer.start" },
		]);
	});

	it("hashes session ids before using them as filenames", () => {
		const key = safeDebugLogSessionId(" session/../id:value ");
		expect(key).toMatch(/^[a-f0-9]{24}$/);
		expect(debugLogRelativePath({ sessionId: " session/../id:value " })).toBe(join("observational-memory", "debug", `${key}.ndjson`));
		expect(debugLogRelativePath({ sessionId: "---" })).toBe(DEBUG_LOG_RELATIVE_PATH);
	});

	it("does not write logs when disabled", () => {
		withDebugLogContext({ enabled: false, sessionId: "session-123" }, () => debugLog("dropper.result"));

		expect(existsSync(join(agentDir, "observational-memory"))).toBe(false);
	});
});
