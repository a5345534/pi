import { describe, expect, it } from "vitest";
import { assertSessionCwdExists, createCustomMessage, SessionManager } from "../src/index.ts";

describe("pi-session exports", () => {
	it("exposes session manager and message helpers", () => {
		expect(typeof SessionManager).toBe("function");
		expect(createCustomMessage("notice", "hello", true, undefined, "2026-01-01T00:00:00.000Z")).toMatchObject({
			role: "custom",
			customType: "notice",
			content: "hello",
		});
		expect(typeof assertSessionCwdExists).toBe("function");
	});
});
