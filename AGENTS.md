# dsh-bash

Windows 上用 Git for Windows 提供 `bash` 工具的 DSH 插件。面向用户的使用说明见 [README.md](README.md)。

## 目标与验收线

- 工具名必须是 `bash`，与原生 `pwsh` 平级；模型和 UI 不应看出它和原生 `bash` 工具的区别。
- 对齐对象：DSH 0.2.1-rc.2 的 `@deepseek-ai/dsh-tool-bash`（描述、参数、输出 schema、渲染文本、systemPrompt 段、卡片、job 契约）。逐条对照见 docs/parity.md。
- 差异只允许在「执行层」：不经过 `ctx.shell` 执行器，自己用 `ctx.subprocess` 拉起 Git Bash，并自己调用 `ctx.sandbox.confine`。

## 文件结构

```
index.js            兼容入口（重新导出 lib/index.js）
lib/index.js        Host 插件：工具注册、执行、job、沙箱、渲染
lib/git-bash.js     bash.exe 探测（唯一不依赖 DSH 包的模块，可单测）
test/git-bash.test.js  node --test
cordis.patch.yml    bundle 激活行（id: dsh-bash，name: @wjunhere/dsh-bash）
docs/               parity / API 审计 / 评审 / 验证记录
scripts/            asar 源码导出脚本
```

## 关键约定（改动前必读）

1. **模型可见文本逐字对齐**。工具描述里的 `$DSH_*`、`[exit code: N]`、`[stderr]`、`(no output)`、`[timed out after Nms]`、`[still running after Nms; moved to background job X]` 等字符串都是从原生命令逐字抄来的，改一个字符就是行为漂移。不要在工具描述里塞 Windows 注意事项（那些放 README/docs）。
2. **执行层要点**（原生 `dsh-bash-local` 的等价实现）：
   - `ctx.sandbox.confine(argv, policy, signal)` 是 **async**（0.2.1-rc.2），必须 `await`，否则 argv 是 undefined；
   - `ctx.subprocess.spawn` 的句柄用 `handle.collected.{stdout,stderr}`（不是 `observed`），停止用 `handle.terminate()`（不是 `kill()`）；`handle.done` resolve `{exitCode,signal}`，只有 spawn/提供方失败才 reject；
   - 超时用 `deadline(signal, timeoutMs, 'BASH_TIMEOUT')` + `timeoutOf`，输出上限 64KB、spill 64MB、grace 3000ms；
   - 子进程 env 固定注入 `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat`，再叠加 `ctx.shellEnv.collect(exec)` 的 `DSH_*`；
   - 沙箱分类直接用 `@deepseek-ai/dsh-sandbox` 导出的 `classifyRunnerFailure` / `matchesSignature` / `isRunnerSpawnFailure`，不要自己实现。
3. **超时转后台（promoteOnTimeout）**：先注册 job（`ctx.jobs.start`，`kind: 'bash'`）再在 starter 里 prepare + spawn；`jobs.wait(id, timeoutMs, owner, signal)`，超时仍活着就做一次**消费式** `jobs.read(id, owner)`，返回 `kind: 'promoted'` 并让 job 继续跑；正常结束则 `jobs.remove` 并返回 foreground；准备阶段超时按原生的「准备超时」返回无输出 `timedOut`。
4. **工具注册时机**：tool schema 在注册时固化。`run_in_background` 依赖 `jobs`，`sandbox_permissions` 依赖 `sandboxPolicy` + `sandbox`；先注册最小定义，再 `ctx.inject([...])` 后重建（见 lib/index.js 末尾）。
5. 模块解析：本插件是 profile bundle，从软链接真实路径加载，**必须有自己的 `node_modules`**（`npm install`）。DSH 运行时包（dsh-tools/dsh-llm/dsh-sandbox/dsh-shell/dsh-timeout）声明在 package.json 的 `dependencies` 里，不要改回 peerDependencies（peer 不会被装进本目录，加载即 ERR_MODULE_NOT_FOUND）。

## DSH API 资料（关键手段）

安装版 DSH 的源码在 asar 里，shell / rg / node 都读不到，但两种方式可以：

- `read` 工具能直接读 `D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\<pkg>\lib\index.js`（.d.ts 没有打包）；
- 需要批量 grep 时，用 Electron 当 Node 把文件拷出来（脚本已入库）：
  `$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\dsh\DeepSeek Harness.exe' B:\vibe_program\dsh-bash\scripts\asar-copy.mjs`
  目标目录默认 `B:\vibe_program\tmp\dsh-api\...`，可用 `DSH_ASAR_SOURCE` / `DSH_ASAR_DEST` 覆盖。

`docs/api-contract.md`（宿主 API 审计）和 `docs/parity.md`（原生 bash/pwsh 行为对照）是这两条路径的产物，改动执行层前先看。

## 已知限制

- **错误元数据**：插件从自己的 `node_modules` 解析 `@deepseek-ai/dsh-llm`/`dsh-tools`（profile bundle 从软链接真实路径加载，peer 不会被装到本目录），而宿主用 asar 里的那份 `HarnessError` 做 `instanceof` 判断，所以本工具抛出的 abort / `SANDBOX_UNAVAILABLE` 在持久化的 `tool/result` 里只有文本，没有 `error.info` 结构化码。文本与 `isError` 不受影响。根治需要宿主为插件做模块别名，属 DSH 侧能力。
- **沙箱未实测**：默认 profile 是 `danger-full-access`，`read-only` / `workspace-write` 下的 confine、拒绝标记与提权审批还没有现场证据；ACL runner 能否包住 `bash.exe` 仍是开放问题。
- **源码文案来源**：模型可见描述/渲染文本与执行语义对齐 `@deepseek-ai/dsh-tool-bash`（DeepSeek Harness，MIT），改动时以 `docs/parity.md` 的逐字引用为准。

## 发布

- npm 包名 `@wjunhere/dsh-bash`（public）；仓库内插件 id / cordis `name` 仍是 `dsh-bash`，两者不要混。
- 发布前：`npm test` 全绿、`git status` 干净、提交已推送；`npm publish`（`publishConfig.access` 已设 public）。
- 发布后核对：`npm view @wjunhere/dsh-bash version`，并在空目录 `npm install @wjunhere/dsh-bash` 验证 tarball 内容完整。
- 本地开发用 `link:` 安装，改 `package.json` 的 name 后必须重装 bundle（cordis 不会热加载）。

## 验证流程

1. `npm test`（探测逻辑）；
2. `plugin_manager install_bundle` 指向本目录，确认 `application: applied` 且无 warnings；
3. 装好后本会话工具列表会直接多出 `bash`（cordis 热加载）；实测：基础输出 / stderr / exit code / UTF-8 / workdir / 超时转后台 + `job_output` / 前后台 job / 超长输出截断 / 无效 workdir 报错；
4. 改代码后 cordis 不会自动重载，必须 `remove_bundle` + `install_bundle` 再复用；
5. 验证记录写在 docs/verification.md。
