# @a5345534/pi-session

App-neutral session persistence, storage helpers, and session owner/client contracts shared by Pi packages.

## Exports

- `SessionManager`, session JSONL helpers, and tree/message conversion helpers
- host-configurable storage helpers: `configureSessionStorageDefaults`, `resolveSessionStorageOptions`, `getSessionsDir`
- shared owner/client types: `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, `SessionSnapshot`

## Storage

Session storage needs host-provided `agentDir`, `sessionsDir`, or `sessionDir` options. Host apps can set defaults once:

```ts
import { configureSessionStorageDefaults, SessionManager } from "@a5345534/pi-session";

configureSessionStorageDefaults({
  agentDir: () => process.env.PI_CODING_AGENT_DIR ?? "~/.pi/agent",
});

const sessions = await SessionManager.list(process.cwd());
```

Pass explicit storage options when creating, opening, resuming, or listing sessions if you do not want global defaults.

## Owner boundary

Use the shared contract types when building a session client or owner adapter.
Pi's in-process adapter lives in `@a5345534/pi-coding-agent` via `createAgentSessionOwner()`.

```ts
import { type SessionClient, type SessionOwner } from "@a5345534/pi-session";
```
