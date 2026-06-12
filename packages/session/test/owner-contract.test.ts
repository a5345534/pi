import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type CreateSessionOptions,
	type ForkSessionTarget,
	SESSION_COMMAND_TYPES,
	SESSION_OWNER_CONTRACT_VERSION,
	SESSION_OWNER_EVENT_TYPES,
	type SessionClient,
	type SessionCommand,
	type SessionEventListener,
	type SessionHandle,
	type SessionListItem,
	type SessionListQuery,
	type SessionOwner,
	type SessionOwnerEvent,
	type SessionSnapshot,
	type SessionSnapshotMessage,
	type SessionTarget,
	type Unsubscribe,
} from "../src/index.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

class ContractSessionOwner implements SessionOwner {
	readonly ownerId = "contract-owner";
	readonly writePolicy = "single-owner" as const;
	readonly commandLog: Array<{ readonly sessionId: string; readonly command: SessionCommand }> = [];
	readonly writerLog: string[] = [];

	private readonly handles = new Map<string, SessionHandle>();
	private readonly snapshots = new Map<string, SessionSnapshot>();
	private readonly listeners = new Map<string, Set<SessionEventListener>>();
	private nextSessionIndex = 1;
	private nextMessageIndex = 1;
	private nextTurnIndex = 1;

	async listSessions(query: SessionListQuery = {}): Promise<readonly SessionListItem[]> {
		let items = Array.from(this.handles.values()).filter((handle) => {
			if (query.cwd && handle.cwd !== query.cwd) return false;
			if (!query.includeClosed && handle.state === "closed") return false;
			if (query.name && handle.name !== query.name) return false;
			if (query.parentSessionId && handle.parentSessionId !== query.parentSessionId) return false;
			if (query.search && !`${handle.id} ${handle.name ?? ""}`.includes(query.search)) return false;
			return true;
		});

		if (query.sortBy === "name") {
			items = [...items].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
		}
		if (query.sortDirection === "desc") {
			items = [...items].reverse();
		}

		const offset = query.offset ?? 0;
		const limit = query.limit ?? items.length;
		return items.slice(offset, offset + limit).map((handle): SessionListItem => {
			const snapshot = this.snapshots.get(handle.id);
			const firstUserMessage = snapshot?.messages.find((message) => message.role === "user");
			const item: SessionListItem = {
				...handle,
				modifiedAt: TIMESTAMP,
				messageCount: snapshot?.messages.length ?? 0,
			};
			return typeof firstUserMessage?.content === "string"
				? { ...item, firstMessage: firstUserMessage.content }
				: item;
		});
	}

	async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
		const id = options.id ?? `session-${this.nextSessionIndex++}`;
		const handle: SessionHandle = {
			id,
			cwd: options.cwd,
			state: "active",
			createdAt: TIMESTAMP,
			name: options.name,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		this.handles.set(id, handle);
		const snapshot = this.createSnapshot(handle, []);
		this.snapshots.set(id, snapshot);
		this.emit({ type: "session.created", sessionId: id, timestamp: TIMESTAMP, handle });
		this.emit({ type: "snapshot", sessionId: id, timestamp: TIMESTAMP, snapshot });
		return handle;
	}

	async openSession(target: SessionTarget): Promise<SessionHandle> {
		const id = target.kind === "session-id" ? target.sessionId : `restored-${this.nextSessionIndex++}`;
		const handle: SessionHandle = {
			id,
			cwd: target.cwd ?? "/workspace",
			state: "active",
			createdAt: TIMESTAMP,
			sessionFile: target.kind === "session-file" ? target.path : undefined,
		};
		this.handles.set(id, handle);
		const snapshot = this.createSnapshot(handle, []);
		this.snapshots.set(id, snapshot);
		this.emit({ type: "session.restored", sessionId: id, timestamp: TIMESTAMP, handle });
		return handle;
	}

	async forkSession(target: ForkSessionTarget): Promise<SessionHandle> {
		const handle: SessionHandle = {
			id: `fork-${this.nextSessionIndex++}`,
			cwd: target.cwd ?? target.source.cwd ?? "/workspace",
			state: "active",
			createdAt: TIMESTAMP,
			name: target.name,
			metadata: target.metadata,
		};
		this.handles.set(handle.id, handle);
		this.snapshots.set(handle.id, this.createSnapshot(handle, []));
		this.emit({ type: "session.created", sessionId: handle.id, timestamp: TIMESTAMP, handle });
		return handle;
	}

	async closeSession(sessionId: string): Promise<void> {
		const snapshot = this.requireSnapshot(sessionId);
		const handle: SessionHandle = { ...snapshot.session, state: "closed" };
		this.handles.set(sessionId, handle);
		this.snapshots.set(sessionId, { ...snapshot, session: handle, state: { status: "closed" } });
		this.emit({ type: "session.closed", sessionId, timestamp: TIMESTAMP });
	}

	async sendCommand(sessionId: string, command: SessionCommand): Promise<void> {
		this.commandLog.push({ sessionId, command });
		this.writerLog.push(`${this.ownerId}:${sessionId}:${command.type}`);
		const snapshot = this.requireSnapshot(sessionId);

		if (command.type === "prompt.submit") {
			const turnId = `turn-${this.nextTurnIndex++}`;
			const turnStarted = {
				id: turnId,
				status: "running" as const,
				startedAt: TIMESTAMP,
				commandId: command.commandId,
			};
			const userMessage: SessionSnapshotMessage = {
				id: `message-${this.nextMessageIndex++}`,
				role: "user",
				content: command.prompt.content,
				createdAt: command.issuedAt ?? TIMESTAMP,
				status: "completed",
				metadata: command.prompt.metadata,
			};
			const assistantMessage: SessionSnapshotMessage = {
				id: `message-${this.nextMessageIndex++}`,
				role: "assistant",
				content: "",
				createdAt: TIMESTAMP,
				status: "streaming",
			};
			const completedAssistantMessage: SessionSnapshotMessage = {
				...assistantMessage,
				content: "ok",
				completedAt: TIMESTAMP,
				status: "completed",
			};
			const turnCompleted = { ...turnStarted, status: "completed" as const, completedAt: TIMESTAMP };

			this.emit({
				type: "turn.started",
				sessionId,
				timestamp: TIMESTAMP,
				commandId: command.commandId,
				turn: turnStarted,
			});
			this.emit({ type: "message.started", sessionId, timestamp: TIMESTAMP, message: assistantMessage });
			this.emit({
				type: "message.delta",
				sessionId,
				timestamp: TIMESTAMP,
				messageId: assistantMessage.id,
				delta: { type: "text", text: "ok" },
			});
			this.emit({ type: "message.completed", sessionId, timestamp: TIMESTAMP, message: completedAssistantMessage });
			this.emit({
				type: "turn.completed",
				sessionId,
				timestamp: TIMESTAMP,
				commandId: command.commandId,
				turn: turnCompleted,
			});
			this.snapshots.set(sessionId, {
				...snapshot,
				state: { status: "idle" },
				messages: [...snapshot.messages, userMessage, completedAssistantMessage],
				activeTurn: turnCompleted,
			});
		}
	}

	async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
		return this.requireSnapshot(sessionId);
	}

	subscribe(sessionId: string, listener: SessionEventListener): Unsubscribe {
		const listeners = this.listeners.get(sessionId) ?? new Set<SessionEventListener>();
		listeners.add(listener);
		this.listeners.set(sessionId, listeners);
		return () => {
			const currentListeners = this.listeners.get(sessionId);
			currentListeners?.delete(listener);
			if (currentListeners?.size === 0) {
				this.listeners.delete(sessionId);
			}
		};
	}

	private createSnapshot(handle: SessionHandle, messages: readonly SessionSnapshotMessage[]): SessionSnapshot {
		return {
			version: SESSION_OWNER_CONTRACT_VERSION,
			session: handle,
			state: { status: "idle" },
			messages,
			writer: {
				kind: "session-owner",
				ownerId: this.ownerId,
				sessionId: handle.id,
				exclusive: true,
				acquiredAt: TIMESTAMP,
			},
		};
	}

	private requireSnapshot(sessionId: string): SessionSnapshot {
		const snapshot = this.snapshots.get(sessionId);
		if (!snapshot) {
			throw new Error(`Unknown session: ${sessionId}`);
		}
		return snapshot;
	}

	private emit(event: SessionOwnerEvent): void {
		const listeners = this.listeners.get(event.sessionId);
		if (!listeners) return;
		for (const listener of listeners) {
			listener(event);
		}
	}
}

describe("session owner contract types", () => {
	it("defines serializable app-neutral session commands", () => {
		const commands = [
			{
				type: "session.create",
				commandId: "cmd-create",
				issuedAt: TIMESTAMP,
				options: { cwd: "/workspace", id: "created-session", name: "Created" },
			},
			{
				type: "session.new",
				commandId: "cmd-new",
				options: { cwd: "/workspace", name: "New" },
			},
			{
				type: "session.open",
				commandId: "cmd-open",
				target: { kind: "session-file", path: "/sessions/one.jsonl", cwd: "/workspace" },
			},
			{
				type: "session.resume",
				commandId: "cmd-resume",
				query: { cwd: "/workspace", limit: 1, sortBy: "modifiedAt", sortDirection: "desc" },
			},
			{
				type: "session.fork",
				commandId: "cmd-fork",
				target: { source: { kind: "session-id", sessionId: "created-session" }, entryId: "entry-1" },
			},
			{
				type: "session.import",
				commandId: "cmd-import",
				source: { kind: "jsonl-file", path: "/imports/session.jsonl", cwd: "/workspace" },
				options: { cwd: "/workspace", name: "Imported" },
			},
			{ type: "session.close", commandId: "cmd-close", reason: "client requested" },
			{
				type: "prompt.submit",
				commandId: "cmd-prompt",
				issuedAt: TIMESTAMP,
				prompt: { content: [{ type: "text", text: "Say ok" }], metadata: { source: "contract-test" } },
			},
			{ type: "turn.abort", commandId: "cmd-abort", turnId: "turn-1", reason: "user cancelled" },
			{
				type: "context.compact",
				commandId: "cmd-compact",
				target: "current-branch",
				instructions: "keep decisions",
			},
			{
				type: "model.change",
				commandId: "cmd-model",
				model: { providerId: "provider-id", modelId: "model-id", displayName: "Model" },
			},
			{ type: "thinking.change", commandId: "cmd-thinking", thinking: { level: "medium", budgetTokens: 1024 } },
			{ type: "owner.shutdown", commandId: "cmd-shutdown", reason: "test complete", force: false },
		] satisfies readonly SessionCommand[];

		expect(commands.map((command) => command.type)).toEqual([...SESSION_COMMAND_TYPES]);
		for (const command of commands) {
			const serialized = JSON.stringify(command);
			expect(JSON.parse(serialized) as SessionCommand).toEqual(command);
		}
	});

	it("exposes stable public owner event names without persistence or adapter internals", () => {
		expect(SESSION_OWNER_EVENT_TYPES).toEqual([
			"session.created",
			"session.restored",
			"session.closed",
			"snapshot",
			"turn.started",
			"turn.completed",
			"message.started",
			"message.delta",
			"message.completed",
			"tool.started",
			"tool.progress",
			"tool.completed",
			"compaction.started",
			"compaction.completed",
			"model.changed",
			"thinking.changed",
			"error",
		]);
		expect(SESSION_OWNER_EVENT_TYPES).not.toContain("SessionMessageEntry");
		expect(SESSION_OWNER_EVENT_TYPES).not.toContain("CompactionEntry");
		expect(SESSION_OWNER_EVENT_TYPES).not.toContain("ProjectTrustEvent");
		expect(SESSION_OWNER_EVENT_TYPES).not.toContain("SessionBeforeCompactEvent");
	});

	it("allows clients to subscribe and unsubscribe from owner events", async () => {
		const owner = new ContractSessionOwner();
		const handle = await owner.createSession({ cwd: "/workspace", id: "subscribed-session" });
		const received: SessionOwnerEvent[] = [];
		const unsubscribe = owner.subscribe(handle.id, (event) => received.push(event));

		await owner.sendCommand(handle.id, {
			type: "prompt.submit",
			commandId: "cmd-prompt",
			prompt: { content: "hello" },
		});
		unsubscribe();
		await owner.sendCommand(handle.id, {
			type: "prompt.submit",
			commandId: "cmd-after-unsubscribe",
			prompt: { content: "ignored" },
		});

		expect(received.map((event) => event.type)).toEqual([
			"turn.started",
			"message.started",
			"message.delta",
			"message.completed",
			"turn.completed",
		]);
		expect(received.every((event) => SESSION_OWNER_EVENT_TYPES.includes(event.type))).toBe(true);
	});

	it("allows late clients to retrieve snapshots without reading JSONL", async () => {
		const owner = new ContractSessionOwner();
		const client: SessionClient = owner;
		const handle = await client.createSession({ cwd: "/workspace", id: "snapshot-session" });

		await client.sendCommand(handle.id, {
			type: "prompt.submit",
			commandId: "cmd-prompt",
			prompt: { content: "capture this" },
		});

		const snapshot = await client.getSnapshot(handle.id);
		expect(snapshot).toMatchObject({
			version: SESSION_OWNER_CONTRACT_VERSION,
			session: { id: handle.id, cwd: "/workspace", state: "active" },
			state: { status: "idle" },
			writer: { kind: "session-owner", ownerId: owner.ownerId, sessionId: handle.id, exclusive: true },
		});
		expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(snapshot.messages[0]?.content).toBe("capture this");
	});

	it("models clients as command senders and the owner as the exclusive writer", async () => {
		const owner = new ContractSessionOwner();
		const client: SessionClient = owner;
		const handle = await client.createSession({ cwd: "/workspace", id: "single-writer-session" });

		expect(owner.writePolicy).toBe("single-owner");
		expect("appendJsonl" in client).toBe(false);

		await client.sendCommand(handle.id, {
			type: "prompt.submit",
			commandId: "cmd-single-writer",
			prompt: { content: "write through owner" },
		});

		const snapshot = await client.getSnapshot(handle.id);
		expect(snapshot.writer).toEqual({
			kind: "session-owner",
			ownerId: owner.ownerId,
			sessionId: handle.id,
			exclusive: true,
			acquiredAt: TIMESTAMP,
		});
		expect(owner.writerLog).toEqual([`${owner.ownerId}:${handle.id}:prompt.submit`]);
	});
});

describe("session package boundary", () => {
	it("does not import coding-agent, TUI, provider auth, CLI parsing, extension UI, or app config modules", () => {
		const srcDir = fileURLToPath(new URL("../src", import.meta.url));
		const forbiddenImports: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
			{ name: "coding-agent", pattern: /^(?:@a5345534\/pi-coding-agent|.*packages\/coding-agent)(?:\/|$)/ },
			{ name: "TUI", pattern: /^(?:@earendil-works\/pi-tui|.*packages\/tui)(?:\/|$)/ },
			{ name: "extension UI", pattern: /(?:^|\/)(?:extension-ui|extensions\/ui|ui\/extensions)(?:\.ts|\/|$)/i },
			{ name: "provider auth", pattern: /(?:^|\/)(?:auth|oauth|provider-auth|providers\/[^/]*auth)(?:\.ts|\/|$)/i },
			{ name: "CLI parsing", pattern: /(?:^|\/)(?:cli|args|arg-parser|commander|yargs)(?:\.ts|\/|$)/i },
			{ name: "app config", pattern: /(?:^|\/)(?:app-config|app-defaults|config\/app)(?:\.ts|\/|$)/i },
		];
		const importPattern = /(?:\bfrom\s+|^\s*import\s+)["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gm;

		for (const file of collectTypeScriptFiles(srcDir)) {
			const source = readFileSync(file, "utf8");
			const relativeFile = relative(srcDir, file);
			expect(source, `${relativeFile} should not contain app-specific path defaults`).not.toMatch(
				/\bPI_FORK_|pi-fork|\.pi-fork/,
			);
			for (const match of source.matchAll(importPattern)) {
				const specifier = match[1] ?? match[2];
				if (!specifier) continue;
				for (const forbidden of forbiddenImports) {
					expect(
						forbidden.pattern.test(specifier),
						`${relativeFile} imports ${specifier}, which matches forbidden ${forbidden.name} boundary`,
					).toBe(false);
				}
			}
		}
	});
});

function collectTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTypeScriptFiles(path));
		} else if (entry.isFile() && path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}
