# `bash` parity contract (DSH 0.2.1-rc.2)

Read-only analysis of the installed runtime. All line citations are 1-based and refer to the files below; verbatim strings are copied byte-for-byte from source (including `—` U+2014 and `’` U+2019) because they will become our tool text.

## Sources

Runtime: DSH `0.2.1-rc.2`. Everything below lives inside the Electron asar, which `pwsh`/`node`/`rg` cannot read; all reads used the `read` tool (asar-aware). Package layout follows each `package.json` `exports`/`files`.

| Alias | Absolute path (lines) |
| --- | --- |
| BASH | `D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-bash\lib\index.js` (731) |
| BASH_PKG | `...\dsh-tool-bash\package.json` (72) |
| PWSH | `...\dsh-tool-pwsh\lib\index.js` (736) |
| PWSH_PKG | `...\dsh-tool-pwsh\package.json` (72) |
| SANDBOX | `...\dsh-sandbox\lib\index.js` (289) |
| SHELL | `...\dsh-shell\lib\index.js` (95) |
| SUBPROC | `...\dsh-subprocess\lib\index.js` (103) |
| BASH_LOCAL | `...\dsh-bash-local\lib\index.js` (332) |
| PWSH_LOCAL | `...\dsh-pwsh-local\lib\index.js` (429) |
| PWSH_SANDBOX | `...\dsh-pwsh-sandbox\lib\index.js` (252) |
| SYSPROMPT | `...\dsh-system-prompt\lib\index.js` (409) |
| BASE_PKG | `...\dsh-base\package.json` (139) |
| WEBAPP_PKG | `...\dsh-web-app\package.json` (212) |

Known tool limitation: the `read` tool truncates a single source line at 2000 characters. It only affects one line here — PWSH:258, the Windows-sandbox description variant — and that variant is pwsh-only, not part of the bash contract.

## 1. Tool identity and hosting

| Fact | bash | pwsh |
| --- | --- | --- |
| Plugin export `name` | `"tool-bash"` (BASH:222) | `"tool-pwsh"` (PWSH:236) |
| Model-facing tool name (registered) | `"bash"` (BASH:493) | `"pwsh"` (PWSH:466) |
| `inject` (declared order) | `["tools","shell","systemPrompt","shellEnv","workingDirectory"]` (BASH:223-229) | identical (PWSH:237-243) |
| Config schema | `{ enableRunInBackground: z.boolean().default(true), promoteOnTimeout: z.boolean().default(true) }` (BASH:231-234) | identical (PWSH:245-248) |
| Config resolution | `backgroundEnabled = enableRunInBackground ?? true`; `promoteOnTimeout = (promoteOnTimeout ?? true) && backgroundEnabled` (BASH:341-342) | identical (PWSH:314-315) |
| Background registration variant | `ctx.tools.register(bashTool(void 0))` when background disabled; else foreground-only first, then re-register with `jobCtx.jobs` on `ctx.inject(["jobs"])` (BASH:386-388, 715-728) | identical pattern (PWSH:360-362, 720-733) |
| Job record `kind` | `"bash"` (BASH:395) | `"pwsh"` (PWSH:369) |
| Escalation approval `toolName` | `"bash"` (BASH:372) | `"pwsh"` (PWSH:346) |
| Composition guard error | `"tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing"` (BASH:346) | `"tool-pwsh: the mounted bash executor confines but ctx.sandboxPolicy is missing"` (PWSH:319) |
| Plugin package description | "Model-facing bash tool with optional generic background-job and sandbox-escalation support" (BASH_PKG:3) | "Model-facing pwsh tool over the bash executor seam" (PWSH_PKG:3) |

Both plugins are *Consumers of the `ctx.shell` capability seam* (BASH:210-216): the tool owns the model-facing contract, the executor owns spawning. `dsh-base` ships both confining executors (`dsh-bash-sandbox` at BASE_PKG:44, `dsh-pwsh-sandbox` at BASE_PKG:70); only one can register as `ctx.shell`. The installed desktop profile presents the `pwsh` tool and no `bash` tool, which indicates the pwsh sandbox executor backs the seam here (confirm against the live composition during implementation). Either way, a bash tool that actually runs Git Bash must replace the consumer *and* supply its own execution path (see §5, §7).

## 2. Side-by-side model-facing contract

### 2.1 Tool description (verbatim)

**bash** — BASH:243-245, single line, no composition-dependent variants:

```text
Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell; pass `workdir` instead of using `cd`. Managed `$DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Provide `description` before `command` in the arguments. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.
```

`$DSH_*` is interpolated from `DSH_ENV_PREFIX = "DSH_"` (SUBPROC:13, imported at BASH:6, SHELL:2).

**pwsh** — two variants selected by `pwshDescription(escalationModes.length > 0)` (PWSH:255-258, 467). Base variant (no confining executor), PWSH:256:

```text
Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\...`); read environment variables with `$env:NAME`. Managed `$env:DSH_*` variables expose current harness environment facts. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. Provide `description` before `command` in the arguments. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive, so `$home` is the same read-only variable. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way.
```

Confining variant (PWSH:258) is the same text plus an appended Windows-confinement paragraph (ConstrainedLanguage in read-only, named-pipe/EPERM boundary, "escalate the exact command once or restructure it to avoid capturing output"). Not needed for bash parity; and the read tool truncates that line at 2000 chars, so its tail could not be extracted verbatim.

Conclusion: **the bash description is fixed and composition-independent.** Do not append Windows/Git-Bash caveats to it — that would be a visible difference from the native bash tool. Environment caveats belong in plugin docs, not in the tool text.

### 2.2 Parameters — declaration order, required flag, verbatim description

Both tools declare the same ordered set; `run_in_background` and `sandbox_permissions`/`justification` are conditionally spread (BASH:514-528). Order is `description`, `command`, `timeoutMs`, `workdir`, `run_in_background?`, `sandbox_permissions?`, `justification?`.

| # | Name | Type | Required | bash description (verbatim) | pwsh difference |
| --- | --- | --- | --- | --- | --- |
| 1 | `description` | string | yes | `Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".` (BASH:499) | last example is `"Get-Process" → "List running processes".` (PWSH:472) |
| 2 | `command` | string | yes | `The bash command to execute.` (BASH:504) | `The PowerShell command to execute.` (PWSH:477) |
| 3 | `timeoutMs` | number | no | promote on: `Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.` / promote off: `Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.` (BASH:508) | identical strings (PWSH:481) |
| 4 | `workdir` | string | no | `Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.` (BASH:512) | identical (PWSH:485) |
| 5 | `run_in_background` | boolean | no | `Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.` (BASH:516); present only when a `jobs` registry is composed (BASH:514, 387) | identical (PWSH:489) |
| 6 | `sandbox_permissions` | string enum `[...escalationModes]` | no | `The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.` = `sandboxPermissionsDescription("command")` (SANDBOX:86-88; used BASH:522) | identical (PWSH:495) |
| 7 | `justification` | string | no | `Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user’s current request.` (BASH:526) | identical (PWSH:499) |

`sandbox_permissions`/`justification` appear only when `escalationModes.length > 0`, i.e. `ctx.shell.sandboxMode !== undefined`; `escalationModes = ESCALATION_TARGETS = ["workspace-write","danger-full-access"]` (BASH:343-344, SANDBOX:42).

Argument validation (before anything executes):

| Check | bash | pwsh |
| --- | --- | --- |
| empty command | `invalid command: expected a non-empty string` (BASH:236) | same (PWSH:250) |
| empty description | `invalid description: expected a non-empty string` (BASH:237) | same (PWSH:251) |
| bad timeout | ``invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`` (BASH:238) | same (PWSH:252) |
| same-mode escalation short-circuit | if `sandbox_permissions === effectiveMode` return early (BASH:239) | **absent** (PWSH:253 only calls `validateEscalationArgs`) |
| pairing rules | `sandbox_permissions` requires a justification; justification alone invalid; non-empty sentence (`invalid escalation: …`, `invalid justification: expected a non-empty sentence`) (SANDBOX:51-55, BASH:240-241) | same call (PWSH:253) |

### 2.3 Output schema — `kind` union

`output.schema = { oneOf: [...] }` in this order (BASH:530-648; PWSH:503-621): **background, promoted, foreground**. Every variant is `additionalProperties: false`; `render` and `presentationMeta` sit beside `schema` (BASH:649-653).

**`kind: "background"`** (BASH:325-339, 531-536) — required `kind` const `"background"`, `jobId`, `cwd`; no other properties allowed.

**`kind: "promoted"`** (BASH:537-563) — required `kind` const `"promoted"`, `cwd`, `jobId`, `timeoutMs` (number), `output` (string).

**`kind: "foreground"`** (BASH:564-647) — required: `kind` const `"foreground"`, `cwd`, `exitCode` (`oneOf` integer/null), `signal` (`oneOf` string/null), `timedOut` boolean, `aborted` boolean, `timeoutMs` number, `stdout`, `stderr`; optional: `stopped` (string), `sandbox` (object: required `mode` string + `denied` boolean, optional `enforcement` string, `runnerFailed` boolean). `stdout`/`stderr` each require `text` string + `truncated` boolean, optional `spillPath` string (BASH:598-629).

The executor DTO is canonicalized field-by-field in `canonicalBashResult` (BASH:295-317): `cwd`, `exitCode`, `signal`, `timedOut`, `aborted`, `timeoutMs`, `stdout`/`stderr` projected to `{text,truncated[,spillPath]}`, and `sandbox` projected to `{mode,denied[,enforcement][,runnerFailed]}` — nothing else from the executor crosses into the tool result. In bash the `kind` field is added at the call sites (BASH:486, 706); in pwsh it is inside `canonicalPwshResult` (PWSH:275). Result is identical.

### 2.4 `render()` — the exact text the model sees

`render: (_args, value) => [{type:"text", text: …}]` with `background → "started background job ${jobId}"`, `promoted → renderPromoted(value)`, else `renderResult(value, escalationModes)` (BASH:649-652).

**Foreground body assembly** (BASH:135-171, identical in PWSH:141-176):

1. `stdoutText = streamText(stdout)`; if `truncated`, append `\n[output truncated; full output: ${spillPath ?? "(unavailable)"}]` (BASH:135-138).
2. Same for stderr, then if stderr non-empty: newline-join stdout (only if it doesn't already end with `\n`) + `[stderr]\n` + stderr (BASH:150-157).
3. Empty body becomes `(no output)` (BASH:158).
4. Markers are appended in **this fixed order**, one per line, each preceded by a newline if the body doesn't end with one (BASH:159-170):

| # | Condition | Verbatim text |
| --- | --- | --- |
| 1 | `sandbox.denied` | `[sandbox: file access denied under ${mode} mode]` = `sandboxDenialMarker` (SANDBOX:64-66) |
| 2 | #1 and `escalationModes.length > 0` | `[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]` = `escalationHintMarker("command")` (SANDBOX:76-78) |
| 3 | `timedOut` | `[timed out after ${timeoutMs}ms]` (BASH:164) |
| 4 | `stopped !== undefined` | `[stopped: ${stopped}]` (BASH:165) |
| 5 | `signal !== null` | `[killed by signal: ${signal}]` (BASH:166) |
| 6 | else `exitCode !== 0` | `[exit code: ${exitCode}]` (BASH:167) |

A clean exit (0, no signal, no flags) yields no marker. Non-zero exits are **reported, not errored** — `isError` is reserved for infrastructure failures (spawn errors, aborts) (BASH:139-143, 704-705).

Note: `renderResult` does **not** emit the runner-failure marker; that marker exists only on the job-read path (BASH:200) — see §4.

**Promoted text** (BASH:181-183, verbatim):

```text
${output-so-far}${if output non-empty and not ending in "\n": "\n"}[still running after ${timeoutMs}ms; moved to background job ${jobId}]
The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.
```

The `output-so-far` is one consuming registry read rendered as `renderJobRead(ringDelta(chunks), lossy, spillPaths, proc.sandbox, escalationModes)` (BASH:471-480). `ringDelta` concatenates stdout chunks in order then, if any stderr chunks, `[stderr]\n` + all stderr (BASH:88-93). `renderJobRead` appends notices after the delta (BASH:197-207): lossy → `[some output was dropped from memory; full output: ${spillPaths.join(", ") || "(unavailable)"}]`; `sandbox.runnerFailed` → `[sandbox: the sandbox runner itself failed under ${mode} mode — the command did not run; this is a sandbox problem, not a command failure]`; else `sandbox.denied` → denial marker + (if escalation offered) hint marker.

**Background text**: just `started background job ${jobId}` (BASH:651); no output in the result.

### 2.5 systemPrompt section — name, order, text

| | bash | pwsh |
| --- | --- | --- |
| Registration | BASH:376-380 | PWSH:350-354 |
| `name` | `"tool:bash"` | `"tool:pwsh"` |
| `order` | `ctx.systemPrompt.getSectionOrder("TOOL_BASH")` = **1000** (SYSPROMPT:17) | `...("TOOL_PWSH")` = **1010** (SYSPROMPT:18) |
| `text` (verbatim) | `Check the [exit code: N] marker on every bash result; investigate failures before moving on.` | `Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.` |
| Placement rule | sections sort by `order`, then name (SYSPROMPT:100-103); this puts bash before pwsh before `TOOL_READ` (1100) | — |

Our plugin must register exactly `name: "tool:bash"`, `order: getSectionOrder("TOOL_BASH")` (1000), and the bash text above. Registering a different section name would let both texts coexist and change the prompt.

### 2.6 `presentCall` / `presentResult` / `presentationMeta` (UI contract)

`presentCall(args)` (BASH:246-263; pwsh inline PWSH:680-697):

- `run_in_background === true` → `{ card: "generic", title: args.command, kind: "execute", rawInput: args.command, content: [{ type: "text", text: args.description }] }`
- otherwise → `{ card: "terminal", title: args.command, description: args.description, ...(args.workdir !== undefined ? { cwd: args.workdir } : {}) }`

`presentResult(args, result)` (BASH:268-287; pwsh inline PWSH:698-717):

- Takes `result.content[0]` only if it is a single text block; anything else → `undefined` (falls back to default rendering).
- If `args.run_in_background === true`, or `result.value?.kind === "promoted"`, or `result.isError` → `{ card: "generic", content: [{ type: "text", text: "```console\n" + raw.replace(/\n+$/, "") + "\n```" }] }`
- otherwise → `card: "terminal"`, `output: body`, plus the exit pill recovered by `parseExitStatus(raw)`.

`parseExitStatus` (SHELL:31-46) is the inverse of the marker contract: `/\n\[killed by signal: ([^\]\n]+)\]$/` → `{body, signal}`; else `/\n\[exit code: (\d+)\]$/` → `{body, exitCode:Number}`; else `{body, exitCode: 0}`. The consumed marker is removed because the terminal card shows the status as its own pill; timeout/stopped/sandbox markers stay in the body.

`presentationMeta: (_args, value) => ({ cwd: value.cwd })` (BASH:653; PWSH:626) — for all three kinds.

Client-side note (limit): the task names a shipped client toolview plugin `bash-toolview-sample`. It is **not present in the installed runtime**: no such dependency in `@deepseek-ai/dsh-base` (BASE_PKG:36-132) or `@deepseek-ai/dsh-web-app` (WEBAPP_PKG:57-192); the only bash-related client package is the generic `@deepseek-ai/dsh-client-ui-tool` (WEBAPP_PKG:121); the profile patch/config lists no such plugin (`C:\Users\wjun\.dsh\profiles\desktop\cordis.patch.yml`, `package.json`), `app.asar.unpacked` has no `*toolview*` file, and a profile-wide grep was defeated by dangling profile `node_modules` links. Conclusion: it is a repository sample, not part of this install. The rendering contract the UI consumes is therefore exactly the Host cards above: a client toolview keyed by the tool name `bash` will attach to our registration as long as (a) the tool name is literally `bash` and (b) the result `value` matches the `kind` union in §2.3 with the same field names. **Correction:** the live Slot inspection (Client `Slots.listSubTree` on `tool.call.toolview`) reports an active occupant `bash-toolview-sample` with `key: "bash"`; live registration supersedes this package search — see §8.

## 3. `promoteOnTimeout` end-to-end (exists in native bash)

Yes: `promoteOnTimeout` exists in **both** bash and pwsh, defaults `true`, and is gated on the background registry: `promoteOnTimeout = (config.promoteOnTimeout ?? true) && backgroundEnabled` (BASH:233-234, 342; PWSH:247-248, 315). The registered parameter description for `timeoutMs` changes accordingly (BASH:508). It also requires a composed jobs registry: `promote = background && promoteOnTimeout` where `background = jobs !== undefined` (BASH:387-388).

Path in native bash for an ordinary (non-`run_in_background`) call:

1. **Resolve policy + cwd**: `resolveSandboxPolicy(exec)`, `validateBashArgs`, optional escalation approval, `cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)`, `workdir = resolveWorkdir(args.workdir, cwd)`, `dshEnv = ctx.shellEnv.collect(exec)` (BASH:655-672).
2. **Resolve spec with no executor deadline**: `spec = ctx.shell.resolve({...request, onExpiry: "none"})` — the executor arms no deadline, so the process is not killed at expiry; the tool owns the wait (BASH:687-691; executor semantics SHELL:60-81; `onExpiry` default is `"kill"` — BASH_LOCAL:97).
3. **Register the job first, spawn inside the starter**: `startJob` calls `registry.start({kind:"bash", label:args.command, toolCall:{callId,rootCallId}, owner, output: processSources(...), run(){...}})` and returns `{id, process:()=>proc, stopped:()=>stopped}` (BASH:390-423). The job is admitted before the spawn; `run()` wraps `processJob(async signal => proc = await ctx.shell.execute({...spec, signal}), started => processOutcome(started, escalationModes))`. Job hooks are `{done, cancel}`; `cancel(reason)` records `stopped = reason` **then** aborts/kills (BASH:403-419).
4. **If registration throws, degrade**: `ctx.logger.warn("bash: job registration refused, running in the foreground with the timeout kill instead: …")` and fall through to the foreground-only path (BASH:692-699). Default foreground path: `ctx.shell.resolve({...request, signal: exec.signal})` (onExpiry default `"kill"`), then `await (await ctx.shell.execute(spec)).result()`, `if (result.aborted) throw toolAborted()`, return `{kind:"foreground", ...canonicalBashResult(...)}` (BASH:700-709).
5. **Wait**: `view = await registry.wait(attached.id, timeoutMs, owner, exec.signal)` where `timeoutMs = spec.timeoutMs` (BASH:425-442). Cancellation of the *call* throws → `stop("tool call aborted")` (kill + wait for settlement + conditional `registry.remove`) and then throws the structured abort (BASH:434-446, 318-323: `HarnessError("tool call aborted", TOOL_ABORTED)` with `name = "AbortError"`).
6. **Preparation-timeout edge**: if the view is still `running`/`stopping` but `attached.process() === undefined` (the spawn never happened), `stop("timed out during preparation")` and return a settled foreground `kind:"foreground"` with `exitCode:null, signal:null, timedOut:true, aborted:false, timeoutMs`, both streams `{text:"",truncated:false}`, and `sandbox:{mode,denied:false}` when a policy exists (BASH:447-470). The model sees `(no output)` + `[timed out after Nms]`.
7. **Promote**: if still `running`/`stopping` with a live process, take **one consuming registry read** — `read = registry.read(attached.id, owner)` — and return `{kind:"promoted", cwd: spec.workdir, jobId: attached.id, timeoutMs, output: renderJobRead(ringDelta(read.chunks), read.lossy, read.job.output.spillPaths ?? [], attached.process()?.sandbox, escalationModes)}` (BASH:471-480). The job is **not** killed and **not** removed: it stays alive with its id, and the model is notified on completion through the job machinery. Because the read is consuming, later `job_output` calls continue exactly after this point.
8. **Settled within the wait**: `registry.remove(attached.id, owner)`, then `process = attached.process()`; if `undefined` throw `new Error(view.detail)`; `result = await process.result()`; return `{kind:"foreground", ...canonicalBashResult(result, spec.workdir), ...(stopped !== undefined ? {stopped} : {})}` (BASH:481-491). `stopped` is present when the call itself stopped the job during the wait (e.g. an aborted-but-not-thrown path) and renders `[stopped: reason]`.
9. **Render/card choice**: output `kind:"promoted"` → `render()` emits `renderPromoted` (still-running line + hand-off guidance) and `presentResult` chooses the **generic** card with a ```console fence instead of the terminal card with the exit pill (BASH:273-280). So a promoted call looks deliberately different from a completed one in the UI: no exit-status pill, no terminal card.

`enableRunInBackground: false` disables both the `run_in_background` parameter and promotion: `promoteOnTimeout` is forced false, and the plugin registers a foreground-only tool whose executor deadline kills on expiry (BASH:341-342, 386-388, 715-718).

## 4. Background-job path (native contract)

- **Hooks**: `registry.start({kind:"bash", label: args.command, toolCall:{callId, rootCallId}, owner: exec.agent.id, output, run})` (BASH:393-419). `run()` returns `{done, cancel}`; `done` resolves to the job outcome, `cancel(reason)` records `stopped` and aborts/kills (BASH:400-423).
- **Output pull sources**: `output: processSources(() => proc)` → `[{channel:"stdout", read(fromByte)}, {channel:"stderr", read(fromByte)}]`, each lazily bound to `proc().observed[channel].readFrom(fromByte)`; before the spawn it returns `{text:"", nextOffset: fromByte, lossy:false}`. These are **non-consuming** readers, so the pump never moves the model's consuming cursor, and a rejected spawn's stderr reader carries `subprocess failed before reporting an outcome: …` (BASH:56-79; BASH_LOCAL:227-242).
- **Terminal outcome vocabulary** (`processOutcome`, BASH:31-55): `proc.status === "killed"` → `{status:"killed", detail: proc.signal !== null ? "signal: <sig>" : "killed before exit"}`; everything else → `{status:"completed", detail: "exit code: <exitCode ?? 0>"}`. A nonzero command exit is `completed`, never `failed`. Sandbox facts join the detail: `detail + "; " + notes.join(" ")` where notes are the runner-failure marker or denial marker (+ escalation hint) (BASH:22-30). `failed` exists only for job-infrastructure errors (`processJob` catch, BASH:118-123: `status: aborted && proc === undefined ? "killed" : "failed"`, detail = error message).
- **Spawn/failure semantics**: `processJob` creates its own `AbortController`, starts the process with job-owned cancellation, and if the controller was aborted before the handle existed, kills the just-started process; `done` includes preparation + process settlement (BASH:94-126).
- **Background return value**: `{kind:"background", jobId, cwd: spec.workdir}` immediately after `startJob(...).id` (BASH:673-686); spec resolved with `onExpiry: "none"` so no executor deadline applies (BASH:677-680; the parameter text promises "No timeout applies"). Guards/errors: `run_in_background is disabled for this deployment (enableRunInBackground: false)`; `background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`; aborted signal → `toolAborted()` (BASH:674-676).
- **Cancellation**: `job_kill` → registry → job `cancel(reason)` → `stopped = reason`; `processJob.cancel` aborts the controller (reason preserved as the signal reason) and kills the live handle if it exists (BASH:104-108, 413-416). In the foreground wait path, cancellation is done by the tool itself via `registry.kill(id, owner, reason)` + `registry.wait` + conditional `registry.remove` (BASH:434-439).
- **Job statuses observed by the tool**: `view.status` is `"running"` or `"stopping"` while live, any other settled status otherwise; `read.job.output.spillPaths` advertises complete-stream files (BASH:437, 447, 471-478). Background rendering is only `started background job <id>`; subsequent output comes from the separate `job_output` tool.

For our Windows tool there is no change to this contract: job `kind` must stay `"bash"`, sources must be non-consuming, and the outcome vocabulary must be identical, because the jobs UI/roster and `job_output`/`job_kill` render these records generically.

## 5. Sandbox behavior: who produces facts, who classifies

The tool **never classifies** anything. It renders facts someone else settled.

- **Executor facts on a settled foreground result** (`result.sandbox`): `{mode, denied, enforcement?, runnerFailed?}` — exactly the fields canonicalized at BASH:310-315 and declared optional at BASH:630-645.
- **Who fills them**: the confining executor subclass. `dsh-pwsh-sandbox` is the shipped example; its header states it is "the pwsh twin of `@deepseek-ai/dsh-bash-sandbox`" and a "deliberate call-for-call mirror" (PWSH_SANDBOX:5-9, 96-107). Its `execute` returns, for `danger-full-access`, `sandbox:{mode, denied:false}`; otherwise it calls `ctx.sandbox.confine(argv(…), policy, signal)` and decorates the result with `{mode, denied: classifyDenial(result, denialSignatures), enforcement}`, while retagging the process with `{mode, enforcement, denialSignatures, runnerFailureRules, runnerProgram: argv[0], workdir}` for background settlement (PWSH_SANDBOX:151-205, 162-179).
- **Classification helpers** (all in `dsh-sandbox`, SANDBOX:176-249; mirrored inside PWSH_SANDBOX:12-93):
  - `matchesSignature(exitCode, stderr, signatures)` — nonzero exit and case-insensitive stderr substring match against the active wrap's `denialSignatures` → `denied` (SANDBOX:245-249; PWSH_SANDBOX:89-93).
  - `classifyRunnerFailure(exitCode, stderr, rules)` — for each `runnerFailureRules` entry gated by `allowedExitCodes`, scans stderr lines, skipping exact `informationalLines` (lowercased), looking for a `fatalSignatures` substring; returns `{detail: line}` (SANDBOX:224-237).
  - `isRunnerSpawnFailure(error, runnerProgram, workdir)` — only Node `ENOENT`/`EACCES` whose `path` (or exact `spawn <runner>` syscall) identifies `argv[0]`, and only when the caller-owned cwd is independently usable (SANDBOX:203-213).
  - Runner failure on a **foreground** call throws `SandboxUnavailableError` (`SANDBOX_UNAVAILABLE`, fail-closed) instead of returning a result (PWSH_SANDBOX:190-191, 200-204; SANDBOX:264-275). On a **background** process it sets `proc.sandbox.runnerFailed = true` (PWSH_SANDBOX:224-237).
- **What the tool does with the facts** (BASH:22-30, 160-163, 197-207): denied → `sandboxDenialMarker(mode)` + `escalationHintMarker("command")` when escalation is advertised; runnerFailed on a job read → the "sandbox runner itself failed…" marker; background detail → same markers appended after `exit code: N`/`signal: X`.
- **Escalation surface** (only when the mounted executor advertises confinement): `escalationModes = ESCALATION_TARGETS` from `ctx.shell.sandboxMode`; `sandboxPolicy = ctx.get("sandboxPolicy")` (required, else the plugin throws at load); per call `policy = sandboxPolicy.resolve({session} or {})`; a request is resolved *before* execution via `approveEscalation({requestedMode, justification, effectiveMode, subject:"command"}, {approver: ctx.get("approval"), agent, callId, toolName:"bash", signal})`; strictly-wider table `read-only → [workspace-write, danger-full-access]`, `workspace-write → [danger-full-access]`; `allowed-once` returns the mode for this call only; `rejected`/`cancelled`/`unavailable` throw (BASH:343-375, SANDBOX:30-42, 99-123). Approval prompt text comes from `approveEscalation`: `escalate sandbox to ${mode}: ${justification}` with `displayReason.en = "Allow this operation with ${mode} permissions: ${justification}"` (SANDBOX:105-115).

**Consequence for our plugin — it must not call `ctx.shell.execute`.** If we spawn Git Bash directly through `ctx.subprocess`, we bypass `dsh-bash-sandbox`/`dsh-pwsh-sandbox` entirely and therefore must reproduce, in our own execution path, everything those executors do:

1. keep the same `resolve()` semantics so `timeoutMs` default/cap and the `[timed out after Nms]` value match (bash-local defaults: `timeoutMs 120000`, `maxTimeoutMs 600000`, `maxOutputBytes 64000`, `maxSpillBytes 64 MiB`, `graceMs 3000`; BASH_LOCAL:69-76);
2. spawn with `{argv, cwd: workdir, stdio:{stdin:"ignore", stdout/stderr: collect(maxBytes) with spill cap}, graceMs, signal, env:{NO_COLOR:"1", TERM:"dumb", PAGER:"cat", GIT_PAGER:"cat", ...spec.env, ...spec.dshEnv}}` (BASH_LOCAL:22-27, 107-128);
3. implement the `onExpiry:"kill"` deadline via the shared timeout helpers (`deadline(signal, timeoutMs, "BASH_TIMEOUT")`, `timeoutOf(...)`) so first-cause `timedOut`/`aborted` classification matches (BASH_LOCAL:157-180; SHELL:68-81);
4. expose a handle with `status/exitCode/signal`, non-consuming `observed.{stdout,stderr}.readFrom(offset)`, `done`, `kill()`, and `result()` → `{exitCode, signal, timedOut, aborted, timeoutMs, stdout:{text,truncated,spillPath?}, stderr:{…}}` (BASH_LOCAL:246-317; consumption shape at BASH:295-317);
5. preserve the provider-failure note `subprocess failed before reporting an outcome: ${detail}` on the observed stderr reader, and settle the handle as `killed` with `result()` rejecting the same error (BASH_LOCAL:227-278);
6. for confinement parity, either (a) call `ctx.get("sandbox").confine(bashArgv, policy, signal)` ourselves and classify with `classifyRunnerFailure`/`matchesSignature`/`isRunnerSpawnFailure` + `SandboxUnavailableError`, setting `proc.sandbox` the same way (PWSH_SANDBOX:151-237), or (b) omit `sandbox` from every result and never advertise `sandbox_permissions` — which is a visible parity break in any confining composition. Recommendation: (a). Note the escalation advertisement decision in native bash reads only `ctx.shell.sandboxMode`; our plugin can keep injecting `shell` *solely* to read that fact and `ctx.shell.resolve()`, while never calling `ctx.shell.execute`.

## 6. What our Windows Git-Bash `bash` tool must reproduce

Each item is model- or UI-visible; matching it is required for indistinguishability.

- Tool name exactly `bash`, verbatim bash description (BASH:243-245), parameter order/required flags/verbatim descriptions (§2.2), conditional `run_in_background` / `sandbox_permissions` / `justification`. **Justification:** description and schema are serialized into the model's tool list; any wording drift is directly observable.
- systemPrompt section `name:"tool:bash"`, `order: getSectionOrder("TOOL_BASH")` = 1000, text `Check the [exit code: N] marker on every bash result; investigate failures before moving on.` **Justification:** the section is injected into every prompt at a fixed position (SYSPROMPT:17, 100-103).
- Output schema exactly the three-variant `oneOf` in order background/promoted/foreground with the same required sets, `additionalProperties:false`, and the same optional `sandbox`/`stopped`/`spillPath` fields (§2.3). **Justification:** schema is model-visible and the client toolview validates/reads `kind`.
- `render()` text byte-for-byte: marker vocabulary *and order* (`[sandbox: …]`, escalation hint, `[timed out after Nms]`, `[stopped: …]`, `[killed by signal: X]` else `[exit code: N]`), `[stderr]` section, `(no output)`, truncation notice, `started background job <id>`, promoted text. **Justification:** these strings are the model's only signal; `parseExitStatus` and the terminal pill depend on their exact shapes (SHELL:31-46).
- `presentCall` terminal card `{title: command, description, cwd?}`; background call generic card `{title, kind:"execute", rawInput, content:[description]}`; `presentResult` generic fenced ```console card for background/promoted/isError and terminal card + exit pill otherwise; `presentationMeta: {cwd}`. **Justification:** the shipped client renders from these payloads; the same card types must arrive for the transcript to look identical.
- `promoteOnTimeout` + `enableRunInBackground` config with the same defaults and gating, jobs registration `kind:"bash"`, no executor deadline on the promote path (`onExpiry:"none"`), one consuming read + `kind:"promoted"` + job left alive, and the prep-timeout `[timed out after …]` fallback (§3). **Justification:** both tools ship it on by default; without it a long command returns a card/exit shape the native bash never produces.
- Background path: registry `start/wait/read/kill/remove`, non-consuming stdout/stderr pull sources, outcome vocabulary `completed`/`killed`/`failed` with `exit code: N` / `signal: X` / `killed before exit`, sandbox notes appended. **Justification:** `job_output`/`job_kill` and the jobs roster render these generically (§4).
- Validation error strings and the same-mode escalation short-circuit (BASH:235-242); `HarnessError("tool call aborted", TOOL_ABORTED)` with `name:"AbortError"` for aborts; non-zero exits reported as text, never `isError`. **Justification:** error text and error-ness are visible to the model and the UI.
- cwd handling: `ctx.workingDirectory.ensure(exec.agent, exec.signal)` then bash's exact relative resolution — string concat `${sessionCwd}${sep}${modelWorkdir}` (BASH:288-293), **not** pwsh's `path.resolve` (PWSH:263). **Justification:** the returned `cwd`, the presentationMeta, and a relative `workdir` with `..`/`.` would otherwise differ from native bash.
- `dshEnv = ctx.shellEnv.collect(exec)` merged into the child env after the color/pager overrides (BASH:665, BASH_LOCAL:122-126), so `$DSH_*` facts promised by the description exist. **Justification:** the description advertises them.

## 7. What legitimately differs

- **No `ctx.shell` executor for bash.** Our plugin spawns `bash.exe` itself via `ctx.subprocess.spawn`; the native bash tool only delegates to whatever backs `ctx.shell` (BASH:210-216, 405-409, 704). We consequently own the executor mechanics listed in §5 (deadline, collect/spill, grace, provider-failure note, observed readers, kill/result). Where feasible, keep injecting `shell` to read `sandboxMode` and `resolve()` for identical defaults, but never call `ctx.shell.execute`.
- **Executable resolution.** bash-local spawns bare `"bash"` and relies on PATH plus argv `["bash","-c",command]` (BASH_LOCAL:140-146); we must resolve Git for Windows `bash.exe` explicitly (config `bashPath`, probing `Program Files\Git\bin\bash.exe`, PATH, etc., mirroring how `resolvePwshPath` probes candidates — PWSH_LOCAL:23-65). Any documented lookup order is our own.
- **No WSL.** Git Bash is an MSYS2 environment: `/c`, `/d` mounts instead of `/mnt/c`; `/tmp` lives on C:; `ln -s`/`chmod`/execute bits are no-ops; `$USER`/`$LOGNAME` are empty (`$USERNAME` is set); cmd built-ins emit GBK; Windows programs emit `\r\n`; native-PE arguments beginning with `/` are rewritten unless `MSYS2_ARG_CONV_EXCL='*'`. The tool cannot hide these; do **not** add them to the tool description (that would break verbatim parity) — document them in the plugin README/skill.
- **Force-killed processes.** Native bash's description has no "settles as `[exit code: 1]`" sentence (contrast PWSH:256 and PWSH:353's systemPrompt text). Our renderer is identical, but our executor will genuinely observe Windows termination as exit code 1 with `signal:null`, so the model sees `[exit code: 1]` where a POSIX bash would have shown `[killed by signal: SIGKILL]`. That is an OS fact, not a contract difference; do not add a marker to compensate.
- **No mandatory sandbox confinement for bash on this host.** `dsh-base` ships both confining executors (`dsh-bash-sandbox` BASE_PKG:44, `dsh-pwsh-sandbox` BASE_PKG:70); this profile's visible shell tool is pwsh, so the mounted executor is most likely the pwsh sandbox one. Its `confine` is built around the pwsh argv (`this.argv(spec)` — PWSH_SANDBOX:247-249), while bash's own confining executor is `dsh-bash-sandbox`, a call-for-call mirror (PWSH_SANDBOX:5-9). Whether the Windows ACL restricted-token runner can wrap `bash.exe` is an open implementation question. If we do not confine, results omit `sandbox` and `sandbox_permissions` must not be advertised — a documented, deliberate gap.
- **Plugin identity.** Our package/export name (`dsh-bash`, its own `name` export) may differ from `"tool-bash"` (BASH:222); only the registered tool name, prompt section name/order, schema, render text, and cards are contract. Config field names (`enableRunInBackground`, `promoteOnTimeout`) should stay identical to keep deployment patches interchangeable.
- **`stopped` in the promoted/timeout path.** In native bash `stopped` can only surface on the settled foreground path (BASH:485-490); promotion never carries it. Keep that shape rather than inventing a `stopped` on promoted.

## 8. 实现落点（本仓库）

- lib/index.js 逐字复刻上述契约；执行层按 §5 第 1-6 条自行实现（spawn / deadline / collect+spill / grace / runner-failure 分类 / observed readers）。
- 与 §2.6 的客户端限制不同：**live Slot 查询**显示 `tool.call.toolview` 的 `bash` 键已被内置 `bash-toolview-sample` 占用（registrant 可见、active），因此本插件不提供 client bundle，直接复用该卡片；§2.6 的「未安装」结论只说明按包名在安装目录/profile 里没找到，live 注册为准。
- 实测记录见 docs/verification.md。

