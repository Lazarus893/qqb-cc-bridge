# qqb-cc-bridge

> Drive **QQ Browser** from **Claude Code**. Read pages via the Accessibility Tree, click & type via CDP, screenshot on demand.

```
Claude Code  ⟶  Bash CLI (qqb)  ⟶  WebSocket  ⟶  Daemon  ⟶  WebSocket  ⟶  QQ Browser Extension  ⟶  CDP
                                       :9528                                    chrome.debugger
```

Three pieces, one repo:

| dir | what |
|---|---|
| [`bridge/`](./bridge) | Long-lived Node.js daemon + `qqb` CLI. Owns `ws://127.0.0.1:9528`. |
| [`extension/`](./extension) | Manifest V3 extension. Talks to the daemon over WS, drives the active tab via Chrome DevTools Protocol. |
| [`skill/`](./skill) | Claude Code Skill — usage docs + recipes that teach Claude how to compose `qqb` calls. |

## What can it do

- **Read pages** — `qqb snapshot` returns a folded accessibility tree with stable `nodeRef`s instead of CSS selectors
- **Click / type / scroll** — CDP synthetic input events (`isTrusted: true`), so login forms don't reject them
- **Navigate / wait** — drive a tab to a URL; wait on idle / url-change / selector
- **Read article text** — reader-mode body text, cheaper than full snapshot
- **Screenshot** — viewport / full page / single element. Writes a PNG to `/tmp/qqb-screenshots/`, returns just the path so it doesn't blow up the LLM context.
- **Escape hatch** — `qqb exec '<expr>'` for things AX truly can't answer (canvas, computed style, app internal state)

The Skill teaches Claude: snapshot first → reason about role+name → click by nodeRef → re-snapshot → screenshot only when AX is insufficient.

## Quick start

### 1. Install + run the daemon

```bash
cd bridge
npm install
node src/index.js          # leave running; first boot prints + saves the auth token
```

The daemon writes a token to `~/.qqb-cc-bridge/token`. Keep it; you'll paste it into the extension.

Optional: symlink the CLI onto your PATH.

```bash
ln -s "$PWD/bin/qqb.js" ~/.local/bin/qqb
```

### 2. Load the extension into QQ Browser

1. `qqbrowser://extensions` → 开发者模式 → 加载已解压的扩展程序
2. Pick the `extension/` directory in this repo
3. Click the extension icon → popup
4. Paste the token from `~/.qqb-cc-bridge/token`, click **save & reconnect** — the dot turns green
5. On the tab you want Claude to control, click **接管当前页** (this attaches `chrome.debugger`; QQ Browser will show its standard yellow consent bar)

### 3. Wire the Skill into Claude Code

```bash
mkdir -p ~/.claude/skills
cp -r skill ~/.claude/skills/qqb-bridge
```

### 4. Try it

```bash
qqb ping --pretty
qqb tabs --refresh true --pretty
qqb snapshot --pretty | jq '{title, url, nodeCount}'
qqb screenshot --pretty
```

In Claude Code, say:

> 用 qqb 看一下当前页面，先 ping 再 tabs 再 snapshot

## Why a CLI instead of MCP?

The first version of this project was an MCP server. Two problems:

1. Each Claude Code session had to spawn its own MCP process — and they fought over port `9528`. Splitting into "daemon + per-session MCP proxy" added a layer.
2. MCP tool schemas don't compose with shell tools (`jq`, redirects, pipes). For ad-hoc browser driving, that's a real loss.

So now: one long-lived daemon, one Bash CLI, the Skill teaches Claude how to compose them. Output is always JSON on stdout — pipe it through `jq` when you need a slice.

## Architecture

```
                                          ┌──────────────────────────┐
                                          │ daemon (long-lived)      │
                                          │ src/index.js             │
                                          │   ├─ WS server :9528     │
                                          │   └─ tab/event hub       │
                                          └────────────▲─────────────┘
                                                       │ WS
                                                       │
        ┌──────────────────────────┐                   │                   ┌────────────────────────┐
        │ QQ Browser extension     │ ◄─────────────────┼──────────────────►│ bin/qqb.js (CLI)       │
        │ chrome.debugger + CDP    │                   │                    │ Auth → 1 request →    │
        │ background.js + lib/*    │                   │                    │ JSON to stdout        │
        └────────────▲─────────────┘                   │                    └─────────▲──────────────┘
                     │                                                                │ Bash
                     │ chrome.debugger.attach (user gesture in popup)                 │
                     ▼                                                                │
              ┌──────────────────┐                                              ┌─────┴───────────────┐
              │ Active tab       │                                              │ Claude Code session │
              │ AX tree, DOM     │                                              │ (Skill: qqb-bridge) │
              └──────────────────┘                                              └─────────────────────┘
```

## How page info is captured

Three channels, in order of preference:

1. **AX tree** (main path) — `chrome.debugger` + `Accessibility.getFullAXTree`, then folded into a token-friendly tree with stable `nodeRef`s. Covers ~70% of real pages.
2. **DOM `innerText`** — `qqb read`, reader-mode body text. For pure article-style reads.
3. **Screenshot** — `qqb screenshot`, CDP `Page.captureScreenshot`. Covers the visual gap (canvas apps, icon-only buttons, layout/overlap, error states).

CDP gives back base64; the CLI writes it to disk and returns just the path so multi-MB images don't end up in the LLM's context window.

## Tools exposed by the CLI

```
qqb ping                          Health check.
qqb tabs                          List browser tabs.
qqb snapshot                      AX tree of a tab.
qqb read                          Reader-mode text.
qqb screenshot                    PNG/JPEG of viewport / full page / element.
qqb click  <nodeRef>              Click by nodeRef from a recent snapshot.
qqb type   <nodeRef> --text "…"   Type into an input.
qqb scroll                        Scroll viewport / element into view.
qqb navigate <url>                Drive a tab to a URL.
qqb wait                          Wait for idle / url change / selector / etc.
qqb exec   '<expression>'         ESCAPE HATCH — eval JS in the tab.
qqb takeover                      Attach chrome.debugger (USER gesture; don't auto-call).
qqb release                       Detach debugger.
```

Run `qqb --help` for the full flag set.

## Wire protocol

JSON over WebSocket, both directions:

| message | sender → receiver | when |
|---|---|---|
| `{type:'auth', token, role}` | client → daemon | first message; role ∈ `extension` \| `mcp-client` |
| `{type:'auth-ok'}` | daemon → client | handshake complete |
| `{id, type:'request', method, params}` | mcp-client → daemon → extension | tool call |
| `{id, type:'response', result \| error}` | extension → daemon → mcp-client | reply |
| `{type:'event', event, data}` | extension → daemon → all mcp-clients | tab list pushes etc. |

## Permissions

The extension requests:

| permission | why |
|---|---|
| `debugger` | the only way to read AX tree + dispatch trusted input events |
| `tabs` | enumerate tabs |
| `scripting` | reserved fallback channel |
| `activeTab` | resolve "current tab" without per-tab prompts |
| `storage` | persist bridge URL + token |
| `<all_urls>` host | required for `chrome.debugger` to attach to any site |

`chrome.debugger.attach` requires explicit user consent every time (the yellow banner). The Skill never auto-attaches — `takeover` is reserved for popup buttons.

## Limitations

- **Single extension client** — latest WS connection wins.
- **Main frame only** — cross-origin iframes not snapshotted yet.
- **`chrome.debugger` cannot attach** to `qqbrowser://` or `chrome://` pages.
- **No captcha / 行为验证** — bot-detection layers that go beyond `isTrusted` are out of scope.
- **No Shadow DOM closed-root** support.
- **Token in plain text** at `~/.qqb-cc-bridge/token` (mode 0600). Local-only by design — daemon binds to `127.0.0.1`.

## License

MIT

## Project status

MVP. Working end-to-end for the AX-driven workflow + screenshots. Future work: cross-frame snapshots, DOM-mode fallback for non-semantic sites, Windows / Linux extension testing.
