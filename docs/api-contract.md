# DSH 0.2.1-rc.2 host API contract

安装版 DSH Desktop 的运行时是 `0.2.1-rc.2`。本文记录 `dsh-bash` 依赖到的宿主 API 与行为，2026-10-18 审计。

## 0. 证据与取证方式

- 安装版的源码在 Electron asar 里：`D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\<pkg>\`，**没有打包 `.d.ts`**，只有编译后的 `lib/index.js`（JSDoc 保留）。
- `read` 工具可以直接读 asar 路径；`pwsh` / `rg` / `glob` / `node` 默认读不到。
- 需要批量 grep 时用 Electron 当 Node 把文件拷出来：见 `scripts/asar-copy.mjs`（默认目标 `B:\vibe_program\tmp\dsh-api\...`）。
- 下文 `<NM>` = `D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\`。

## 1. 运行时版本

`@deepseek-ai/dsh-tool-bash/package.json` 是权威参照：所有 `@deepseek-ai/dsh-*` 精确锁 `0.2.1-rc.2`，`@deepseek-ai/cordis` 为 `~4.0.5`（安装 4.0.5），`@deepseek-ai/schemastery` 为 `~3.18.5`（安装 3.18.5）。

## 2. 服务契约

### 2.1 `@deepseek-ai/dsh-subprocess`（`ctx.subprocess`）

- `spawn(spec): SubprocessHandle`，同步返回；`spec = { argv, cwd, stdio, graceMs, signal?, env? }`；`stdio = { stdin: 'ignore' | 'pipe' | {data}, stdout/stderr: 'pipe' | 'inherit' | { maxBytes, spill?: { maxBytes } } }`（`<NM>\dsh-subprocess\lib\index.js:76-92`）。
- `SubprocessHandle = { stdin, stdout, stderr, control, collected: { stdout?: SubprocessOutputReader, stderr?: SubprocessOutputReader }, done: Promise<{exitCode,signal}>, terminate(), waitForExit(signal?) }`（`:57-73`）。
- `SubprocessOutputReader.readFrom(fromByte) -> { text, nextOffset, lossy, spillPath? }`，**非消费式**（`:38-42`）。
- `spawn` 在 pre-abort、argv/cwd/env/grace 非法时**同步抛错**；`done` 的 reject 只表示 spawn/提供方失败，普通非零退出与 kill 都 resolve（`:94-102` 的语义说明）。

### 2.2 `@deepseek-ai/dsh-jobs`（`ctx.jobs`）

```ts
start(spec: JobSpec): JobId
list(caller?: SessionId): JobView[]
get(id, caller?): JobView
read(id, caller?): JobRead              // 消费式：推进模型游标，返回自上次以来的 chunks
readAt(id, from, caller?): JobOutputRead // 非消费式
kill(id, caller?, reason?): 'requested' | 'already-finished'
wait(id, timeoutMs, caller?, signal?): Promise<JobView>
remove(id, caller?): void                // 仅对已 settled 的 job
```

- `JobSpec = { kind, label, owner?, toolCall?, outputLimitBytes?, output?: readonly JobOutputSource[], run(job): JobHooks }`；`JobHooks = { cancel(reason?), done: Promise<JobOutcome> }`；`JobOutcome = { status: 'completed' | 'killed' | 'failed', detail?, result? }`（`<NM>\dsh-jobs\lib\index.js` 类型区）。
- `JobOutputSource = { channel?, read(fromByte) -> { text, nextOffset, lossy, spillPath? } }`，由 registry 泵入 job 的输出环。
- `JobRead = { chunks, lossy, result?, job }`；`JobView.output = { total, earliest, spillPaths? }`；`JobView.status ∈ running | stopping | completed | killed | failed`。
- `start` 在「owner 没有 attached job controller」时拒绝；`remove` 只接受已 settled 的 job。

### 2.3 `@deepseek-ai/dsh-sandbox`（`ctx.sandbox`）

- `confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>`，**是 async**。
- `ConfinedArgv = { argv: string[], enforcement: 'full' | 'partial', denialSignatures: readonly string[], runnerFailureRules: readonly RunnerFailureRule[] }`。
- `RunnerFailureRule = { allowedExitCodes?: number[], fatalSignatures: string[], informationalLines?: string[] }`。
- 导出的分类/标记工具：`classifyRunnerFailure(exitCode, stderr, rules) -> {detail} | undefined`、`matchesSignature(exitCode, stderr, signatures) -> boolean`、`isRunnerSpawnFailure(error, runnerProgram, workdir) -> boolean`、`sandboxDenialMarker(mode)`、`escalationHintMarker(subject)`、`sandboxPermissionsDescription(subject)`、`SandboxUnavailableError`、`ESCALATION_TARGETS = ['workspace-write','danger-full-access']`、`approveEscalation(request, deps)`、`validateEscalationArgs(p, j)`、`canonicalPath`（`<NM>\dsh-sandbox\lib\index.js:30-289`）。
- `SandboxPolicy extends SandboxExecutionPolicy { mode: 'read-only' | 'workspace-write' }`：`danger-full-access` 不走 `confine`，直接执行。

### 2.4 `@deepseek-ai/dsh-sandbox-policy`（`ctx.sandboxPolicy`）

`{ readonly defaultMode: SandboxMode, readonly workspaceRoot: string, resolve(request?: {session?}): SandboxExecutionPolicy, overrideOf(session) }`；`SandboxExecutionPolicy = { mode, workspaceRoot, sessionId? }`。

### 2.5 `@deepseek-ai/dsh-shell`（`ctx.shell` 与渲染工具）

- `ShellExecutor`：`resolve(request) -> spec`、`execute(spec) -> Promise<ShellExecution>`、`get sandboxMode(): SandboxMode | undefined`；`ShellExecSpec = { command, workdir, timeoutMs, onExpiry: 'kill'|'none', stdoutMaxBytes, signal?, stdin?, env?, dshEnv?, sandboxPolicy }`（`<NM>\dsh-shell\lib\index.js:55-95`）。
- `parseExitStatus(text) -> { body, exitCode? } | { body, signal? }`：剥掉末尾 `[exit code: N]` / `[killed by signal: X]` 标记供终端卡片显示。
- 导出 `DSH_ENV_PREFIX = 'DSH_'`（来自 dsh-subprocess）。

### 2.6 `@deepseek-ai/dsh-tools`（`ctx.tools` / `defineTool`）

- `ctx.tools.register(definition): () => void`；`defineTool({ name, description, parameters, output: { schema, render, presentationMeta? }, execute, presentCall, presentResult })`。
- `parameters` 是「属性名 -> `{ type, required?, description?, enum?, const?, oneOf?, ... }`」的片段，顶层 required 由 `required: true` 聚合；`output.schema` 同样走受支持的 JSON Schema 子集（`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解）。
- `render(args, value) -> ContentBlock[]`；`presentResult(args, result)` 的 `result` 含 `content`、`isError`、`value`；`parseExitStatus` 用于把标记还原成终端卡片的 exit pill。
- 导出的 `TOOL_ABORTED` 常量值是 `"ABORTED"`；tool JSON schema 与描述在注册时**固化**，能力变化需要重新注册。

### 2.7 `@deepseek-ai/dsh-timeout`

`clampTimeout(requested, def, max, name?)`、`deadline(upstream, timeoutMs, code) -> { signal, [Symbol.dispose] }`（`<=0` 表示不设超时）、`timeoutOf(x, code?) -> TimeoutReason | undefined`，`TimeoutReason` 带 `code` / `timeoutMs`（`<NM>\dsh-timeout\lib\index.js:43-147`）。

### 2.8 `@deepseek-ai/dsh-system-prompt`

`section({ name, order, text }) -> disposer`；`getSectionOrder('TOOL_BASH') = 1000`、`'TOOL_PWSH' = 1010`（`<NM>\dsh-system-prompt\lib\index.js:17`）。section 名相同即相互覆盖，顺序按 `order` 再按 name。

### 2.9 `@deepseek-ai/dsh-shell-env`（`ctx.shellEnv`）

`collect(execution) -> Record<string, string>`：注入 `DSH_HOME`、`DSH_SHELL="1"`、`DSH_SESSION_ID` 等托管变量，直接作为 spawn env 的覆盖层。

### 2.10 `@deepseek-ai/dsh-working-directory`（`ctx.workingDirectory`）

`{ readonly defaultDirectory: string, get(session), ensure(agent, signal?) -> Promise<string>, set(agent, path, signal?) }`。

### 2.11 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm`

tool `exec` 提供 `agent`（`.id`、`.session`，`session.header.cwd/id`）、`callId`、`rootCallId`、`signal`、`name`。`HarnessError(message, code)` 是结构化错误基类；abort 惯用法是 `new HarnessError('tool call aborted', TOOL_ABORTED)` 再 `name = 'AbortError'`。

### 2.12 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`

`ctx.get(name)`、`ctx.inject([deps], cb)`、`ctx.effect(disposer-returning)`、`ctx.fiber.state`（**2 = loaded/active，3 = failed，4 = disposed**；`FiberState` 定义在 cordis `lib/index.js:1288-1292`）。schemastery 3.18.5 支持 `z.object/boolean/string/number/union`、`.default()`、`.required(false)`。

## 3. 对本插件的硬约束

1. `confine` 必须 `await` 并把取消信号传进去；`danger-full-access` 不调用它。
2. 通过 `ctx.subprocess` 执行时，句柄只有 `collected` 与 `terminate()`；`observed` 属于 `ctx.shell` 的进程形态，不能混用。
3. 前台等待/超时转后台必须走 `ctx.jobs`（`start` → `wait` → 超时 `read` → 留在后台），不能自己轮询输出。
4. 沙箱失败分类只能用 `dsh-sandbox` 导出的函数；前台 runner 失败抛 `SandboxUnavailableError`（fail closed），后台把 `runnerFailed` 放进 job detail。
5. 插件 bundle 从 `link:` 真实路径加载，`@deepseek-ai/*` 必须由包自己的 `node_modules` 解析 → 声明在 `dependencies`；peer 不会被装进包目录。
