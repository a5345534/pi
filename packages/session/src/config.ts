import { join } from "node:path";
import { normalizePath } from "./utils/paths.ts";

export type SessionStoragePathProvider = () => string | undefined;
export type SessionStoragePathSource = string | SessionStoragePathProvider;

export interface SessionStorageDefaults {
	/** Host application config directory, used as the base for sessions when sessionsDir is omitted. */
	agentDir?: SessionStoragePathSource;
	/** Directory containing per-cwd session directories. Defaults to `${agentDir}/sessions`. */
	sessionsDir?: SessionStoragePathSource;
	/** Explicit session directory for hosts that do not use per-cwd session directories. */
	sessionDir?: SessionStoragePathSource;
}

export interface SessionStorageOptions {
	/** Host application config directory, used as the base for sessions when sessionsDir is omitted. */
	agentDir?: string;
	/** Directory containing per-cwd session directories. Defaults to `${agentDir}/sessions`. */
	sessionsDir?: string;
	/** Explicit session directory for hosts that do not use per-cwd session directories. */
	sessionDir?: string;
}

export interface ResolvedSessionStorageOptions {
	agentDir?: string;
	sessionsDir?: string;
	sessionDir?: string;
}

let configuredStorageDefaults: SessionStorageDefaults | undefined;

export function configureSessionStorageDefaults(defaults: SessionStorageDefaults | undefined): void {
	configuredStorageDefaults = defaults;
}

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

function resolvePathSource(source: SessionStoragePathSource | undefined): string | undefined {
	const value = typeof source === "function" ? source() : source;
	return value ? expandTildePath(value) : undefined;
}

function getConfiguredStorageOptions(): SessionStorageOptions | undefined {
	if (!configuredStorageDefaults) return undefined;
	const agentDir = resolvePathSource(configuredStorageDefaults.agentDir);
	const sessionsDir = resolvePathSource(configuredStorageDefaults.sessionsDir);
	const sessionDir = resolvePathSource(configuredStorageDefaults.sessionDir);
	return { agentDir, sessionsDir, sessionDir };
}

export function resolveSessionStorageOptions(options?: SessionStorageOptions): ResolvedSessionStorageOptions {
	const storageOptions = options ?? getConfiguredStorageOptions();
	if (!storageOptions) {
		throw new Error("Session storage requires host-provided agentDir, sessionsDir, or sessionDir options");
	}

	const agentDir = storageOptions.agentDir ? expandTildePath(storageOptions.agentDir) : undefined;
	const sessionsDir = storageOptions.sessionsDir ? expandTildePath(storageOptions.sessionsDir) : undefined;
	const sessionDir = storageOptions.sessionDir ? expandTildePath(storageOptions.sessionDir) : undefined;

	if (sessionDir) {
		return { agentDir, sessionsDir, sessionDir };
	}
	if (sessionsDir) {
		return { agentDir, sessionsDir };
	}
	if (agentDir) {
		return { agentDir, sessionsDir: join(agentDir, "sessions") };
	}

	throw new Error("Session storage requires host-provided agentDir, sessionsDir, or sessionDir options");
}

/** Get the root directory used for session storage. */
export function getSessionsDir(options?: SessionStorageOptions): string {
	const storage = resolveSessionStorageOptions(options);
	if (storage.sessionDir) return storage.sessionDir;
	if (storage.sessionsDir) return storage.sessionsDir;
	throw new Error("Session storage requires host-provided agentDir, sessionsDir, or sessionDir options");
}
