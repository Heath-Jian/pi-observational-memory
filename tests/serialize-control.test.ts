import { describe, expect, it } from "vitest";

import { renderRecallSourceEntry, serializeBranchEntries, serializeSourceAddressedBranchEntries } from "../src/serialize.js";

const control = {
	type: "custom_message",
	id: "control-1",
	timestamp: "2026-07-22T00:00:00.000Z",
	customType: "pi-convergence-control",
	content: "Do not call more tools",
};

const userCustom = {
	type: "custom_message",
	id: "custom-1",
	timestamp: "2026-07-22T00:00:01.000Z",
	customType: "user-note",
	content: "Keep this requirement",
};

describe("internal control serialization", () => {
	it("excludes convergence controls from observer and recall input", () => {
		expect(serializeBranchEntries([control, userCustom])).not.toContain("Do not call more tools");
		expect(serializeBranchEntries([control, userCustom])).toContain("Keep this requirement");

		const addressed = serializeSourceAddressedBranchEntries([control, userCustom]);
		expect(addressed.sourceEntryIds).toEqual(["custom-1"]);
		expect(addressed.text).not.toContain("Do not call more tools");
		expect(renderRecallSourceEntry(control)).toBeNull();
	});
});
