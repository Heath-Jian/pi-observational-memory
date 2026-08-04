export const CHECKPOINT_REQUEST_EVENT = "pi-coordination:checkpoint-request";
export const CHECKPOINT_GRANT_EVENT = "pi-coordination:checkpoint-grant";
export const CHECKPOINT_FINISH_EVENT = "pi-coordination:checkpoint-finish";
export const CHECKPOINT_RELEASE_EVENT = "pi-coordination:checkpoint-release";
export const CHECKPOINT_CANCEL_EVENT = "pi-coordination:checkpoint-cancel";

export type CheckpointPurpose =
	| "observational-memory:observe"
	| "observational-memory:compaction-recovery";

export type CheckpointRequestV1 = {
	version: 1;
	requestId: string;
	requester: "observational-memory";
	requesterGeneration: number;
	purpose: CheckpointPurpose;
	urgency: "routine" | "strict";
	boundaryKey: string;
	targetEntryId: string;
	branchHeadId: string;
	requestedAt: number;
	maxLeaseMs: number;
};

export type CheckpointGrantV1 = {
	version: 1;
	requestId: string;
	leaseId: string;
	requesterGeneration: number;
	boundaryKey: string;
	targetEntryId: string;
	branchHeadId: string;
	grantedAt: number;
	expiresAt: number;
};

export type CheckpointReleaseV1 = {
	version: 1;
	requestId: string;
	leaseId?: string;
	requesterGeneration: number;
	boundaryKey: string;
	targetEntryId: string;
	branchHeadId: string;
	reason: "expired" | "preempted" | "session-changed" | "coordinator-disabled" | "busy";
	releasedAt: number;
};

export type CheckpointFinishOutcome = "observed" | "compacted" | "not-needed" | "failed" | "aborted";
export type CheckpointFinishReason = "superseded" | "session-changed" | "lease-expired";

export function isCheckpointGrant(value: unknown): value is CheckpointGrantV1 {
	if (!value || typeof value !== "object") return false;
	const grant = value as Partial<CheckpointGrantV1>;
	return grant.version === 1
		&& typeof grant.requestId === "string"
		&& typeof grant.leaseId === "string"
		&& typeof grant.requesterGeneration === "number"
		&& typeof grant.boundaryKey === "string"
		&& typeof grant.targetEntryId === "string"
		&& typeof grant.branchHeadId === "string"
		&& typeof grant.grantedAt === "number"
		&& typeof grant.expiresAt === "number"
		&& Number.isFinite(grant.grantedAt)
		&& Number.isFinite(grant.expiresAt)
		&& grant.expiresAt > grant.grantedAt
		&& grant.expiresAt > Date.now();
}

export function isCheckpointRelease(value: unknown): value is CheckpointReleaseV1 {
	if (!value || typeof value !== "object") return false;
	const release = value as Partial<CheckpointReleaseV1>;
	return release.version === 1
		&& typeof release.requestId === "string"
		&& typeof release.requesterGeneration === "number"
		&& typeof release.boundaryKey === "string"
		&& typeof release.targetEntryId === "string"
		&& typeof release.branchHeadId === "string"
		&& ["expired", "preempted", "session-changed", "coordinator-disabled", "busy"].includes(String(release.reason))
		&& typeof release.releasedAt === "number"
		&& Number.isFinite(release.releasedAt);
}
