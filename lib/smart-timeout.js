/**
 * Content-aware defaults for `timeoutMs`, ported from `pi-smart-timeout`
 * (same author, MIT). A single flat number has an obvious failure mode: low
 * enough to catch hangs and it promotes your `cargo build` mid-run; high enough
 * to let builds finish and it stops catching hangs. So the default is chosen
 * per command, and an explicit `timeoutMs` always wins.
 *
 * Decision order (first match wins):
 *  1. the model supplied `timeoutMs` -> used as-is, clamped to the ceiling
 *  2. the command wraps itself in `timeout N ...` -> N + grace, so the inner
 *     guard fires first with a precise error instead of a race
 *  3. the command looks long-running -> longSeconds
 *  4. everything else -> defaultSeconds
 *
 * Quoted text is blanked before the long-running heuristics run, so
 * `grep -n 'npm install' src/` or `echo "make sure"` cannot trip a pattern
 * meant for the actual command words.
 *
 * @module dsh-bash/smart-timeout
 */

/** Seconds for an ordinary command. */
export const DEFAULT_SECONDS = 120
/** Seconds for a command known to run long (builds, tests, installs, ...). */
export const LONG_SECONDS = 1800
/** Hard ceiling applied even to a model-supplied value, in seconds. */
export const MAX_SECONDS = 3600
/** Headroom added on top of a detected inner `timeout N`, in seconds. */
export const GRACE_SECONDS = 30

/**
 * Built-in long-running heuristics. Keep in sync with
 * `pi-smart-timeout/extensions/smart-timeout.ts`; that file carries the
 * rationale for each omission (`curl`, `ssh`, bare `while true`, ...).
 */
const LONG_RUNNING = [
  // package managers / task runners
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|update|upgrade|dedupe|build|test|publish|run\s+\S+)\b/,
  /\b(?:pip|pip3|uv|conda|mamba|poetry|pipenv)\s+(?:install|sync|update|add|lock|create|run)\b/,
  /\b(?:apt|apt-get|dpkg|brew|choco|winget|pacman|dnf|yum|apk|snap)\s+\S/,
  /\bnpx\s+\S/,
  // compilers / build systems. `go` and `make` are also ordinary English words
  // and file names, so they only count as the command word: start of command,
  // after a separator, or after a common prefix like sudo/time.
  /(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)go\s+(?:build|test|run|vet|fmt|generate|mod|get|install|work|tool)\b/,
  /(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)make(?:\s|$)/,
  /\b(?:cargo|rustc|dotnet|mvn|mvnw|gradle|gradlew|cmake|ninja|meson|bazel|buck)\b/,
  /\btsc\s+(?:--build|-b)\b|\bwebpack\b|\bvite\s+build\b|\bnext\s+build\b|\brollup\b|\besbuild\b/,
  // containers / infra / cloud CLIs
  /\b(?:docker|podman|nerdctl)\s+(?:build|compose|pull|run|up|push|logs\s+-f)\b/,
  /\b(?:vagrant|terraform|ansible-playbook|helm|kubectl|aws|gcloud|az)\s+\S/,
  /\bsystemctl\s+\S/,
  // VCS network ops / remote copy. Bare `ssh`/`ssh-keygen` and `curl`/`wget`
  // are deliberately absent: they hang on prompts and unreachable hosts far
  // more often than they legitimately run long, so the default bucket catches
  // the hang; pass an explicit timeoutMs for a genuinely long transfer.
  /\bgit\s+(?:clone|fetch|pull|push|submodule|lfs)\b/,
  /\b(?:scp|sftp|rsync)\b/,
  // tests / benchmarks
  /\b(?:pytest|py\.test|tox|nox|vitest|jest|mocha|playwright|cypress|rspec|phpunit|ctest)\b/,
  // bounded wait/poll loops; an unconditioned `while true` is a hang by
  // definition and must keep the default cap
  /\b(?:for|until|while)\b(?![^\n|;&]*\b(?:true|:)\b)[^\n]*\bdo\b[^\n]*\bsleep\s+\S/,
  // long scans / waits / media. `tar`/`zip` must be the command word so file
  // names like `*.tar` do not match.
  /\b(?:watch|tail\s+-f|tail\s+-F|journalctl\s+-f|nvidia-smi\s+-l)\b/,
  /\b(?:python|python3|node|deno|ruby|php)\s+-m\s+(?:http\.server|json\.tool|timeit)\b/,
  /\bsleep\s+(?:[2-9]\d|\d{3,})\b/,
  /(?:^|[;&|(]\s*|\b(?:sudo|time|nohup|env)\s+)(?:ffmpeg|magick|7z|tar|zip)\b/,
  /\b(?:jupyter|pytest|sphinx|mkdocs)\b/,
]

const TIMEOUT_CMD_RE = /(?:^|[;&|(`\s])(?:\S*\/)?timeout\s+/g
const DURATION_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/
const QUOTE_RESET_RE = /[;&|`\n]/g

/**
 * Validate the configured knobs and compile their regexes once, at mount time.
 * Every invalid value throws here rather than silently changing a later cap.
 */
export function resolveSmartTimeoutConfig(raw) {
  const defaultSeconds = Number(raw?.defaultSeconds ?? DEFAULT_SECONDS)
  const longSeconds = Number(raw?.longSeconds ?? LONG_SECONDS)
  const maxSeconds = Number(raw?.maxSeconds ?? MAX_SECONDS)
  const graceSeconds = Number(raw?.graceSeconds ?? GRACE_SECONDS)
  for (const [key, value] of Object.entries({ defaultSeconds, longSeconds, maxSeconds })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-bash: smartTimeout.${key} must be a positive finite number, got ${JSON.stringify(raw?.[key])}`)
  }
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) throw new Error(`dsh-bash: smartTimeout.graceSeconds must be a non-negative finite number, got ${JSON.stringify(raw?.graceSeconds)}`)
  if (longSeconds < defaultSeconds) throw new Error(`dsh-bash: smartTimeout.longSeconds (${longSeconds}) must be >= defaultSeconds (${defaultSeconds})`)
  if (maxSeconds < defaultSeconds) throw new Error(`dsh-bash: smartTimeout.maxSeconds (${maxSeconds}) must be >= defaultSeconds (${defaultSeconds})`)
  const longPatterns = (raw?.longPatterns ?? []).map((pattern) => {
    try {
      return new RegExp(pattern)
    } catch (error) {
      throw new Error(`dsh-bash: smartTimeout.longPatterns has an invalid regex ${JSON.stringify(pattern)}: ${error.message}`)
    }
  })
  return { enabled: raw?.enabled !== false, defaultSeconds, longSeconds, maxSeconds, graceSeconds, longPatterns }
}

/**
 * Pick the default `timeoutMs` for one command.
 *
 * @param {string} command raw command text
 * @param {number | undefined} requestedMs explicit model value, already known positive
 * @param {ReturnType<typeof resolveSmartTimeoutConfig>} config compiled configuration
 * @returns {{ timeoutMs: number, reason: 'explicit' | 'explicit-clamped' | 'inner-guard' | 'long-running' | 'default' }}
 */
export function planTimeoutMs(command, requestedMs, config) {
  const ceilingMs = config.maxSeconds * 1000
  const clamp = (ms) => Math.min(ms, ceilingMs)

  if (requestedMs !== undefined) {
    if (!Number.isFinite(requestedMs) || requestedMs <= 0) throw new Error('bash: request.timeoutMs must be a positive finite number')
    const timeoutMs = clamp(Math.ceil(requestedMs))
    return { timeoutMs, reason: timeoutMs === requestedMs ? 'explicit' : 'explicit-clamped' }
  }

  const innerSeconds = parseInnerTimeoutSeconds(command)
  if (innerSeconds !== undefined) {
    return { timeoutMs: clamp((Math.ceil(innerSeconds) + config.graceSeconds) * 1000), reason: 'inner-guard' }
  }

  if (looksLongRunning(command, config.longPatterns)) {
    return { timeoutMs: clamp(config.longSeconds * 1000), reason: 'long-running' }
  }

  return { timeoutMs: clamp(config.defaultSeconds * 1000), reason: 'default' }
}

/** True when the command text names a long-running operation. */
function looksLongRunning(command, longPatterns) {
  const bare = stripQuotedText(command)
  if (LONG_RUNNING.some((re) => re.test(bare))) return true
  return longPatterns.some((re) => re.test(command))
}

/**
 * Replace the contents of single- and double-quoted spans (and the quotes
 * themselves) with spaces, preserving offsets. Approximate on purpose: it only
 * feeds the long-running heuristics, never the inner-guard parser, which has
 * its own quote handling.
 */
function stripQuotedText(command) {
  const out = command.split('')
  let single = false
  let double = false
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i]
    if (ch === '\\' && (single || double)) {
      out[i] = ' '
      if (i + 1 < out.length) out[i + 1] = ' '
      i += 1
      continue
    }
    if (ch === "'" && !double) {
      single = !single
      out[i] = ' '
    } else if (ch === '"' && !single) {
      double = !double
      out[i] = ' '
    } else if (single || double) {
      out[i] = ' '
    }
  }
  return out.join('')
}

/** True when `index` sits inside a single- or double-quoted span of the command. */
function isInsideQuotes(command, index) {
  let segmentStart = 0
  QUOTE_RESET_RE.lastIndex = 0
  let separator
  while ((separator = QUOTE_RESET_RE.exec(command)) !== null && separator.index < index) {
    segmentStart = separator.index + 1
  }
  let single = false
  let double = false
  for (let i = segmentStart; i < index; i += 1) {
    const ch = command[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === "'" && !double) single = !single
    else if (ch === '"' && !single) double = !double
  }
  return single || double
}

/**
 * Extract the duration of a `timeout N ...` wrapper, in seconds, walking the
 * option list properly so `-s KILL` / `--kill-after=5` are not read as the
 * duration. `timeout 0` means "no limit" in coreutils, so it is not a guard.
 */
function parseInnerTimeoutSeconds(command) {
  TIMEOUT_CMD_RE.lastIndex = 0
  let match
  while ((match = TIMEOUT_CMD_RE.exec(command)) !== null) {
    const wordAt = match.index + match[0].lastIndexOf('timeout')
    if (isInsideQuotes(command, wordAt)) continue

    const tokens = command.slice(match.index + match[0].length).split(/\s+/)
    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]
      if (!token) {
        i += 1
        continue
      }
      if (token.startsWith('-')) {
        const takesValue = /^(-k|--kill-after|-s|--signal)$/.test(token)
        i += takesValue ? 2 : 1
        continue
      }
      break
    }

    const durationToken = tokens[i]
    if (!durationToken) continue
    const duration = durationToken.match(DURATION_RE)
    if (!duration) continue
    const value = Number(duration[1])
    const unit = duration[2] || 's'
    const seconds = unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : unit === 'd' ? value * 86400 : value
    if (Number.isFinite(seconds) && seconds > 0) return seconds
  }
  return undefined
}
