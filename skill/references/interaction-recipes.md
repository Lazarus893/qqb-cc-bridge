# Interaction recipes

Drop-in patterns for common workflows. Each recipe shows the `qqb` CLI calls
you should produce; copy-adapt as needed. All commands print JSON to stdout —
parse with `jq` when you only need a slice.

## 1. Login a website

```bash
# 1. ensure tab is on the right page
qqb tabs --pretty
# pick the matching tab — say tabId=1715533381 — or navigate:
qqb navigate "https://example.com/login" --tab 1715533381 --waitUntil load

# 2. see the form
qqb snapshot --tab 1715533381 --pretty
# locate the textboxes by name (用户名/手机号/邮箱) and the submit button (登录)
# → say n3=username, n4=password, n5=submit

# 3. fill + submit
qqb type n3 --tab 1715533381 --text "alice"
qqb type n4 --tab 1715533381 --text "<asked-from-user>"
qqb click n5 --tab 1715533381

# 4. wait for nav
qqb wait --url-changes --tab 1715533381 --timeoutMs 8000

# 5. verify
qqb snapshot --tab 1715533381 --pretty   # confirm we're on dashboard
```

### Variants

- **Captcha appears** — abort the recipe and report to the user; ask them to
  solve it manually, then continue.
- **2FA prompt** — same: pause, ask user for the code, then `qqb type` it in.
- **OAuth redirect to a 3rd-party domain** — navigation completes when the
  final URL is back on `example.com/callback`; use
  `qqb wait --url-matches "/callback"` rather than `--url-changes`.

## 2. Search and read first result

```bash
qqb type n_searchbox --text "foo bar" --submit true
qqb wait --idle 600
qqb snapshot --pretty | jq '..|objects|select(.role=="link")|{name,nodeRef}' | head -20
# pick the relevant link, say n42
qqb click n42
qqb wait --url-changes
qqb read --pretty | jq '{title, wordCount, text}'
```

## 3. Multi-step form (wizard)

```bash
# loop:
qqb snapshot --pretty
# if you see "下一步" button → fill current step's fields → qqb click <ref>
# if you see "完成"/"提交" → click it, break
qqb wait --idle 500
# repeat
```

Don't carry nodeRefs across iterations — re-snapshot each step.

## 4. Modal/dialog appears

If after a click you snapshot and see a node like:

```yaml
- role: dialog
  name: "确认删除?"
  children:
    - role: button
      name: "取消"
      nodeRef: n80
    - role: button
      name: "确定"
      nodeRef: n81
```

That's a modal. **Treat it as the page** — don't try to dismiss it via ESC
unless explicitly asked. Click the appropriate button. Confirm with the user
before destructive actions ("确定删除" should always be confirmed).

## 5. Infinite-scroll feed

```bash
# loop until you've seen N items or 10 scrolls:
qqb snapshot --maxNodes 400 --pretty   # smaller cap to spare context
# collect items
qqb scroll --direction down --pages 1
qqb wait --idle 600
# repeat
```

Use a smaller `--maxNodes` to avoid blowing CC context. If you see the same
item twice in a row, you've hit the bottom — stop.

## 6. Read article body without interacting

For "总结一下这篇文章":

```bash
qqb read --pretty
# returns {title, text, wordCount}
# summarize from `text` directly
```

`qqb read` strips nav/footer/script and prefers `<article>` — it's the cheap,
reading-only path.

## 7. Wait for SPA route change after clicking a link

```bash
BEFORE=$(qqb snapshot | jq -r .url)
qqb click n_link
qqb wait --url-changes "$BEFORE" --timeoutMs 8000
qqb wait --idle 500    # also let React re-render after pushState
```

If the SPA uses pushState without DOMContentLoaded, the chained `--idle` is
what catches the actual paint.

## 8. Verify an action succeeded

After every important action, snapshot once and check for:
- A success heading/banner (`role:status` or `role:alert`)
- An expected URL change
- A previously-disabled button is now enabled, or the form is gone

If none of these are true, **report failure to the user** rather than
continue.

## 9. Quick "what's on this page" summary

When the user just asks "看一下这页":

```bash
qqb snapshot | jq '{
  title, url, nodeCount,
  headings: [..|objects|select(.role=="heading")|{level, name}],
  interactive: [..|objects|select(.nodeRef)|{role, name, nodeRef}] | .[0:20]
}'
```

That gets you title + url + outlines + the first 20 interactive elements
without dumping the whole tree into context.

## 10. Visual question (canvas / icons / layout)

When AX won't help — Figma, design tools, icon-only toolbars, "is this
toggle on", "what does the chart look like":

```bash
qqb screenshot --pretty
# returns {tabId, url, title, format, path: "/tmp/qqb-screenshots/shot-...png", width, height, byteLength}
```

Then load that path as a multimodal attachment and reason from the image.
For long pages:

```bash
qqb screenshot --fullPage --format jpeg --quality 70 --pretty
```

For just one element (after a snapshot gives you nodeRef):

```bash
qqb snapshot | jq '..|objects|select(.role=="figure")|.nodeRef'
# → "n42"
qqb screenshot --ref n42 --pretty
```

### Combining AX + screenshot

The strongest pattern when AX is ambiguous:

```bash
qqb snapshot --pretty           # gives you nodeRefs, but says "button" "button" "button"
qqb screenshot --pretty         # now you can see which is which
# decide which nodeRef to click based on visual context
qqb click n7
qqb wait --idle 500
qqb screenshot --pretty         # confirm the action did what you expected
```

Use this sparingly — every screenshot is a bigger context cost than a
snapshot. But for verification of irreversible actions, it's worth it.

## 11. Verifying an action with before/after screenshots

```bash
qqb screenshot --out /tmp/before.png
qqb click n_submit
qqb wait --idle 1000
qqb screenshot --out /tmp/after.png
# diff visually if needed; or just attach both to your reasoning
```

## 10. Visual question (canvas / icons / layout)

When AX won't help — Figma, design tools, icon-only toolbars, "is this
toggle on", "what does the chart look like":

```bash
qqb screenshot --pretty
# returns {tabId, url, title, format, path: "/tmp/qqb-screenshots/shot-...png", width, height, byteLength}
```

Then load that path as a multimodal attachment and reason from the image.
For long pages:

```bash
qqb screenshot --fullPage --format jpeg --quality 70 --pretty
```

For just one element (after a snapshot gives you nodeRef):

```bash
qqb snapshot | jq '..|objects|select(.role=="figure")|.nodeRef'
# → "n42"
qqb screenshot --ref n42 --pretty
```

### Combining AX + screenshot

The strongest pattern when AX is ambiguous:

```bash
qqb snapshot --pretty           # gives you nodeRefs, but says "button" "button" "button"
qqb screenshot --pretty         # now you can see which is which
# decide which nodeRef to click based on visual context
qqb click n7
qqb wait --idle 500
qqb screenshot --pretty         # confirm the action did what you expected
```

Use this sparingly — every screenshot is a bigger context cost than a
snapshot. But for verification of irreversible actions, it's worth it.

## 11. Verifying an action with before/after screenshots

```bash
qqb screenshot --out /tmp/before.png
qqb click n_submit
qqb wait --idle 1000
qqb screenshot --out /tmp/after.png
# diff visually if needed; or just attach both to your reasoning
```
