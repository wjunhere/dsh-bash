import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

/**
 * Locate the Git for Windows `bash.exe` this tool should execute.
 *
 * Detection is deliberately ordered and side-effect free: Git is usually
 * installed under `Program Files`, through scoop, or as a per-user install,
 * and every installation puts `bash.exe` under either `<root>\bin` or
 * `<root>\usr\bin`. A `git.exe` on `PATH` also names its root, which catches
 * custom drive installs. `C:\Windows\System32\bash.exe` is the WSL launcher
 * and is never accepted.
 *
 * @module dsh-bash/git-bash
 */

const BASH_SUFFIXES = [
  ['bin', 'bash.exe'],
  ['usr', 'bin', 'bash.exe'],
]

/** PATH entries whose parent is a Git installation root (`...\Git\cmd`). */
const GIT_CONTEXT_DIRS = new Set(['cmd', 'bin', 'mingw64', 'usr'])

function windowsRoots(env) {
  const roots = []
  const systemRoot = normalize(env.SystemRoot ?? env.windir ?? '')
  const windowsDirs = new Set(
    [systemRoot, join(systemRoot, 'System32')]
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.toLowerCase()),
  )
  return { roots, windowsDirs }
}

/** Strip quotes and trailing separators from one PATH entry. */
function normalizePathEntry(entry) {
  const trimmed = entry.trim().replace(/^"|"$/g, '')
  if (trimmed.length === 0) return undefined
  return normalize(trimmed)
}

function isWindowsSystemBash(candidate, windowsDirs) {
  const parent = dirname(candidate).toLowerCase()
  return windowsDirs.has(parent)
}

/**
 * Ordered candidate list: `{ path, origin }`, first entry wins.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {{ path: string, origin: string }[]}
 */
export function gitBashCandidates(env) {
  const candidates = []
  const seen = new Set()
  const push = (path, origin) => {
    if (path === undefined || path.length === 0) return
    const normalized = normalize(path)
    const key = normalized.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ path: normalized, origin })
  }

  const programFilesDirs = [
    env.ProgramFiles,
    env.ProgramW6432,
    env.ProgramFiles ? join(env.ProgramFiles.replace(/ \(x86\)$/, ''), '') : undefined,
    env['ProgramFiles(x86)'],
  ]
  for (const base of programFilesDirs) {
    if (base === undefined) continue
    for (const suffix of BASH_SUFFIXES) push(join(base, 'Git', ...suffix), `Program Files (${join('Git', ...suffix)})`)
  }

  const localAppData = env.LOCALAPPDATA
  if (localAppData !== undefined) {
    for (const suffix of BASH_SUFFIXES) push(join(localAppData, 'Programs', 'Git', ...suffix), 'per-user install')
  }

  const scoopRoot = env.SCOOP ?? (env.USERPROFILE === undefined ? undefined : join(env.USERPROFILE, 'scoop'))
  if (scoopRoot !== undefined) {
    for (const suffix of BASH_SUFFIXES) push(join(scoopRoot, 'apps', 'git', 'current', ...suffix), 'scoop')
  }

  const { windowsDirs } = windowsRoots(env)
  for (const rawEntry of (env.PATH ?? '').split(';')) {
    const entry = normalizePathEntry(rawEntry)
    if (entry === undefined) continue
    // `<root>\Git\cmd` and `<root>\Git\bin` both name the installation root.
    if (GIT_CONTEXT_DIRS.has(basename(entry).toLowerCase())) {
      const root = dirname(entry)
      for (const suffix of BASH_SUFFIXES) push(join(root, ...suffix), 'PATH git directory')
    }
    if (existsSync(join(entry, 'git.exe'))) {
      for (const suffix of BASH_SUFFIXES) push(join(entry, '..', ...suffix), 'PATH git.exe')
    }
    const direct = join(entry, 'bash.exe')
    if (!isWindowsSystemBash(direct, windowsDirs)) push(direct, 'PATH bash.exe')
  }

  return candidates
}

/**
 * Resolve the bash executable. An explicit `bashPath` is authoritative: a
 * wrong value throws here instead of silently falling back to another
 * installation.
 * @param {string | undefined} configured - `config.bashPath`.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {{ path: string, origin: string }}
 */
export function resolveGitBash(configured, env = process.env) {
  if (configured !== undefined) {
    if (configured.trim().length === 0) throw new Error('dsh-bash: config.bashPath is empty')
    const resolved = isAbsolute(configured) ? normalize(configured) : normalize(configured)
    if (!existsSync(resolved)) throw new Error(`dsh-bash: config.bashPath does not exist: ${resolved}`)
    return { path: resolved, origin: 'config.bashPath' }
  }
  const candidates = gitBashCandidates(env)
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate
  }
  const checked = candidates.map((candidate) => `${candidate.path} (${candidate.origin})`).join(', ')
  throw new Error(
    `dsh-bash: Git for Windows bash.exe not found. Install Git for Windows (https://git-scm.com/download/win) or set config.bashPath. Checked: ${checked}`,
  )
}
