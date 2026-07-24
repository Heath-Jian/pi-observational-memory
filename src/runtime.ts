import { type Config, DEFAULTS, loadConfig } from "./config.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

export type ConsolidationTaskResult = {
	status: "success" | "failed" | "aborted";
	phase: ConsolidationPhase;
	watermark: string;
	error?: string;
	retryAt?: number;
};

export type StageFailureStatus = {
	watermark: string;
	failures: number;
	lastError: string;
	nextRetryAt: number;
	circuitOpenUntil?: number;
};

export type CompactionAttemptKind = "proactive" | "force";

export type ActiveCompactionAttempt = {
	id: number;
	kind: CompactionAttemptKind;
	lifecycleGeneration: number;
	boundaryKey: string;
};

export type PendingCompaction = {
	boundaryKey: string;
	cutKey: string;
	lifecycleGeneration: number;
	startedAt: number;
	deadlineAt: number;
	state: "waiting_coverage" | "ready";
};

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new Error(String(signal.reason ?? "aborted"));
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error(String(signal.reason ?? "aborted")));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<ConsolidationTaskResult> | null = null;
	consolidationPhase: ConsolidationPhase | undefined;
	consolidationWatermark: string | undefined;
	consolidationGeneration = 0;
	consolidationController: AbortController | null = null;
	lifecycleGeneration = 0;
	lifecycleController = new AbortController();
	convergenceControlInFlight = false;
	compactInFlight = false;
	compactHookInFlight = false;
	compactionDeferred = false;
	compactionDeferralKey: string | undefined;
	compactionDeferralCount = 0;
	pendingCompaction: PendingCompaction | undefined;
	activeCompactionAttempt: ActiveCompactionAttempt | undefined;
	compactionCancelCooldownUntil = 0;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	private nextCompactionAttemptId = 0;
	private readonly stageFailures = new Map<ConsolidationPhase, StageFailureStatus>();

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	async resolveModel(ctx: ResolveCtx, signal?: AbortSignal): Promise<ResolveResult> {
		let model = ctx.model;
		if (this.config.model) {
			const sessionProvider = (ctx.model as { provider?: unknown } | undefined)?.provider;
			const crossProvider = typeof sessionProvider === "string" && sessionProvider !== this.config.model.provider;
			if (crossProvider && !this.config.allowCrossProvider) {
				if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: cross-provider model ${this.config.model.provider}/${this.config.model.id} is disabled; using session model`,
						"warning",
					);
				}
			} else {
				const configured = ctx.modelRegistry.find(this.config.model.provider, this.config.model.id);
				if (configured) {
					model = configured;
				} else if (ctx.hasUI && ctx.ui) {
					ctx.ui.notify(
						`Observational memory: configured model ${this.config.model.provider}/${this.config.model.id} not found, using session model`,
						"warning",
					);
				}
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no observational-memory model configured)" };
		let auth: any;
		try {
			auth = await waitWithSignal(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
		} catch {
			return { ok: false, reason: signal?.aborted ? "model resolution aborted" : "model authentication failed" };
		}
		if (!auth.ok || !auth.apiKey) {
			const provider = (model as { provider?: string }).provider ?? "unknown";
			return { ok: false, reason: `no API key for provider "${provider}"` };
		}
		return { ok: true, model, apiKey: auth.apiKey as string, headers: auth.headers as Record<string, string> | undefined };
	}

	stageTimeoutMs(phase: ConsolidationPhase): number {
		const legacyTimeout = this.config.consolidationTimeoutMs ?? DEFAULTS.consolidationTimeoutMs;
		if (phase === "observer") return this.config.observerTimeoutMs ?? legacyTimeout;
		if (phase === "reflector") return this.config.reflectorTimeoutMs ?? legacyTimeout;
		return this.config.dropperTimeoutMs ?? legacyTimeout;
	}

	stageFailureStatus(phase: ConsolidationPhase): StageFailureStatus | undefined {
		const state = this.stageFailures.get(phase);
		return state ? { ...state } : undefined;
	}

	stageRetryAt(phase: ConsolidationPhase, watermark: string, now = Date.now()): number | undefined {
		const state = this.stageFailures.get(phase);
		if (!state || state.watermark !== watermark) return undefined;
		const retryAt = Math.max(state.nextRetryAt, state.circuitOpenUntil ?? 0);
		return retryAt > now ? retryAt : undefined;
	}

	recordStageSuccess(phase: ConsolidationPhase): void {
		this.stageFailures.delete(phase);
		if (phase === "observer") this.lastObserverError = undefined;
		if (phase === "reflector") this.lastReflectorError = undefined;
		if (phase === "dropper") this.lastDropperError = undefined;
	}

	recordStageFailure(phase: ConsolidationPhase, watermark: string, error: string, now = Date.now()): StageFailureStatus {
		const previous = this.stageFailures.get(phase);
		const failures = previous && previous.watermark === watermark ? previous.failures + 1 : 1;
		const delay = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)];
		const breakerFailures = this.config.consolidationCircuitBreakerFailures ?? DEFAULTS.consolidationCircuitBreakerFailures;
		const breakerMs = this.config.consolidationCircuitBreakerMs ?? DEFAULTS.consolidationCircuitBreakerMs;
		const circuitOpenUntil = failures >= breakerFailures
			? now + breakerMs
			: undefined;
		const state: StageFailureStatus = {
			watermark,
			failures,
			lastError: error,
			nextRetryAt: now + delay,
			...(circuitOpenUntil !== undefined ? { circuitOpenUntil } : {}),
		};
		this.stageFailures.set(phase, state);
		return state;
	}

	launchConsolidationTask(
		ctx: LaunchCtx,
		phase: ConsolidationPhase,
		watermark: string,
		work: (signal: AbortSignal, generation: number) => Promise<boolean>,
	): Promise<ConsolidationTaskResult> {
		const generation = ++this.consolidationGeneration;
		const controller = new AbortController();
		this.consolidationController = controller;
		this.consolidationInFlight = true;
		this.consolidationPhase = phase;
		this.consolidationWatermark = watermark;
		const timeoutReason = `${phase} timeout`;
		const timer = setTimeout(() => controller.abort(timeoutReason), this.stageTimeoutMs(phase));

		let promise!: Promise<ConsolidationTaskResult>;
		promise = (async (): Promise<ConsolidationTaskResult> => {
			let result: ConsolidationTaskResult;
			try {
				const progressed = await waitWithSignal(work(controller.signal, generation), controller.signal);
				if (generation !== this.consolidationGeneration) {
					result = { status: "aborted", phase, watermark };
				} else if (!progressed) {
					const message = `${phase} returned no durable progress`;
					this.recordConsolidationStageError(ctx, phase, message);
					const failure = this.recordStageFailure(phase, watermark, message);
					result = { status: "failed", phase, watermark, error: message, retryAt: failure.nextRetryAt };
				} else {
					this.recordStageSuccess(phase);
					result = { status: "success", phase, watermark };
				}
			} catch (error) {
				const message = errorMessage(error);
				const abortReason = controller.signal.aborted ? String(controller.signal.reason ?? "aborted") : undefined;
				const staleOrForegroundAbort = generation !== this.consolidationGeneration
					|| (abortReason !== undefined && abortReason !== timeoutReason);
				if (staleOrForegroundAbort) {
					result = { status: "aborted", phase, watermark, error: message };
				} else {
					this.recordConsolidationStageError(ctx, phase, message);
					const failure = this.recordStageFailure(phase, watermark, message);
					result = { status: "failed", phase, watermark, error: message, retryAt: failure.nextRetryAt };
				}
			} finally {
				clearTimeout(timer);
				if (this.consolidationGeneration === generation) {
					this.consolidationInFlight = false;
					this.consolidationPhase = undefined;
					this.consolidationWatermark = undefined;
					this.consolidationController = null;
					if (this.consolidationPromise === promise) this.consolidationPromise = null;
				}
			}
			return result!;
		})();
		this.consolidationPromise = promise;
		return promise;
	}

	isConsolidationCurrent(generation: number): boolean {
		return this.consolidationGeneration === generation && this.consolidationController?.signal.aborted === false;
	}

	isLifecycleCurrent(generation: number): boolean {
		return this.lifecycleGeneration === generation;
	}

	get lifecycleSignal(): AbortSignal {
		return this.lifecycleController.signal;
	}

	abortConsolidation(reason: string): void {
		this.consolidationGeneration += 1;
		this.consolidationController?.abort(reason);
		this.consolidationController = null;
		this.consolidationInFlight = false;
		this.consolidationPromise = null;
		this.consolidationPhase = undefined;
		this.consolidationWatermark = undefined;
	}

	deferCompaction(key: string, boundaryKey = "root", now = Date.now()): number {
		if (this.compactionDeferred) {
			this.compactionDeferralCount += 1;
		} else {
			this.compactionDeferralCount = 1;
			this.pendingCompaction = {
				boundaryKey,
				cutKey: key,
				lifecycleGeneration: this.lifecycleGeneration,
				startedAt: now,
				deadlineAt: now + this.config.compactionWaitForConsolidationMs,
				state: "waiting_coverage",
			};
		}
		this.compactionDeferralKey = key;
		this.compactionDeferred = true;
		if (this.pendingCompaction) {
			this.pendingCompaction.cutKey = key;
			this.pendingCompaction.boundaryKey = boundaryKey;
		}
		return this.compactionDeferralCount;
	}

	markCompactionReady(): void {
		if (this.pendingCompaction) this.pendingCompaction.state = "ready";
	}

	isDeferredGraceActive(now = Date.now()): boolean {
		return !!this.pendingCompaction && now < this.pendingCompaction.deadlineAt;
	}

	beginCompactionAttempt(kind: CompactionAttemptKind, boundaryKey: string): ActiveCompactionAttempt {
		const attempt: ActiveCompactionAttempt = {
			id: ++this.nextCompactionAttemptId,
			kind,
			lifecycleGeneration: this.lifecycleGeneration,
			boundaryKey,
		};
		this.activeCompactionAttempt = attempt;
		return attempt;
	}

	isCompactionAttemptCurrent(attemptId: number): boolean {
		const attempt = this.activeCompactionAttempt;
		return !!attempt
			&& attempt.id === attemptId
			&& attempt.lifecycleGeneration === this.lifecycleGeneration;
	}

	finishCompactionAttempt(attemptId: number): void {
		if (this.activeCompactionAttempt?.id === attemptId) {
			this.activeCompactionAttempt = undefined;
		}
	}

	setCompactionCancelCooldown(durationMs: number, now = Date.now()): void {
		this.compactionCancelCooldownUntil = Math.max(this.compactionCancelCooldownUntil, now + durationMs);
	}

	clearCompactionCancelCooldown(): void {
		this.compactionCancelCooldownUntil = 0;
	}

	clearCompactionDeferral(): void {
		this.compactionDeferred = false;
		this.compactionDeferralKey = undefined;
		this.compactionDeferralCount = 0;
		this.pendingCompaction = undefined;
	}

	clearCompactionState(): void {
		this.compactInFlight = false;
		this.compactHookInFlight = false;
		this.activeCompactionAttempt = undefined;
		this.clearCompactionDeferral();
		this.clearCompactionCancelCooldown();
	}

	invalidateConsolidation(): void {
		this.lifecycleController.abort("session or branch changed");
		this.lifecycleController = new AbortController();
		this.lifecycleGeneration += 1;
		this.abortConsolidation("session or branch changed");
		this.convergenceControlInFlight = false;
		this.clearCompactionState();
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = errorMessage(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
		return message;
	}
}
