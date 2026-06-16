// popup.js — UI for connection settings and tab takeover.

const $ = (id) => document.getElementById(id)

async function loadSettings() {
  const stored = await chrome.storage.local.get(['bridgeUrl', 'token'])
  $('bridgeUrl').value = stored.bridgeUrl ?? 'ws://127.0.0.1:9528'
  $('token').value = stored.token ?? ''
}

async function saveSettings() {
  await chrome.storage.local.set({
    bridgeUrl: $('bridgeUrl').value.trim(),
    token: $('token').value.trim(),
  })
  await reconnect()
}

async function reconnect() {
  $('status').textContent = 'connecting…'
  $('dot').className = 'dot bad'
  const r = await chrome.runtime.sendMessage({ type: 'reconnect' })
  refreshStatus(r?.connected ?? false)
}

function refreshStatus(connected) {
  $('status').textContent = connected ? 'connected' : 'disconnected'
  $('dot').className = connected ? 'dot good' : 'dot bad'
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' })
  refreshStatus(status?.connected ?? false)
  await renderTabs(status?.attachedTabs ?? [])
}

async function renderTabs(attached) {
  const all = await chrome.tabs.query({})
  const root = $('tabs')
  root.innerHTML = ''
  for (const t of all) {
    if (!t.url || t.url.startsWith('chrome-extension://')) continue
    const isAttached = attached.includes(t.id)
    const row = document.createElement('div')
    row.className = 'tab'
    row.innerHTML = `
      <div class="title">${escapeHtml(t.title || t.url)}<br><small>${escapeHtml(t.url)}</small></div>
      <div class="row-actions">
        <span class="badge ${isAttached ? 'attached' : ''}">${isAttached ? 'attached' : 'idle'}</span>
        <button class="secondary" data-tabid="${t.id}" data-action="${isAttached ? 'release' : 'takeover'}">
          ${isAttached ? 'release' : 'attach'}
        </button>
      </div>
    `
    root.appendChild(row)
  }
  root.querySelectorAll('button[data-tabid]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      const tabId = Number(btn.dataset.tabid)
      const action = btn.dataset.action
      if (action === 'takeover') {
        // Switch focus to that tab first, so "active tab" semantics line up.
        await chrome.tabs.update(tabId, { active: true })
        await chrome.runtime.sendMessage({ type: 'takeover-active' })
      } else {
        await chrome.runtime.sendMessage({ type: 'release', tabId })
      }
      await refresh()
    })
  })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

$('reconnect').addEventListener('click', reconnect)
$('save').addEventListener('click', saveSettings)
$('takeover').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'takeover-active' })
  await refresh()
})

loadSettings().then(refresh)
