import {
	type CreateSessionOptions,
	type ForkSessionTarget,
	SESSION_OWNER_CONTRACT_VERSION,
	type SessionClient,
	type SessionCommand,
	type SessionCompactionSnapshot,
	type SessionContentBlock,
	type SessionEventListener,
	type SessionHandle,
	type SessionJsonObject,
	type SessionJsonValue,
	type SessionListItem,
	type SessionListQuery,
	type SessionMessageRole,
	type SessionMessageStatus,
	type SessionMetadata,
	type SessionModelSelection,
	type SessionOwner,
	type SessionOwnerError,
	type SessionOwnerEvent,
	type SessionOwnerEventBase,
	type SessionOwnerEventType,
	type SessionPrompt,
	type SessionPromptContent,
	type SessionRuntimeStatus,
	type SessionSnapshot,
	type SessionSnapshotMessage,
	type SessionTarget,
	type SessionThinkingSelection,
	type SessionToolCallSnapshot,
	type SessionToolProgress,
	type SessionTurnSnapshot,
	type Unsubscribe,
} from "@a5345534/pi-session";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { getDefaultSessionDir, type SessionInfo, SessionManager } from "./session-manager.ts";

export interface AgentSessionOwnerOptions {
	readonly ownerId?: string;
	readonly acquiredAt?: string;
}

interface ResolvedSessionTarget {
	readonly alreadyActive: boolean;
	readonly sessionFile?: string;
	readonly cwdOverride?: string;
}

interface PromptInput {
	readonly text: string;
	readonly images?: ImageContent[];
}

const DEFAULT_OWNER_ID = "coding-agent-runtime";

function nowIso(): string {
	return new Date().toISOString();
}

function isoFromTimestamp(timestamp: number | undefined, fallback: string = nowIso()): string {
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function toSessionJsonValue(
	value: unknown,
	seen: WeakSet<object> = new WeakSet<object>(),
): SessionJsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : String(value);
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return "[Circular]";
		}
		seen.add(value);
		const items = value.map((item) => toSessionJsonValue(item, seen) ?? null);
		seen.delete(value);
		return items;
	}
	if (typeof value === "object" && value !== null) {
		if (seen.has(value)) {
			return "[Circular]";
		}
		seen.add(value);
		const object: Record<string, SessionJsonValue> = {};
		for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
			const jsonValue = toSessionJsonValue(entryValue, seen);
			if (jsonValue !== undefined) {
				object[key] = jsonValue;
			}
		}
		seen.delete(value);
		return object;
	}
	return undefined;
}

function toSessionJsonObject(value: unknown): SessionJsonObject | undefined {
	const jsonValue = toSessionJsonValue(value);
	if (jsonValue === undefined) {
		return undefined;
	}
	if (typeof jsonValue === "object" && jsonValue !== null && !Array.isArray(jsonValue)) {
		return jsonValue as SessionJsonObject;
	}
	return { value: jsonValue };
}

function errorToOwnerError(error: unknown, code = "coding_agent_runtime_error"): SessionOwnerError {
	if (error instanceof Error) {
		return {
			code,
			message: error.message,
			details: { name: error.name },
		};
	}
	return { code, message: String(error) };
}

function modelToSelection(model: Model<string> | undefined): SessionModelSelection | undefined {
	if (!model) {
		return undefined;
	}
	return {
		providerId: model.provider,
		modelId: model.id,
		displayName: model.name,
	};
}

function statusForSession(session: AgentSession, closed: boolean): SessionRuntimeStatus {
	if (closed) {
		return "closed";
	}
	if (session.isCompacting) {
		return "compacting";
	}
	if (session.isStreaming) {
		return "running";
	}
	return "idle";
}

function promptBlocksToContent(blocks: readonly SessionContentBlock[]): SessionPromptContent {
	if (blocks.length === 0) {
		return "";
	}
	if (blocks.length === 1 && blocks[0]?.type === "text") {
		return blocks[0].text;
	}
	return blocks;
}

function textContent(text: string): SessionPromptContent {
	return text;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

function contentBlocksFromMessageContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): SessionPromptContent {
	if (typeof content === "string") {
		return content;
	}
	const blocks: SessionContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string") {
			blocks.push({ type: "image", mimeType: block.mimeType, data: block.data });
		}
	}
	return promptBlocksToContent(blocks);
}

function contentFromAgentMessage(message: AgentMessage): SessionPromptContent {
	if (isAssistantMessage(message)) {
		const blocks: SessionContentBlock[] = [];
		for (const block of message.content) {
			if (block.type === "text") {
				blocks.push({ type: "text", text: block.text });
			}
		}
		return promptBlocksToContent(blocks);
	}
	if (isToolResultMessage(message)) {
		return contentBlocksFromMessageContent(message.content);
	}
	if (message.role === "user") {
		return contentBlocksFromMessageContent(message.content);
	}
	if (message.role === "bashExecution") {
		return textContent(message.output || "(no output)");
	}
	if (message.role === "custom") {
		return contentBlocksFromMessageContent(message.content);
	}
	if (message.role === "branchSummary") {
		return textContent(message.summary);
	}
	if (message.role === "compactionSummary") {
		return textContent(message.summary);
	}
	return "";
}

function roleFromAgentMessage(message: AgentMessage): SessionMessageRole {
	if (message.role === "toolResult" || message.role === "bashExecution") {
		return "tool";
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return "system";
	}
	if (message.role === "custom") {
		return "custom";
	}
	return message.role;
}

function statusFromAgentMessage(message: AgentMessage, streaming: boolean): SessionMessageStatus {
	if (streaming) {
		return "streaming";
	}
	if (isAssistantMessage(message) && (message.stopReason === "error" || message.stopReason === "aborted")) {
		return "failed";
	}
	return "completed";
}

function messageMetadata(message: AgentMessage): SessionMetadata | undefined {
	if (isAssistantMessage(message) && (message.stopReason === "error" || message.stopReason === "aborted")) {
		return {
			stopReason: message.stopReason,
			errorMessage: message.errorMessage ?? null,
		};
	}
	if (message.role === "custom") {
		return {
			customType: message.customType,
			display: message.display,
		};
	}
	if (message.role === "bashExecution") {
		return {
			command: message.command,
			exitCode: message.exitCode ?? null,
			cancelled: message.cancelled,
			truncated: message.truncated,
		};
	}
	return undefined;
}

function messageTimestamp(message: AgentMessage, fallback: string): string {
	return isoFromTimestamp((message as { readonly timestamp?: number }).timestamp, fallback);
}

function sortSessionItems(items: SessionListItem[], query: SessionListQuery): SessionListItem[] {
	const sorted = [...items];
	const direction = query.sortDirection === "asc" ? 1 : -1;
	if (query.sortBy === "name") {
		sorted.sort((a, b) => direction * (a.name ?? "").localeCompare(b.name ?? ""));
	} else if (query.sortBy === "createdAt") {
		sorted.sort((a, b) => direction * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
	} else {
		sorted.sort(
			(a, b) =>
				direction *
				(new Date(a.modifiedAt ?? a.createdAt).getTime() - new Date(b.modifiedAt ?? b.createdAt).getTime()),
		);
	}
	return sorted;
}

export class AgentSessionOwner implements SessionOwner {
	readonly ownerId: string;
	readonly writePolicy = "single-owner" as const;

	private readonly runtime: AgentSessionRuntime;
	private readonly acquiredAt: string;
	private readonly listeners = new Map<string, Set<SessionEventListener>>();
	private readonly snapshots = new Map<string, SessionSnapshot>();
	private readonly metadataBySessionId = new Map<string, SessionMetadata>();
	private readonly closedSessionIds = new Set<string>();
	private readonly sessionSequences = new Map<string, number>();
	private readonly messageIds = new WeakMap<object, string>();
	private readonly toolCalls = new Map<string, SessionToolCallSnapshot>();
	private readonly runningCommands = new Set<Promise<void>>();
	private sessionUnsubscribe: Unsubscribe | undefined;
	private operationQueue: Promise<void> = Promise.resolve();
	private activeTurn: SessionTurnSnapshot | undefined;
	private activeCompaction: SessionCompactionSnapshot | undefined;
	private pendingTurnCommandIds: Array<string | undefined> = [];
	private nextMessageIndex = 1;
	private nextTurnIndex = 1;
	private nextCompactionIndex = 1;

	constructor(runtime: AgentSessionRuntime, options: AgentSessionOwnerOptions = {}) {
		this.runtime = runtime;
		this.ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
		this.acquiredAt = options.acquiredAt ?? nowIso();
		this.attachToCurrentSession();
		this.cacheSnapshot();
	}

	async listSessions(query: SessionListQuery = {}): Promise<readonly SessionListItem[]> {
		const cwd = query.cwd ?? this.runtime.cwd;
		const sessions = await SessionManager.list(cwd, this.getSessionStorage(cwd));
		let items = sessions.map((sessionInfo) => this.sessionInfoToListItem(sessionInfo));
		const activeHandle = this.buildHandle(
			this.runtime.session,
			this.closedSessionIds.has(this.runtime.session.sessionId),
		);
		if (!items.some((item) => item.id === activeHandle.id)) {
			items.unshift({
				...activeHandle,
				modifiedAt: activeHandle.createdAt,
				messageCount: this.runtime.session.messages.length,
			});
		}
		items = items.filter((item) => {
			if (query.cwd && resolvePath(item.cwd) !== resolvePath(query.cwd)) {
				return false;
			}
			if (!query.includeClosed && this.closedSessionIds.has(item.id)) {
				return false;
			}
			if (query.name && item.name !== query.name) {
				return false;
			}
			if (query.parentSessionId && item.parentSessionId !== query.parentSessionId) {
				return false;
			}
			if (query.includeForks === false && item.parentSessionId) {
				return false;
			}
			if (query.search) {
				const haystack = `${item.id} ${item.name ?? ""} ${item.firstMessage ?? ""}`.toLowerCase();
				if (!haystack.includes(query.search.toLowerCase())) {
					return false;
				}
			}
			return true;
		});
		items = sortSessionItems(items, query);
		const offset = query.offset ?? 0;
		const limit = query.limit ?? items.length;
		return items.slice(offset, offset + limit);
	}

	async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
		return this.runExclusive(async () => this.replaceWithNewSession(options, "session.created"));
	}

	async openSession(target: SessionTarget): Promise<SessionHandle> {
		return this.runExclusive(async () => this.restoreSession(target));
	}

	async forkSession(target: ForkSessionTarget): Promise<SessionHandle> {
		return this.runExclusive(async () => this.forkActiveSession(target));
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.runExclusive(async () => this.closeSessionInternal(sessionId, "closed"));
	}

	async sendCommand(sessionId: string, command: SessionCommand): Promise<void> {
		if (command.type === "prompt.submit") {
			await this.runExclusive(async () => {
				try {
					this.assertActiveSession(sessionId);
					await this.startPrompt(command.prompt, command.commandId);
				} catch (error) {
					this.emitError(error, command.commandId);
					throw error;
				}
			});
			return;
		}

		await this.runExclusive(async () => {
			try {
				await this.dispatchCommand(sessionId, command);
			} catch (error) {
				this.emitError(error, command.commandId);
				throw error;
			}
		});
	}

	async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
		if (sessionId === this.runtime.session.sessionId && !this.closedSessionIds.has(sessionId)) {
			return this.cacheSnapshot();
		}
		const snapshot = this.snapshots.get(sessionId);
		if (!snapshot) {
			throw new Error(`Unknown session: ${sessionId}`);
		}
		return snapshot;
	}

	subscribe(sessionId: string, listener: SessionEventListener): Unsubscribe {
		const listeners = this.listeners.get(sessionId) ?? new Set<SessionEventListener>();
		listeners.add(listener);
		this.listeners.set(sessionId, listeners);
		return () => {
			const current = this.listeners.get(sessionId);
			current?.delete(listener);
			if (current?.size === 0) {
				this.listeners.delete(sessionId);
			}
		};
	}

	async importSession(
		source: { readonly path: string; readonly cwd?: string },
		options?: CreateSessionOptions,
	): Promise<SessionHandle> {
		return this.runExclusive(async () => this.importSessionInternal(source, options));
	}

	private async dispatchCommand(sessionId: string, command: SessionCommand): Promise<void> {
		switch (command.type) {
			case "session.create":
				await this.replaceWithNewSession(command.options, "session.created", command.commandId);
				return;
			case "session.new":
				await this.replaceWithNewSession(
					command.options ?? { cwd: this.runtime.cwd },
					"session.created",
					command.commandId,
				);
				return;
			case "session.open":
				await this.restoreSession(command.target, command.commandId);
				return;
			case "session.resume":
				await this.restoreLatestSession(command.query, command.commandId);
				return;
			case "session.fork":
				this.assertActiveSession(sessionId);
				await this.forkActiveSession(command.target, command.commandId);
				return;
			case "session.import":
				await this.importSessionInternal(command.source, command.options, command.commandId);
				return;
			case "session.close":
				await this.closeSessionInternal(sessionId, command.reason ?? "closed");
				return;
			case "turn.abort":
				this.assertActiveSession(sessionId);
				await this.runtime.session.abort();
				return;
			case "context.compact":
				this.assertActiveSession(sessionId);
				if (command.target === "full-session") {
					throw new Error("Full-session compaction is not supported by the coding-agent runtime adapter");
				}
				await this.runtime.session.compact(command.instructions);
				return;
			case "model.change": {
				this.assertActiveSession(sessionId);
				const model = this.runtime.session.modelRegistry.find(command.model.providerId, command.model.modelId);
				if (!model) {
					throw new Error(`Unknown model: ${command.model.providerId}/${command.model.modelId}`);
				}
				await this.runtime.session.setModel(model);
				this.emitModelChanged(modelToSelection(this.runtime.session.model) ?? command.model, command.commandId);
				this.emitSnapshot();
				return;
			}
			case "thinking.change":
				this.assertActiveSession(sessionId);
				this.runtime.session.setThinkingLevel(command.thinking.level as ThinkingLevel);
				return;
			case "owner.shutdown":
				this.assertActiveSession(sessionId);
				await this.closeSessionInternal(sessionId, command.reason ?? "shutdown");
				return;
		}
	}

	private async importSessionInternal(
		source: { readonly path: string; readonly cwd?: string },
		options?: CreateSessionOptions,
		commandId?: string,
	): Promise<SessionHandle> {
		const previousSessionId = this.runtime.session.sessionId;
		const result = await this.runtime.importFromJsonl(source.path, options?.cwd ?? source.cwd);
		if (result.cancelled) {
			throw new Error("Session import cancelled");
		}
		if (options?.name) {
			this.runtime.session.setSessionName(options.name);
		}
		await this.applyCreateOptions(options);
		if (options?.metadata) {
			this.metadataBySessionId.set(this.runtime.session.sessionId, options.metadata);
		}
		return this.afterSessionReplacement(previousSessionId, "import", "session.restored", commandId);
	}

	private async closeSessionInternal(sessionId: string, reason: string): Promise<void> {
		this.assertActiveSession(sessionId);
		await this.runtime.dispose();
		this.detachFromCurrentSession();
		this.closedSessionIds.add(sessionId);
		this.emitSessionClosed(sessionId, reason);
	}

	private async replaceWithNewSession(
		options: CreateSessionOptions,
		eventType: "session.created",
		commandId?: string,
	): Promise<SessionHandle> {
		const previousSessionId = this.runtime.session.sessionId;
		const sessionDir = this.getSessionStorage(options.cwd);
		const result = await this.runtime.newSession({
			cwd: options.cwd,
			sessionDir,
			id: options.id,
			name: options.name,
			parentSession: options.parentSessionId,
		});
		if (result.cancelled) {
			throw new Error("Session creation cancelled");
		}
		await this.applyCreateOptions(options);
		if (options.metadata) {
			this.metadataBySessionId.set(this.runtime.session.sessionId, options.metadata);
		}
		return this.afterSessionReplacement(previousSessionId, "new", eventType, commandId);
	}

	private async restoreSession(target: SessionTarget, commandId?: string): Promise<SessionHandle> {
		const resolved = await this.resolveSessionTarget(target);
		if (resolved.alreadyActive) {
			return this.buildHandle(this.runtime.session, false);
		}
		if (!resolved.sessionFile) {
			throw new Error("Session target does not resolve to a session file");
		}
		const previousSessionId = this.runtime.session.sessionId;
		const result = await this.runtime.switchSession(resolved.sessionFile, { cwdOverride: resolved.cwdOverride });
		if (result.cancelled) {
			throw new Error("Session restore cancelled");
		}
		return this.afterSessionReplacement(previousSessionId, "restore", "session.restored", commandId);
	}

	private async restoreLatestSession(query: SessionListQuery | undefined, commandId?: string): Promise<SessionHandle> {
		const cwd = query?.cwd ?? this.runtime.cwd;
		const items = await this.listSessions({
			...query,
			cwd,
			limit: query?.limit ?? 1,
			sortBy: query?.sortBy ?? "modifiedAt",
			sortDirection: query?.sortDirection ?? "desc",
		});
		const latest = items[0];
		if (!latest?.sessionFile) {
			throw new Error("No resumable session found");
		}
		return this.restoreSession({ kind: "session-file", path: latest.sessionFile, cwd: latest.cwd }, commandId);
	}

	private async forkActiveSession(target: ForkSessionTarget, commandId?: string): Promise<SessionHandle> {
		if (target.entryId === undefined) {
			throw new Error("Forking without an entryId is not supported by the coding-agent runtime adapter");
		}
		const source = await this.resolveSessionTarget(target.source);
		if (!source.alreadyActive) {
			throw new Error("Forking a non-active source session is not supported by the coding-agent runtime adapter");
		}
		if (target.cwd && resolvePath(target.cwd) !== this.runtime.cwd) {
			throw new Error("Forking into a different cwd is not supported by the coding-agent runtime adapter");
		}
		const previousSessionId = this.runtime.session.sessionId;
		const result = await this.runtime.fork(target.entryId, { position: "before" });
		if (result.cancelled) {
			throw new Error("Session fork cancelled");
		}
		if (target.name) {
			this.runtime.session.setSessionName(target.name);
		}
		if (target.metadata) {
			this.metadataBySessionId.set(this.runtime.session.sessionId, target.metadata);
		}
		return this.afterSessionReplacement(previousSessionId, "fork", "session.created", commandId);
	}

	private async applyCreateOptions(options: CreateSessionOptions | undefined): Promise<void> {
		if (!options) {
			return;
		}
		if (options.initialModel) {
			const model = this.runtime.session.modelRegistry.find(
				options.initialModel.providerId,
				options.initialModel.modelId,
			);
			if (!model) {
				throw new Error(`Unknown model: ${options.initialModel.providerId}/${options.initialModel.modelId}`);
			}
			await this.runtime.session.setModel(model);
		}
		if (options.thinking) {
			this.runtime.session.setThinkingLevel(options.thinking.level as ThinkingLevel);
		}
	}

	private async startPrompt(prompt: SessionPrompt, commandId: string | undefined): Promise<void> {
		const input = this.promptToInput(prompt);
		const session = this.runtime.session;
		this.pendingTurnCommandIds.push(commandId);
		let accepted = false;
		const acceptedPromise = new Promise<void>((resolve, reject) => {
			const task = session.prompt(input.text, {
				expandPromptTemplates: false,
				images: input.images,
				streamingBehavior: session.isStreaming ? "followUp" : undefined,
				preflightResult: (success) => {
					if (success) {
						accepted = true;
						resolve();
					} else {
						reject(new Error("Prompt was rejected before execution"));
					}
				},
			});
			task
				.catch((error: unknown) => {
					if (!accepted) {
						reject(new Error(errorToOwnerError(error).message));
						return;
					}
					this.emitError(error, commandId);
				})
				.finally(() => {
					this.runningCommands.delete(task);
				});
			this.runningCommands.add(task);
		});
		try {
			await acceptedPromise;
		} catch (error) {
			this.removePendingCommandId(commandId);
			throw error;
		}
	}

	private promptToInput(prompt: SessionPrompt): PromptInput {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		const collectBlock = (block: SessionContentBlock): void => {
			if (block.type === "text") {
				textParts.push(block.text);
				return;
			}
			if (!block.data) {
				throw new Error("Image URL prompts are not supported by the coding-agent runtime adapter");
			}
			images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		};
		if (typeof prompt.content === "string") {
			textParts.push(prompt.content);
		} else {
			for (const block of prompt.content) {
				collectBlock(block);
			}
		}
		for (const block of prompt.attachments ?? []) {
			collectBlock(block);
		}
		return {
			text: textParts.join("\n"),
			images: images.length > 0 ? images : undefined,
		};
	}

	private handleSessionEvent = (event: AgentSessionEvent): void => {
		const sessionId = this.runtime.session.sessionId;
		switch (event.type) {
			case "turn_start":
				this.handleTurnStart(sessionId);
				return;
			case "turn_end":
				this.handleTurnEnd(sessionId, event.message);
				return;
			case "message_start":
				this.emitMessageStarted(sessionId, event.message);
				return;
			case "message_update":
				this.emitMessageDelta(sessionId, event);
				return;
			case "message_end":
				this.emitMessageCompleted(sessionId, event.message);
				return;
			case "tool_execution_start":
				this.emitToolStarted(sessionId, event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_update":
				this.emitToolProgress(sessionId, event.toolCallId, event.partialResult);
				return;
			case "tool_execution_end":
				this.emitToolCompleted(sessionId, event.toolCallId, event.toolName, event.result, event.isError);
				return;
			case "compaction_start":
				this.emitCompactionStarted(sessionId);
				return;
			case "compaction_end":
				this.emitCompactionCompleted(sessionId, event.result, event.errorMessage);
				return;
			case "thinking_level_changed":
				this.emitThinkingChanged({ level: event.level });
				this.emitSnapshot();
				return;
			case "agent_end":
			case "agent_start":
			case "queue_update":
			case "auto_retry_start":
			case "auto_retry_end":
			case "session_info_changed":
				this.emitSnapshot();
				return;
		}
	};

	private handleTurnStart(sessionId: string): void {
		const commandId = this.pendingTurnCommandIds.shift();
		const turn: SessionTurnSnapshot = {
			id: `turn-${this.nextTurnIndex++}`,
			status: "running",
			startedAt: nowIso(),
			commandId,
		};
		this.activeTurn = turn;
		const event: SessionOwnerEvent = {
			...this.eventBase("turn.started", sessionId, commandId),
			turn,
		};
		this.emit(event);
	}

	private handleTurnEnd(sessionId: string, message: AgentMessage): void {
		const activeTurn = this.activeTurn;
		if (!activeTurn) {
			return;
		}
		const completedTurn: SessionTurnSnapshot = {
			...activeTurn,
			status:
				isAssistantMessage(message) && message.stopReason === "aborted"
					? "aborted"
					: statusFromAgentMessage(message, false) === "failed"
						? "failed"
						: "completed",
			completedAt: nowIso(),
			error:
				isAssistantMessage(message) && message.errorMessage
					? { code: "assistant_error", message: message.errorMessage }
					: undefined,
		};
		this.activeTurn = completedTurn;
		const event: SessionOwnerEvent = {
			...this.eventBase("turn.completed", sessionId, activeTurn.commandId),
			turn: completedTurn,
		};
		this.emit(event);
		this.emitSnapshot();
	}

	private emitMessageStarted(sessionId: string, message: AgentMessage): void {
		const messageSnapshot = this.createMessageSnapshot(message, true);
		const event: SessionOwnerEvent = {
			...this.eventBase("message.started", sessionId, this.activeTurn?.commandId),
			message: messageSnapshot,
		};
		this.emit(event);
	}

	private emitMessageDelta(sessionId: string, event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (event.assistantMessageEvent.type !== "text_delta") {
			return;
		}
		const ownerEvent: SessionOwnerEvent = {
			...this.eventBase("message.delta", sessionId, this.activeTurn?.commandId),
			messageId: this.getMessageId(event.message),
			delta: {
				type: "text",
				text: event.assistantMessageEvent.delta,
				index: event.assistantMessageEvent.contentIndex,
			},
		};
		this.emit(ownerEvent);
	}

	private emitMessageCompleted(sessionId: string, message: AgentMessage): void {
		const messageSnapshot = this.createMessageSnapshot(message, false);
		const event: SessionOwnerEvent = {
			...this.eventBase("message.completed", sessionId, this.activeTurn?.commandId),
			message: messageSnapshot,
		};
		this.emit(event);
		this.emitSnapshot();
	}

	private emitToolStarted(sessionId: string, toolCallId: string, toolName: string, args: unknown): void {
		const toolCall: SessionToolCallSnapshot = {
			id: toolCallId,
			name: toolName,
			status: "running",
			startedAt: nowIso(),
			input: toSessionJsonObject(args),
		};
		this.toolCalls.set(toolCallId, toolCall);
		const event: SessionOwnerEvent = {
			...this.eventBase("tool.started", sessionId, this.activeTurn?.commandId),
			toolCall,
		};
		this.emit(event);
	}

	private emitToolProgress(sessionId: string, toolCallId: string, partialResult: unknown): void {
		const progress = this.toolProgressFromPartial(partialResult);
		const currentTool = this.toolCalls.get(toolCallId);
		if (currentTool) {
			this.toolCalls.set(toolCallId, { ...currentTool, progress });
		}
		const event: SessionOwnerEvent = {
			...this.eventBase("tool.progress", sessionId, this.activeTurn?.commandId),
			toolCallId,
			progress,
		};
		this.emit(event);
	}

	private emitToolCompleted(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
	): void {
		const currentTool = this.toolCalls.get(toolCallId);
		const toolCall: SessionToolCallSnapshot = {
			...(currentTool ?? { id: toolCallId, name: toolName, status: "running" as const, startedAt: nowIso() }),
			status: isError ? "failed" : "completed",
			completedAt: nowIso(),
			output: toSessionJsonValue(result),
			error: isError ? { code: "tool_error", message: "Tool execution failed" } : undefined,
		};
		this.toolCalls.set(toolCallId, toolCall);
		const event: SessionOwnerEvent = {
			...this.eventBase("tool.completed", sessionId, this.activeTurn?.commandId),
			toolCall,
		};
		this.emit(event);
		this.emitSnapshot();
	}

	private emitCompactionStarted(sessionId: string): void {
		const compaction: SessionCompactionSnapshot = {
			id: `compaction-${this.nextCompactionIndex++}`,
			status: "running",
			startedAt: nowIso(),
		};
		this.activeCompaction = compaction;
		const event: SessionOwnerEvent = {
			...this.eventBase("compaction.started", sessionId),
			compaction,
		};
		this.emit(event);
	}

	private emitCompactionCompleted(
		sessionId: string,
		result: { readonly summary: string; readonly tokensBefore: number } | undefined,
		errorMessage: string | undefined,
	): void {
		const compaction: SessionCompactionSnapshot = {
			...(this.activeCompaction ?? { id: `compaction-${this.nextCompactionIndex++}`, startedAt: nowIso() }),
			status: errorMessage ? "failed" : "completed",
			completedAt: nowIso(),
			summary: result?.summary,
			tokensBefore: result?.tokensBefore,
			error: errorMessage ? { code: "compaction_error", message: errorMessage } : undefined,
		};
		this.activeCompaction = compaction;
		const event: SessionOwnerEvent = {
			...this.eventBase("compaction.completed", sessionId),
			compaction,
		};
		this.emit(event);
		this.emitSnapshot();
	}

	private emitModelChanged(model: SessionModelSelection, commandId: string | undefined): void {
		const event: SessionOwnerEvent = {
			...this.eventBase("model.changed", this.runtime.session.sessionId, commandId),
			model,
		};
		this.emit(event);
	}

	private emitThinkingChanged(thinking: SessionThinkingSelection): void {
		const event: SessionOwnerEvent = {
			...this.eventBase("thinking.changed", this.runtime.session.sessionId),
			thinking,
		};
		this.emit(event);
	}

	private emitError(error: unknown, commandId?: string): void {
		const sessionId = this.runtime.session.sessionId;
		const event: SessionOwnerEvent = {
			...this.eventBase("error", sessionId, commandId),
			error: errorToOwnerError(error),
			fatal: false,
		};
		this.emit(event);
	}

	private emitSnapshot(): void {
		const snapshot = this.cacheSnapshot();
		const event: SessionOwnerEvent = {
			...this.eventBase("snapshot", snapshot.session.id),
			snapshot,
		};
		this.emit(event);
	}

	private emitSessionClosed(sessionId: string, reason: string): void {
		const previous = this.snapshots.get(sessionId);
		if (previous) {
			const handle: SessionHandle = { ...previous.session, state: "closed" };
			this.snapshots.set(sessionId, {
				...previous,
				session: handle,
				state: { ...previous.state, status: "closed" },
			});
		}
		const event: SessionOwnerEvent = {
			...this.eventBase("session.closed", sessionId),
			reason,
		};
		this.emit(event);
	}

	private emitSessionLifecycle(
		eventType: "session.created" | "session.restored",
		handle: SessionHandle,
		commandId?: string,
	): void {
		const event: SessionOwnerEvent = {
			...this.eventBase(eventType, handle.id, commandId),
			handle,
		};
		this.emit(event);
		this.emitSnapshot();
	}

	private afterSessionReplacement(
		previousSessionId: string,
		reason: string,
		eventType: "session.created" | "session.restored",
		commandId?: string,
	): SessionHandle {
		this.detachFromCurrentSession();
		this.resetLiveState();
		this.attachToCurrentSession();
		this.emitSessionClosed(previousSessionId, reason);
		const handle = this.buildHandle(this.runtime.session, false);
		this.closedSessionIds.delete(handle.id);
		this.cacheSnapshot();
		this.emitSessionLifecycle(eventType, handle, commandId);
		return handle;
	}

	private attachToCurrentSession(): void {
		this.sessionUnsubscribe = this.runtime.session.subscribe(this.handleSessionEvent);
	}

	private detachFromCurrentSession(): void {
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
	}

	private resetLiveState(): void {
		this.activeTurn = undefined;
		this.activeCompaction = undefined;
		this.pendingTurnCommandIds = [];
		this.toolCalls.clear();
	}

	private cacheSnapshot(): SessionSnapshot {
		const session = this.runtime.session;
		const sessionId = session.sessionId;
		const closed = this.closedSessionIds.has(sessionId);
		const snapshot = this.buildSnapshot(session, closed);
		this.snapshots.set(sessionId, snapshot);
		return snapshot;
	}

	private buildSnapshot(session: AgentSession, closed: boolean): SessionSnapshot {
		const handle = this.buildHandle(session, closed);
		return {
			version: SESSION_OWNER_CONTRACT_VERSION,
			session: handle,
			state: {
				status: statusForSession(session, closed),
				activeTurnId: this.activeTurn?.id,
				queuedCommandCount: session.pendingMessageCount,
				error: session.state.errorMessage
					? { code: "agent_error", message: session.state.errorMessage }
					: undefined,
			},
			messages: this.snapshotMessagesFromSession(session),
			writer: {
				kind: "session-owner",
				ownerId: this.ownerId,
				sessionId: handle.id,
				exclusive: true,
				acquiredAt: this.acquiredAt,
			},
			activeTurn: this.activeTurn,
			toolCalls: Array.from(this.toolCalls.values()),
			compaction: this.activeCompaction,
			model: modelToSelection(session.model),
			thinking: { level: session.thinkingLevel },
		};
	}

	private buildHandle(session: AgentSession, closed: boolean): SessionHandle {
		const header = session.sessionManager.getHeader();
		return {
			id: session.sessionId,
			cwd: session.sessionManager.getCwd(),
			state: closed ? "closed" : "active",
			createdAt: header?.timestamp ?? this.acquiredAt,
			sessionFile: session.sessionFile,
			name: session.sessionName,
			parentSessionId: header?.parentSession,
			metadata: this.metadataBySessionId.get(session.sessionId),
		};
	}

	private snapshotMessagesFromSession(session: AgentSession): SessionSnapshotMessage[] {
		const entries = session.sessionManager.getBranch();
		const messages: SessionSnapshotMessage[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(this.createMessageSnapshot(entry.message, false, entry.id, entry.timestamp));
			} else if (entry.type === "custom_message") {
				messages.push({
					id: entry.id,
					role: "custom",
					content: contentBlocksFromMessageContent(entry.content),
					createdAt: entry.timestamp,
					completedAt: entry.timestamp,
					status: "completed",
					metadata: { customType: entry.customType, display: entry.display },
				});
			} else if (entry.type === "branch_summary") {
				messages.push({
					id: entry.id,
					role: "system",
					content: entry.summary,
					createdAt: entry.timestamp,
					completedAt: entry.timestamp,
					status: "completed",
				});
			} else if (entry.type === "compaction") {
				messages.push({
					id: entry.id,
					role: "system",
					content: entry.summary,
					createdAt: entry.timestamp,
					completedAt: entry.timestamp,
					status: "completed",
					metadata: { tokensBefore: entry.tokensBefore },
				});
			}
		}
		return messages;
	}

	private createMessageSnapshot(
		message: AgentMessage,
		streaming: boolean,
		id: string = this.getMessageId(message),
		entryTimestamp?: string,
	): SessionSnapshotMessage {
		const fallbackTimestamp = entryTimestamp ?? nowIso();
		const status = statusFromAgentMessage(message, streaming);
		return {
			id,
			role: roleFromAgentMessage(message),
			content: contentFromAgentMessage(message),
			createdAt: messageTimestamp(message, fallbackTimestamp),
			completedAt: status === "streaming" ? undefined : fallbackTimestamp,
			status,
			model: isAssistantMessage(message)
				? { providerId: message.provider, modelId: message.model, displayName: message.model }
				: undefined,
			metadata: messageMetadata(message),
		};
	}

	private getMessageId(message: AgentMessage): string {
		const key = message as object;
		const existing = this.messageIds.get(key);
		if (existing) {
			return existing;
		}
		const id = `message-${this.nextMessageIndex++}`;
		this.messageIds.set(key, id);
		return id;
	}

	private toolProgressFromPartial(partialResult: unknown): SessionToolProgress {
		const jsonObject = toSessionJsonObject(partialResult);
		if (!jsonObject) {
			return {};
		}
		const message = typeof jsonObject.message === "string" ? jsonObject.message : undefined;
		const current = typeof jsonObject.current === "number" ? jsonObject.current : undefined;
		const total = typeof jsonObject.total === "number" ? jsonObject.total : undefined;
		return { message, current, total, metadata: jsonObject };
	}

	private async resolveSessionTarget(target: SessionTarget): Promise<ResolvedSessionTarget> {
		if (target.kind === "session-file") {
			const sessionFile = resolvePath(target.path, target.cwd ?? this.runtime.cwd);
			if (sessionFile === this.runtime.session.sessionFile) {
				return { alreadyActive: true };
			}
			return { alreadyActive: false, sessionFile, cwdOverride: target.cwd };
		}
		if (target.kind === "session-id") {
			if (target.sessionId === this.runtime.session.sessionId) {
				return { alreadyActive: true };
			}
			const cwd = target.cwd ?? this.runtime.cwd;
			const items = await this.listSessions({ cwd, includeClosed: true, includeForks: true });
			const item = items.find((candidate) => candidate.id === target.sessionId);
			if (!item?.sessionFile) {
				throw new Error(`Session not found: ${target.sessionId}`);
			}
			return { alreadyActive: false, sessionFile: item.sessionFile, cwdOverride: item.cwd };
		}
		const items = await this.listSessions({
			...target.query,
			cwd: target.cwd,
			limit: target.query?.limit ?? 1,
			sortBy: target.query?.sortBy ?? "modifiedAt",
			sortDirection: target.query?.sortDirection ?? "desc",
		});
		const latest = items[0];
		if (!latest?.sessionFile) {
			throw new Error("No session matched latest target");
		}
		if (latest.id === this.runtime.session.sessionId) {
			return { alreadyActive: true };
		}
		return { alreadyActive: false, sessionFile: latest.sessionFile, cwdOverride: latest.cwd };
	}

	private sessionInfoToListItem(info: SessionInfo): SessionListItem {
		const closed = this.closedSessionIds.has(info.id);
		return {
			id: info.id,
			cwd: info.cwd,
			state: closed ? "closed" : "active",
			createdAt: info.created.toISOString(),
			sessionFile: info.path,
			name: info.name,
			parentSessionId: info.parentSessionPath,
			modifiedAt: info.modified.toISOString(),
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
		};
	}

	private getSessionStorage(cwd: string): string {
		const sessionManager = this.runtime.session.sessionManager;
		if (
			sessionManager.isPersisted() &&
			sessionManager.getSessionDir() &&
			resolvePath(sessionManager.getCwd()) === resolvePath(cwd)
		) {
			return sessionManager.getSessionDir();
		}
		return getDefaultSessionDir(cwd, this.runtime.services.agentDir);
	}

	private assertActiveSession(sessionId: string): void {
		if (sessionId !== this.runtime.session.sessionId || this.closedSessionIds.has(sessionId)) {
			throw new Error(`Session is not active: ${sessionId}`);
		}
	}

	private eventBase<TType extends SessionOwnerEventType>(
		type: TType,
		sessionId: string,
		commandId?: string,
	): SessionOwnerEventBase<TType> {
		const previous = this.sessionSequences.get(sessionId) ?? 0;
		const sequence = previous + 1;
		this.sessionSequences.set(sessionId, sequence);
		return {
			type,
			sessionId,
			timestamp: nowIso(),
			eventId: `${this.ownerId}:${sessionId}:${sequence}`,
			sequence,
			commandId,
		};
	}

	private emit(event: SessionOwnerEvent): void {
		const listeners = this.listeners.get(event.sessionId);
		if (!listeners) {
			return;
		}
		for (const listener of [...listeners]) {
			listener(event);
		}
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.operationQueue.then(operation, operation);
		this.operationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private removePendingCommandId(commandId: string | undefined): void {
		const index = this.pendingTurnCommandIds.indexOf(commandId);
		if (index !== -1) {
			this.pendingTurnCommandIds.splice(index, 1);
		}
	}
}

export function createAgentSessionOwner(
	runtime: AgentSessionRuntime,
	options?: AgentSessionOwnerOptions,
): AgentSessionOwner {
	return new AgentSessionOwner(runtime, options);
}

export type CodingAgentSessionClient = SessionClient;
