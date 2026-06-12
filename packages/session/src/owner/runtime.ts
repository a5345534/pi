import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type NewSessionOptions, SessionManager } from "../session-manager.ts";
import { resolvePath } from "../utils/paths.ts";

export type SessionRuntimeSwitchReason = "new" | "resume";
export type SessionRuntimeForkPosition = "before" | "at";
export type SessionRuntimeShutdownReason = "new" | "resume" | "fork" | "quit";
export type SessionRuntimeStartReason = "startup" | "new" | "resume" | "fork";

export interface OwnedSessionRuntimeSession {
	readonly sessionManager: SessionManager;
	readonly sessionFile: string | undefined;
	dispose(): void;
}

export interface OwnedSessionRuntimeServices {
	readonly cwd: string;
	readonly agentDir: string;
}

export interface SessionRuntimeShutdownEvent {
	readonly type: "session_shutdown";
	readonly reason: SessionRuntimeShutdownReason;
	readonly targetSessionFile?: string;
}

export interface SessionRuntimeStartEvent {
	readonly type: "session_start";
	readonly reason: SessionRuntimeStartReason;
	readonly previousSessionFile?: string;
}

export interface CreateSessionRuntimeOptions<SessionStartEvent, ProjectTrustContext> {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
	readonly sessionStartEvent?: SessionStartEvent;
	readonly projectTrustContext?: ProjectTrustContext;
}

export interface CreateSessionRuntimeResult<
	Session extends OwnedSessionRuntimeSession,
	Services extends OwnedSessionRuntimeServices,
	Diagnostic,
> {
	readonly session: Session;
	readonly services: Services;
	readonly diagnostics: readonly Diagnostic[];
	readonly modelFallbackMessage?: string;
}

export type CreateSessionRuntimeFactory<
	Session extends OwnedSessionRuntimeSession,
	Services extends OwnedSessionRuntimeServices,
	Diagnostic,
	SessionStartEvent = never,
	ProjectTrustContext = never,
> = (
	options: CreateSessionRuntimeOptions<SessionStartEvent, ProjectTrustContext>,
) => Promise<CreateSessionRuntimeResult<Session, Services, Diagnostic>>;

export interface SessionReplacementOptions<ReplacedSessionContext> {
	readonly withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}

export interface SwitchSessionOptions<ProjectTrustContext, ReplacedSessionContext>
	extends SessionReplacementOptions<ReplacedSessionContext> {
	readonly cwdOverride?: string;
	readonly projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
}

export interface NewSessionRuntimeOptions<ReplacedSessionContext>
	extends SessionReplacementOptions<ReplacedSessionContext> {
	readonly cwd?: string;
	readonly sessionDir?: string;
	readonly id?: string;
	readonly name?: string;
	readonly parentSession?: string;
	readonly setup?: (sessionManager: SessionManager) => Promise<void>;
}

export interface ForkSessionRuntimeOptions<ReplacedSessionContext>
	extends SessionReplacementOptions<ReplacedSessionContext> {
	readonly position?: SessionRuntimeForkPosition;
}

export interface SessionRuntimeLifecycleHooks<
	Session extends OwnedSessionRuntimeSession,
	_Services extends OwnedSessionRuntimeServices,
	SessionStartEvent,
	ProjectTrustContext,
	ReplacedSessionContext,
> {
	readonly assertSessionCwdExists?: (sessionManager: SessionManager, fallbackCwd: string) => void;
	readonly beforeSwitch?: (
		session: Session,
		reason: SessionRuntimeSwitchReason,
		targetSessionFile?: string,
	) => Promise<{ readonly cancelled: boolean }>;
	readonly beforeFork?: (
		session: Session,
		entryId: string,
		options: { readonly position: SessionRuntimeForkPosition },
	) => Promise<{ readonly cancelled: boolean }>;
	readonly emitShutdown?: (session: Session, event: SessionRuntimeShutdownEvent) => Promise<void>;
	readonly disposeSession?: (session: Session) => void;
	readonly createSessionStartEvent?: (
		reason: SessionRuntimeStartReason,
		previousSessionFile: string | undefined,
	) => SessionStartEvent;
	readonly createProjectTrustContext?: (cwd: string) => ProjectTrustContext;
	readonly createReplacedSessionContext?: (session: Session) => ReplacedSessionContext;
	readonly setSessionName?: (session: Session, name: string) => void;
	readonly afterSessionManagerSetup?: (session: Session, sessionManager: SessionManager) => void;
}

export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ readonly type: string; readonly text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { readonly type: "text"; readonly text: string } => {
			return part.type === "text" && typeof part.text === "string";
		})
		.map((part) => part.text)
		.join("");
}

function isUserMessageEntry(entry: { readonly type: string; readonly message?: unknown }): entry is {
	readonly type: "message";
	readonly message: {
		readonly role: "user";
		readonly content: string | Array<{ readonly type: string; readonly text?: string }>;
	};
} {
	const message = entry.message as { readonly role?: unknown; readonly content?: unknown } | undefined;
	if (entry.type !== "message" || message?.role !== "user") {
		return false;
	}
	return typeof message.content === "string" || Array.isArray(message.content);
}

export class SessionRuntimeHost<
	Session extends OwnedSessionRuntimeSession,
	Services extends OwnedSessionRuntimeServices,
	Diagnostic,
	SessionStartEvent = SessionRuntimeStartEvent,
	ProjectTrustContext = never,
	ReplacedSessionContext = Session,
> {
	private rebindSession?: (session: Session) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: Session;
	private _services: Services;
	private readonly createRuntime: CreateSessionRuntimeFactory<
		Session,
		Services,
		Diagnostic,
		SessionStartEvent,
		ProjectTrustContext
	>;
	private _diagnostics: readonly Diagnostic[];
	private _modelFallbackMessage?: string;
	private readonly hooks: SessionRuntimeLifecycleHooks<
		Session,
		Services,
		SessionStartEvent,
		ProjectTrustContext,
		ReplacedSessionContext
	>;

	constructor(
		_session: Session,
		_services: Services,
		createRuntime: CreateSessionRuntimeFactory<Session, Services, Diagnostic, SessionStartEvent, ProjectTrustContext>,
		_diagnostics: readonly Diagnostic[] = [],
		_modelFallbackMessage?: string,
		hooks: SessionRuntimeLifecycleHooks<
			Session,
			Services,
			SessionStartEvent,
			ProjectTrustContext,
			ReplacedSessionContext
		> = {},
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.hooks = hooks;
	}

	get services(): Services {
		return this._services;
	}

	get session(): Session {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly Diagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: Session) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: SessionRuntimeSwitchReason,
		targetSessionFile?: string,
	): Promise<{ readonly cancelled: boolean }> {
		return this.hooks.beforeSwitch?.(this.session, reason, targetSessionFile) ?? { cancelled: false };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { readonly position: SessionRuntimeForkPosition },
	): Promise<{ readonly cancelled: boolean }> {
		return this.hooks.beforeFork?.(this.session, entryId, options) ?? { cancelled: false };
	}

	private async teardownCurrent(reason: SessionRuntimeShutdownReason, targetSessionFile?: string): Promise<void> {
		await this.hooks.emitShutdown?.(this.session, { type: "session_shutdown", reason, targetSessionFile });
		this.beforeSessionInvalidate?.();
		this.hooks.disposeSession?.(this.session) ?? this.session.dispose();
	}

	private apply(result: CreateSessionRuntimeResult<Session, Services, Diagnostic>): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private createStartEvent(
		reason: SessionRuntimeStartReason,
		previousSessionFile: string | undefined,
	): SessionStartEvent | undefined {
		return this.hooks.createSessionStartEvent?.(reason, previousSessionFile);
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			const context = this.hooks.createReplacedSessionContext?.(this.session);
			if (context === undefined) {
				throw new Error("Session replacement context hook is required for withSession callbacks");
			}
			await withSession(context);
		}
	}

	async switchSession(
		sessionPath: string,
		options?: SwitchSessionOptions<ProjectTrustContext, ReplacedSessionContext>,
	): Promise<{ readonly cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		this.hooks.assertSessionCwdExists?.(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: this.createStartEvent("resume", previousSessionFile),
				projectTrustContext:
					options?.projectTrustContextFactory?.(sessionManager.getCwd()) ??
					this.hooks.createProjectTrustContext?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(
		options?: NewSessionRuntimeOptions<ReplacedSessionContext>,
	): Promise<{ readonly cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const cwd = options?.cwd ?? this.cwd;
		const sessionDir = options?.sessionDir ?? this.session.sessionManager.getSessionDir();
		const newSessionOptions: NewSessionOptions | undefined =
			options?.id !== undefined || options?.parentSession !== undefined
				? { id: options.id, parentSession: options.parentSession }
				: undefined;
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(cwd, sessionDir, newSessionOptions)
			: SessionManager.inMemory(cwd);
		if (!this.session.sessionManager.isPersisted() && newSessionOptions) {
			sessionManager.newSession(newSessionOptions);
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: this.createStartEvent("new", previousSessionFile),
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.hooks.afterSessionManagerSetup?.(this.session, this.session.sessionManager);
		}
		if (options?.name) {
			this.hooks.setSessionName?.(this.session, options.name) ??
				this.session.sessionManager.appendSessionInfo(options.name);
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: ForkSessionRuntimeOptions<ReplacedSessionContext>,
	): Promise<{ readonly cancelled: boolean; readonly selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (!isUserMessageEntry(selectedEntry)) {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: this.createStartEvent("fork", previousSessionFile),
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: this.createStartEvent("fork", previousSessionFile),
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: this.createStartEvent("fork", previousSessionFile),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ readonly cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		this.hooks.assertSessionCwdExists?.(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: this.createStartEvent("resume", previousSessionFile),
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		await this.hooks.emitShutdown?.(this.session, { type: "session_shutdown", reason: "quit" });
		this.beforeSessionInvalidate?.();
		this.hooks.disposeSession?.(this.session) ?? this.session.dispose();
	}
}

export async function createSessionRuntimeHost<
	Session extends OwnedSessionRuntimeSession,
	Services extends OwnedSessionRuntimeServices,
	Diagnostic,
	SessionStartEvent = SessionRuntimeStartEvent,
	ProjectTrustContext = never,
	ReplacedSessionContext = Session,
>(
	createRuntime: CreateSessionRuntimeFactory<Session, Services, Diagnostic, SessionStartEvent, ProjectTrustContext>,
	options: CreateSessionRuntimeOptions<SessionStartEvent, ProjectTrustContext>,
	hooks?: SessionRuntimeLifecycleHooks<
		Session,
		Services,
		SessionStartEvent,
		ProjectTrustContext,
		ReplacedSessionContext
	>,
): Promise<
	SessionRuntimeHost<Session, Services, Diagnostic, SessionStartEvent, ProjectTrustContext, ReplacedSessionContext>
> {
	hooks?.assertSessionCwdExists?.(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new SessionRuntimeHost(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		hooks,
	);
}
