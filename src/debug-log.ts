import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEBUG_LOG_RELATIVE_PATH = join("observational-memory", "debug.ndjson");
export const DEBUG_LOG_SESSION_DIR_RELATIVE_PATH = join("observational-memory", "debug");

export interface DebugLogContext {
	enabled: boolean;
	sessionId?: string;
	runId?: string;
}

const storage = new AsyncLocalStorage<DebugLogContext>();

export function withDebugLogContext<T>(context: DebugLogContext, fn: () => T): T {
	const parent = storage.getStore();
	return storage.run({ ...parent, ...context }, fn);
}

export function safeDebugLogSessionId(sessionId: string | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	if (!/[A-Za-z0-9]/.test(trimmed)) return undefined;
	return createHash("sha256").update(trimmed).digest("hex").slice(0, 24);
}

export function debugLogRelativePath(context: Pick<DebugLogContext, "sessionId">): string {
	const safeSessionId = safeDebugLogSessionId(context.sessionId);
	return safeSessionId
		? join(DEBUG_LOG_SESSION_DIR_RELATIVE_PATH, `${safeSessionId}.ndjson`)
		: DEBUG_LOG_RELATIVE_PATH;
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
	const context = storage.getStore();
	if (context?.enabled !== true) return;

	try {
		const path = join(getAgentDir(), debugLogRelativePath(context));
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		chmodSync(dirname(path), 0o700);
		rotateIfNeeded(path);
		const payload = {
			ts: new Date().toISOString(),
			event,
			sessionKey: safeDebugLogSessionId(context.sessionId),
			runId: context.runId,
			data,
		};
		appendFileSync(path, `${JSON.stringify(payload)}\n`, { encoding: "utf-8", mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		// Debug logging must never affect memory behavior.
	}
}

function rotateIfNeeded(path: string): void {
	if (!existsSync(path)) return;
	if (statSync(path).size < DEBUG_LOG_MAX_BYTES) return;
	const backupPath = `${path}.1`;
	if (existsSync(backupPath)) unlinkSync(backupPath);
	renameSync(path, backupPath);
	chmodSync(backupPath, 0o600);
}
