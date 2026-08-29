# Agent Note: workspace path open refuses fast on hosts without a desktop opener

Status: implemented

English | [中文](2026-08-29-headless-path-open-refusal.zh.md)

> Scope: the `session/openWorkspacePath` RPC gate and the Chat file-open dialog's localized refusal. No wire-type, persistence, or activation-policy changes.

## Problem

A headless deployment still accepted file-open clicks: `session/openWorkspacePath` ran the platform opener regardless of the deployment's own `canOpenWorkspacePath()` probe, so a Host with no display server and no MIME handler spawned `xdg-open`, which failed and relayed a multi-line `no "view" rule for type "text/markdown"` dump into the Chat file-open dialog. The capability probe existed — the produced-files row already uses it to gate **Show in folder** — but the open RPC never consulted it.

## Decision

**The gate the capability advertises now also guards the operation.** `openWorkspacePath` checks `canOpenPath()` (the same `nativeOpen` config / injected opener / platform probe the Client can query) after the abort check and fails fast with the existing error vocabulary: `internal` / `path open failed: desktop unavailable`. The Host never spawns a platform opener it knows cannot reach a desktop. The Chat open face recognizes that refusal and throws the locale-owned `fileOpen.desktopUnavailable` copy instead of the wire message; other failures keep relaying the wire reason.

**Core file surfaces route through the better-sidebar editor when it is installed.** The third-party `dsh-better-sidebar` plugin already intercepts the produced-files chips and opens them in its sidebar editor; the core surfaces (inline mentions, tool-row paths, generic file cards) still hit the Host opener, which is exactly the surface a headless deployment cannot serve. The Chat open face now prefers that plugin's service — a structural `ctx.get('betterSidebar')` `openTab` duck check, no package dependency — and opens `{ type: 'editor', title: basename, path: absolute, id: 'editor:<absolute>' }`; the native opener remains the fallback for plugin-less profiles and for folder reveals (`.` carries no editor file).

## Consequences

- Clicking a file on this deployment now opens the sidebar editor when better-sidebar is present, and shows one localized sentence instead of the `xdg-open` dump when it is not.
- `canOpenWorkspacePath()` and `openWorkspacePath` can no longer disagree: the operation refuses exactly when the probe reports `false`, and the probe still reports `true` for injected openers (tests pin both).
- Deployments that keep `nativeOpen: true` while their platform opener is broken still relay the platform's own failure text.

## Alternatives considered

- **Return `{ opened: false }` like the settings controller's directory open** — silent for the user; the dialog's retry/close conversation and the failure vocabulary already exist, so a refusal reads better than a no-op.
- **Client-side capability pre-check before every click** — duplicates the Host's single source of truth and races the probe; the RPC gate is the enforcement point, the Client only localizes the refusal.
- **Re-intercept the turn-tail in a fork plugin instead of patching `ui-chat`** — the inline mentions and tool-row paths never flow through the turn-tail chain, so a fork plugin could not reach them; the `openFile` closure is the single funnel every core surface shares.
- **Serve the file content over HTTP for remote previews** — the 2026-07-31 workspace-file-links decision ruled this out of scope and retired the built prototype; not revisited here.
