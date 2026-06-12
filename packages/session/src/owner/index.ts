export const SESSION_OWNER_CONTRACT_VERSION = 1 as const;

export const SESSION_COMMAND_TYPES = [
	"session.create",
	"session.new",
	"session.open",
	"session.resume",
	"session.fork",
	"session.import",
	"session.close",
	"prompt.submit",
	"turn.abort",
	"context.compact",
	"model.change",
	"thinking.change",
	"owner.shutdown",
] as const;

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number];

export const SESSION_OWNER_EVENT_TYPES = [
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
] as const;

export type SessionOwnerEventType = (typeof SESSION_OWNER_EVENT_TYPES)[number];

export type SessionJsonPrimitive = string | number | boolean | null;
export type SessionJsonValue = SessionJsonPrimitive | SessionJsonObject | readonly SessionJsonValue[];

export interface SessionJsonObject {
	readonly [key: string]: SessionJsonValue;
}

export type SessionMetadata = SessionJsonObject;

export type SessionHandleState = "opening" | "active" | "closing" | "closed";

export interface SessionHandle {
	readonly id: string;
	readonly cwd: string;
	readonly state: SessionHandleState;
	readonly createdAt: string;
	readonly sessionFile?: string;
	readonly name?: string;
	readonly parentSessionId?: string;
	readonly metadata?: SessionMetadata;
}

export type SessionListSortField = "createdAt" | "modifiedAt" | "name";
export type SessionListSortDirection = "asc" | "desc";

export interface SessionListQuery {
	readonly cwd?: string;
	readonly search?: string;
	readonly name?: string;
	readonly parentSessionId?: string;
	readonly includeClosed?: boolean;
	readonly includeForks?: boolean;
	readonly limit?: number;
	readonly offset?: number;
	readonly sortBy?: SessionListSortField;
	readonly sortDirection?: SessionListSortDirection;
}

export interface SessionListItem extends SessionHandle {
	readonly modifiedAt?: string;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

export interface SessionIdTarget {
	readonly kind: "session-id";
	readonly sessionId: string;
	readonly cwd?: string;
}

export interface SessionFileTarget {
	readonly kind: "session-file";
	readonly path: string;
	readonly cwd?: string;
}

export interface LatestSessionTarget {
	readonly kind: "latest";
	readonly cwd: string;
	readonly query?: SessionListQuery;
}

export type SessionTarget = SessionIdTarget | SessionFileTarget | LatestSessionTarget;

export interface CreateSessionOptions {
	readonly cwd: string;
	readonly id?: string;
	readonly name?: string;
	readonly parentSessionId?: string;
	readonly initialModel?: SessionModelSelection;
	readonly thinking?: SessionThinkingSelection;
	readonly metadata?: SessionMetadata;
}

export interface ForkSessionTarget {
	readonly source: SessionTarget;
	readonly entryId?: string;
	readonly cwd?: string;
	readonly name?: string;
	readonly metadata?: SessionMetadata;
}

export interface SessionImportSource {
	readonly kind: "jsonl-file";
	readonly path: string;
	readonly cwd?: string;
	readonly metadata?: SessionMetadata;
}

export interface SessionTextContentBlock {
	readonly type: "text";
	readonly text: string;
}

export interface SessionImageContentBlock {
	readonly type: "image";
	readonly mimeType: string;
	readonly data?: string;
	readonly url?: string;
	readonly altText?: string;
}

export type SessionContentBlock = SessionTextContentBlock | SessionImageContentBlock;
export type SessionPromptContent = string | readonly SessionContentBlock[];

export interface SessionPrompt {
	readonly content: SessionPromptContent;
	readonly attachments?: readonly SessionContentBlock[];
	readonly metadata?: SessionMetadata;
}

export interface SessionModelSelection {
	readonly providerId: string;
	readonly modelId: string;
	readonly displayName?: string;
}

export interface SessionThinkingSelection {
	readonly level: string;
	readonly budgetTokens?: number;
}

export interface SessionCommandBase<TType extends SessionCommandType> {
	readonly type: TType;
	readonly commandId?: string;
	readonly issuedAt?: string;
	readonly metadata?: SessionMetadata;
}

export interface CreateSessionCommand extends SessionCommandBase<"session.create"> {
	readonly options: CreateSessionOptions;
}

export interface NewSessionCommand extends SessionCommandBase<"session.new"> {
	readonly options?: CreateSessionOptions;
}

export interface OpenSessionCommand extends SessionCommandBase<"session.open"> {
	readonly target: SessionTarget;
}

export interface ResumeSessionCommand extends SessionCommandBase<"session.resume"> {
	readonly query?: SessionListQuery;
}

export interface ForkSessionCommand extends SessionCommandBase<"session.fork"> {
	readonly target: ForkSessionTarget;
}

export interface ImportSessionCommand extends SessionCommandBase<"session.import"> {
	readonly source: SessionImportSource;
	readonly options?: CreateSessionOptions;
}

export interface CloseSessionCommand extends SessionCommandBase<"session.close"> {
	readonly reason?: string;
}

export interface PromptSessionCommand extends SessionCommandBase<"prompt.submit"> {
	readonly prompt: SessionPrompt;
}

export interface AbortSessionCommand extends SessionCommandBase<"turn.abort"> {
	readonly turnId?: string;
	readonly reason?: string;
}

export interface CompactSessionCommand extends SessionCommandBase<"context.compact"> {
	readonly target?: "current-branch" | "full-session";
	readonly instructions?: string;
}

export interface ChangeModelSessionCommand extends SessionCommandBase<"model.change"> {
	readonly model: SessionModelSelection;
}

export interface ChangeThinkingSessionCommand extends SessionCommandBase<"thinking.change"> {
	readonly thinking: SessionThinkingSelection;
}

export interface ShutdownSessionCommand extends SessionCommandBase<"owner.shutdown"> {
	readonly reason?: string;
	readonly force?: boolean;
}

export type SessionCommand =
	| CreateSessionCommand
	| NewSessionCommand
	| OpenSessionCommand
	| ResumeSessionCommand
	| ForkSessionCommand
	| ImportSessionCommand
	| CloseSessionCommand
	| PromptSessionCommand
	| AbortSessionCommand
	| CompactSessionCommand
	| ChangeModelSessionCommand
	| ChangeThinkingSessionCommand
	| ShutdownSessionCommand;

export type SessionRuntimeStatus = "idle" | "running" | "compacting" | "closing" | "closed" | "error";

export interface SessionRuntimeState {
	readonly status: SessionRuntimeStatus;
	readonly activeTurnId?: string;
	readonly queuedCommandCount?: number;
	readonly error?: SessionOwnerError;
}

export type SessionMessageRole = "system" | "user" | "assistant" | "tool" | "custom";
export type SessionMessageStatus = "streaming" | "completed" | "failed";

export interface SessionSnapshotMessage {
	readonly id: string;
	readonly role: SessionMessageRole;
	readonly content: SessionPromptContent;
	readonly createdAt: string;
	readonly completedAt?: string;
	readonly status?: SessionMessageStatus;
	readonly model?: SessionModelSelection;
	readonly parentMessageId?: string;
	readonly metadata?: SessionMetadata;
}

export type SessionTurnStatus = "queued" | "running" | "completed" | "aborted" | "failed";

export interface SessionTurnSnapshot {
	readonly id: string;
	readonly status: SessionTurnStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly commandId?: string;
	readonly error?: SessionOwnerError;
}

export type SessionToolStatus = "running" | "completed" | "failed";

export interface SessionToolProgress {
	readonly message?: string;
	readonly current?: number;
	readonly total?: number;
	readonly metadata?: SessionMetadata;
}

export interface SessionToolCallSnapshot {
	readonly id: string;
	readonly name: string;
	readonly status: SessionToolStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly input?: SessionJsonObject;
	readonly output?: SessionJsonValue;
	readonly progress?: SessionToolProgress;
	readonly error?: SessionOwnerError;
	readonly metadata?: SessionMetadata;
}

export type SessionCompactionStatus = "running" | "completed" | "failed";

export interface SessionCompactionSnapshot {
	readonly id: string;
	readonly status: SessionCompactionStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly summary?: string;
	readonly tokensBefore?: number;
	readonly tokensAfter?: number;
	readonly error?: SessionOwnerError;
	readonly metadata?: SessionMetadata;
}

export interface SessionOwnerError {
	readonly code: string;
	readonly message: string;
	readonly recoverable?: boolean;
	readonly details?: SessionMetadata;
}

export interface SessionWriteAuthority {
	readonly kind: "session-owner";
	readonly ownerId: string;
	readonly sessionId: string;
	readonly exclusive: true;
	readonly acquiredAt?: string;
}

export interface SessionSnapshot {
	readonly version: typeof SESSION_OWNER_CONTRACT_VERSION;
	readonly session: SessionHandle;
	readonly state: SessionRuntimeState;
	readonly messages: readonly SessionSnapshotMessage[];
	readonly writer: SessionWriteAuthority;
	readonly activeTurn?: SessionTurnSnapshot;
	readonly queuedCommands?: readonly SessionCommand[];
	readonly toolCalls?: readonly SessionToolCallSnapshot[];
	readonly compaction?: SessionCompactionSnapshot;
	readonly model?: SessionModelSelection;
	readonly thinking?: SessionThinkingSelection;
	readonly metadata?: SessionMetadata;
}

export type SessionContentDelta =
	| {
			readonly type: "text";
			readonly text: string;
			readonly index?: number;
	  }
	| {
			readonly type: "replace";
			readonly content: readonly SessionContentBlock[];
	  };

export interface SessionOwnerEventBase<TType extends SessionOwnerEventType> {
	readonly type: TType;
	readonly sessionId: string;
	readonly timestamp: string;
	readonly eventId?: string;
	readonly sequence?: number;
	readonly commandId?: string;
}

export interface SessionCreatedEvent extends SessionOwnerEventBase<"session.created"> {
	readonly handle: SessionHandle;
}

export interface SessionRestoredEvent extends SessionOwnerEventBase<"session.restored"> {
	readonly handle: SessionHandle;
}

export interface SessionClosedEvent extends SessionOwnerEventBase<"session.closed"> {
	readonly reason?: string;
}

export interface SessionSnapshotEvent extends SessionOwnerEventBase<"snapshot"> {
	readonly snapshot: SessionSnapshot;
}

export interface SessionTurnStartedEvent extends SessionOwnerEventBase<"turn.started"> {
	readonly turn: SessionTurnSnapshot;
}

export interface SessionTurnCompletedEvent extends SessionOwnerEventBase<"turn.completed"> {
	readonly turn: SessionTurnSnapshot;
}

export interface SessionMessageStartedEvent extends SessionOwnerEventBase<"message.started"> {
	readonly message: SessionSnapshotMessage;
}

export interface SessionMessageDeltaEvent extends SessionOwnerEventBase<"message.delta"> {
	readonly messageId: string;
	readonly delta: SessionContentDelta;
}

export interface SessionMessageCompletedEvent extends SessionOwnerEventBase<"message.completed"> {
	readonly message: SessionSnapshotMessage;
}

export interface SessionToolStartedEvent extends SessionOwnerEventBase<"tool.started"> {
	readonly toolCall: SessionToolCallSnapshot;
}

export interface SessionToolProgressEvent extends SessionOwnerEventBase<"tool.progress"> {
	readonly toolCallId: string;
	readonly progress: SessionToolProgress;
}

export interface SessionToolCompletedEvent extends SessionOwnerEventBase<"tool.completed"> {
	readonly toolCall: SessionToolCallSnapshot;
}

export interface SessionCompactionStartedEvent extends SessionOwnerEventBase<"compaction.started"> {
	readonly compaction: SessionCompactionSnapshot;
}

export interface SessionCompactionCompletedEvent extends SessionOwnerEventBase<"compaction.completed"> {
	readonly compaction: SessionCompactionSnapshot;
}

export interface SessionModelChangedEvent extends SessionOwnerEventBase<"model.changed"> {
	readonly model: SessionModelSelection;
}

export interface SessionThinkingChangedEvent extends SessionOwnerEventBase<"thinking.changed"> {
	readonly thinking: SessionThinkingSelection;
}

export interface SessionErrorEvent extends SessionOwnerEventBase<"error"> {
	readonly error: SessionOwnerError;
	readonly fatal?: boolean;
}

export type SessionOwnerEvent =
	| SessionCreatedEvent
	| SessionRestoredEvent
	| SessionClosedEvent
	| SessionSnapshotEvent
	| SessionTurnStartedEvent
	| SessionTurnCompletedEvent
	| SessionMessageStartedEvent
	| SessionMessageDeltaEvent
	| SessionMessageCompletedEvent
	| SessionToolStartedEvent
	| SessionToolProgressEvent
	| SessionToolCompletedEvent
	| SessionCompactionStartedEvent
	| SessionCompactionCompletedEvent
	| SessionModelChangedEvent
	| SessionThinkingChangedEvent
	| SessionErrorEvent;

export type SessionEventListener = (event: SessionOwnerEvent) => void;
export type Unsubscribe = () => void;

export interface SessionClient {
	listSessions(query?: SessionListQuery): Promise<readonly SessionListItem[]>;
	createSession(options: CreateSessionOptions): Promise<SessionHandle>;
	openSession(target: SessionTarget): Promise<SessionHandle>;
	forkSession(target: ForkSessionTarget): Promise<SessionHandle>;
	closeSession(sessionId: string): Promise<void>;
	sendCommand(sessionId: string, command: SessionCommand): Promise<void>;
	getSnapshot(sessionId: string): Promise<SessionSnapshot>;
	subscribe(sessionId: string, listener: SessionEventListener): Unsubscribe;
}

export interface SessionOwner extends SessionClient {
	readonly ownerId: string;
	readonly writePolicy: "single-owner";
}
