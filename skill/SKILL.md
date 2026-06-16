---
name: qqb-bridge
description: Drive QQ Browser from Claude Code via the Accessibility Tree — read pages, click, type, navigate. Triggers on "QQ浏览器", "qqb", "读一下当前页面", "帮我在浏览器里…", "browser bridge", "qqb-bridge".
---

# qqb-bridge — control QQ Browser from Claude Code

This skill drives the **qqb-cc-bridge** daemon through a single Bash CLI:
**`qqb`**. No MCP layer involved — every action is one shell command, every
output is JSON on stdout.

```
Bash:  qqb <command> [args] [--flags]
       └─ WebSocket → daemon (ws://127.0.0.1:9528) → QQ Browser extension → AX tree / CDP input
```

## Pre-flight (run this once at the top of any qqb session)

```bash
qqb ping --pretty
```

Returns:

```json
{
  "ok": true,
  "daemonReachable": true,        // WS daemon answers
  "extensionConnected": true,     // extension is authed to the daemon
  "anyTabAttached": false,        // at least one tab has chrome.debugger
  "tabs": 5
}
```

Three failure modes to disambiguate:

- **`daemonReachable:false`** → the long-lived daemon isn't running. Tell the user:

  > 桥接器 daemon 没跑起来。请在 terminal 跑：
  > ```
  > node ~/projects/qqb-cc-bridge/src/index.js
  > ```
  > 跑起来再让我继续。

- **`daemonReachable:true, extensionConnected:false`** → daemon is up but the QQ Browser extension isn't connected. Tell the user:

  > Daemon 在跑，但 QQ 浏览器扩展没连上。请：
  > 1. 打开 QQ 浏览器，点扩展图标弹 popup
  > 2. 粘贴 `~/.qqb-cc-bridge/token` 里的 token，点 save & reconnect
  >
  > 弄完告诉我。

- **`extensionConnected:true, anyTabAttached:false`** → extension's there, but no tab has been "接管" (debugger attached) yet. List tabs and ask the user to take over the right one:

  ```bash
  qqb tabs --pretty
  ```

  > 扩展连上了。请在 popup 里挑一个 tab 点 "接管当前页"（debugger 接管会有一个黄色提示条，正常）。
  > 接管哪个？

  Do **not** call `qqb takeover` yourself — that pops the user's browser without consent.

- **`anyTabAttached:true`** → ready to go.

## Core workflow

```
qqb tabs  →  qqb snapshot  →  reason about tree  →  qqb click/type/scroll
                ↑                                              │
                └──── re-snapshot after every action ──────────┘
```

### 1. snapshot is the canonical "see the page" call

```bash
qqb snapshot --pretty
qqb snapshot --tab 1715533381 --pretty
qqb snapshot --maxNodes 400          # smaller, for token budget
```

Returns a compacted accessibility tree:

```yaml
tabId: 12
url: https://example.com/login
title: 登录
etag: "1k2x9p"
nodeCount: 47
truncated: false
tree:
  - role: heading
    name: "欢迎登录"
    level: 1
  - role: textbox
    name: "用户名"
    nodeRef: n3            # ← use this with click/type
    value: ""
  - role: textbox
    name: "密码"
    nodeRef: n4
  - role: button
    name: "登录"
    nodeRef: n5
```

**Read the tree like accessible markup**, not like a DOM. `role + name`
identifies what to click; `nodeRef` is the handle.

### 2. Re-snapshot after every interaction

`nodeRef`s are scoped to **the most recent snapshot of that tab**. After a
click/type, the tree may have changed (form revealed, redirect, disabled
state, modal). Always:

```bash
qqb click n5
qqb wait --idle 500          # or --url-changes, --selector, etc.
qqb snapshot --pretty        # fresh nodeRefs
```

Reusing a stale ref → daemon throws `unknown nodeRef "nX"` — that's the
contract telling you to re-snapshot.

### 3. Use `qqb wait`, not `sleep`

```bash
qqb wait --idle 500                          # DOM quiet for 500ms — generic post-click settle
qqb wait --url-changes "https://old.url"     # navigation happened
qqb wait --url-matches "/dashboard"          # URL matches regex
qqb wait --selector ".loaded"                # element appeared
qqb wait --no-selector ".spinner"            # loading state finished
qqb wait --idle 500 --timeoutMs 15000        # custom timeout
```

Default `--timeoutMs 10000`.

### 4. Don't reach for `qqb exec`

Order of preference:
1. `qqb snapshot` — the AX tree already says role + name + state
2. `qqb read` — for "what does this article say"
3. `qqb screenshot` — for visual questions (canvas, icons-without-labels,
   "is this thing red", layout/overlap, "show me the page")
4. `qqb exec '<expr>'` — only for things AX/visual truly cannot answer
   (computed style, application-internal state, programmatic inspection)

The CLI labels `exec` as ESCAPE HATCH; honor it.

### 5. When to use `qqb screenshot`

Use it when **the AX tree won't tell you what the user actually sees**:

| trigger | example |
|---|---|
| Canvas / WebGL UI | Figma, design tools, video editors, maps, charts |
| Icon-only buttons with no aria-label | toolbar icons, kebab menus |
| Visual state matters | "is the toggle on?", "is this row highlighted?", error red borders |
| Layout / overlap questions | "is the modal covering the form?" |
| User says "看下这页长啥样" / "give me a picture" | obvious |
| Verifying a click landed | snapshot says you're on /dashboard but the page is half-broken — screenshot proves it |

**Don't** use it as the default — AX tree is far cheaper in tokens. Default
to snapshot, fall back to screenshot when snapshot returns suspiciously
little or the question is inherently visual.

The default flow writes a PNG to `/tmp/qqb-screenshots/` and returns just
the path + dimensions. The image isn't in stdout, so it doesn't blow up
context. Pass the path to Claude as a multimodal attachment when you want
it analyzed.

```bash
qqb screenshot                              # viewport, default
qqb screenshot --fullPage                   # whole document (long pages)
qqb screenshot --ref n5                     # just one element by nodeRef
qqb screenshot --format jpeg --quality 70   # smaller file for big pages
qqb screenshot --out /tmp/before.png        # explicit path
```

## Commands cheat-sheet

| command | shape |
|---|---|
| `qqb ping [--pretty]` | health check |
| `qqb tabs [--refresh] [--pretty]` | list tabs |
| `qqb snapshot [--tab N] [--mode ax\|text\|mixed] [--maxNodes N] [--pretty]` | AX tree |
| `qqb read [--tab N] [--selector CSS] [--pretty]` | reader-mode text |
| `qqb screenshot [--tab N] [--fullPage] [--ref nX] [--format png\|jpeg] [--quality N] [--scale N] [--out PATH] [--base64]` | capture image (writes PNG/JPEG to /tmp by default) |
| `qqb click <nodeRef> [--tab N] [--button left\|right\|middle] [--clickCount N]` | click |
| `qqb type <nodeRef> --text "value" [--tab N] [--clear true\|false] [--submit true\|false]` | type |
| `qqb scroll [--tab N] [--ref nX] [--direction up\|down\|top\|bottom] [--pages N]` | scroll |
| `qqb navigate <url> [--tab N] [--waitUntil load\|domcontentloaded\|networkidle] [--newTab]` | go to URL |
| `qqb wait --idle MS \| --url-changes [FROM] \| --url-matches PATTERN \| --selector SEL \| --no-selector SEL [--timeoutMs MS]` | wait for condition |
| `qqb exec '<expression>' [--tab N] [--awaitPromise true\|false]` | escape-hatch JS |
| `qqb pulse [--label TEXT] [--duration MS] [--stop] [--destroy]` | manually trigger / clear the breathing overlay (cosmetic) |
| `qqb pulse [--label TEXT] [--duration MS] [--stop] [--destroy]` | manually trigger / clear the breathing overlay (cosmetic) |
| `qqb takeover [--tab N]` | attach debugger (USER GESTURE — don't call without explicit consent) |
| `qqb release [--tab N]` | detach debugger |

Global flags: `--pretty` (indented JSON), `--timeoutMs N`, `--tab N`.
Output: always JSON to stdout, exit 0 on success / non-zero on error.
Override daemon URL with `QQB_BRIDGE_URL=ws://...`.

## Breathing overlay (visual feedback)

Every action — snapshot, click, type, screenshot, etc. — automatically
shows a soft cyan glow pulsing along the viewport edges + a label pill in
the top-right corner naming the action ("qqb · click n5", "qqb · reading
page"). This is Atlas-style visual feedback so the human watching the
browser always knows the agent is touching the page.

You don't need to do anything special — it happens for free. Two cases
where you *might* call it explicitly:

```bash
# Demo / get the user's attention before doing something
qqb pulse --label "qqb · about to delete this row" --duration 3000

# Force-clear an overlay (rare — auto-hide handles it)
qqb pulse --stop
```

The overlay is purely cosmetic — never blocks pointer events, never
appears in screenshots you take of the page (well, it does, since it's
in the page; if you need a clean screenshot, `qqb pulse --stop` first).

When summarizing a page back to the user, do **not** dump the full tree —
it's noise. Pick:

- **Page identity**: `title`, `url`
- **Primary action surface**: list of interactive nodes with `name + role`
- **Anything the user asked about specifically**

Example summary back to the user:

> 当前页是「example.com 登录页」。看到三个交互元素：
> - 用户名 textbox
> - 密码 textbox
> - 登录 button
>
> 是否要我填入账号 alice 并登录？

To trim the snapshot before reading it yourself, pipe through `jq`:

```bash
qqb snapshot | jq '{title, url, nodeCount, interactive: [..|objects|select(.nodeRef)|{role,name,nodeRef,value}]}'
```

## Common recipes

See `references/interaction-recipes.md`:
- 登录 / 搜索 / 表单填充
- SPA "等接口返回再做下一步"
- 多步表单（分页 wizard）
- 弹窗 / Modal 处理

## Anti-patterns

❌ **Calling `qqb exec` to scrape data** — almost always means you skipped
   `qqb snapshot`. Snapshot first.

❌ **Looping snapshot on a timer** — wasteful. Snapshot is on-demand; use
   `qqb wait` between actions instead.

❌ **Building selectors from `qqb snapshot` output** — there are no
   selectors in there, only `nodeRef`. If you want a selector, you've
   already lost.

❌ **Calling `qqb takeover` / `qqb release` programmatically** — that's the
   user's consent gesture in the popup. Skill won't do it for them.

❌ **Dumping the full tree to the user** — summarize, then offer to drill in.

❌ **Treating the JSON output as opaque text** — it's JSON. Pipe through
   `jq` when you only need a slice.

## Troubleshooting

See `references/troubleshooting.md`:
- "extension not connected" 怎么办
- DevTools 抢占 debugger
- AX tree 在某些 SPA 页面节点很少 / 全是 generic
- iframe 跨域
- daemon 死了怎么重启

## File layout (for reference)

```
~/projects/qqb-cc-bridge/                  # daemon + CLI (Node.js)
~/projects/qqb-cc-bridge/bin/qqb.js        # ← the CLI this skill uses
~/.local/bin/qqb                           # symlink (on PATH)
~/projects/qqb-cc-bridge-extension/        # the QQ Browser extension (MV3)
~/.claude/skills/qqb-bridge/SKILL.md       # this file
~/.claude/skills/qqb-bridge/references/    # deep-dive docs
~/.qqb-cc-bridge/token                     # auth token (chmod 600)
```
