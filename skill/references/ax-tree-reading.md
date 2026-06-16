# Reading the AX-tree snapshot

`qqb snapshot` returns a tree designed to be **read by you, the LLM**, not
parsed mechanically. This page documents what each field means and how to
reason from it.

## Top-level fields

| field | meaning |
|---|---|
| `tabId` | numeric id; pass via `--tab N` to subsequent calls if not the active tab |
| `url`, `title` | identity — useful for `qqb wait --url-changes` |
| `etag` | hash of the tree; if it didn't change after a click, the page didn't change either |
| `nodeCount` | how many surviving nodes |
| `truncated` | true if `--maxNodes` was hit — request a smaller scope or scroll |
| `tree` | array of root-level nodes |

## Per-node fields

| field | meaning | example |
|---|---|---|
| `role` | ARIA role | `button`, `textbox`, `link`, `heading` |
| `name` | accessible name (from `aria-label`, label, alt, text content) | `"登录"` |
| `value` | current value (for inputs) | `"alice"` |
| `level` | heading level (only on `heading`) | `1` |
| `disabled` | only present if `true` | `true` |
| `checked`, `expanded` | for stateful widgets | |
| `url` | for links | |
| `nodeRef` | the only thing you pass to click/type/scroll | `"n10"` |
| `children` | nested array, same shape | |

## What's NOT in the tree

- **CSS selectors / xpath** — the bridge intentionally hides them.
- **Pixel positions** — handled internally for `click`; you don't need them.
- **Inner HTML** — only accessible name + value. Use `qqb read` for body copy.
- **Aria-hidden / presentation-only nodes** — they're stripped during compaction.

## Compaction rules (so you can predict what's missing)

1. Roles in `{generic, none, presentation, GenericContainer, …}` are stripped
   unless they have a meaningful name. Children get hoisted up.
2. `ignored:true` nodes are descended through.
3. Names/values truncated to ~200 chars with a `…` suffix.
4. Hard cap on total nodes (default 800). When hit, `truncated:true`.

If a page looks emptier than you expected (e.g. "where's the login form?"),
the form might be inside an iframe (not in the main tree by default) or
rendered in a canvas. Try `qqb read` or `qqb exec '<expr>'` as fallbacks.

## A concrete example

Suppose you snapshot a Bilibili video page. You'll typically see:

```yaml
tree:
  - role: banner
    children:
      - role: link
        name: "首页"
        nodeRef: n0
        url: /
      - role: searchbox
        name: "搜索"
        nodeRef: n1
  - role: main
    children:
      - role: heading
        name: "<视频标题>"
        level: 1
      - role: button
        name: "点赞"
        nodeRef: n5
        checked: false
      - role: button
        name: "投币"
        nodeRef: n6
      …
```

To "搜索 xxx 视频"，your move is:
```bash
qqb type n1 --text "xxx" --submit true
qqb wait --url-changes "<previous url>"
qqb snapshot --pretty   # now you see search results
```

## Sanity checks before acting

Before clicking anything, confirm:
- Does the `name` actually match what the user wants?
  - "登录" vs "免费登录" vs "登录注册" — pick the right one.
- Is it `disabled:true`? Then you need to fill prerequisites first.
- Multiple nodes with the same name? Read the surrounding `children` to
  disambiguate (e.g. two "删除" buttons in a list — you want the one in the
  matching row).

If ambiguous, **ask the user** which one before firing the action.
