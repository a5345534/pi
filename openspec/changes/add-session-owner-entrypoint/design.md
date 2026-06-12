# Design: add-session-owner-entrypoint

## Context

`packages/session` currently exports message helpers, session cwd helpers, and `SessionManager`. It also contains app-specific defaults in `src/config.ts`, including `APP_NAME = "pi-fork"`, `.pi-fork`, and `PI_FORK_CODING_AGENT_DIR`. That makes it useful to the current fork but not yet app-neutral.

`packages/coding-agent` depends on `@a5345534/pi-session` and keeps compatibility shim files under `src/core/session-manager.ts`, `src/core/messages.ts`, and `src/core/session-cwd.ts`. The live runtime remains in `packages/coding-agent`: `AgentSession` owns agent lifecycle, event subscription with persistence, model/thinking changes, compaction, bash/tool execution, extension integration, and session operations exposed to modes; `AgentSessionRuntime` owns runtime replacement for `/new`, `/resume`, `/fork`, and JSONL import; `AgentSessionServices` owns cwd-bound Pi application services such as auth, settings, model registry, and resource loading.

The long-term direction needs `packages/session` to become the common entrypoint for session ownership without importing Pi application concerns. This proposal defines that boundary and the staged work required to reach it.

## Spec Kernel

- Why: The project needs one clear session owner boundary before TUI, Web, RPC, SDK, or a future daemon can safely share live sessions.
- Capabilities:
  - Define app-neutral session owner/client contracts that serialize commands, publish events, provide snapshots, and preserve single-writer JSONL ownership.
  - Preserve `coding-agent` as the Pi application host for model, tool, resource, extension, CLI, TUI, RPC, SDK, and config concerns.
  - Support a staged migration where `coding-agent` can adapt the current runtime to the new contract before implementation ownership moves.
- Constraints:
  - Existing session JSONL files must remain readable and writable without format migration.
  - `packages/session` must not hardcode `pi-fork`, `.pi-fork`, or Pi application environment variables.
  - `packages/session` must not import TUI, extension UI, provider auth, or CLI-specific modules.
  - No component may write live session JSONL unless it also owns the corresponding runtime command/event ordering.
- Non-goals:
  - No `pi-sessiond`, Web UI, network protocol, remote auth, or multi-user role system in this change.
  - No provider/tool/resource/extension ownership move into `packages/session`.
- Success signal: Contract, tests, and docs make the owner boundary clear enough for later TUI/Web/sessiond implementation to proceed without duplicating runtime ownership.

## Goals

- Make `packages/session` host-configurable and app-neutral.
- Define explicit `SessionOwner`, `SessionClient`, command, event, and snapshot contracts.
- Define the responsibility split between `packages/session` and `packages/coding-agent`.
- Provide a migration path that keeps current `coding-agent` behavior working while call sites move behind the owner/client boundary.
- Block unsafe designs where a bridge writes JSONL while another runtime owns streaming/tool/abort state.

## Non-Goals

- Build or ship an out-of-process daemon.
- Build or ship Web attach mode.
- Define browser token handling, remote auth, multi-client roles, or cross-host discovery.
- Rewrite the TUI as a pure client in the first phase.
- Change the JSONL schema solely for this boundary.
- Move Pi-specific settings, auth, models, tools, prompts, resources, or extensions into `packages/session`.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Module ownership | `packages/session` is intended to become shared infrastructure, but current runtime ownership is still in `coding-agent`. | Define target and transition responsibilities separately. |
| API compatibility | SDK/examples/extensions may import session types through existing paths. | Keep compatibility shims until replacement imports are available and documented. |
| Data/write safety | Multiple writers to JSONL can corrupt ordering or lose runtime state. | Require the JSONL writer for a live session to be the session owner. |
| App-specific leakage | Current `packages/session/src/config.ts` hardcodes fork defaults. | Move path/config defaults to host-provided options from `coding-agent`. |
| Runtime complexity | Streaming, tool calls, aborts, queueing, compaction, and branch state are intertwined. | Add an adapter first, then migrate ownership incrementally. |
| Future Web/TUI parity | Web attach requires the same command/event surface as TUI. | Make client-facing commands/events frontend-neutral. |
| Security and auth | Personal live sessions may trust local tokens, but network auth is a separate concern. | Defer daemon/network auth and roles; do not bake them into the core contract now. |
| Rollback | A broad runtime move is risky. | Keep source-compatible shims and migrate by phases with contract tests. |

## Decisions

### D1. `packages/session` owns the app-neutral session boundary

**Choice**
`packages/session` SHALL own session persistence helpers, session identity/path abstractions, session tree/message types, owner/client TypeScript contracts, command/event/snapshot types, and single-writer semantics. It SHALL accept storage/config paths from the host instead of deriving `pi-fork` paths itself.

**Rationale**
This lets TUI, Web, RPC, SDK, or a future daemon share one session control surface without depending on `coding-agent` UI or CLI internals.

**Alternatives considered**
- Keep `packages/session` as persistence-only utilities: rejected because Web/TUI parity still needs a shared owner boundary.
- Move all `coding-agent` runtime code immediately: rejected because current runtime depends on model, tool, extension, and UI-adjacent services that need an adapter seam first.

### D2. `packages/coding-agent` remains the Pi application host

**Choice**
`packages/coding-agent` SHALL continue to own CLI parsing, interactive/print/RPC modes, TUI rendering, settings, auth storage, model registry, provider configuration, resource loading, system prompt construction, extension loading, tool definitions, and `pi-fork` app/config defaults. It SHALL inject these dependencies into the session owner boundary instead of making `packages/session` import them.

**Rationale**
These concerns are application-specific. Moving them into `packages/session` would make the session package a second coding-agent package rather than a reusable session owner entrypoint.

**Alternatives considered**
- Put model/tool/extension services into `packages/session`: rejected because it violates app-neutral ownership and makes non-coding-agent consumers inherit Pi CLI behavior.
- Keep frontend modes directly coupled to `AgentSession`: deferred; existing code can remain while an owner/client adapter is introduced.

### D3. Runtime ownership migrates through an in-process adapter first

**Choice**
The first implementation SHALL introduce contracts and an in-process adapter around the current `AgentSessionRuntime`. The adapter may live in `packages/coding-agent` while implementing `packages/session` interfaces. Only after frontend call sites use the contract should implementation ownership move into `packages/session`.

**Rationale**
This reduces risk and gives tests a stable contract before moving streaming, abort, queue, tool, compaction, and branch state.

**Alternatives considered**
- Directly move `AgentSession` and `AgentSessionRuntime` into `packages/session`: rejected for first phase because it would force many app-specific dependencies across the boundary.
- Build `pi-sessiond` first: rejected because a daemon without a stable in-process contract would freeze the wrong API.

### D4. Live session JSONL writes require runtime ownership

**Choice**
A live session owner SHALL be the only component that appends to that session's JSONL file. Clients may request commands and receive events/snapshots, but they SHALL NOT write JSONL directly. If a bridge wants to write JSONL, it must own the runtime state for streaming, pending prompts, tool calls, abort, compaction, branch/leaf state, and event ordering.

**Rationale**
JSONL is not just storage; it is the durable record of runtime decisions. A passive writer cannot safely reconstruct concurrent live state.

**Alternatives considered**
- Allow UI bridges to append JSONL while the TUI runtime runs elsewhere: rejected as unsafe and incomplete.

### D5. Out-of-process protocol is follow-on work

**Choice**
This change SHALL NOT define a WebSocket/stdio/IPC wire protocol. It MAY shape command/event/snapshot types so they can later be serialized by `pi-sessiond`.

**Rationale**
The package boundary must stabilize before network/process boundaries are introduced.

**Alternatives considered**
- Design the daemon protocol now: deferred to avoid coupling the core contract to unimplemented auth, lifecycle, and multi-client policies.

### D6. `packages/session` exposes types-only in the first phase; no reference owner

**Choice**
`packages/session` SHALL define `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, `SessionSnapshot`, and related contract types plus contract tests. It SHALL NOT ship an in-process reference owner implementation in this phase.

**Rationale**
A reference owner that does not talk to models or tools is too trivial to be useful. A real reference owner would need model invocation, tool execution, and agent runtime lifecycle concerns that are owned by `coding-agent` per D2. The coding-agent adapter (per D3) is the real first implementation. Contract tests alone can prove the types are implementable without pulling provider/runtime dependencies into `packages/session`.

**Alternatives considered**
- Include a minimal reference owner: rejected because it either duplicates trivial scaffolding that adds no value, or pulls in model/tool/runtime concerns that violate the app-neutral boundary.
- Defer even the types: rejected because types and contract tests are the minimal deliverable that lets downstream consumers code against the boundary while the adapter is built.

### D7. Event surface classification: public contract versus internal adapter details

**Choice**
The `SessionOwnerEvent` names below SHALL be the stable public contract surface delivered by `SessionOwner.subscribe()`. JSONL entry type names, coding-agent extension event names, and adapter mapping logic SHALL be treated as internal implementation details not covered by the public contract.

**Rationale**
Clients and future transports need a stable set of event names they can rely on. The internal persistence format and extension event system are coding-agent implementation details that can evolve independently. Separating these now prevents the public contract from being coupled to JSONL schema changes or extension API evolution.

**Public contract events** (stable):
- `session.created`, `session.restored`, `session.closed` — lifecycle
- `snapshot` — full session state for late-join clients
- `turn.started`, `turn.completed` — turn boundaries
- `message.started`, `message.delta`, `message.completed` — streaming message lifecycle
- `tool.started`, `tool.progress`, `tool.completed` — tool execution lifecycle
- `compaction.started`, `compaction.completed` — context compaction lifecycle
- `model.changed`, `thinking.changed` — session configuration changes
- `error` — error conditions

**Internal adapter details** (not stable public contract):
- JSONL entry type names: `SessionHeader`, `SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `LabelEntry`, `SessionInfoEntry`, `CustomMessageEntry`, etc.
- Coding-agent extension event names: `ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionBeforeCompactEvent`, `SessionBeforeForkEvent`, `SessionBeforeSwitchEvent`, `SessionBeforeTreeEvent`, `AfterProviderResponseEvent`, `BeforeProviderRequestEvent`, `BeforeAgentStartEvent`, `AgentStartEvent`, `AgentEndEvent`, etc.
- Adapter mapping logic between `AgentSession` events and `SessionOwnerEvent`
- Event ordering guarantees within an adapter implementation
- Internal session metadata fields (`leafId`, `cwd`, `sessionDir`) on non-contract types

**Alternatives considered**
- Make JSONL entry types part of the public contract: rejected because the persistence format should be able to evolve without breaking clients.
- Make coding-agent extension events part of the public contract: rejected because extensions are Pi-specific internal machinery, not a generic session client surface.

## Detailed Design

### Responsibility Boundary

`packages/session` target responsibilities:

- Session identity, file/path metadata, cwd metadata, and storage option types.
- Session JSONL read/write helpers and tree/message conversion contracts.
- `SessionManager` and related persistence APIs, with host-provided storage directories.
- App-neutral `SessionOwner` and `SessionClient` contracts.
- Serializable command types such as prompt, abort, compact, switch/fork, model intent, and shutdown intent when they can be expressed without Pi-specific dependencies.
- Serializable event types such as snapshot, entry appended, turn state, stream delta, tool call state, queue state, runtime state, and error state.
- Snapshot types that allow late-joining clients to render current state before subscribing to deltas.
- Single-writer rules for live session JSONL.
- Contract tests for owner/client behavior.

`packages/session` must not own:

- `pi-fork` app name, `.pi-fork` default directories, or `PI_FORK_*` environment variables.
- CLI argument parsing, TUI components, print mode, or RPC server mode.
- Provider auth, API key storage, model registry, model fallback policy, or provider-specific request logic.
- Tool implementation, bash execution policy, resource loading, prompt templates, settings, project trust, or extension loading.
- Browser UI, daemon lifecycle, remote auth, roles, or host discovery.

`packages/coding-agent` responsibilities:

- Compute app defaults such as `pi-fork`, `.pi-fork`, `PI_FORK_CODING_AGENT_DIR`, and session directory paths.
- Create and inject cwd-bound services: auth storage, settings manager, model registry, resource loader, extension runtime, tool definitions, and system prompt inputs.
- Own CLI/TUI/RPC/print/SDK user interaction layers.
- Provide the first `SessionOwner` adapter over existing `AgentSessionRuntime`.
- Map app-neutral session owner events to extension events and TUI/RPC render updates.
- Keep compatibility shims while public imports migrate.

### Data / Contract Changes

New TypeScript-level contracts are expected under `packages/session/src/owner/` or equivalent. The first phase SHALL be **types-only**: `packages/session` defines the contract types and contract tests but does not ship a reference owner implementation.

```ts
export interface SessionOwner {
  listSessions(query?: SessionListQuery): Promise<SessionInfo[]>;
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;
  openSession(target: SessionTarget): Promise<SessionHandle>;
  forkSession(target: ForkSessionTarget): Promise<SessionHandle>;
  closeSession(sessionId: string): Promise<void>;
  sendCommand(sessionId: string, command: SessionCommand): Promise<void>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  subscribe(sessionId: string, listener: SessionEventListener): Unsubscribe;
}
```

Stable public `SessionOwnerEvent` names:
- `session.created`, `session.restored`, `session.closed` — lifecycle
- `snapshot` — full session state for late-join clients
- `turn.started`, `turn.completed` — turn boundaries
- `message.started`, `message.delta`, `message.completed` — streaming message lifecycle
- `tool.started`, `tool.progress`, `tool.completed` — tool execution lifecycle
- `compaction.started`, `compaction.completed` — context compaction lifecycle
- `model.changed`, `thinking.changed` — session configuration changes
- `error` — error conditions

The following are internal adapter details, NOT public contract: JSONL entry type names (`SessionHeader`, `SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, etc.), coding-agent extension event names (`ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionBeforeCompactEvent`, etc.), and adapter mapping logic between `AgentSession` events and `SessionOwnerEvent`.

The first contract version should prefer stable, app-neutral shapes and avoid exposing `AgentSession`, TUI components, extension runner instances, provider models, or tool implementation objects.

No JSONL schema migration is required by this proposal. If future command/event needs require persisted schema changes, that work must be proposed separately.

### Execution Flow

1. `coding-agent` computes the effective `agentDir` and `sessionDir` from app config and environment variables.
2. `coding-agent` creates or opens a session by passing host-provided storage options into `packages/session` APIs.
3. The current `AgentSessionRuntime` is wrapped by a `SessionOwner` adapter.
4. TUI/RPC/SDK call sites migrate from direct `AgentSessionRuntime` method calls to `SessionClient` commands where practical.
5. The adapter serializes commands, invokes current runtime behavior, and emits app-neutral session events.
6. Once call sites depend on the owner/client contract, implementation details can move from `coding-agent` to `packages/session` behind the same interface.
7. A future daemon can expose the same command/event/snapshot surface over IPC/WebSocket without changing frontend semantics.

### Module Boundaries

- `packages/session` may depend on generic session data packages such as `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` only when required for existing message/session data shapes. New owner contracts should minimize dependency on provider/runtime implementation types.
- `packages/session` must not import from `packages/coding-agent`.
- `packages/coding-agent` may import from `packages/session` and provide adapters/services.
- `packages/tui` remains a rendering toolkit, not a session owner.
- `packages/agent` remains generic agent harness/core infrastructure, not the Pi coding-agent session owner unless a separate future proposal changes that boundary.

### Migration / Rollout

1. Phase 0: remove app-specific config from `packages/session`; require host-provided storage options while preserving current default behavior through `coding-agent`.
2. Phase 1: add owner/client types, snapshot/event/command contracts, and contract tests in `packages/session`.
3. Phase 2: add a `coding-agent` in-process adapter around `AgentSessionRuntime`; migrate low-risk TUI/RPC/SDK call sites.
4. Phase 3: move runtime ownership internals behind the owner boundary only after adapter tests cover prompts, queueing, abort, tools, compaction, switching, forking, and JSONL writes.
5. Phase 4: separately propose `pi-sessiond` or Web attach protocol if needed.

Rollback per phase should preserve the current shim imports and direct runtime path until the replacement path passes tests.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Boundary becomes too broad and turns `packages/session` into another `coding-agent`. | High | Explicitly exclude app-specific services and require dependency injection from `coding-agent`. |
| Owner event contract leaks unstable internal runtime details. | Medium | Mark first contract version experimental and keep public shapes app-neutral. |
| Direct JSONL writers reappear for live attach prototypes. | High | Add normative spec language forbidding client-side JSONL writes for live sessions. |
| Migration breaks SDK/extensions importing current session paths. | Medium | Keep compatibility shims and update docs/examples after replacement imports exist. |
| Adapter duplicates state instead of delegating to the current runtime. | Medium | Contract tests should assert command/event ordering and single writer behavior. |

## Verification Plan

- Run `npm run check` after implementation changes.
- Run `npm --prefix packages/session test` for contract tests.
- Run targeted `packages/coding-agent` tests for session switching, forking, RPC, SDK, and extension lifecycle when adapter call sites change.
- Manually smoke `pi-fork --help`, `pi-fork --version`, and a no-session/no-tools prompt when runtime behavior changes.
- Verify no new imports from `packages/session` to `packages/coding-agent`, TUI, or app-specific config modules.

## Load-Bearing Preservation Notes

- Current `packages/session` is persistence/helper-only and hardcodes `pi-fork` config → captured in Context, D1, and Phase 0.
- Current runtime ownership remains in `AgentSession` and `AgentSessionRuntime` → captured in Context, D2, and D3.
- Single JSONL writer must also own live runtime state → captured in Why, D4, and normative spec requirements.
- User wants clear responsibility and development/non-development scope → captured in Responsibility Boundary, Non-Goals, and tasks.
- Future Web/TUI parity depends on a shared owner/client entrypoint → captured in Why, Goals, D3, and D5.
