import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const sessionSrcIndex = fileURLToPath(new URL("../session/src/index.ts", import.meta.url));
const sessionSrcMessages = fileURLToPath(new URL("../session/src/messages.ts", import.meta.url));
const sessionSrcOwner = fileURLToPath(new URL("../session/src/owner/index.ts", import.meta.url));
const sessionSrcSessionCwd = fileURLToPath(new URL("../session/src/session-cwd.ts", import.meta.url));
const sessionSrcSessionManager = fileURLToPath(new URL("../session/src/session-manager.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@a5345534\/pi-session$/, replacement: sessionSrcIndex },
			{ find: /^@a5345534\/pi-session\/messages$/, replacement: sessionSrcMessages },
			{ find: /^@a5345534\/pi-session\/owner$/, replacement: sessionSrcOwner },
			{ find: /^@a5345534\/pi-session\/session-cwd$/, replacement: sessionSrcSessionCwd },
			{ find: /^@a5345534\/pi-session\/session-manager$/, replacement: sessionSrcSessionManager },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
