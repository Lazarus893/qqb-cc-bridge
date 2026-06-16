# qqb-cc-bridge

Local bridge between the QQ-Browser extension and Claude Code's MCP layer.

```
                                              ┌──────────────────────────┐
                                              │ daemon (long-lived)      │
┌────────────────────────┐  WebSocket         │ src/index.js             │  spawned per CC session
│ QQB extension (MV3)    │ ───────────────►   │   ├─ WS server :9528     │ ◄────────────────────────┐
│ chrome.debugger + CDP  │                    │   └─ tab/event hub       │                          │
└────────────────────────┘                    └────────────▲─────────────┘                          │
                                                           │ WebSocket as 'mcp-client'              │
                                                           │                                        │
                                                ┌──────────┴──────────┐  MCP stdio  ┌──────────────┴──────┐
                                                │ src/mcp-client.js   │ ──────────► │ Claude Code session │
                                                └─────────────────────┘             └─────────────────────┘
```

There are **two entrypoints**:

- **`src/index.js`** — long-lived daemon. Run it once per machine. Owns WS port 9528 and stays connected to the QQ Browser extension across CC sessions.
- **`src/mcp-client.js`** — thin MCP-over-stdio proxy that CC spawns per session. Connects to the daemon as a `mcp-client` and forwards tool calls.

This split means: the extension authenticates **once** (when you boot the daemon), and any number of CC sessions can attach to it.

## Run

### One-time: install deps

```bash
cd ~/projects/qqb-cc-bridge
npm install
```

### Start the daemon (run when you boot, leave running)

```bash
node ~/projects/qqb-cc-bridge/src/index.js
```

First boot prints a token to stderr and writes it to `~/.qqb-cc-bridge/token`. Paste it into the extension popup.

### Add to Claude Code config

In `~/.claude.json` or your project `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "qqb-cc-bridge": {
      "command": "node",
      "args": ["/Users/<you>/projects/qqb-cc-bridge/src/mcp-client.js"]
    }
  }
}
```

Note `mcp-client.js`, not `index.js`. CC spawns the proxy; the daemon must already be running.

## Tools exposed

All under `qqb.*` namespace:

| tool | purpose |
|---|---|
| `qqb.ping` | health check, no extension needed |
| `qqb.list_tabs` | enumerate browser tabs |
| `qqb.snapshot` | read the AX tree of a tab |
| `qqb.read_text` | reader-mode body text |
| `qqb.click` | click by nodeRef |
| `qqb.type` | type into input by nodeRef |
| `qqb.scroll` | scroll viewport / element into view |
| `qqb.navigate` | drive a tab to a URL |
| `qqb.wait_for` | wait for idle / url change / selector / etc. |
| `qqb.exec_js` | escape hatch — evaluate JS |

See `~/.claude/skills/qqb-bridge/SKILL.md` for usage patterns.

## Wire protocol (extension ↔ bridge)

JSON over WS, both directions:

| message | direction |
|---|---|
| `{type:'auth', token}` | ext → bridge (first message) |
| `{type:'auth-ok'}` | bridge → ext |
| `{id, type:'request', method, params}` | bridge → ext |
| `{id, type:'response', result\|error}` | ext → bridge |
| `{type:'event', event, data}` | ext → bridge (push) |

`method` is the internal extension method (e.g. `snapshot`, `click`); it's not
the MCP tool name. The bridge translates `qqb.snapshot` → `snapshot`, etc.

## Layout

```
src/
├── index.js              # daemon entry — long-lived; owns WS server
├── mcp-client.js         # MCP proxy entry — spawned by CC per session
├── log.js                # stderr logger (stdout is MCP)
├── auth.js               # token persistence
├── ws/server.js          # WS server, request/response/event hub
├── mcp/server.js         # MCP stdio server (used by --with-mcp single-process mode)
└── tools/
    ├── index.js          # registry
    ├── ping.js
    ├── list-tabs.js
    ├── snapshot.js
    ├── read-text.js
    ├── click.js
    ├── type-text.js
    ├── scroll.js
    ├── navigate.js
    ├── wait-for.js
    └── exec-js.js
```
