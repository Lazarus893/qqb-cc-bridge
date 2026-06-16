// MCP tool registry. Each tool is a self-contained module.
// Add a tool here once it's implemented.

import { ping } from './ping.js'
import { listTabs } from './list-tabs.js'
import { snapshot } from './snapshot.js'
import { readText } from './read-text.js'
import { click } from './click.js'
import { typeText } from './type-text.js'
import { scroll } from './scroll.js'
import { navigate } from './navigate.js'
import { waitFor } from './wait-for.js'
import { execJs } from './exec-js.js'

export const tools = [
  ping,
  listTabs,
  snapshot,
  readText,
  click,
  typeText,
  scroll,
  navigate,
  waitFor,
  execJs,
]
