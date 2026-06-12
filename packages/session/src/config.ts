import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "./utils/paths.ts";

export const APP_NAME = "pi-fork";
export const CONFIG_DIR_NAME = ".pi-fork";
const APP_ENV_PREFIX = APP_NAME.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
export const ENV_AGENT_DIR = `${APP_ENV_PREFIX}_CODING_AGENT_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

/** Get the agent config directory (e.g., ~/.pi-fork/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}
