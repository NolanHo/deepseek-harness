# Agent Note: Startup never mints sessions — clean-storage browsers stay on the hero

Status: implemented

English | [中文](2026-08-28-startup-reuse-only-session-selection.zh.md)

> Scope: the web client's one-shot startup selection policy in `WorkspaceRuntime.startInitialSelection`. No host-side, persistence, or wire-format changes.

## Problem

Every browser connect that could not restore a saved current session (phone PWA reinstall, embedded webview, storage eviction, a fresh device) made `startInitialSelection` connect the most recent Workspace and **create** a blank session when none existed to reuse. Each such connect left a seed-only session (permission/sandbox/approval preset events plus `session/end-seed`, no content) in the sidebar under the Workspace title — users saw empty "deepseek-harness" sessions appear with no action on their side. A phone reconnecting a few times produced several in seconds.

## Decision

**Startup is reuse-only; creation stays a gesture.** The reuse scan is extracted from `connectWorkspace` into a private `blankSessionOf(workspace)` (unchanged membership/canonical-cwd/archived rules). `connectWorkspace` keeps its reuse-or-create contract — the New Session button, the brand shortcut, and the hero Workspace picker all still mint sessions. `startInitialSelection` now opens the recent Workspace's reusable blank when one exists and otherwise finishes in the empty hero state without calling the host; the retry-on-failure machinery goes away with the async create.

The test surface pins both branches:

- runtime specs: startup with a recent Workspace and no blank creates nothing and stays unselected; startup with a reusable blank opens it without creating.
- assembled `built-boot` snapshot and the four fixture snapshots (`todo-row`, `search-card`, `image-display`, `max-tokens-notice`) expand the Workspace group explicitly — the auto-opened session previously expanded it for them.
- the `startup-auto-selection` e2e keeps its held-`session.history` reuse flow (the observable behavior is identical) and its header documents the policy; the no-blank branch is unit- and assembled-snapshot-pinned because an e2e host cannot easily present a Workspace with no blank.

## Consequences

- Clean-storage connects land on the hero (wordmark + composer), never conjure sessions.
- Blank-session reuse is now shared by both paths, so the New Session gesture deduplicates against the startup policy's own prior reuses.
- Deleting the leftover blank sessions (created before this change) makes the next clean connect stay on the hero permanently.

## Alternatives considered

- **Keep the create path and clean up later** (host-side or cron deletion of stale blanks): cleanup is remediation, not prevention — the phantom rows keep appearing between sweeps, and the host-side change would need a restart.
- **Reuse-only plus auto-expand the recent Workspace group**: the tree expansion is derived from the current session; decoupling it for a not-yet-opened session would add startup-only state for a purely cosmetic gain.
- **Always create, never reuse**: rejected on both axes — it regresses the reuse contract the New Session gesture relies on, and it makes every reload mint another blank.
