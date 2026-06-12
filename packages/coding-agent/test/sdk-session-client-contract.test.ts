import { describe, expect, it } from "vitest";
import type { SessionClient, SessionCommand, SessionOwnerEvent } from "../src/core/sdk.ts";
import { createAgentSessionOwner, SESSION_OWNER_CONTRACT_VERSION } from "../src/core/sdk.ts";

describe("SDK session owner contract exports", () => {
	it("exposes the owner/client contract through the SDK entrypoint", () => {
		const command = { type: "turn.abort", commandId: "sdk-contract-test" } satisfies SessionCommand;
		const eventType: SessionOwnerEvent["type"] = "turn.completed";
		const clientMethods = ["sendCommand", "getSnapshot", "subscribe"] satisfies Array<keyof SessionClient>;

		expect(createAgentSessionOwner).toBeTypeOf("function");
		expect(SESSION_OWNER_CONTRACT_VERSION).toBe(1);
		expect(command.type).toBe("turn.abort");
		expect(eventType).toBe("turn.completed");
		expect(clientMethods).toContain("sendCommand");
	});
});
