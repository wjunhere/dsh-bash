import { isAbsolute, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  ESCALATION_TARGETS,
  SandboxUnavailableError,
  approveEscalation,
  classifyRunnerFailure,
  escalationHintMarker,
  isRunnerSpawnFailure,
  matchesSignature,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import { DSH_ENV_PREFIX, parseExitStatus } from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { resolveGitBash } from './git-bash.js'
import { planTimeoutMs, resolveSmartTimeoutConfig } from './smart-timeout.js'

/**
 * The `bash` tool, backed by Git for Windows instead of WSL.
 *
 * The model-facing contract, renderer strings, output schema, cards and the
 * system-prompt section mirror the native `@deepseek-ai/dsh-tool-bash` tool
 * (DSH 0.2.1-rc.2) so neither the model nor the shipped UI can tell the two
 * apart. Where the native tool consumes the `ctx.shell` executor seam, this
 * tool owns its execution path: it spawns the resolved `bash.exe` through
 * `ctx.subprocess`, arms the shared timeout primitive itself, and applies
 * `ctx.sandbox.confine` with the same denial/runner-failure classification the
 * sandbox executors use.
 *
 * @module dsh-bash
 */

export const name = 'dsh-bash'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'shellEnv', 'workingDirectory']

/** Runtime configuration schema. Shell knobs are aligned with the native tools. */
export const Config = z.object({
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
  bashPath: z.string().required(false),
  // Content-aware defaults for `timeoutMs`; see lib/smart-timeout.js.
  smartTimeout: z
    .object({
      enabled: z.boolean().default(true),
      defaultSeconds: z.number().default(120),
      longSeconds: z.number().default(1800),
      maxSeconds: z.number().default(3600),
      graceSeconds: z.number().default(30),
      longPatterns: z.array(z.string()).default([]),
    })
    .default({}),
})

/** Executor defaults copied from `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
const MAX_OUTPUT_BYTES = 64000
const MAX_SPILL_BYTES = 64 * 1024 * 1024
const GRACE_MS = 3000
const TIMEOUT_CODE = 'BASH_TIMEOUT'
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }

/* -------------------------------------------------------------------------- */
/* Model-facing rendering                                                      */
/* -------------------------------------------------------------------------- */

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** Shape one finished run into the text the model sees. */
function renderResult(result, escalationModes = []) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** Shape a foreground call that stopped waiting into the text the model sees. */
function renderPromoted(promoted) {
  return `${promoted.output.length > 0 ? (promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`) : ''}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`
}

/** Ring chunks of one consuming read rendered as the shell tools render output. */
function ringDelta(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/** The delta text plus any loss or sandbox notice. */
function renderJobRead(delta, lossy, spillPaths, sandbox, escalationModes = []) {
  const notices = []
  if (lossy) notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`)
  if (sandbox?.runnerFailed) notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/** Sandbox notices that belong in a background job's terminal `detail`. */
function sandboxNotes(sandbox, escalationModes) {
  if (sandbox?.runnerFailed) return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/** Map a settled background process onto the job-outcome vocabulary. */
function processOutcome(proc, escalationModes = []) {
  if (proc.status === 'failed') return { status: 'failed', detail: proc.failure ?? 'spawn failed' }
  const base = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

function toolAborted() {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/* -------------------------------------------------------------------------- */
/* Request validation and tool text                                            */
/* -------------------------------------------------------------------------- */

function validateBashArgs(args, effectiveMode) {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (args.description !== undefined && (typeof args.description !== 'string' || args.description.trim().length === 0)) throw new Error('invalid description: expected a non-empty string when provided')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode) return
  const justification = args.sandbox_permissions === undefined && args.justification?.trim() === '' ? undefined : args.justification
  validateEscalationArgs(args.sandbox_permissions, justification)
}

function bashDescription() {
  return `Execute a bash command (\`bash -c\`) and return its stdout/stderr. Each call runs in a fresh shell; pass \`workdir\` instead of using \`cd\`. Managed \`$${DSH_ENV_PREFIX}*\` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with \`\${VAR:?}\`. Commands may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\`, a policy denial: do not retry another way.`
}

function presentBashCall(args) {
  const description = typeof args.description === 'string' && args.description.trim().length > 0 ? args.description : undefined
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: description ?? args.command }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    ...(description !== undefined ? { description } : {}),
    ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
  }
}

function presentBashResult(args, result) {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && args.run_in_background === true
  const isPromoted = result.value?.kind === 'promoted'
  if (isBackground || isPromoted || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/** Resolve a relative per-call override against the Session's current directory. */
function resolveWorkdir(modelWorkdir, sessionCwd, fallbackCwd) {
  if (modelWorkdir === undefined) return sessionCwd ?? fallbackCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return `${sessionCwd}${sep}${modelWorkdir}`
  if (!isAbsolute(modelWorkdir)) return resolve(fallbackCwd, modelWorkdir)
  return modelWorkdir
}

/** Project one run result onto the tool's wire value. */
function canonicalResult(result, cwd) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  return {
    kind: 'foreground',
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined
      ? {
          sandbox: {
            mode: result.sandbox.mode,
            denied: result.sandbox.denied,
            ...(result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {}),
            ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {}),
          },
        }
      : {}),
  }
}

/** Canonical background-handle properties shared by the output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
  cwd: { type: 'string', required: true },
}

const PROMOTED_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'promoted' },
  cwd: { type: 'string', required: true },
  jobId: { type: 'string', required: true },
  timeoutMs: { type: 'number', required: true },
  output: { type: 'string', required: true },
}

const FOREGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'foreground' },
  cwd: { type: 'string', required: true },
  exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
  signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
  timedOut: { type: 'boolean', required: true },
  aborted: { type: 'boolean', required: true },
  stopped: { type: 'string' },
  timeoutMs: { type: 'number', required: true },
  stdout: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      text: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true },
      spillPath: { type: 'string' },
    },
  },
  stderr: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      text: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true },
      spillPath: { type: 'string' },
    },
  },
  sandbox: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', required: true },
      denied: { type: 'boolean', required: true },
      enforcement: { type: 'string' },
      runnerFailed: { type: 'boolean' },
    },
  },
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

export function apply(ctx, config = {}) {
  const backgroundEnabled = config.enableRunInBackground ?? true
  const promoteEnabled = (config.promoteOnTimeout ?? true) && backgroundEnabled
  const bash = resolveGitBash(config.bashPath)
  // Fail fast on bad tuning at mount time instead of quietly capping differently.
  const smartTimeout = resolveSmartTimeoutConfig(config.smartTimeout)

  // Sandbox facts are read LIVE, never captured at apply() time: cordis mounts
  // plugin rows in parallel, so this row can run before `sandbox-policy` or the
  // sandbox provider registered. A stale `false` here would run every command
  // unconfined while the description still promises confinement.
  const sandboxPolicyService = () => {
    const service = ctx.get('sandboxPolicy')
    return service?.defaultMode === undefined ? undefined : service
  }
  const escalationTargets = () => (sandboxPolicyService() === undefined || ctx.get('sandbox') === undefined ? [] : [...ESCALATION_TARGETS])

  /** Resolve a sandbox-escalation request through `ctx.approval` before anything executes. */
  const approveBashEscalation = (mode, justification, exec, standingPolicy) => {
    if (escalationTargets().length === 0) throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    return approveEscalation(
      {
        requestedMode: mode,
        justification,
        effectiveMode: standingPolicy.mode,
        subject: 'command',
      },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'bash',
        signal: exec.signal,
      },
    )
  }

  /** Apply implementation-owned defaults and caps to one execution request. */
  function resolveSpec(request) {
    return {
      command: request.command,
      workdir: request.workdir,
      timeoutMs: smartTimeout.enabled
        ? planTimeoutMs(request.command, request.timeoutMs, smartTimeout).timeoutMs
        : clampTimeout(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'bash: request.timeoutMs'),
      stdoutMaxBytes: MAX_OUTPUT_BYTES,
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      ...(request.sandboxPolicy !== undefined ? { sandboxPolicy: request.sandboxPolicy } : {}),
    }
  }

  /** Map a resolved spec plus its confined argv onto a fully-specified subprocess spawn. */
  function spawnSpec(spec, argv, signal) {
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: MAX_SPILL_BYTES } })
    return {
      argv,
      cwd: spec.workdir,
      stdio: {
        stdin: 'ignore',
        stdout: collect(spec.stdoutMaxBytes),
        stderr: collect(MAX_OUTPUT_BYTES),
      },
      graceMs: GRACE_MS,
      ...(signal !== undefined ? { signal } : {}),
      env: {
        ...ENV_OVERRIDES,
        ...spec.env,
        ...spec.dshEnv,
      },
    }
  }

  function finalOutput(reader) {
    if (reader === undefined) return { text: '', truncated: false }
    const read = reader.readFrom(0)
    return {
      text: read.text,
      truncated: read.lossy,
      ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
    }
  }

  /** The settled-empty result an expiry during preparation produces. */
  function preparationTimedOut(spec, policy) {
    return {
      exitCode: null,
      signal: null,
      timedOut: true,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      ...(policy !== undefined ? { sandbox: { mode: policy.mode, denied: false } } : {}),
    }
  }

  /**
   * Confined argv for one call, plus the facts needed to classify its exit.
   * Fail closed: a confined policy with no sandbox provider is an error, never
   * an unconfined run.
   */
  async function prepareArgv(argv, policy, signal) {
    if (policy === undefined) return { argv, sandboxFacts: undefined }
    if (policy.mode === 'danger-full-access') return { argv, sandboxFacts: { mode: policy.mode } }
    const provider = ctx.get('sandbox')
    if (provider === undefined) throw new Error('dsh-bash: sandboxing is required by this composition but ctx.sandbox is missing')
    const confined = await provider.confine(argv, policy, signal)
    return {
      argv: confined.argv,
      sandboxFacts: {
        mode: policy.mode,
        enforcement: confined.enforcement,
        denialSignatures: confined.denialSignatures,
        runnerFailureRules: confined.runnerFailureRules,
      },
    }
  }

  /**
   * Run one prepared command in the foreground under an already-armed deadline;
   * nonzero exits and kills resolve, infrastructure failures reject.
   */
  async function runForeground(spec, prepared, d) {
    const { argv, sandboxFacts } = prepared
    const confined = sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access'
    let handle
    try {
      handle = ctx.subprocess.spawn(spawnSpec(spec, argv, d.signal))
    } catch (error) {
      if (d.signal.aborted) {
        if (timeoutOf(d.signal, TIMEOUT_CODE) !== undefined) return preparationTimedOut(spec, sandboxFacts)
        throw toolAborted()
      }
      if (confined && isRunnerSpawnFailure(error, argv[0], spec.workdir)) throw new SandboxUnavailableError(sandboxFacts.mode, String(error))
      throw error
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      if (d.signal.aborted && timeoutOf(d.signal, TIMEOUT_CODE) === undefined) throw toolAborted()
      if (confined && isRunnerSpawnFailure(error, argv[0], spec.workdir)) throw new SandboxUnavailableError(sandboxFacts.mode, String(error))
      throw error
    }
    const timedOut = timeoutOf(d.signal, TIMEOUT_CODE) !== undefined
    const aborted = d.signal.aborted && !timedOut
    const stdout = finalOutput(handle.collected.stdout)
    const stderr = finalOutput(handle.collected.stderr)
    let sandbox
    if (sandboxFacts !== undefined) {
      if (!confined) {
        sandbox = { mode: sandboxFacts.mode, denied: false }
      } else {
        const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, sandboxFacts.runnerFailureRules)
        if (runnerFailure !== undefined) throw new SandboxUnavailableError(sandboxFacts.mode, runnerFailure.detail)
        sandbox = {
          mode: sandboxFacts.mode,
          denied: matchesSignature(outcome.exitCode, stderr.text, sandboxFacts.denialSignatures),
          enforcement: sandboxFacts.enforcement,
        }
      }
    }
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout,
      stderr,
      ...(sandbox !== undefined ? { sandbox } : {}),
    }
  }

  /**
   * Start one background process; no deadline applies. Spawn/provider failures
   * settle as `killed` with the failure published on the stderr pull source,
   * mirroring `@deepseek-ai/dsh-bash-local`, while `readResult()` keeps the
   * failure for a foreground caller that collected the job.
   */
  function startProcess(spec, argv, sandboxFacts) {
    const handle = ctx.subprocess.spawn(spawnSpec(spec, argv, undefined))
    const collected = handle.collected
    const confined = sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access'
    const proc = {
      handle,
      status: 'running',
      exitCode: null,
      signal: null,
      sandbox: undefined,
      failureError: undefined,
      providerFailure: undefined,
      runnerFailure: undefined,
      stderrNote: undefined,
      result: undefined,
      stoppedReason: undefined,
      kill(reason) {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        proc.stoppedReason = reason
        handle.terminate()
        return true
      },
    }
    proc.done = handle.done.then(
      (outcome) => {
        if (proc.status === 'running') proc.status = 'completed'
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        const stdout = finalOutput(collected.stdout)
        const stderr = finalOutput(collected.stderr)
        if (sandboxFacts !== undefined) {
          if (!confined) {
            proc.sandbox = { mode: sandboxFacts.mode, denied: false }
          } else {
            const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, sandboxFacts.runnerFailureRules)
            proc.runnerFailure = runnerFailure?.detail
            proc.sandbox = {
              mode: sandboxFacts.mode,
              denied: runnerFailure === undefined && matchesSignature(outcome.exitCode, stderr.text, sandboxFacts.denialSignatures),
              enforcement: sandboxFacts.enforcement,
              ...(runnerFailure !== undefined ? { runnerFailed: true } : {}),
            }
          }
        }
        proc.result = {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout,
          stderr,
          ...(proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {}),
        }
      },
      (error) => {
        // A rejected `done` is a spawn/provider failure. The local executor
        // settles it as killed and publishes the failure on the observed
        // stderr stream; a confined runner failure is tagged so a foreground
        // caller can fail closed with `SandboxUnavailableError`.
        const detail = error instanceof Error ? error.message : String(error)
        proc.status = 'killed'
        proc.failureError = error
        proc.providerFailure = detail
        proc.stderrNote = `subprocess failed before reporting an outcome: ${detail}`
        if (confined && isRunnerSpawnFailure(error, argv[0], spec.workdir)) proc.runnerFailure = detail
        if (confined) {
          proc.sandbox = {
            mode: sandboxFacts.mode,
            denied: false,
            enforcement: sandboxFacts.enforcement,
            ...(proc.runnerFailure !== undefined ? { runnerFailed: true } : {}),
          }
        }
        proc.result = {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: proc.stderrNote, truncated: false },
          ...(proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {}),
        }
      },
    )
    proc.readResult = () => {
      if (proc.runnerFailure !== undefined) throw new SandboxUnavailableError(sandboxFacts.mode, proc.runnerFailure)
      if (proc.failureError !== undefined) throw proc.failureError
      return proc.result
    }
    return proc
  }

  /** The process's non-consuming stream readers as registry pull sources. */
  function processSources(proc) {
    const source = (channel) => ({
      channel,
      read: (fromByte) => {
        const live = proc()
        if (live?.providerFailure !== undefined && channel === 'stderr') {
          const note = live.stderrNote ?? ''
          return note.length > 0 && fromByte === 0
            ? { text: note, nextOffset: note.length, lossy: false }
            : { text: '', nextOffset: fromByte, lossy: false }
        }
        const reader = live?.handle.collected[channel]
        if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
        return reader.readFrom(fromByte)
      },
    })
    return [source('stdout'), source('stderr')]
  }

  /**
   * Register one process as a job. Preparation and spawn both happen inside the
   * starter, after admission, so cancellation can abort confinement and a
   * foreground wait covers preparation exactly as the native tool's does.
   */
  function startJob(registry, args, exec, spec, prepare) {
    const controller = new AbortController()
    let proc
    let stopped
    const id = registry.start({
      kind: 'bash',
      label: args.command,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      ...(exec.agent !== undefined ? { owner: exec.agent.id } : {}),
      output: processSources(() => proc),
      run: () => ({
        cancel: (reason) => {
          stopped = reason
          if (!controller.signal.aborted) controller.abort(reason)
          if (proc !== undefined) proc.kill(reason)
        },
        done: (async () => {
          try {
            proc = await prepare(controller.signal)
          } catch (error) {
            return {
              status: controller.signal.aborted ? 'killed' : 'failed',
              detail: error instanceof Error ? error.message : String(error),
            }
          }
          if (controller.signal.aborted) proc.kill(stopped)
          await proc.done
          return processOutcome(proc, escalationTargets())
        })(),
      }),
    })
    return { id, process: () => proc, stopped: () => stopped }
  }

  /** Wait on a registered foreground command until it settles or the timeout passes. */
  async function waitOnJob(registry, attached, exec, spec, policy) {
    const owner = exec.agent?.id
    const timeoutMs = spec.timeoutMs
    const stop = async (reason) => {
      registry.kill(attached.id, owner, reason)
      const settled = await registry.wait(attached.id, timeoutMs, owner)
      if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
      return settled
    }
    let view
    try {
      view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)
    } catch {
      await stop('tool call aborted')
      throw toolAborted()
    }
    if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
      // The wait expired during preparation (confinement or spawn): nothing ran,
      // so settle like the native tool's preparation-timeout branch.
      await stop('timed out during preparation')
      return canonicalResult(preparationTimedOut(spec, policy), spec.workdir)
    }
    if (view.status === 'running' || view.status === 'stopping') {
      // The job keeps running with its id: one consuming read hands the model
      // the output produced so far, and later `job_output` reads continue
      // exactly after it.
      const read = registry.read(attached.id, owner)
      const proc = attached.process()
      return {
        kind: 'promoted',
        cwd: spec.workdir,
        jobId: attached.id,
        timeoutMs,
        output: renderJobRead(ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], proc?.sandbox, escalationTargets()),
      }
    }
    registry.remove(attached.id, owner)
    const proc = attached.process()
    if (proc === undefined) throw new Error(view.detail ?? 'bash: the command failed before it started')
    const result = proc.readResult()
    const stopped = attached.stopped()
    return { ...canonicalResult(result, spec.workdir), ...(stopped !== undefined ? { stopped } : {}) }
  }

  async function execute(args, exec) {
    const standingPolicy = sandboxPolicyService()?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    validateBashArgs(args, standingPolicy?.mode)
    const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
      ? await approveBashEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
      : undefined
    const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }

    const sessionCwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const workdir = resolveWorkdir(args.workdir, sessionCwd, ctx.workingDirectory.defaultDirectory)
    const dshEnv = ctx.shellEnv.collect(exec)
    const request = {
      command: args.command,
      workdir,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      dshEnv,
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
    }
    const spec = resolveSpec(request)
    const argv = [bash.path, '-c', args.command]
    // Preparation (confinement) runs inside the job starter for the job paths,
    // so the wait covers it and cancellation can abort it.
    const prepare = (signal) => prepareArgv(argv, policy, signal).then((prepared) => startProcess(spec, prepared.argv, prepared.sandboxFacts))

    if (args.run_in_background === true) {
      if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
      const jobs = ctx.get('jobs')
      if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      if (exec.signal.aborted) throw toolAborted()
      const attached = startJob(jobs, args, exec, spec, prepare)
      return { kind: 'background', jobId: attached.id, cwd: spec.workdir }
    }

    const jobs = ctx.get('jobs')
    if (jobs !== undefined && promoteEnabled) {
      let attached
      try {
        attached = startJob(jobs, args, exec, spec, prepare)
      } catch (error) {
        // Degrade to the foreground path with the deadline kill rather than
        // failing a command the caller can still run synchronously.
        ctx.logger?.warn(`bash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
      }
      if (attached !== undefined) return waitOnJob(jobs, attached, exec, spec, policy)
    }

    // Foreground-only path: arm the deadline before confinement, so preparation
    // is bounded by the advertised timeout as well.
    const d = deadline(exec.signal, spec.timeoutMs, TIMEOUT_CODE)
    try {
      let prepared
      try {
        prepared = await prepareArgv(argv, policy, d.signal)
      } catch (error) {
        if (d.signal.aborted) {
          if (timeoutOf(d.signal, TIMEOUT_CODE) !== undefined) return canonicalResult(preparationTimedOut(spec, policy), spec.workdir)
          throw toolAborted()
        }
        if (policy !== undefined && policy.mode !== 'danger-full-access' && isRunnerSpawnFailure(error, argv[0], spec.workdir)) {
          throw new SandboxUnavailableError(policy.mode, String(error))
        }
        throw error
      }
      const result = await runForeground(spec, prepared, d)
      if (result.aborted) throw toolAborted()
      return canonicalResult(result, spec.workdir)
    } finally {
      d[Symbol.dispose]?.()
    }
  }

  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  /** Build the tool definition for the capabilities available right now. */
  const bashTool = () => {
    const background = backgroundEnabled && ctx.get('jobs') !== undefined
    const promotion = background && promoteEnabled
    const escalationModes = escalationTargets()
    return defineTool({
      name: 'bash',
      description: bashDescription(),
      parameters: {
        description: {
          type: 'string',
          description: 'Optional short description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
        },
        command: {
          type: 'string',
          required: true,
          description: 'The bash command to execute.',
        },
        timeoutMs: {
          type: 'number',
          description: smartTimeout.enabled
            ? `Timeout in milliseconds. Omit to use a content-aware default: ${smartTimeout.defaultSeconds}s for ordinary commands, ${smartTimeout.longSeconds}s for commands known to run long (builds, tests, installs, ...), capped at ${smartTimeout.maxSeconds}s. ${promotion ? 'On expiry the command moves to the background as a job instead of being killed.' : 'The command is killed on expiry.'}`
            : promotion
              ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.'
              : 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
        },
        ...(background
          ? {
              run_in_background: {
                type: 'boolean',
                description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
              },
            }
          : {}),
        ...(escalationModes.length > 0
          ? {
              sandbox_permissions: {
                type: 'string',
                enum: escalationModes,
                description: sandboxPermissionsDescription('command'),
              },
              justification: {
                type: 'string',
                description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user’s current request.',
              },
            }
          : {}),
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: BACKGROUND_OUTPUT_PROPERTIES,
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: PROMOTED_OUTPUT_PROPERTIES,
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: FOREGROUND_OUTPUT_PROPERTIES,
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background job ${value.jobId}`
            : value.kind === 'promoted'
              ? renderPromoted(value)
              : renderResult(value, escalationModes),
        }],
        presentationMeta: (_args, value) => ({ cwd: value.cwd }),
      },
      execute,
      presentCall: presentBashCall,
      presentResult: presentBashResult,
    })
  }

  // A tool's JSON schema and description freeze at registration, so the
  // conditions that add `run_in_background` and the escalation fields can only
  // be advertised once the `jobs` registry and the sandbox services exist.
  // Register the minimal definition first, then rebuild it as those services
  // come up (or fall back when they go away).
  let disposeTool = ctx.tools.register(bashTool())
  const refresh = () => {
    disposeTool()
    disposeTool = ctx.tools.register(bashTool())
  }
  for (const deps of [['jobs'], ['sandboxPolicy', 'sandbox']]) {
    ctx.inject(deps, (serviceCtx) => {
      refresh()
      serviceCtx.effect(() => () => {
        // cordis FiberState 2 = loaded/active; 4 = disposed. Rebuild only while
        // this plugin is still mounted.
        if (ctx.fiber?.state === 2) refresh()
      })
    })
  }
}
