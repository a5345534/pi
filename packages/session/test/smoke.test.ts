import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertSessionCwdExists,
	CURRENT_SESSION_VERSION,
	configureSessionStorageDefaults,
	createCustomMessage,
	getDefaultSessionDir,
	loadEntriesFromFile,
	SessionManager,
} from "../src/index.ts";

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

describe("session storage options", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-"));
		configureSessionStorageDefaults(undefined);
	});

	afterEach(() => {
		configureSessionStorageDefaults(undefined);
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("requires a host-provided storage path for new persisted sessions", () => {
		expect(() => SessionManager.create(tempDir)).toThrow(/host-provided/);
	});

	it("creates JSONL sessions under a host-provided agent directory", () => {
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent-root");
		mkdirSync(cwd, { recursive: true });

		const sessionManager = SessionManager.create(cwd, { agentDir }, { id: "host-session" });
		const expectedSessionDir = getDefaultSessionDir(cwd, { agentDir });
		expect(sessionManager.getSessionDir()).toBe(expectedSessionDir);
		expect(sessionManager.usesDefaultSessionDir()).toBe(true);

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "test-api",
			provider: "test",
			model: "model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		const entries = loadEntriesFromFile(sessionFile!);
		expect(entries[0]).toMatchObject({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "host-session",
			cwd: resolve(cwd),
		});
		expect(entries).toHaveLength(3);
	});

	it("uses configured host defaults without app-specific session package defaults", () => {
		const cwd = join(tempDir, "configured-project");
		const agentDir = join(tempDir, "configured-agent");
		mkdirSync(cwd, { recursive: true });
		configureSessionStorageDefaults({ agentDir: () => agentDir });

		const sessionManager = SessionManager.create(cwd, undefined, { id: "configured-session" });
		expect(sessionManager.getSessionDir()).toBe(getDefaultSessionDir(cwd, { agentDir }));
		expect(sessionManager.getSessionFile()).toContain("configured-session");
	});

	it("opens and rewrites legacy session files from explicit host session directories", () => {
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "legacy.jsonl");
		writeFileSync(
			sessionFile,
			'{"type":"session","id":"legacy","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"message","timestamp":"2025-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}\n',
		);

		const sessionManager = SessionManager.open(sessionFile, { sessionDir });
		expect(sessionManager.getSessionId()).toBe("legacy");
		expect(sessionManager.getEntries()).toHaveLength(1);
		expect(readFileSync(sessionFile, "utf-8")).toContain(`"version":${CURRENT_SESSION_VERSION}`);
	});
});
