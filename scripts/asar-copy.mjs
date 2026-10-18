// Copy DSH runtime packages out of the installed Electron asar so ordinary
// tools (rg, read, grep) can inspect them. The asar supports readFileSync and
// readdirSync but not cpSync's path handling, so files are copied one by one.
//
// Usage (PowerShell):
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & 'D:\dsh\DeepSeek Harness.exe' 'B:\vibe_program\dsh-bash\scripts\asar-copy.mjs'
//
// Override the defaults with env vars:
//   DSH_ASAR_SOURCE  e.g. D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai
//   DSH_ASAR_DEST    e.g. B:/vibe_program/tmp/dsh-api/node_modules/@deepseek-ai
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const source = process.env.DSH_ASAR_SOURCE ?? 'D:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai'
const dest = process.env.DSH_ASAR_DEST ?? 'B:/vibe_program/tmp/dsh-api/node_modules/@deepseek-ai'

/** Runtime packages this plugin's contract is derived from. */
const packages = [
  'dsh-tools',
  'dsh-llm',
  'dsh-agent',
  'dsh-agent-loop',
  'dsh-sandbox',
  'dsh-sandbox-local',
  'dsh-sandbox-policy',
  'dsh-subprocess',
  'dsh-subprocess-local',
  'dsh-shell',
  'dsh-bash-local',
  'dsh-bash-sandbox',
  'dsh-pwsh-sandbox',
  'dsh-jobs',
  'dsh-jobs-local',
  'dsh-tool-jobs',
  'dsh-timeout',
  'dsh-system-prompt',
  'dsh-shell-env',
  'dsh-user-approval',
  'dsh-working-directory',
  'dsh-tool-bash',
  'dsh-tool-pwsh',
]

function walk(from, to) {
  mkdirSync(to, { recursive: true })
  let count = 0
  for (const entry of readdirSync(from)) {
    const fromPath = `${from}/${entry}`
    const toPath = join(to, entry)
    let stats
    try {
      stats = statSync(fromPath)
    } catch {
      continue
    }
    if (stats.isDirectory()) count += walk(fromPath, toPath)
    else if (stats.isFile()) {
      writeFileSync(toPath, readFileSync(fromPath))
      count += 1
    }
  }
  return count
}

for (const name of packages) {
  try {
    console.log('copied', name, walk(join(source, name), join(dest, name)), 'files')
  } catch (error) {
    console.log('failed', name, error.code ?? '', error.message)
  }
}
