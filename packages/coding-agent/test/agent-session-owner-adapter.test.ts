import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOwnerEvent } from "@a5345534/pi-session";
import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createAgentSessionOwner } from "../src/core/session-owner-adapter.ts";

describe("AgentSessionOwner adapter", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createOwnerHost(options: { responses?: FauxResponseStep[]; tokensPerSecond?: number } = {}) {
		const tempDir = join(tmpdir(), `pi-owner-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ tokensPerSecond: options.tokensPerSecond });
		faux.setResponses(options.responses ?? []);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		const owner = createAgentSessionOwner(runtimeHost, { ownerId: "test-owner" });

		cleanups.push(async () => {
			try {
				await runtimeHost.dispose();
			} catch {
				// Tests may shut the owner down before cleanup.
			}
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { owner, runtimeHost, tempDir, faux };
	}

	it("maps prompt and compaction commands to app-neutral events and snapshots", async () => {
		const { owner, runtimeHost } = await createOwnerHost({
			responses: [fauxAssistantMessage("owner reply"), fauxAssistantMessage("owner summary")],
		});
		const sessionId = runtimeHost.session.sessionId;
		const events: SessionOwnerEvent[] = [];
		owner.subscribe(sessionId, (event) => events.push(event));

		await owner.sendCommand(sessionId, {
			type: "prompt.submit",
			commandId: "cmd-prompt",
			prompt: { content: "hello owner" },
		});
		await runtimeHost.session.agent.waitForIdle();
		await owner.sendCommand(sessionId, {
			type: "context.compact",
			commandId: "cmd-compact",
			instructions: "keep adapter details",
		});

		const eventTypes = events.map((event) => event.type);
		expect(eventTypes).toContain("turn.started");
		expect(eventTypes).toContain("message.delta");
		expect(eventTypes).toContain("turn.completed");
		expect(eventTypes).toContain("compaction.started");
		expect(eventTypes).toContain("compaction.completed");

		const snapshot = await owner.getSnapshot(sessionId);
		expect(snapshot.writer).toMatchObject({
			kind: "session-owner",
			ownerId: "test-owner",
			sessionId,
			exclusive: true,
		});
		expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant", "system"]);
		expect(snapshot.messages[0]?.content).toBe("hello owner");
		expect(snapshot.messages[1]?.content).toBe("owner reply");
		expect(snapshot.compaction).toMatchObject({ status: "completed", summary: "owner summary" });

		const serialized = JSON.stringify({ events, snapshot });
		expect(serialized).not.toContain("extensionRunner");
		expect(serialized).not.toContain("uiContext");
		expect(serialized).not.toContain("execute");
		expect(serialized).not.toContain("baseUrl");
	});

	it("maps create, open, resume, fork, and import to runtime session replacement", async () => {
		const { owner, runtimeHost, tempDir, faux } = await createOwnerHost({
			responses: [fauxAssistantMessage("original reply")],
		});
		const originalSessionId = runtimeHost.session.sessionId;
		await owner.sendCommand(originalSessionId, {
			type: "prompt.submit",
			commandId: "cmd-original-prompt",
			prompt: { content: "original prompt" },
		});
		await runtimeHost.session.agent.waitForIdle();
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const oldEvents: SessionOwnerEvent[] = [];
		owner.subscribe(originalSessionId, (event) => oldEvents.push(event));
		const created = await owner.createSession({ cwd: tempDir, id: "created-session", name: "Created" });
		expect(created).toMatchObject({ id: "created-session", cwd: tempDir, name: "Created", state: "active" });
		expect(oldEvents.map((event) => event.type)).toContain("session.closed");

		const restored = await owner.openSession({ kind: "session-file", path: originalSessionFile! });
		expect(restored.id).toBe(originalSessionId);
		expect(runtimeHost.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		await owner.sendCommand(restored.id, {
			type: "session.resume",
			commandId: "cmd-resume",
			query: { cwd: tempDir, limit: 1, sortBy: "modifiedAt", sortDirection: "desc" },
		});
		expect(runtimeHost.session.sessionId).toBe(originalSessionId);

		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const forked = await owner.forkSession({
			source: { kind: "session-id", sessionId: restored.id },
			entryId: userMessage.entryId,
			name: "Forked",
		});
		expect(forked.id).not.toBe(originalSessionId);
		expect(forked.name).toBe("Forked");
		expect(runtimeHost.session.messages).toEqual([]);

		faux.setResponses([fauxAssistantMessage("imported prompt reply")]);
		const imported = await owner.importSession(
			{ path: originalSessionFile!, cwd: tempDir },
			{ cwd: tempDir, name: "Imported" },
		);
		expect(imported.id).toBe(originalSessionId);
		expect(imported.name).toBe("Imported");
		const importedSnapshot = await owner.getSnapshot(imported.id);
		expect(importedSnapshot.messages.map((message) => message.content)).toEqual([
			"original prompt",
			"original reply",
		]);
	});

	it("maps abort and shutdown commands without exposing runtime internals", async () => {
		const { owner, runtimeHost } = await createOwnerHost({
			responses: [fauxAssistantMessage("slow response that should be aborted")],
			tokensPerSecond: 1,
		});
		const sessionId = runtimeHost.session.sessionId;
		const events: SessionOwnerEvent[] = [];
		owner.subscribe(sessionId, (event) => events.push(event));

		await owner.sendCommand(sessionId, {
			type: "prompt.submit",
			commandId: "cmd-slow-prompt",
			prompt: { content: "please wait" },
		});
		await owner.sendCommand(sessionId, { type: "turn.abort", commandId: "cmd-abort", reason: "test abort" });
		await runtimeHost.session.agent.waitForIdle();

		expect(events.some((event) => event.type === "turn.completed" && event.turn.status === "aborted")).toBe(true);

		await owner.sendCommand(sessionId, { type: "owner.shutdown", commandId: "cmd-shutdown", reason: "test done" });
		const snapshot = await owner.getSnapshot(sessionId);
		expect(snapshot.session.state).toBe("closed");
		expect(snapshot.state.status).toBe("closed");
		expect(JSON.stringify(snapshot)).not.toContain("extensionRunner");
	});
});
