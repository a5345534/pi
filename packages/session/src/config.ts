import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "./utils/paths.ts";

export const APP_NAME = "pi";
export const CONFIG_DIR_NAME = ".pi";
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

/** Get the agent config directory (e.g., ~/.pi/agent/) */
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
