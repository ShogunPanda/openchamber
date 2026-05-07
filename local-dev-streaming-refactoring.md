# Local Dev Streaming Refactoring Plan

## Problem

OpenChamber can stop rendering updates for background sessions while OpenCode continues to send session, message, part, permission, and question events. Users then cannot reliably work across two or more simultaneous sessions without restarting the app.

This is unacceptable for OpenChamber's core workflow. A coding UI must treat every active session as live, not only the currently viewed one.

## Current Failure Modes

The current sync pipeline has too many independent recovery and presentation layers:

- directory child stores
- routing index
- per-session cache eviction
- optimistic shadow maps
- parts-only repair
- reconnect recovery
- active-session recovery
- separate streaming store
- sidebar live aggregation
- message record snapshot caching
- turn projection
- blocking-request resync

These layers were added for good reasons, but together they allow partial state to exist for a session. The backend may continue streaming, while the UI has an incomplete materialized model and cannot render the turn.

Known weak points:

- `message.part.delta` cannot apply if the local part row is missing.
- Repair historically restored parts without guaranteeing the owning message row exists.
- Cache eviction could remove live session state and leave later events with no complete state to mutate.
- Background sessions depend on recovery code that is less direct than active-session rendering.
- Rendering logic has relied on fallbacks for incomplete grouping instead of a strict user-rooted contract.

## Goal

Build a first-class robust streaming architecture, not another patch layer.

The refactor should make these invariants true:

- Any active session can stream in the background indefinitely.
- Events are applied by `sessionID`/`messageID` regardless of whether the session is currently viewed.
- Missing local message/part state triggers deterministic recovery, not silent drops.
- Cache eviction is a memory optimization only; it must never affect correctness.
- Rendering receives a complete, user-rooted session timeline model.
- Reconnect, retry, permission, question, abort, archive/delete, and revisit flows remain correct.

## Reference: OpenCode

OpenCode's app uses a simpler timeline contract:

- user messages are the timeline roots;
- assistant messages render under `assistant.parentID === user.id`;
- a session can be loaded by fetching message snapshots and reconciling by ID;
- session cache limit is `40`, not `8`.

We do not need to copy OpenCode exactly because OpenChamber has more cross-runtime and sidebar behavior. But the key lesson is that rendering should be user-rooted and sync repair should restore full message snapshots, not isolated fragments.

## Target Architecture

### 1. Session Materialization Layer

Introduce a focused session materialization module owned by sync.

Responsibilities:

- maintain `message[sessionID]` and `part[messageID]` together;
- merge message snapshots by ID;
- merge part snapshots by message ID and part ID;
- preserve references for unchanged records;
- preserve richer existing state unless a newer complete snapshot replaces it;
- update routing indexes from every materialized snapshot.

This replaces ad-hoc message/part merging in event reducer, repair, reconnect, ensure-message hooks, and prefetch paths.

### 2. Deterministic Recovery Queue

Replace parts-only repair with message-level recovery.

Recovery key: `(directory, sessionID)`.

Triggers:

- `message.part.delta` for missing message/part;
- `message.part.updated` for unknown message when session can be resolved;
- `message.updated` that leaves a message without parts while the assistant is active;
- reconnect or transport switch;
- explicit session revisit when local materialization is incomplete.

Recovery behavior:

- fetch recent messages for the session;
- materialize messages and parts together;
- preserve existing richer local state when appropriate;
- clear stale recovery state only after successful materialization.

### 3. Correct Event Reducer Boundaries

The event reducer should be a pure event-to-state reducer, not a place where missing state is silently ignored forever.

Rules:

- `message.updated` must ensure a message row exists.
- `message.part.updated` must ensure a part row exists and schedule message recovery if the owning message is unknown.
- `message.part.delta` may return no state change only if it also reports a recoverable missing-state condition.
- `session.status`, `permission`, and `question` updates must not depend on message cache presence.

### 4. Eviction Policy Refactor

Session eviction must never remove correctness-critical live state.

Rules:

- never evict busy/retry sessions;
- never evict sessions with pending permissions or questions;
- never evict sessions with incomplete assistant messages;
- never evict the viewed session;
- prefer evicting heavy parts/content before removing message shells/status;
- if a session is evicted, routing and recovery metadata must be left in a state where future events can recover it.

### 5. Rendering Contract

The chat renderer should consume a user-rooted timeline model.

Rules:

- user messages are turn roots;
- assistants render only under their parent user message;
- assistant messages with missing parent user are not rendered as standalone entries;
- non-chat/system orphan messages may remain explicitly ungrouped only where there is a real UI reason;
- background and active sessions use the same materialized session model.

### 6. Streaming State Consolidation

Audit the split between `session_status`, incomplete assistant fallback, and `streamingStore`.

Goal:

- one authoritative source for live session activity;
- derived stores are presentation caches only;
- losing a presentation cache cannot stop session rendering.

## Implementation Phases

This is a single refactor branch, but the work should still land as coherent commits.

### Phase 1: Mapping And Tests

- Add focused tests for background-session materialization.
- Add tests for missing part delta recovery.
- Add tests for cache eviction not breaking active background sessions.
- Add tests for user-rooted rendering against out-of-order events.

### Phase 2: Materialization Module

- Create a module for message/part materialization.
- Move snapshot merge logic there.
- Use it from fetch/load, reconnect, repair, and ensure-message code paths.

### Phase 3: Recovery Queue

- Replace `repairSessionParts` with session message recovery.
- Deduplicate and debounce recovery by `(directory, sessionID)`.
- Make reducer missing-state outcomes explicit.

### Phase 4: Eviction Cleanup

- Make eviction policy safety-first.
- Preserve message shells/status for live sessions.
- Remove any eviction behavior that can strand future SSE events.

### Phase 5: Rendering Cleanup

- Ensure `MessageList` and turn projection consume the user-rooted model.
- Remove fallback paths that render assistant messages as standalone chat rows.
- Keep system/non-chat orphan handling explicit and narrow.

### Phase 6: Full Validation

- Type check and lint.
- Targeted unit tests.
- Manual multi-session test: start two long-running sessions, switch between them, leave one backgrounded, answer permissions/questions, abort/retry, then revisit both.
- Desktop smoke test because this bug is user-reported there.

## Non-Goals

- Do not change OpenCode server behavior.
- Do not hide partial failure. If recovery fails, keep state recoverable and visible to debug tooling.
- Do not rely on active-session-only logic for correctness.

## Success Criteria

- Working on multiple simultaneous sessions does not require restart.
- Background sessions continue rendering when revisited.
- Permission/question states survive background operation and cache pressure.
- SSE events can arrive before local message/part state without permanently breaking rendering.
- The resulting code is simpler to reason about than the current patch stack.
