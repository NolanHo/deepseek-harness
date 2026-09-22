# Agent Note: workspace path open refuses fast on hosts without a desktop opener

Status: implemented

English | [中文](2026-08-29-headless-path-open-refusal.zh.md)

> Scope: the `session/openWorkspacePath` RPC gate, the Chat file-open dialog's localized refusal, and the native gating of the delivered-file prose vocabulary. No wire-type, persistence, or activation-policy changes.

## Problem

A headless deployment still accepted file-open clicks: `session/openWorkspacePath` ran the platform opener regardless of the deployment's own `canOpenWorkspacePath()` probe, so a Host with no display server and no MIME handler spawned `xdg-open`, which failed and relayed a multi-line `no "view" rule for type "text/markdown"` dump into the Chat file-open dialog. The capability probe existed — the produced-files row already uses it to gate **Show in folder** — but the open RPC never consulted it.

A second surface had the same defect from the other side. A `present` tool delivery reaches the closing prose as a file mention whose gesture runs `presentedOpen.open()`, POSTing `/api/present.open`; that route carries upstream's own `workspaceDesktop().available` check and answers **409** on a Host without a desktop. Its card disables the menu in that state, but the prose mention had no guard, so every click on a delivered file printed a 409 and opened nothing.

## Decision

**The gate the capability advertises now also guards the operation.** `openWorkspacePath` checks `canOpenPath()` (the same `nativeOpen` config / injected opener / platform probe the Client can query) after the abort check and fails fast with the existing error vocabulary: `internal` / `path open failed: desktop unavailable`. The Host never spawns a platform opener it knows cannot reach a desktop. The Chat open face treats that refusal as "no native opener here" and takes the official Sidebar's session-scoped resource address instead (the better-sidebar routing below claims it first when the plugin is installed); other failures keep relaying the wire reason.

**Core file surfaces route through the better-sidebar editor when it is installed.** The third-party `dsh-better-sidebar` plugin already intercepts the produced-files chips and opens them in its sidebar editor; the core surfaces (inline mentions, tool-row paths, generic file cards) still hit the Host opener, which is exactly the surface a headless deployment cannot serve. The Chat open face now prefers that plugin's service — a structural `ctx.get('betterSidebar')` `openTab` duck check, no package dependency — and opens `{ type: 'editor', title: basename, path: absolute, id: 'editor:<absolute>' }`; the native opener remains the fallback for plugin-less profiles and for folder reveals (`.` carries no editor file).

**A delivered file's prose mention is native-gated and falls back to the Chat opener.** The mention vocabulary the deliverables plugin publishes (`chatFileMentions`) is wrapped by the fork module's `nativeGatedMentions` in `src/client/chat/fork/open-file-routing.ts`: the gesture first asks `ctx.remote.session.canOpenWorkspacePath()`, keeps the vocabulary's own native path when the probe reports a desktop, and otherwise routes the path through the owner's `openFile` — the Chat view's own gesture path, which owns the busy state and the localized failure dialog — so a headless deployment opens the delivered file in the sidebar editor exactly like every other core surface. A rejected probe reads as unavailable: the path must open somewhere, and a probe error cannot prove a desktop. The wrapper preserves the vocabulary's label and title, and an unresolved token stays inert.

**The probe and the refusing route ask different predicates.** The client asks `canOpenWorkspacePath()` (`canOpenPath()`), while `/api/present.open` refuses on `workspaceDesktop().available` (`nativeFileManager() !== null && canOpenPath()`). They disagree only where no native file manager exists — outside darwin/win32/linux — while an injected opener or `nativeOpen: true` forces `canOpenPath()` true: there the mention keeps its native gesture and the route still refuses. Session-free availability has no narrower query, and the gap needs a hand-configured opener on an unsupported platform, so the gate takes the cardinality mismatch rather than inventing a second probe.

## Consequences

- Clicking a file on this deployment now opens the sidebar editor when better-sidebar is present, and shows one localized sentence instead of the `xdg-open` dump when it is not — for delivered-file prose mentions as well as produced-file chips.
- `canOpenWorkspacePath()` and `openWorkspacePath` can no longer disagree: the operation refuses exactly when the probe reports `false`, and the probe still reports `true` for injected openers (tests pin both).
- Deployments that keep `nativeOpen: true` while their platform opener is broken still relay the platform's own failure text.
- `workspaceDesktop().available` false remains upstream's 409 answer on `/api/present.open`; the client no longer reaches it from prose, and the deliverables card keeps its own disabled menu.
- A failed fallback open reaches the user through the Chat view's failure dialog: the wrapper calls the owner's opener rather than the raw inject-face closure.

## Alternatives considered

- **Return `{ opened: false }` like the settings controller's directory open** — silent for the user; the dialog's retry/close conversation and the failure vocabulary already exist, so a refusal reads better than a no-op.
- **Client-side capability pre-check before every click** — duplicates the Host's single source of truth and races the probe; the RPC gate is the enforcement point, the Client only localizes the refusal.
- **Re-intercept the turn-tail in a fork plugin instead of patching `ui-chat`** — the inline mentions and tool-row paths never flow through the turn-tail chain, so a fork plugin could not reach them; the `openFile` closure is the single funnel every core surface shares.
- **Gate the mention inside `ui-deliverables`'s `forClosing` (an upstream file)** — that opens a new tier C fork row re-applied at every sync, and the answer is available without it: `canOpenWorkspacePath()` is the upstream probe that reports native-opening availability without addressing a Session, and `ui-chat`'s mention seat already sits in this note's fork row.
- **Serve the file content over HTTP for remote previews** — the 2026-07-31 workspace-file-links decision ruled this out of scope and retired the built prototype; not revisited here.
