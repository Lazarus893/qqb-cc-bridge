// Token management — generates a stable per-machine token on first run and
// caches it in ~/.qqb-cc-bridge/token. The user pastes it into the extension
// popup to authorize WS connections.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const DIR = join(homedir(), '.qqb-cc-bridge')
const TOKEN_FILE = join(DIR, 'token')

export async function ensureToken() {
  await mkdir(DIR, { recursive: true })
  try {
    const existing = (await readFile(TOKEN_FILE, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch {
    // fall through to generation
  }
  const token = randomBytes(24).toString('base64url')
  await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 })
  await chmod(TOKEN_FILE, 0o600)
  return token
}
