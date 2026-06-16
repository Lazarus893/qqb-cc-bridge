# Troubleshooting

## "extension not connected — open the QQB extension popup…"

Cause: bridge daemon is running but the extension hasn't authenticated.

Fix steps:
1. Confirm daemon is running:
   ```bash
   pgrep -fl 'qqb-cc-bridge.*src/index.js' || pgrep -fl 'projects/qqb-cc-bridge/src/index.js'
   ```
   If not, start it: `node ~/projects/qqb-cc-bridge/src/index.js`
2. Read the token:
   ```bash
   cat ~/.qqb-cc-bridge/token
   ```
3. Open the QQ Browser extension popup, paste the token, click "save & reconnect".
4. The dot in the popup should turn green.
5. Verify from CC: `qqb ping --pretty` → `extensionConnected: true`.

## "no active tab; specify tabId" or list_tabs returns no `attached` tabs

Cause: the user hasn't clicked "接管当前页" in the popup. Without that, the
extension doesn't attach `chrome.debugger`, so AX tree can't be read.

Fix: tell the user. Do not silently call `takeover`.

## "Cannot attach to this target" when attaching debugger

Common causes:
- The tab is at a `qqbrowser://` internal URL — not allowed.
- DevTools is already open on that tab — close DevTools first.
- The page is in a closed/discarded state — focus the tab in the browser
  first, then retry.

The popup also yields a Chrome native banner ("此扩展程序正在调试此标签页")
while attached. That's required UX; it can't be suppressed.

## AX tree returns very few / mostly `generic` nodes

Causes (in order of likelihood):
1. **The page just loaded** — try `qqb wait --idle 800` before snapshot.
2. **Heavy canvas-based UI** (e.g. design tools) — fall back to `qqb read`
   or, last resort, `qqb exec '<expr>'`.
3. **Cross-origin iframe** containing the actual content — current MVP only
   reads the main frame. M6 will add per-frame snapshot.
4. **Page uses non-semantic divs everywhere** — call `qqb snapshot --mode mixed`
   (when implemented) for a DOM fallback.

## "unknown nodeRef \"nX\""

Cause: you're using a nodeRef from an old snapshot. Refs are valid only
against the most recent snapshot of that tab.

Fix: call `qqb snapshot` again, then re-derive the ref by `role + name`.

## click / type doesn't seem to do anything

Possible causes:
1. **Element is offscreen and `scrollIntoView` failed** — try
   `qqb scroll --ref nX` first, then click.
2. **The element is covered by a fixed nav/banner** — scroll up or close the
   banner first.
3. **The site checks `event.isTrusted`** — bridge already uses CDP synthetic
   events which set isTrusted to true. If a site still rejects it, that's
   a bot-detection layer — not solvable from the extension side.
4. **Login pages with 行为验证 (slider captcha, click captcha)** — abort
   automation; ask the user to solve manually.

## type lands the wrong characters / IME issues

The bridge uses `Input.insertText` rather than per-key events for the main
text path. This bypasses IME entirely — the literal string you pass is what
appears. If you're typing Chinese: just pass it as text, don't try to
simulate Pinyin keystrokes.

## wait --idle returns immediately on a busy page

`--idle` waits for `MutationObserver` quiet for the requested ms. Pages with
constantly-running animations (clock, ticker) will never quiet. For those,
use `qqb wait --url-matches "..."` or `qqb wait --selector "..."`.

## Bridge daemon crashed / port 9528 in use

Check what's holding the port:
```bash
lsof -i :9528
```
If it's a stale daemon, kill it:
```bash
kill <pid>
```
Then restart. The token persists in `~/.qqb-cc-bridge/token`, so the
extension stays authenticated.

## "qqb-cc-bridge daemon not running at ws://127.0.0.1:9528"

The CLI couldn't open the WS connection. Either:
- Daemon isn't running — `node ~/projects/qqb-cc-bridge/src/index.js`
- Daemon is on a non-default port — `QQB_BRIDGE_URL=ws://127.0.0.1:NNNN qqb ...`

## How to restart everything cleanly

```bash
# 1. Kill bridge
pkill -f 'qqb-cc-bridge.*src/index.js'

# 2. Restart bridge (keep terminal open)
node ~/projects/qqb-cc-bridge/src/index.js

# 3. In QQ Browser: open extension popup → "reconnect"

# 4. Verify
qqb ping --pretty
```

Token doesn't need re-pasting unless `~/.qqb-cc-bridge/token` was deleted.
