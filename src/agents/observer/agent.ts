import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { OBSERVER_SYSTEM } from "./prompts.js";
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
}

export interface ObserverRunStats {
	toolCalls: number;
	added: number;
	duplicate: number;
	rejected: number;
	stopReason: string;
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

const RECORD_OBSERVATIONS_DESCRIPTION =
	"Record a batch of new observations distilled from the conversation chunk. " +
	"Call this multiple times as you work through the chunk. Stop calling when coverage is complete, " +
	"then emit a short plain-text confirmation to end the run.";

function joinOrEmpty(items: string[]): string {
	return items.length ? items.join("\n") : "(none yet)";
}

export function buildObserverUserText(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
	now?: string;
}): string {
	const conversation = args.chunk.trim();
	return `Current local time: ${args.now ?? nowTimestamp()}

CURRENT REFLECTIONS:
${joinOrEmpty(args.priorReflections)}

CURRENT OBSERVATIONS:
${joinOrEmpty(args.priorObservations)}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

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

export function estimateObserverPromptTokensForChunkCharacters(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunkCharacters: number;
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
	});
	return {
		promptTokens: estimateStringTokens(OBSERVER_SYSTEM)
			+ Math.ceil((emptyChunkUserText.length + Math.max(0, args.chunkCharacters)) / 4)
			+ estimateStringTokens(OBSERVER_TOOL_DECLARATION),
		priorMemoryTokens,
	};
}

export function estimateObserverPromptTokens(args: {
	priorReflections: string[];
	priorObservations: string[];
	chunk: string;
}): { promptTokens: number; priorMemoryTokens: number } {
	return estimateObserverPromptTokensForChunkCharacters({
		priorReflections: args.priorReflections,
		priorObservations: args.priorObservations,
		chunkCharacters: args.chunk.trim().length,
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
	let toolCalls = 0;
	let totalAdded = 0;
	let totalDuplicates = 0;
	let totalRejected = 0;

	const recordObservations: AgentTool<typeof RecordObservationsSchema> = {
		name: "record_observations",
		label: "Record observations",
		description: RECORD_OBSERVATIONS_DESCRIPTION,
		parameters: RecordObservationsSchema,
		execute: async (_id, params: RecordObservationsArgs) => {
			toolCalls++;
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

	const userText = buildObserverUserText({ priorReflections, priorObservations, chunk: conversation });

	const prompts: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		},
	];

	const context: AgentContext = {
		systemPrompt: OBSERVER_SYSTEM,
		messages: [],
		tools: [recordObservations as AgentTool<any>],
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
		...(effectiveMaxTurns !== undefined
			? {
				shouldStopAfterTurn: () => {
					turnCount++;
					maxTurnsReached = turnCount >= effectiveMaxTurns;
					return maxTurnsReached;
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
	const stopReason = providerStopReason === "stop"
		? "stop"
		: maxTurnsReached ? "max-turns" : (providerStopReason ?? "completed");
	return {
		observations: Array.from(accumulated.values()),
		stats: {
			toolCalls,
			added: totalAdded,
			duplicate: totalDuplicates,
			rejected: totalRejected,
			stopReason,
		},
		covered: !maxTurnsReached && providerStopReason === "stop",
	};
}

/** Compatibility wrapper for callers that still consume the pre-Phase-1 shape. */
export async function runObserverObservations(args: RunObserverArgs): Promise<Observation[] | undefined> {
	const result = await runObserver(args);
	return result.observations.length > 0 ? result.observations : undefined;
}
