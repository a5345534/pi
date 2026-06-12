import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CreateSessionRuntimeFactory,
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	type OwnedSessionRuntimeServices,
	type OwnedSessionRuntimeSession,
	SessionManager,
	SessionRuntimeHost,
	type SessionRuntimeShutdownEvent,
	type SessionRuntimeStartEvent,
} from "../src/index.ts";

class RuntimeSession implements OwnedSessionRuntimeSession {
	readonly sessionManager: SessionManager;
	disposed = false;

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface RuntimeServices extends OwnedSessionRuntimeServices {}

const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "test-api",
	provider: "test-provider",
	model: "test-model",
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
} satisfies Message;

function createPersistedSession(cwd: string, agentDir: string, id: string): SessionManager {
	const sessionManager = SessionManager.create(cwd, { agentDir }, { id });
	sessionManager.appendMessage({ role: "user", content: `hello from ${id}`, timestamp: 1 });
	sessionManager.appendMessage(assistantMessage);
	return sessionManager;
}

describe("SessionRuntimeHost", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-runtime-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createHost(initialManager: SessionManager) {
		const events: Array<string> = [];
		const shutdownEvents: SessionRuntimeShutdownEvent[] = [];
		const startEvents: SessionRuntimeStartEvent[] = [];
		const sessions: RuntimeSession[] = [];
		const createRuntime: CreateSessionRuntimeFactory<
			RuntimeSession,
			RuntimeServices,
			string,
			SessionRuntimeStartEvent,
			{ readonly cwd: string }
		> = async ({ cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext }) => {
			const session = new RuntimeSession(sessionManager);
			sessions.push(session);
			events.push(`create:${sessionManager.getSessionId()}:${projectTrustContext?.cwd ?? "none"}`);
			if (sessionStartEvent) {
				startEvents.push(sessionStartEvent);
			}
			return {
				session,
				services: { cwd, agentDir },
				diagnostics: [`created:${sessionManager.getSessionId()}`],
			};
		};

		const initialSession = new RuntimeSession(initialManager);
		sessions.push(initialSession);
		const host = new SessionRuntimeHost(
			initialSession,
			{ cwd: initialManager.getCwd(), agentDir: tempDir },
			createRuntime,
			[],
			undefined,
			{
				emitShutdown: async (_session, event) => {
					shutdownEvents.push(event);
					events.push(`shutdown:${event.reason}:${_session.sessionManager.getSessionId()}`);
				},
				disposeSession: (session) => {
					events.push(`dispose:${session.sessionManager.getSessionId()}`);
					session.dispose();
				},
				createSessionStartEvent: (reason, previousSessionFile): SessionRuntimeStartEvent => ({
					type: "session_start",
					reason,
					previousSessionFile,
				}),
				createProjectTrustContext: (cwd) => ({ cwd }),
				createReplacedSessionContext: (session) => session,
			},
		);

		return { host, events, shutdownEvents, startEvents, sessions };
	}

	it("moves session replacement ownership into packages/session without changing JSONL format", async () => {
		const initialManager = createPersistedSession(tempDir, tempDir, "first-session");
		const originalFile = initialManager.getSessionFile();
		expect(originalFile).toBeDefined();
		const { host, events, startEvents, sessions } = createHost(initialManager);

		await host.newSession({ cwd: tempDir, id: "second-session" });
		expect(host.session.sessionManager.getSessionId()).toBe("second-session");
		expect(sessions[0]?.disposed).toBe(true);
		expect(events).toEqual(["shutdown:new:first-session", "dispose:first-session", "create:second-session:none"]);

		await host.switchSession(originalFile!, {
			projectTrustContextFactory: (cwd) => ({ cwd: resolve(cwd) }),
		});
		expect(host.session.sessionManager.getSessionId()).toBe("first-session");
		expect(host.session.sessionManager.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(startEvents.map((event) => event.reason)).toEqual(["new", "resume"]);

		const entries = loadEntriesFromFile(originalFile!);
		expect(entries[0]).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION, id: "first-session" });
		expect(entries).toHaveLength(3);
	});

	it("keeps the active runtime as the only writer across fork and import operations", async () => {
		const initialManager = createPersistedSession(tempDir, tempDir, "writer-session");
		const originalFile = initialManager.getSessionFile();
		expect(originalFile).toBeDefined();
		const userEntry = initialManager.getEntries().find((entry) => entry.type === "message");
		expect(userEntry).toBeDefined();
		const { host, events, shutdownEvents } = createHost(initialManager);

		const forkResult = await host.fork(userEntry!.id, { position: "at" });
		expect(forkResult.cancelled).toBe(false);
		expect(host.session.sessionManager.getSessionId()).not.toBe("writer-session");
		expect(events.slice(0, 3)).toEqual([
			"shutdown:fork:writer-session",
			"dispose:writer-session",
			`create:${host.session.sessionManager.getSessionId()}:none`,
		]);

		host.session.sessionManager.appendMessage({ role: "user", content: "active owner writes", timestamp: 3 });
		host.session.sessionManager.appendMessage({ ...assistantMessage, timestamp: 4 });
		const activeFile = host.session.sessionManager.getSessionFile();
		expect(activeFile).toBeDefined();
		expect(existsSync(activeFile!)).toBe(true);

		await host.importFromJsonl(originalFile!, tempDir);
		expect(host.session.sessionManager.getSessionId()).toBe("writer-session");
		expect(shutdownEvents.map((event) => event.reason)).toEqual(["fork", "resume"]);
		expect(host.session.sessionManager.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
	});
});
