import {
	type CreateSessionRuntimeFactory,
	SessionImportFileNotFoundError,
	SessionRuntimeHost,
	type SessionRuntimeLifecycleHooks,
} from "@a5345534/pi-session";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import type { SessionManager } from "./session-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = CreateSessionRuntimeFactory<
	AgentSession,
	AgentSessionServices,
	AgentSessionRuntimeDiagnostic,
	SessionStartEvent,
	ProjectTrustContext
>;

function createSessionStartEvent(
	reason: "startup" | "new" | "resume" | "fork",
	previousSessionFile: string | undefined,
): SessionStartEvent {
	if (reason === "startup") {
		return { type: "session_start", reason };
	}
	return { type: "session_start", reason, previousSessionFile };
}

function createRuntimeHooks(): SessionRuntimeLifecycleHooks<
	AgentSession,
	AgentSessionServices,
	SessionStartEvent,
	ProjectTrustContext,
	ReplacedSessionContext
> {
	return {
		assertSessionCwdExists,
		beforeSwitch: async (session, reason, targetSessionFile) => {
			const runner = session.extensionRunner;
			if (!runner.hasHandlers("session_before_switch")) {
				return { cancelled: false };
			}

			const result = await runner.emit({
				type: "session_before_switch",
				reason,
				targetSessionFile,
			});
			return { cancelled: result?.cancel === true };
		},
		beforeFork: async (session, entryId, options) => {
			const runner = session.extensionRunner;
			if (!runner.hasHandlers("session_before_fork")) {
				return { cancelled: false };
			}

			const result = await runner.emit({
				type: "session_before_fork",
				entryId,
				...options,
			});
			return { cancelled: result?.cancel === true };
		},
		emitShutdown: async (session, event) => {
			await emitSessionShutdownEvent(session.extensionRunner, event as SessionShutdownEvent);
		},
		disposeSession: (session) => session.dispose(),
		createSessionStartEvent,
		createReplacedSessionContext: (session) => session.createReplacedSessionContext(),
		setSessionName: (session, name) => session.setSessionName(name),
		afterSessionManagerSetup: (session, sessionManager) => {
			session.agent.state.messages = sessionManager.buildSessionContext().messages;
		},
	};
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. Generic runtime ownership and JSONL replacement
 * mechanics live in packages/session; this subclass supplies coding-agent's
 * app-specific lifecycle hooks for extensions, project trust, and agent state.
 */
export class AgentSessionRuntime extends SessionRuntimeHost<
	AgentSession,
	AgentSessionServices,
	AgentSessionRuntimeDiagnostic,
	SessionStartEvent,
	ProjectTrustContext,
	ReplacedSessionContext
> {
	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: readonly AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		super(_session, _services, createRuntime, _diagnostics, _modelFallbackMessage, createRuntimeHooks());
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export { SessionImportFileNotFoundError };
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
