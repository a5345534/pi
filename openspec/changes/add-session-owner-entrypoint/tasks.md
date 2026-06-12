# Tasks: add-session-owner-entrypoint

## 1. Spec and Contract

- [x] 1.1 Review and approve the `session-owner-boundary` spec delta.
- [x] 1.2 Confirm the public terms: `SessionOwner`, `SessionClient`, `SessionCommand`, `SessionOwnerEvent`, and `SessionSnapshot`.
- [x] 1.3 Decide whether the first implementation exposes only types or also a minimal in-process reference owner in `packages/session`.
  **Decision: types-only.** See D6 in design.md. `packages/session` SHALL define contract types and contract tests only; no reference owner in this phase. The coding-agent adapter (per D3) is the first real implementation.

## 2. Session Package Boundary

- [ ] 2.1 Remove `pi-fork`, `.pi-fork`, and `PI_FORK_*` defaults from `packages/session`; accept host-provided storage/path options instead.
- [ ] 2.2 Preserve existing `SessionManager` JSONL behavior and existing session file compatibility.
- [ ] 2.3 Add app-neutral owner/client command, event, snapshot, handle, and list-query types under `packages/session`.
- [ ] 2.4 Add contract tests that prove command serialization, event subscription, snapshot retrieval, and single-writer expectations.
- [ ] 2.5 Verify `packages/session` does not import from `packages/coding-agent`, TUI modules, extension UI modules, provider auth, CLI parsing, or app config modules.

## 3. Coding-Agent Adapter

- [ ] 3.1 Keep `coding-agent` responsible for app defaults: `pi-fork`, `.pi-fork`, `PI_FORK_CODING_AGENT_DIR`, and effective session directory selection.
- [ ] 3.2 Add a `coding-agent` in-process `SessionOwner` adapter over the current `AgentSessionRuntime`.
- [ ] 3.3 Map app-neutral owner commands to current runtime operations for create/open/new/resume/fork/import, prompt, abort, compact, and shutdown where supported.
- [ ] 3.4 Map current runtime events into app-neutral owner events without exposing TUI component instances, extension runner instances, provider objects, or tool implementation objects.
- [ ] 3.5 Keep existing compatibility shims until imports and docs migrate to the new entrypoint.

## 4. Runtime Migration Slices

- [ ] 4.1 Migrate low-risk SDK/RPC call sites to the owner/client contract while preserving current behavior.
- [ ] 4.2 Migrate interactive mode call sites only after adapter tests cover session switching, forking, prompt queueing, abort, tool calls, compaction, and JSONL write ordering.
- [ ] 4.3 Move implementation ownership from `coding-agent` into `packages/session` only behind the already-tested owner/client contract.
- [ ] 4.4 Keep provider auth, model registry, tool definitions, resource loading, extension loading, system prompt construction, TUI rendering, and CLI parsing in `coding-agent` as injected services.

## 5. Verification

- [ ] 5.1 Run `npm run check`.
- [ ] 5.2 Run `npm --prefix packages/session test`.
- [ ] 5.3 Run targeted `packages/coding-agent` tests covering changed adapter or call-site behavior.
- [ ] 5.4 Smoke `pi-fork --help` and `pi-fork --version` after package boundary changes.
- [ ] 5.5 Verify a live session has exactly one JSONL writer: the active owner, not a frontend bridge/client.

## 6. Documentation / Closeout

- [ ] 6.1 Update relevant package README/docs after public owner/client imports exist.
- [ ] 6.2 Refresh `source-manifest.json` after spec changes.
- [ ] 6.3 Validate `change-explainer.html` if generated for review.
- [ ] 6.4 Run archive preflight only after implementation and non-backlog tasks are complete.

## Backlog / Follow-ups

- [ ] [BACKLOG] Propose and implement `pi-sessiond` as a separate out-of-process owner after the in-process contract is stable.
- [ ] [BACKLOG] Add Web attach mode and browser token handling after `pi-sessiond` or an equivalent owner transport exists.
- [ ] [BACKLOG] Define remote-host discovery, multi-client roles, or network authentication only if the scope expands beyond trusted local personal use.
