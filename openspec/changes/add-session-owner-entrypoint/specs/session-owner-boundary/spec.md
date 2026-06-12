# session-owner-boundary Specification

## Purpose

This capability defines the boundary between the app-neutral session owner entrypoint in `packages/session` and the Pi application host responsibilities in `packages/coding-agent`. It governs what a session owner must control, what clients may request, and which responsibilities must remain outside `packages/session`.

## Requirements

### Requirement: Session package owns app-neutral session contracts

`packages/session` SHALL own app-neutral session persistence helpers, session metadata, JSONL read/write behavior, session tree/message contracts, and the TypeScript owner/client entrypoint for session control.

`packages/session` SHALL NOT hardcode application names, application config directories, or application environment variable names such as `pi-fork`, `.pi-fork`, or `PI_FORK_*`.

#### Scenario: Host provides storage paths

- **GIVEN** a host application wants to create or open a session
- **WHEN** it calls `packages/session` APIs
- **THEN** the effective agent/session directories are supplied by the host or by explicit storage options
- **AND** `packages/session` does not derive those directories from `pi-fork` defaults.

#### Scenario: Session package remains independent from coding-agent

- **GIVEN** a module inside `packages/session`
- **WHEN** its imports are inspected
- **THEN** it does not import from `packages/coding-agent`, TUI UI modules, extension UI modules, provider auth modules, CLI parsing modules, or app config modules.

### Requirement: Coding-agent owns Pi application services

`packages/coding-agent` SHALL own Pi-specific application services and inject them into the session owner boundary when needed. These services include CLI/TUI/RPC/SDK modes, `pi-fork` app defaults, settings, auth storage, model registry, provider configuration, resource loading, system prompt construction, tool definitions, extension loading, and UI rendering.

#### Scenario: Application defaults stay in coding-agent

- **GIVEN** the fork command uses `pi-fork` and the fork config directory is `.pi-fork`
- **WHEN** session storage paths are computed
- **THEN** `packages/coding-agent` determines those defaults
- **AND** passes the resulting paths or options to `packages/session`.

#### Scenario: Provider and tool dependencies remain outside session package

- **GIVEN** a session owner needs to run a prompt that uses a model and tools
- **WHEN** model resolution, API key lookup, resource loading, tool creation, or extension setup is required
- **THEN** `packages/coding-agent` provides those services
- **AND** `packages/session` does not create or own those application services directly.

### Requirement: Owner/client contract serializes session control

The session boundary SHALL define app-neutral owner/client contracts for listing sessions, creating/opening sessions, sending commands, subscribing to events, retrieving snapshots, and closing sessions.

The contract SHALL include app-neutral command, event, and snapshot shapes that can be used by TUI, RPC, SDK, Web, or a future daemon without exposing `AgentSession`, TUI component instances, extension runner instances, provider objects, or tool implementation objects.

**Stable public `SessionOwnerEvent` names** delivered by `SessionOwner.subscribe()`:
- `session.created`, `session.restored`, `session.closed` — lifecycle
- `snapshot` — full session state for late-join clients
- `turn.started`, `turn.completed` — turn boundaries
- `message.started`, `message.delta`, `message.completed` — streaming message lifecycle
- `tool.started`, `tool.progress`, `tool.completed` — tool execution lifecycle
- `compaction.started`, `compaction.completed` — context compaction lifecycle
- `model.changed`, `thinking.changed` — session configuration changes
- `error` — error conditions

**Internal adapter details** (not public contract):
- JSONL entry type names (`SessionHeader`, `SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `LabelEntry`, `SessionInfoEntry`, `CustomMessageEntry`)
- Coding-agent extension event names (`ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionBeforeCompactEvent`, `SessionBeforeForkEvent`, `SessionBeforeSwitchEvent`, `SessionBeforeTreeEvent`, `AfterProviderResponseEvent`, `BeforeProviderRequestEvent`, `BeforeAgentStartEvent`, `AgentStartEvent`, `AgentEndEvent`)
- Adapter mapping logic between `AgentSession` events and `SessionOwnerEvent`

#### Scenario: Late client attaches to an active session

- **GIVEN** a session owner has an active session
- **WHEN** a client subscribes after the session has already started
- **THEN** the client can retrieve a snapshot of current session state
- **AND** can subscribe to subsequent owner events without reading or writing JSONL directly.

#### Scenario: Client submits a command

- **GIVEN** a client wants to prompt, abort, compact, switch, fork, or shut down a session
- **WHEN** it sends a `SessionCommand` to the owner
- **THEN** the owner serializes the command against the live runtime
- **AND** publishes resulting events through the owner event stream.

#### Scenario: Client receives stable event names

- **GIVEN** a client has subscribed to owner events
- **WHEN** an event is published
- **THEN** the event name is drawn from the stable public contract set
- **AND** JSONL entry types, coding-agent extension events, and adapter mapping logic are not leaked through the public event stream.

### Requirement: Live JSONL writes are single-owner

A live session's JSONL file SHALL have exactly one writer: the component that owns the corresponding live runtime. A client, bridge, frontend, or attach surface SHALL NOT append to a live session JSONL file unless it also owns the session runtime state and command/event ordering.

Runtime state includes streaming output, pending prompts, prompt queue state, tool call lifecycle, abort state, compaction state, active branch/leaf state, model/thinking state, extension lifecycle, and event subscriber ordering.

#### Scenario: Frontend attaches to a TUI-owned session

- **GIVEN** the TUI process owns an active session runtime
- **WHEN** a Web, RPC, SDK, or extension frontend attaches to that live session
- **THEN** the frontend sends commands to the owner and receives events/snapshots
- **AND** the frontend does not append directly to the JSONL file.

#### Scenario: Bridge wants to write JSONL

- **GIVEN** a bridge proposes to append messages to an active session JSONL file
- **WHEN** it does not own streaming, queueing, tool calls, aborts, compaction, branch state, and event ordering
- **THEN** the design is invalid for live sessions
- **AND** the bridge must instead become the session owner or delegate writes to the current owner.

### Requirement: Migration preserves existing behavior

The first implementation phase SHALL allow `packages/coding-agent` to adapt the current `AgentSessionRuntime` to the new owner/client contract before runtime implementation moves into `packages/session`.

Existing session JSONL files SHALL remain readable and writable without a required schema migration for this boundary change.

#### Scenario: Compatibility shims remain during migration

- **GIVEN** existing `coding-agent` code imports session manager, messages, or session-cwd helpers through current compatibility paths
- **WHEN** the owner/client contract is introduced
- **THEN** those imports continue to work until callers have a documented replacement path
- **AND** removing compatibility shims is handled as a separate migration decision.

#### Scenario: Runtime move is deferred behind contract tests

- **GIVEN** prompts, aborts, tool calls, compaction, session switching, forking, and JSONL writes are still implemented by `coding-agent`
- **WHEN** owner/client contracts are introduced
- **THEN** `coding-agent` may provide an in-process owner adapter
- **AND** implementation ownership moves only after contract tests cover the relevant behavior.

### Requirement: Daemon and Web attach are follow-on capabilities

This change SHALL NOT require an out-of-process daemon, WebSocket protocol, browser UI, remote authentication, role system, or cross-host discovery.

The owner/client TypeScript contracts SHOULD be shaped so a future daemon can serialize them, but daemon transport details are outside this capability.

#### Scenario: Future session daemon is proposed

- **GIVEN** the in-process session owner contract is stable
- **WHEN** a future change proposes `pi-sessiond`
- **THEN** it can map the existing command/event/snapshot contract to a transport protocol
- **AND** it must define daemon lifecycle, transport security, and frontend attach behavior in its own proposal.

### Requirement: First implementation phase is types-only

The first `packages/session` delivery under this change SHALL define `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, `SessionSnapshot`, and related contract types, plus contract tests. It SHALL NOT ship an in-process reference owner implementation.

The first real `SessionOwner` implementation SHALL be the coding-agent adapter defined by D3, which wraps `AgentSessionRuntime` in `packages/coding-agent` while implementing the `packages/session` interfaces.

#### Scenario: Contract types exist without a reference owner

- **GIVEN** the first phase of `packages/session` changes is shipped
- **WHEN** a downstream consumer imports the contract types
- **THEN** `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, and `SessionSnapshot` are available
- **AND** no reference owner implementation class is exported from `packages/session`
- **AND** contract tests in `packages/session` validate the types are implementable.

#### Scenario: Stable public events are distinguishable from internal details

- **GIVEN** the `SessionOwnerEvent` contract is defined
- **WHEN** a client subscribes to owner events
- **THEN** event names match the stable public contract set
- **AND** clients do not receive events named after JSONL entry types (`SessionMessageEntry`, `CompactionEntry`, etc.)
- **AND** clients do not receive events named after coding-agent extension events (`ProjectTrustEvent`, `ResourcesDiscoverEvent`, `SessionBeforeCompactEvent`, etc.).
