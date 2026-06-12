# add-session-owner-entrypoint

## Why

`@a5345534/pi-session` has been mechanically extracted from `@a5345534/pi-coding-agent`, but it currently behaves as shared persistence utilities rather than a general session owner entrypoint. The live-session/Web attach direction needs a clear boundary before more runtime code moves: only one component may own live session state and JSONL write ordering, while TUI, Web, RPC, SDK, and future daemons should interact through a consistent owner/client contract.

Without an explicit boundary, future work risks either duplicating session runtime responsibilities in multiple frontends or creating unsafe bridges that write JSONL without owning streaming state, pending prompts, tool calls, aborts, compaction, and branch selection.

## What Changes

- Define `@a5345534/pi-session` as the app-neutral package that owns session persistence contracts and the future owner/client entrypoint.
- Define `@a5345534/pi-coding-agent` as the application host that owns Pi-specific CLI/TUI/RPC/SDK modes, settings, auth, model/tool/resource/extension wiring, and `pi-fork` config defaults.
- Introduce a staged migration path: first make `packages/session` configurable by host-provided paths, then add owner/client types and contract tests, then adapt `coding-agent` to the contract before moving live runtime ownership.
- Establish that a component which writes session JSONL for a live session must also own the corresponding runtime state, event ordering, and command serialization.
- Explicitly exclude Web UI/session daemon/network protocol work from this change; those become follow-on consumers once the owner boundary exists.

## Impact

- Affected specs: `session-owner-boundary`
- Affected modules/repos: `packages/session`, `packages/coding-agent`
- Affected APIs/events/data: new TypeScript-level session owner/client command, event, and snapshot contracts; no required JSONL format change in this proposal.
- Migration/deployment impact: incremental internal API migration; existing `coding-agent` imports may keep compatibility shims during transition.
- User-visible impact: none expected in early phases. Later phases enable TUI/Web/RPC/SDK to attach through the same owner boundary.

## Non-Goals

- Do not build `pi-sessiond`, Web attach mode, browser UI, or remote session protocol in this change.
- Do not add multi-user roles, permissions, network authentication, or remote-host discovery.
- Do not make bridges or clients write Pi JSONL directly without owning the runtime.
- Do not move provider auth, model registry, tool definitions, resource loading, extension loading, TUI rendering, CLI parsing, or `pi-fork` app defaults into `packages/session`.
- Do not introduce a new session file format or migrate existing JSONL files as part of the boundary proposal.
- Do not remove current `coding-agent` compatibility shims until downstream imports have a replacement path.

## Success Signal

A reviewer can identify, from the new contract and tests, which responsibilities belong to `packages/session`, which remain in `packages/coding-agent`, which capabilities are intentionally deferred, and how later TUI/Web/sessiond work can depend on the owner entrypoint without creating a second JSONL writer.

## Assumptions

- [ASSUMPTION] The near-term implementation should remain in-process; out-of-process `pi-sessiond` is deferred until after the TypeScript contract is stable.
- [ASSUMPTION] Existing session JSONL compatibility is a hard constraint for this change.
- [ASSUMPTION] The current fork package scope and command naming (`@a5345534/*`, `pi-fork`) remain in place while the boundary is introduced.

## Resolved Questions

- [x] **Should `packages/session` expose only app-neutral owner/client types first, or should it also include a minimal in-process reference owner before `coding-agent` integration?**

  **Decision: types-only for the first phase.** `packages/session` SHALL define `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, `SessionSnapshot`, and related contract types plus contract tests. It SHALL NOT include an in-process reference owner in this phase. Rationale: a reference owner that does nothing is not useful; a real reference owner would need to import model invocation, tool execution, or runtime lifecycle concerns that belong in `coding-agent` per D2. The coding-agent adapter (per D3) is the first real implementation. Contract tests alone can validate that the types are implementable without coupling `packages/session` to provider/runtime internals.

- [x] **Which event names should be considered stable public contract versus internal adapter details during the first implementation phase?**

  **Decision: classify as follows.**

  **Stable public contract events** (the `SessionOwnerEvent` surface delivered by `SessionOwner.subscribe()`):
  - `session.created` — session was created
  - `session.restored` — session was opened/restored from file
  - `session.closed` — session was closed
  - `snapshot` — full session state snapshot (for late-join clients)
  - `turn.started` — a new turn begins
  - `turn.completed` — a turn completes
  - `message.started` — a message starts streaming
  - `message.delta` — incremental text delta
  - `message.completed` — a message completed
  - `tool.started` — tool execution started
  - `tool.progress` — tool execution progress update
  - `tool.completed` — tool execution completed
  - `compaction.started` — context compaction started
  - `compaction.completed` — context compaction completed
  - `model.changed` — model selection changed
  - `thinking.changed` — thinking level changed
  - `error` — error condition

  **Internal adapter details** (not stable public contract; may change without notice):
  - JSONL entry type names (`SessionHeader`, `SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, etc.) — these are persistence format, not a client-facing API
  - `coding-agent` extension event names (`ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionBeforeCompactEvent`, etc.) — these remain internal to the coding-agent extension system
  - Adapter mapping logic between `AgentSession` events and `SessionOwnerEvent` — implementation detail of the coding-agent adapter
  - Event ordering guarantees within an adapter implementation
  - Internal session metadata field names (`leafId`, `cwd`, `sessionDir`, etc.) on non-contract types
