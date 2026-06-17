# Changelog

All notable changes to **qqb-cc-bridge** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In progress / planned:

- **Windows / Linux extension testing** — only validated on macOS QQ Browser so far.
- **`QQB_DRY_LOAD=1` guard in `bridge/src/index.js`** — to enable a real import-smoke test in CI (currently CI only runs `node --check` + `npm ci`).
- **Schema validation for `extension/manifest.json`** in CI (currently shape-only).

## [0.2.0] - 2026-06-17

### Added

- **Cross-frame iframe AX snapshots** (`extension/lib/ax-tree.js`) — `snapshot` now walks `Page.getFrameTree`, fetches `Accessibility.getFullAXTree` per child frame, and grafts each child frame's compacted tree under its owning Iframe-role node. Cross-origin frames that reject the call surface as `{role:'frame', name:'(unavailable)', frameId, error}` placeholders. Recursion capped at depth 3; `maxNodes` budget shared across the merged tree.
- **DOM-mode snapshot** (`--mode dom`) — walks `DOM.getDocument(depth:-1, pierce:true)` directly. Prefers `aria-label` / `aria-labelledby` for `name`; fetches `DOM.getBoxModel` only for interactive-ish tags to keep the cost down. Each emitted node still gets a stable `nodeRef` so `click` / `type` keep working regardless of mode.
- **`--mode mixed` snapshot** — runs AX first, then re-runs as DOM if the AX tree has fewer than 20 named nodes (`MIXED_FALLBACK_THRESHOLD`). Returns `mode: 'dom-fallback'` so the caller knows.
- **`extension/lib/cdp.js`** (new helper) — single `cdp(tabId, method, params, opts?)` wrapper around `chrome.debugger.sendCommand` with auto-retry on transient errors (`Internal error`, `-32603`, `Detached`, `Target closed`). On a transient failure: detach → 200 ms sleep → reattach → re-emit per-tab `*.enable` sequence → retry once. `interact.js`, `ax-tree.js`, and `overlay.js` all flow through it now.
- **`.github/workflows/ci.yml`** — minimal CI job that parse-checks every JS file under `bridge/`, `extension/`, `skill/` with `node --check`, validates `extension/manifest.json` MV3 shape, and runs `npm ci` in `bridge/`. Bonus `audit` job runs `npm audit --audit-level=high` warn-only.
- **Top-level `frames` count** in snapshot output — number of child frames successfully merged.

### Changed

- All CDP traffic in `interact.js` / `ax-tree.js` / `overlay.js` now routed through `lib/cdp.js`'s retry shim instead of calling `chrome.debugger.sendCommand` directly.
- `~/.claude/skills/qqb-bridge/SKILL.md` cheat-sheet: snapshot row advertises `--mode ax|dom|mixed` and auto-merged cross-frame iframes.

## [0.1.3] - 2026-06-17

### Added

- `bridge/bin/storyboard.sh` — scripted 6-scene demo runner that drives a real tab through clean → pulse → reading → click ripple → command timeline → clean again, capturing one frame per beat with backoff retry.
- `bridge/bin/build-demo.sh` — stitches captured frames into the 10-second `docs/qqb-demo.mp4` shown at the top of the README, with xfade crossfades between scenes.
- `bridge/bin/grab.js` — persistent-WS frame grabber that holds one connection open to fire screenshot requests faster than respawning `qqb` each time.
- `qqb screenshot --quiet` — skips the overlay pulse on the screenshot itself so the demo grabber doesn't steal focus from the action being captured.

`0176cb2 Add demo recording scripts + screenshot --quiet flag`

## [0.1.2] - 2026-06-16

### Added

- **Click ripple** — every CDP-synthesized click flashes a focused ring on the target nodeRef, so the human watching can see *exactly* what was clicked.
- **Command timeline** — recent `qqb` calls scroll up the side of the active tab as a tiny activity log.
- **Status palette** — overlay color reflects state (cyan = reading, green = success, amber = warning, red = error).
- `qqb screenshot --clean` — temporarily hides the breathing overlay during capture so archival screenshots aren't polluted by cosmetic UI.

`c5e24b0 Polish overlay: click ripple, command timeline, --clean, status colors`

## [0.1.1] - 2026-06-16

### Added

- **Atlas-style breathing overlay** — every `qqb` action automatically pulses a soft cyan glow + label pill on the active page. Makes "the agent is touching this" visible to the human watching.
- `qqb pulse` command — manual trigger / `--stop` / `--destroy` for the overlay (cosmetic; normally automatic).

`e2fb1ce Add breathing overlay for visible agent presence`

## [0.1.0] - 2026-06-16

Initial commit. End-to-end MVP: Claude Code can drive a QQ Browser tab through the AX tree + CDP synthetic input.

### Added

- **`bridge/`** — long-lived Node.js daemon owning `ws://127.0.0.1:9528`, plus the `qqb` Bash CLI (one-shot: auth → request → JSON to stdout → exit).
- **`extension/`** — Manifest V3 QQ Browser extension. Connects to the daemon over WS, attaches `chrome.debugger` on user gesture, proxies CDP calls back.
- **`skill/`** — Claude Code Skill (`qqb-bridge`) with usage docs + recipes that teach Claude how to compose `qqb` calls (snapshot → reason → click by nodeRef → re-snapshot).
- Tools exposed: `ping`, `tabs`, `snapshot`, `read`, `screenshot`, `click`, `type`, `scroll`, `navigate`, `wait`, `exec`, `takeover`, `release`.
- Token-based auth at `~/.qqb-cc-bridge/token` (mode 0600); daemon binds to `127.0.0.1` only.
- Screenshots written to `/tmp/qqb-screenshots/` with only the path returned, to keep multi-MB images out of the LLM context window.

`b7c0589 Initial commit: qqb-cc-bridge monorepo`

[Unreleased]: https://github.com/Lazarus893/qqb-cc-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lazarus893/qqb-cc-bridge/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Lazarus893/qqb-cc-bridge/commit/0176cb2
[0.1.2]: https://github.com/Lazarus893/qqb-cc-bridge/commit/c5e24b0
[0.1.1]: https://github.com/Lazarus893/qqb-cc-bridge/commit/e2fb1ce
[0.1.0]: https://github.com/Lazarus893/qqb-cc-bridge/commit/b7c0589
