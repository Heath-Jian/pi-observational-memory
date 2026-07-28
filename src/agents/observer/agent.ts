import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_EMPTY_COVERAGE_COMMIT_INSTRUCTIONS, OBSERVER_SYSTEM } from "./prompts.js";
import { nowTimestamp, truncateRecordContent } from "../../serialize.js";
import type { Observation, Relevance } from "../../session-ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";

export interface RunObserverArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	allowedSourceEntryIds: string[];
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
	/** Optional response cap used only by config-gated bounded observer runs. */
	maxOutputTokens?: number;
	/** Enables the explicit empty-batch coverage commit tool for this run. */
	emptyCoverageCommit?: boolean;
}

export interface ObserverRunStats {
	toolCalls: number;
	added: number;
	duplicate: number;
	rejected: number;
	stopReason: string;
	commitCalls?: number;
	duplicateCommits?: number;
	postCommitRejected?: number;
	toolErrors?: number;
	commitDiagnostic?: string;
}

export interface ObserverRunResult {
	observations: Observation[];
	stats: ObserverRunStats;
	/** Best-effort signal from a normally completed final assistant turn. */
	covered?: boolean;
}

const RelevanceSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

const CommitEmptyCoverageSchema = Type.Object({}, { additionalProperties: false });

const RecordObservationsSchema = Type.Object({
	observations: Type.Array(
		Type.Object({
			timestamp: Type.String({
				pattern: OBSERVATION_TIMESTAMP_PATTERN,
				description: "Observation time in local 'YYYY-MM-DD HH:MM' format.",
			}),
			content: Type.String({
				minLength: 1,
				description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
			}),
			relevance: RelevanceSchema,
			sourceEntryIds: Type.Array(
				Type.String({ minLength: 1 }),
				{
					minItems: 1,
					description:
						"Exact source entry ids from the chunk that directly support this observation. " +
						"Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
				},
			),
		}),
		{ description: "Batch of new observations. May be empty only if the tool is not called at all." },
	),
});

type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;
type CommitEmptyCoverageArgs = Static<typeof CommitEmptyCoverageSchema>;

const RECORD_OBSERVATIONS_DESCRIPTION =
	"Record a batch of new observations distilled from the conversation chunk. " +
	"Call this multiple times as you work through the chunk. Stop calling when coverage is complete, " +
	"then emit a short plain-text confirmation to end the run.";

const COMMIT_EMPTY_COVERAGE_DESCRIPTION =
	"Commit that you fully inspected this batch and found no new content worth recording. " +
	"Call exactly once, only after inspecting the entire chunk and only when no valid observations were recorded. " +
	"A successful call ends the run; never schedule another tool call after it.";

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function buildObserverUserText(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	now?: string;
	emptyCoverageCommit?: boolean;
}): string {
	const conversation = args.chunk.trim();
	const completionInstruction = args.emptyCoverageCommit
		? "If the fully inspected chunk yields zero valid observations, call commit_empty_coverage exactly once; that call ends the run. If you recorded observations, do not call it and finish with the normal short plain-text confirmation."
		: "Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.";
	return `Current local time: ${args.now ?? nowTimestamp()}

CURRENT REFLECTIONS:
${joinOrEmpty(args.priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(args.priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. ${completionInstruction}

NEW CONVERSATION CHUNK:
${conversation}`;
}

/**
 * Estimate the complete observer input, including the system/user templates and
 * the record_observations tool declaration. The caller applies an additional
 * safety factor before comparing this estimate with a configured hard budget.
 */
const OBSERVER_TOOL_DECLARATION = JSON.stringify({
	name: "record_observations",
	description: RECORD_OBSERVATIONS_DESCRIPTION,
	parameters: RecordObservationsSchema,
});
const COMMIT_EMPTY_COVERAGE_TOOL_DECLARATION = JSON.stringify({
	name: "commit_empty_coverage",
	description: COMMIT_EMPTY_COVERAGE_DESCRIPTION,
	parameters: CommitEmptyCoverageSchema,
});

export function estimateObserverPromptTokensForChunkCharacters(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunkCharacters: number;
	emptyCoverageCommit?: boolean;
}): { promptTokens: number; priorMemoryTokens: number } {
	const priorMemoryTokens = (args.priorReflections.length > 0
		? estimateStringTokens(args.priorReflections.join("\n"))
		: 0)
		+ (args.priorObservations.length > 0
			? estimateStringTokens(args.priorObservations.join("\n"))
			: 0);
	const emptyChunkUserText = buildObserverUserText({
		priorReflections: args.priorReflections,
		priorObservations: args.priorObservations,
		chunk: "",
		emptyCoverageCommit: args.emptyCoverageCommit,
	});
	const systemPrompt = args.emptyCoverageCommit
		? OBSERVER_SYSTEM + OBSERVER_EMPTY_COVERAGE_COMMIT_INSTRUCTIONS
		: OBSERVER_SYSTEM;
	return {
		promptTokens: estimateStringTokens(systemPrompt)
			+ Math.ceil((emptyChunkUserText.length + Math.max(0, args.chunkCharacters)) / 4)
			+ estimateStringTokens(OBSERVER_TOOL_DECLARATION)
			+ (args.emptyCoverageCommit ? estimateStringTokens(COMMIT_EMPTY_COVERAGE_TOOL_DECLARATION) : 0),
		priorMemoryTokens,
	};
}

export function estimateObserverPromptTokens(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	emptyCoverageCommit?: boolean;
}): { promptTokens: number; priorMemoryTokens: number } {
	return estimateObserverPromptTokensForChunkCharacters({
		priorReflections: args.priorReflections,
		priorObservations: args.priorObservations,
		chunkCharacters: args.chunk.trim().length,
		emptyCoverageCommit: args.emptyCoverageCommit,
	});
}

export function normalizeSourceEntryIds(
	sourceEntryIds: readonly string[] | undefined,
	allowedSourceEntryIds: readonly string[],
): string[] | undefined {
	if (!sourceEntryIds || sourceEntryIds.length === 0) return undefined;
	const allowedOrder = new Map<string, number>();
	for (let i = 0; i < allowedSourceEntryIds.length; i++) allowedOrder.set(allowedSourceEntryIds[i], i);

	const seen = new Set<string>();
	for (const id of sourceEntryIds) {
		if (!allowedOrder.has(id)) return undefined;
		seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return Array.from(seen).sort((a, b) => (allowedOrder.get(a) ?? 0) - (allowedOrder.get(b) ?? 0));
}

export async function runObserver(args: RunObserverArgs): Promise<ObserverRunResult> {
	const { model, apiKey, headers, priorReflections, priorObservations, chunk, allowedSourceEntryIds, signal } = args;
	const conversation = chunk.trim();
	if (!conversation) {
		return {
			observations: [],
			stats: { toolCalls: 0, added: 0, duplicate: 0, rejected: 0, stopReason: "empty-input" },
			covered: false,
		};
	}

	const accumulated = new Map<string, Observation>();
	const executedToolCallIds = new Set<string>();
	const guardedPostCommitIds = new Set<string>();
	let toolCalls = 0;
	let totalAdded = 0;
	let totalDuplicates = 0;
	let totalRejected = 0;
	let commitCalls = 0;
	let duplicateCommits = 0;
	let postCommitRejected = 0;
	let toolErrors = 0;
	let emptyCoverageLocked = false;
	let commitCandidate = false;
	let acceptedCommitCallId: string | undefined;
	let commitDiagnostic = "not-called";

	const postCommitResult = (toolName: string) => ({
		content: [{ type: "text" as const, text: `${toolName} rejected: empty coverage was already committed; no state was changed.` }],
		details: { observerDiagnostic: "post-commit-call-rejected", toolName },
		terminate: true,
	});

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description: RECORD_OBSERVATIONS_DESCRIPTION,
		parameters: RecordObservationsSchema,
		execute: async (id, params: RecordObservationsArgs) => {
			executedToolCallIds.add(id);
			toolCalls++;
			if (emptyCoverageLocked) {
				postCommitRejected++;
				guardedPostCommitIds.add(id);
				return postCommitResult("record_observations");
			}
			let added = 0;
			let duplicates = 0;
			let rejected = 0;
			for (const obs of params.observations) {
				const sourceEntryIds = normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds);
				if (!sourceEntryIds) {
					rejected++;
					continue;
				}
				const content = truncateRecordContent(obs.content);
				const id = hashId(content);
				if (accumulated.has(id)) {
					duplicates++;
					continue;
				}
				accumulated.set(id, {
					id,
					content,
					timestamp: obs.timestamp,
					relevance: obs.relevance as Relevance,
					sourceEntryIds,
					tokenCount: estimateStringTokens(content),
				});
				added++;
			}
			totalAdded += added;
			totalDuplicates += duplicates;
			totalRejected += rejected;
			const rejectedPart = rejected > 0
				? ` ${rejected} observation${rejected === 1 ? "" : "s"} rejected for missing or invalid sourceEntryIds.`
				: "";
			const ack =
				`Recorded ${added} new observation${added === 1 ? "" : "s"} ` +
				(duplicates > 0 ? `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped).` : ".") +
				rejectedPart +
				` Total so far this run: ${accumulated.size}. ` +
				`Continue if the chunk still has uncovered content; otherwise stop calling the tool and emit a short plain-text confirmation.`;
			return { content: [{ type: "text", text: ack }], details: { added, duplicates, rejected, total: accumulated.size } };
		},
	};

	const commitEmptyCoverage: AgentTool<typeof CommitEmptyCoverageSchema> = {
		name: "commit_empty_coverage",
		label: "Commit empty coverage",
		description: COMMIT_EMPTY_COVERAGE_DESCRIPTION,
		parameters: CommitEmptyCoverageSchema,
		execute: async (id, _params: CommitEmptyCoverageArgs) => {
			executedToolCallIds.add(id);
			toolCalls++;
			commitCalls++;
			if (emptyCoverageLocked) {
				duplicateCommits++;
				guardedPostCommitIds.add(id);
				commitDiagnostic = "duplicate-commit";
				return postCommitResult("commit_empty_coverage");
			}
			if (accumulated.size > 0) {
				commitDiagnostic = "commit-after-observations";
				return {
					content: [{ type: "text", text: "commit_empty_coverage rejected: valid observations were already recorded." }],
					details: { observerDiagnostic: commitDiagnostic },
				};
			}
			if (totalRejected > 0 || toolErrors > 0) {
				commitDiagnostic = "commit-with-unresolved-errors";
				return {
					content: [{ type: "text", text: "commit_empty_coverage rejected: this batch has unresolved tool errors." }],
					details: { observerDiagnostic: commitDiagnostic },
				};
			}
			commitCandidate = true;
			emptyCoverageLocked = true;
			acceptedCommitCallId = id;
			commitDiagnostic = "accepted";
			return {
				content: [{ type: "text", text: "Empty coverage committed. The observer run is complete." }],
				details: { observerDiagnostic: "empty-coverage-committed" },
				terminate: true,
			};
		},
	};

	const userText = buildObserverUserText({
		priorReflections,
		priorObservations,
		chunk: conversation,
		emptyCoverageCommit: args.emptyCoverageCommit,
	});

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: args.emptyCoverageCommit
			? OBSERVER_SYSTEM + OBSERVER_EMPTY_COVERAGE_COMMIT_INSTRUCTIONS
			: OBSERVER_SYSTEM,
		messages: [],
		tools: args.emptyCoverageCommit
			? [recordObservations as AgentTool<any>, commitEmptyCoverage as AgentTool<any>]
			: [recordObservations as AgentTool<any>],
	};

	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	let maxTurnsReached = false;
	const outputMaxTokens = args.maxOutputTokens && args.maxOutputTokens > 0
		? Math.min(AGENT_LOOP_MAX_TOKENS, args.maxOutputTokens)
		: AGENT_LOOP_MAX_TOKENS;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, outputMaxTokens),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(args.emptyCoverageCommit
			? {
				beforeToolCall: async ({ toolCall }) => {
					if (!emptyCoverageLocked || toolCall.id === acceptedCommitCallId) return undefined;
					guardedPostCommitIds.add(toolCall.id);
					if (toolCall.name === "commit_empty_coverage") duplicateCommits++;
					else postCommitRejected++;
					commitDiagnostic = toolCall.name === "commit_empty_coverage"
						? "duplicate-commit"
						: "post-commit-call-rejected";
					return { block: true, reason: "empty coverage was already committed; no further tool calls are allowed" };
				},
				afterToolCall: async ({ toolCall, result, isError }) => {
					const details = result.details as { observerDiagnostic?: unknown } | undefined;
					const logicalDiagnostic = typeof details?.observerDiagnostic === "string";
					if (guardedPostCommitIds.has(toolCall.id)) return { isError: true, terminate: true };
					if (isError) {
						if (emptyCoverageLocked && toolCall.id !== acceptedCommitCallId) {
							guardedPostCommitIds.add(toolCall.id);
							if (toolCall.name === "commit_empty_coverage") duplicateCommits++;
							else postCommitRejected++;
							return { isError: true, terminate: true };
						}
						if (!executedToolCallIds.has(toolCall.id)) {
							toolCalls++;
							if (toolCall.name === "commit_empty_coverage") commitCalls++;
							if (toolCall.name === "record_observations") totalRejected++;
						}
						toolErrors++;
						commitCandidate = false;
						commitDiagnostic = "tool-error";
					}
					if (logicalDiagnostic && details?.observerDiagnostic !== "empty-coverage-committed") {
						return { isError: true, terminate: emptyCoverageLocked };
					}
					return emptyCoverageLocked ? { terminate: true } : undefined;
				},
			}
			: {}),
		...(effectiveMaxTurns !== undefined || args.emptyCoverageCommit
			? {
				shouldStopAfterTurn: () => {
					if (effectiveMaxTurns !== undefined) {
						turnCount++;
						maxTurnsReached = turnCount >= effectiveMaxTurns;
					}
					return emptyCoverageLocked || maxTurnsReached;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, streamSimple);
	for await (const _event of stream) {
		// Drain events; the tool's execute already collects records.
	}
	const finalMessages = await stream.result();
	const messages = Array.isArray(finalMessages) ? finalMessages : [];
	const lastAssistant = [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as
		| { stopReason?: unknown }
		| undefined;
	const providerStopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : undefined;
	const stopReason = maxTurnsReached
		? "max-turns"
		: emptyCoverageLocked ? "empty-coverage-commit"
			: providerStopReason === "stop" ? "stop" : (providerStopReason ?? "completed");
	const interrupted = maxTurnsReached || signal?.aborted === true;
	const covered = args.emptyCoverageCommit === true
		&& commitCandidate
		&& emptyCoverageLocked
		&& totalRejected === 0
		&& toolErrors === 0
		&& !interrupted;
	if (commitCandidate && interrupted) commitDiagnostic = "interrupted-after-commit";
	return {
		observations: Array.from(accumulated.values()),
		stats: {
			toolCalls,
			added: totalAdded,
			duplicate: totalDuplicates,
			rejected: totalRejected,
			stopReason,
			...(args.emptyCoverageCommit
				? { commitCalls, duplicateCommits, postCommitRejected, toolErrors, commitDiagnostic }
				: {}),
		},
		covered,
	};
}

const CoverageVerificationSchema = Type.Object({
	hasRecordableContent: Type.Boolean(),
	reason: Type.String({ minLength: 1, description: "Brief evidence-based reason for the verdict." }),
});

type CoverageVerificationArgs = Static<typeof CoverageVerificationSchema>;

export interface CoverageVerifierRunResult {
	verdict?: CoverageVerificationArgs;
	stats: {
		toolCalls: number;
		toolErrors: number;
		stopReason: string;
	};
}

export interface RunCoverageVerifierArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	chunk: string;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	thinkingLevel?: ModelThinkingLevel;
}

const COVERAGE_VERIFIER_SYSTEM = `You verify a proposed empty observation batch.
Read the entire conversation chunk. Use report_coverage_verification exactly once.
Set hasRecordableContent=true if the chunk contains any new fact, decision, constraint, correction, completion, unresolved blocker, or other content that should become an observation.
Set it to false only when the chunk contains no recordable content. Fail closed when uncertain.`;

/** Independently verifies every proposed empty coverage commit through one structured tool. */
export async function runCoverageVerifier(args: RunCoverageVerifierArgs): Promise<CoverageVerifierRunResult> {
	let verdict: CoverageVerificationArgs | undefined;
	let toolCalls = 0;
	let toolErrors = 0;
	const report: AgentTool<typeof CoverageVerificationSchema> = {
		name: "report_coverage_verification",
		label: "Report coverage verification",
		description: "Return the verifier's structured verdict for the complete chunk.",
		parameters: CoverageVerificationSchema,
		execute: async (_id, params: CoverageVerificationArgs) => {
			toolCalls++;
			if (verdict) {
				return {
					content: [{ type: "text", text: "Verification verdict already reported." }],
					details: { verifierDiagnostic: "duplicate-verdict" },
					terminate: true,
				};
			}
			verdict = { hasRecordableContent: params.hasRecordableContent, reason: params.reason };
			return {
				content: [{ type: "text", text: "Verification verdict recorded." }],
				details: { accepted: true },
				terminate: true,
			};
		},
	};
	const prompts: Message[] = [{
		role: "user",
		content: [{ type: "text", text: `Verify this exact observer chunk:\n\n${args.chunk}` }],
		timestamp: Date.now(),
	}];
	const context: AgentContext = {
		systemPrompt: COVERAGE_VERIFIER_SYSTEM,
		messages: [],
		tools: [report as AgentTool<any>],
	};
	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const config: AgentLoopConfig = {
		model: args.model,
		apiKey: args.apiKey,
		headers: args.headers,
		maxTokens: boundedMaxTokens(args.model, Math.min(AGENT_LOOP_MAX_TOKENS, 2_000)),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		afterToolCall: async ({ isError }) => {
			if (isError) toolErrors++;
			return verdict ? { terminate: true } : undefined;
		},
		shouldStopAfterTurn: () => verdict !== undefined || toolErrors > 0,
	};
	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, args.signal, streamSimple);
	for await (const _event of stream) {
		// Drain; the structured tool captures the verdict.
	}
	const finalMessages = await stream.result();
	const messages = Array.isArray(finalMessages) ? finalMessages : [];
	const lastAssistant = [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as
		| { stopReason?: unknown }
		| undefined;
	const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : "completed";
	return {
		...(verdict && toolErrors === 0 && !args.signal?.aborted ? { verdict } : {}),
		stats: { toolCalls, toolErrors, stopReason },
	};
}

/** Compatibility wrapper for callers that still consume the pre-Phase-1 shape. */
export async function runObserverObservations(args: RunObserverArgs): Promise<Observation[] | undefined> {
	const result = await runObserver(args);
	return result.observations.length > 0 ? result.observations : undefined;
}
