# QQB-CC Bridge — QQ Browser extension

MV3 extension that exposes the active QQ Browser tab to a local bridge daemon
over WebSocket, so Claude Code can read its accessibility tree and drive
interactions via CDP.

## Install

1. Open `qqbrowser://extensions`.
2. Toggle **开发者模式** (developer mode).
3. Click **加载已解压的扩展程序** and pick this directory.
4. Click the extension icon → popup.
5. Paste the token from the bridge daemon (`~/.qqb-cc-bridge/token`) and
   click **save & reconnect**. The dot should turn green.
6. On any tab you want CC to control, click **接管当前页**.

QQ Browser will show a yellow banner saying "此扩展程序正在调试此标签页"
on attached tabs. That's required by Chromium and can't be suppressed.

## Permissions

| permission | why |
|---|---|
| `debugger` | attach CDP — get AX tree, dispatch input events |
| `tabs` | enumerate tabs |
| `scripting` | reserved fallback channel (M6) |
| `activeTab` | resolve "current tab" without per-tab prompts |
| `storage` | persist bridge URL + token |
| `<all_urls>` host | required for `chrome.debugger` to attach to any site |

## Layout

```
manifest.json
background.js            # service worker — routes WS requests
lib/
├── ws-client.js         # WS connection w/ backoff reconnect
├── ax-tree.js           # AX tree fetch + compaction + nodeRef assignment
└── interact.js          # debugger lifecycle + click/type/scroll/navigate/wait/exec
popup/
├── popup.html
└── popup.js             # connection settings + tab takeover UI
content/
└── inspector.js         # reserved (not used yet)
icons/
└── icon{16,48,128}.png
```

## Notes / known limits (MVP)

- Single extension client at a time. Latest WS connection wins.
- Main frame only — cross-origin iframes not snapshotted yet (M6).
- `mode:'mixed'` and `mode:'text'` for snapshot are accepted but currently
  behave like `'ax'` (M6 will diverge them).
- `chrome.debugger` cannot attach to `qqbrowser://` or `chrome://` pages.
