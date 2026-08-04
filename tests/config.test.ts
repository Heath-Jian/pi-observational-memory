import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEFAULTS, loadConfig, readEnvConfig, resolveCompactAfterTokens } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			observerChunkMaxTokens: 0,
			observerChunkOverlapEntries: 0,
			observerChunkOutputReserveTokens: 8000,
			observerEmptyCoverageCommit: false,
			reflectAfterTokens: 20000,
			compactAfterTokens: 81000,
			compactAfterTokensMode: "calibrated",
			compactAfterTokensRatio: 0.68,
			compactAfterTokensOverrides: [],
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			reflectAfterObservationTokens: 2500,
			reflectAfterObserverBatches: 2,
			observerTimeoutMs: 180000,
			reflectorTimeoutMs: 240000,
			dropperTimeoutMs: 120000,
			consolidationTimeoutMs: 120000,
			consolidationIdleDelayMs: 500,
			consolidationCircuitBreakerFailures: 3,
			consolidationCircuitBreakerMs: 900000,
			compactionWaitForConsolidationMs: 15000,
			allowNativeCompactionFallback: true,
			allowCrossProvider: false,
			showWorkerNotifications: true,
			passive: false,
			debugLog: false,
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				observerChunkMaxTokens: 12_000,
				observerChunkOverlapEntries: 2,
				observerChunkOutputReserveTokens: 2_000,
				observerEmptyCoverageCommit: true,
				observerCoverageVerifyModel: { provider: "openai", id: "verifier", thinking: "minimal" },
				reflectAfterTokens: 20,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				reflectAfterObservationTokens: 12,
				reflectAfterObserverBatches: 3,
				observerTimeoutMs: 65,
				reflectorTimeoutMs: 85,
				dropperTimeoutMs: 55,
				consolidationTimeoutMs: 75,
				consolidationIdleDelayMs: 5,
				consolidationCircuitBreakerFailures: 4,
				consolidationCircuitBreakerMs: 125,
				compactionWaitForConsolidationMs: 25,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				allowCrossProvider: true,
				showWorkerNotifications: true,
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
				showWorkerNotifications: false,
			},
		});

		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			observerChunkMaxTokens: 12_000,
			observerChunkOverlapEntries: 2,
			observerChunkOutputReserveTokens: 2_000,
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "openai", id: "verifier", thinking: "minimal" },
			reflectAfterTokens: 20,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			reflectAfterObservationTokens: 12,
			reflectAfterObserverBatches: 3,
			observerTimeoutMs: 65,
			reflectorTimeoutMs: 85,
			dropperTimeoutMs: 55,
			consolidationTimeoutMs: 75,
			consolidationIdleDelayMs: 5,
			consolidationCircuitBreakerFailures: 4,
			consolidationCircuitBreakerMs: 125,
			compactionWaitForConsolidationMs: 25,
			model: { provider: "openai", id: "project", thinking: "low" },
			allowCrossProvider: true,
			showWorkerNotifications: false,
			passive: true,
			debugLog: true,
		});
	});

	it("loads the strict native-compaction fallback policy", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				allowNativeCompactionFallback: false,
				compactionWaitForConsolidationMs: 210000,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			allowNativeCompactionFallback: false,
			compactionWaitForConsolidationMs: 210000,
		});
	});

	it("ignores invalid V3 values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				observerChunkMaxTokens: -1,
				observerChunkOverlapEntries: 1.5,
				observerChunkOutputReserveTokens: 0,
				reflectAfterTokens: 0,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				showWorkerNotifications: "no",
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("clamps bounded batching to full-chunk without explicit verified empty commits", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { observerChunkMaxTokens: 64_000 },
		});

		const config = loadConfig(cwd, {});

		expect(config.observerChunkMaxTokens).toBe(0);
		expect(config.observerEmptyCoverageCommit).toBe(false);
		expect(config.configDiagnostics).toEqual([{
			level: "warning",
			message: "bounded batching requires observerEmptyCoverageCommit; falling back to full-chunk",
		}]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("bounded batching requires observerEmptyCoverageCommit"));
		warn.mockRestore();
	});

	it("disables commit without a verifier then re-applies the batching gate", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observerChunkMaxTokens: 64_000,
				observerEmptyCoverageCommit: true,
			},
		});

		const config = loadConfig(cwd, {});

		expect(config.observerEmptyCoverageCommit).toBe(false);
		expect(config.observerChunkMaxTokens).toBe(0);
		expect(config.configDiagnostics?.map((diagnostic) => diagnostic.message)).toEqual([
			"empty-coverage commit requires observerCoverageVerifyModel; disabled",
			"bounded batching requires observerEmptyCoverageCommit; falling back to full-chunk",
		]);
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("keeps the valid atomic batching, commit, and verifier combination", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observerChunkMaxTokens: 64_000,
				observerEmptyCoverageCommit: true,
				observerCoverageVerifyModel: { provider: "anthropic", id: "verifier", thinking: "low" },
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observerChunkMaxTokens: 64_000,
			observerEmptyCoverageCommit: true,
			observerCoverageVerifyModel: { provider: "anthropic", id: "verifier", thinking: "low" },
		});
		expect(loadConfig(cwd, {}).configDiagnostics).toBeUndefined();
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("parses passive env override", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
	});

	describe("compactAfterTokens ratio mode", () => {
		it("accepts compactAfterTokensMode and compactAfterTokensRatio", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
		});

		it("rejects invalid mode values and falls back to default calibrated", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "auto",
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensMode: "calibrated" });
		});

		it("rejects ratio outside (0, 1) and falls back to default", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 0,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1.5,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: -0.2,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});

		it("rejects non-numeric ratio and falls back to default", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: "0.5",
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});
	});

	describe("resolveCompactAfterTokens", () => {
		it("returns the calibrated value in calibrated mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "calibrated", compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81000);
		});

		it("returns calibrated value regardless of context window in calibrated mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "calibrated", compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
		});

		it("scales by context window in ratio mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(500_000);
			expect(resolveCompactAfterTokens(config, 200_000)).toBe(100_000);
		});

		it("floors fractional results to an integer >= 1", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 3)).toBe(1);
			expect(resolveCompactAfterTokens(config, 1)).toBe(1);
		});

		it("falls back to calibrated value when context window is unavailable in ratio mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
			expect(resolveCompactAfterTokens(config, -1)).toBe(81000);
		});
	});

	describe("compactAfterTokensOverrides", () => {
		it("parses valid overrides from settings", () => {
			writeJson(join(agentDir, "settings.json"), {
				"observational-memory": {
					compactAfterTokensOverrides: [
						{ provider: "kimi-coding", compactAfterTokens: 80000 },
						{ provider: "ark", model: "glm-5.2", compactAfterTokensRatio: 0.2 },
					],
				},
			});
			expect(loadConfig(cwd, {}).compactAfterTokensOverrides).toEqual([
				{ provider: "kimi-coding", compactAfterTokens: 80000 },
				{ provider: "ark", model: "glm-5.2", compactAfterTokensRatio: 0.2 },
			]);
		});

		it("drops entries without a provider/model selector or without a threshold", () => {
			writeJson(join(agentDir, "settings.json"), {
				"observational-memory": {
					compactAfterTokensOverrides: [
						{ compactAfterTokens: 80000 },
						{ provider: "kimi-coding" },
						{ provider: "", compactAfterTokens: 80000 },
						"nonsense",
						{ model: "k3", compactAfterTokensRatio: 1.5 },
						{ provider: "kimi-coding", compactAfterTokens: 80000 },
					],
				},
			});
			expect(loadConfig(cwd, {}).compactAfterTokensOverrides).toEqual([
				{ provider: "kimi-coding", compactAfterTokens: 80000 },
			]);
		});

		it("defaults to an empty override list", () => {
			expect(loadConfig(cwd, {}).compactAfterTokensOverrides).toEqual([]);
		});

		it("applies a matching provider override with a fixed threshold", () => {
			const config = {
				...DEFAULTS,
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.45,
				compactAfterTokensOverrides: [{ provider: "kimi-coding", compactAfterTokens: 80000 }],
			} as any;
			expect(resolveCompactAfterTokens(config, 1_000_000, { provider: "kimi-coding", id: "k3" })).toBe(80000);
			expect(resolveCompactAfterTokens(config, 1_000_000, { provider: "ark", id: "glm-5.2" })).toBe(450000);
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(450000);
		});

		it("requires both provider and model to match when both are specified", () => {
			const config = {
				...DEFAULTS,
				compactAfterTokensMode: "calibrated",
				compactAfterTokens: 81000,
				compactAfterTokensOverrides: [{ provider: "ark", model: "glm-5.2", compactAfterTokens: 50000 }],
			} as any;
			expect(resolveCompactAfterTokens(config, 256000, { provider: "ark", id: "glm-5.2" })).toBe(50000);
			expect(resolveCompactAfterTokens(config, 256000, { provider: "ark", id: "deepseek-v4-pro" })).toBe(81000);
			expect(resolveCompactAfterTokens(config, 256000, { provider: "kimi-coding", id: "glm-5.2" })).toBe(81000);
		});

		it("supports model-only overrides and override ratios", () => {
			const config = {
				...DEFAULTS,
				compactAfterTokensMode: "calibrated",
				compactAfterTokens: 81000,
				compactAfterTokensOverrides: [{ model: "k3", compactAfterTokensRatio: 0.1 }],
			} as any;
			expect(resolveCompactAfterTokens(config, 1_000_000, { provider: "kimi-coding", id: "k3" })).toBe(100000);
			// window unavailable: override ratio unusable, base calibrated applies
			expect(resolveCompactAfterTokens(config, undefined, { provider: "kimi-coding", id: "k3" })).toBe(81000);
		});

		it("uses the first matching override", () => {
			const config = {
				...DEFAULTS,
				compactAfterTokensOverrides: [
					{ provider: "kimi-coding", compactAfterTokens: 70000 },
					{ provider: "kimi-coding", compactAfterTokens: 90000 },
				],
			} as any;
			expect(resolveCompactAfterTokens(config, 1_000_000, { provider: "kimi-coding", id: "k3" })).toBe(70000);
		});
	});
});
