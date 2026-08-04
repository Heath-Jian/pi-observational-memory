import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export interface ConfigDiagnostic {
	level: "warning";
	message: string;
}

/**
 * How `compactAfterTokens` is interpreted.
 *
 * - `"calibrated"` (default): use the static `compactAfterTokens` value directly.
 *   Backwards-compatible with all existing V3 configs.
 *
 * - `"ratio"`: compute the effective threshold as
 *   `floor(model.contextWindow * compactAfterTokensRatio)`. This auto-scales the
 *   proactive compaction trigger to the active model's context window, so a 1M
 *   context model is not preempted at the same 81K threshold as a 128K model.
 *
 *   Some models advertise a large context window but lose attention at long
 *   range; users can lower `compactAfterTokensRatio` to compact earlier on such
 *   models without giving up the window on models that stay sharp.
 *
 *   When the active model's `contextWindow` is unavailable (undefined, 0, or
 *   negative), ratio mode falls back to the calibrated `compactAfterTokens`
 *   value so compaction still triggers safely.
 */
export type CompactAfterTokensMode = "calibrated" | "ratio";

/**
 * Per-provider/per-model compaction threshold override.
 *
 * Resolution order in `resolveCompactAfterTokens`:
 * 1. First override whose `provider` (if set) matches the active model's
 *    provider AND whose `model` (if set) matches the active model's id wins.
 * 2. A winning override with `compactAfterTokens` returns that fixed value.
 * 3. A winning override with only `compactAfterTokensRatio` scales by the
 *    active model's context window; when the window is unavailable the
 *    override is skipped and base resolution applies.
 * 4. No matching override: base `compactAfterTokensMode` logic applies.
 *
 * Use this when a specific provider enforces rate limits that make large
 * contexts expensive (e.g. a 1M-window model whose backend throttles long
 * requests): compact earlier only for that provider without lowering the
 * threshold for every other model.
 */
export interface CompactAfterTokensOverride {
	provider?: string;
	model?: string;
	compactAfterTokens?: number;
	compactAfterTokensRatio?: number;
}

export interface Config {
	observeAfterTokens: number;
	/**
	 * Maximum estimated tokens for one observer request. A value of 0 keeps the
	 * legacy behavior and sends the entire uncovered source range.
	 */
	observerChunkMaxTokens: number;
	/**
	 * Read-only source entries appended after a bounded batch for context. These
	 * entries are never included in the batch coverage watermark.
	 */
	observerChunkOverlapEntries: number;
	/**
	 * Output tokens reserved inside observerChunkMaxTokens. In bounded mode this
	 * also caps the observer response token allowance.
	 */
	observerChunkOutputReserveTokens: number;
	/**
	 * Enables explicit empty-batch coverage commits. This is fail-closed and is
	 * normalized back to false unless observerCoverageVerifyModel is valid.
	 */
	observerEmptyCoverageCommit: boolean;
	/** Dedicated model that verifies every proposed empty-batch coverage commit. */
	observerCoverageVerifyModel?: ConfiguredModel;
	/** Load-time clamps to surface once a Runtime receives UI context. */
	configDiagnostics?: ConfigDiagnostic[];
	reflectAfterTokens: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;
	compactAfterTokensRatio: number;
	compactAfterTokensOverrides: CompactAfterTokensOverride[];
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	agentMaxTurns: number;
	reflectAfterObservationTokens: number;
	reflectAfterObserverBatches: number;
	observerTimeoutMs: number;
	reflectorTimeoutMs: number;
	dropperTimeoutMs: number;
	consolidationTimeoutMs: number;
	consolidationIdleDelayMs: number;
	consolidationCircuitBreakerFailures: number;
	consolidationCircuitBreakerMs: number;
	compactionWaitForConsolidationMs: number;
	/**
	 * Whether incomplete observational coverage may fall through to Pi's native
	 * compaction, which uses the active session model.
	 */
	allowNativeCompactionFallback: boolean;
	model?: ConfiguredModel;
	allowCrossProvider: boolean;
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	observerChunkMaxTokens: 0,
	observerChunkOverlapEntries: 0,
	observerChunkOutputReserveTokens: 8_000,
	observerEmptyCoverageCommit: false,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	compactAfterTokensOverrides: [],
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	reflectAfterObservationTokens: 2_500,
	reflectAfterObserverBatches: 2,
	observerTimeoutMs: 180_000,
	reflectorTimeoutMs: 240_000,
	dropperTimeoutMs: 120_000,
	consolidationTimeoutMs: 120_000,
	consolidationIdleDelayMs: 500,
	consolidationCircuitBreakerFailures: 3,
	consolidationCircuitBreakerMs: 15 * 60_000,
	compactionWaitForConsolidationMs: 15_000,
	allowNativeCompactionFallback: true,
	allowCrossProvider: false,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};

export const COMPACT_AFTER_TOKENS_MODE_VALUES: readonly CompactAfterTokensMode[] = ["calibrated", "ratio"] as const;

/**
 * Resolve the effective proactive-compaction token threshold for the given
 * config and active model context window.
 *
 * In `"calibrated"` mode this is always `config.compactAfterTokens`.
 *
 * In `"ratio"` mode this is `floor(contextWindow * compactAfterTokensRatio)`
 * (clamped to a minimum of 1) when `contextWindow` is a positive number, and
 * falls back to `config.compactAfterTokens` otherwise.
 *
 * Before the base mode is consulted, `config.compactAfterTokensOverrides` is
 * checked against the active model (see {@link CompactAfterTokensOverride}).
 */
export function resolveCompactAfterTokens(
	config: Config,
	contextWindow: number | undefined,
	model?: { provider?: string; id?: string },
): number {
	for (const override of config.compactAfterTokensOverrides ?? []) {
		if (override.provider !== undefined && override.provider !== model?.provider) continue;
		if (override.model !== undefined && override.model !== model?.id) continue;
		if (override.compactAfterTokens !== undefined) return override.compactAfterTokens;
		if (
			override.compactAfterTokensRatio !== undefined
			&& typeof contextWindow === "number"
			&& contextWindow > 0
		) {
			return Math.max(1, Math.floor(contextWindow * override.compactAfterTokensRatio));
		}
	}
	if (config.compactAfterTokensMode === "ratio" && typeof contextWindow === "number" && contextWindow > 0) {
		return Math.max(1, Math.floor(contextWindow * config.compactAfterTokensRatio));
	}
	return config.compactAfterTokens;
}

export const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function validTargetOrUndefined(value: unknown, maxTokens: number): number | undefined {
	const target = positiveIntegerOrUndefined(value);
	return target !== undefined && target < maxTokens ? target : undefined;
}

function derivedObservationPoolTarget(maxTokens: number): number {
	return Math.floor(maxTokens / 2);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isCompactAfterTokensMode(value: unknown): value is CompactAfterTokensMode {
	return typeof value === "string" && (COMPACT_AFTER_TOKENS_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * A valid ratio is a finite number strictly between 0 and 1.
 * 0 would never trigger; >= 1 would compact at/after the full window with no
 * room left for the response.
 */
function validRatioOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeCompactAfterTokensOverride(value: unknown): CompactAfterTokensOverride | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const model = nonEmptyString(value.model);
	if (!provider && !model) return undefined;
	const compactAfterTokens = positiveIntegerOrUndefined(value.compactAfterTokens);
	const compactAfterTokensRatio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (compactAfterTokens === undefined && compactAfterTokensRatio === undefined) return undefined;
	const override: CompactAfterTokensOverride = {};
	if (provider) override.provider = provider;
	if (model) override.model = model;
	if (compactAfterTokens !== undefined) override.compactAfterTokens = compactAfterTokens;
	if (compactAfterTokensRatio !== undefined) override.compactAfterTokensRatio = compactAfterTokensRatio;
	return override;
}

function normalizeModel(value: unknown): ConfiguredModel | undefined {
	if (!isRecord(value)) return undefined;
	const provider = nonEmptyString(value.provider);
	const id = nonEmptyString(value.id);
	if (!provider || !id) return undefined;
	const model: ConfiguredModel = { provider, id };
	if (isThinkingLevel(value.thinking)) model.thinking = value.thinking;
	return model;
}

function normalizeSettingsConfig(value: Record<string, unknown>): Partial<Config> {
	const normalized: Partial<Config> = {};
	const numberKeys = [
		"observeAfterTokens",
		"observerChunkOutputReserveTokens",
		"reflectAfterTokens",
		"compactAfterTokens",
		"observationsPoolMaxTokens",
		"observationsPoolTargetTokens",
		"agentMaxTurns",
		"reflectAfterObservationTokens",
		"reflectAfterObserverBatches",
		"observerTimeoutMs",
		"reflectorTimeoutMs",
		"dropperTimeoutMs",
		"consolidationTimeoutMs",
		"consolidationIdleDelayMs",
		"consolidationCircuitBreakerFailures",
		"consolidationCircuitBreakerMs",
		"compactionWaitForConsolidationMs",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	for (const key of ["observerChunkMaxTokens", "observerChunkOverlapEntries"] as const) {
		const normalizedValue = nonNegativeIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	if (isCompactAfterTokensMode(value.compactAfterTokensMode)) {
		normalized.compactAfterTokensMode = value.compactAfterTokensMode;
	}
	const ratio = validRatioOrUndefined(value.compactAfterTokensRatio);
	if (ratio !== undefined) normalized.compactAfterTokensRatio = ratio;
	if (Array.isArray(value.compactAfterTokensOverrides)) {
		normalized.compactAfterTokensOverrides = value.compactAfterTokensOverrides
			.map(normalizeCompactAfterTokensOverride)
			.filter((override): override is CompactAfterTokensOverride => override !== undefined);
	}
	if (typeof value.observerEmptyCoverageCommit === "boolean") {
		normalized.observerEmptyCoverageCommit = value.observerEmptyCoverageCommit;
	}
	const observerCoverageVerifyModel = normalizeModel(value.observerCoverageVerifyModel);
	if (observerCoverageVerifyModel) normalized.observerCoverageVerifyModel = observerCoverageVerifyModel;
	if (typeof value.showWorkerNotifications === "boolean") normalized.showWorkerNotifications = value.showWorkerNotifications;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.allowNativeCompactionFallback === "boolean") {
		normalized.allowNativeCompactionFallback = value.allowNativeCompactionFallback;
	}
	if (typeof value.allowCrossProvider === "boolean") normalized.allowCrossProvider = value.allowCrossProvider;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	const model = normalizeModel(value.model);
	if (model) normalized.model = model;
	return normalized;
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? normalizeSettingsConfig(nested) : {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
	const globalPath = join(getAgentDir(), "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	const globalConfig = readNamespacedConfig(globalPath);
	const projectConfig = readNamespacedConfig(projectPath);
	const envConfig = readEnvConfig(env);
	const merged = {
		...DEFAULTS,
		observationsPoolTargetTokens: undefined,
		...globalConfig,
		...projectConfig,
		...envConfig,
	};
	const target = validTargetOrUndefined(
		merged.observationsPoolTargetTokens,
		merged.observationsPoolMaxTokens,
	) ?? derivedObservationPoolTarget(merged.observationsPoolMaxTokens);
	const diagnostics: ConfigDiagnostic[] = [];
	let observerEmptyCoverageCommit = merged.observerEmptyCoverageCommit;
	let observerChunkMaxTokens = merged.observerChunkMaxTokens;

	if (observerEmptyCoverageCommit && !merged.observerCoverageVerifyModel) {
		observerEmptyCoverageCommit = false;
		diagnostics.push({
			level: "warning",
			message: "empty-coverage commit requires observerCoverageVerifyModel; disabled",
		});
	}
	if (observerChunkMaxTokens > 0 && !observerEmptyCoverageCommit) {
		observerChunkMaxTokens = 0;
		diagnostics.push({
			level: "warning",
			message: "bounded batching requires observerEmptyCoverageCommit; falling back to full-chunk",
		});
	}

	for (const diagnostic of diagnostics) {
		// loadConfig intentionally has no UI context. Keep clamps visible in
		// headless runtimes; an interactive Runtime surfaces the same diagnostics.
		console.warn(`Observational memory: ${diagnostic.message}`);
	}

	return {
		...merged,
		observerChunkMaxTokens,
		observerEmptyCoverageCommit,
		observationsPoolTargetTokens: target,
		...(diagnostics.length > 0 ? { configDiagnostics: diagnostics } : {}),
	};
}
