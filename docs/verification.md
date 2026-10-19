# 验证记录

环境：DSH Desktop 0.2.1-rc.2，profile `desktop`，Windows，Git for Windows 2.53.0，`bashPath` 未配置（自动探测到 `D:\software\git\Git\bin\bash.exe`）。
验证时间：2026-10-18。仓库更名为 `dsh-bash` 后重新 `npm install`、重新安装 bundle，并重跑冒烟用例。

## 前置与安装

1. 本仓库目录执行 `npm install`。profile 记录的是 `link:B:\vibe_program\dsh-bash`，插件从软链接真实路径加载，运行时包由本目录自己的 `node_modules` 解析；缺了它加载即失败。
2. `plugin_manager install_bundle`（本地目录）→ `application: applied`，`warnings: []`。
3. 早期安装曾因缺少 `node_modules` 报 `failed to import: Cannot find package '@deepseek-ai/schemastery'`；补 `npm install` 并把运行时包从 `peerDependencies` 改为 `dependencies` 后恢复。

| 检查项 | 结果 |
| --- | --- |
| 工具出现在会话工具表 | 是，名称 `bash`，参数与原生 bash 一致（含 `run_in_background`、`sandbox_permissions`/`justification`） |
| cordis 行是否持久 | `Config` 检查可见 `include:dsh-bash`；profile `dsh.profile.bundles` 含 `dsh-bash`，`dependencies` 为 `dsh-bash: link:B:/vibe_program/dsh-bash` |
| 是否残留旧包 | profile 的 `package.json` / lockfile 里不再有旧包名 |
| 卡片 | Client `Slots.listSubTree`（root `tool.call.toolview`）返回 occupant：`registrant: bash-toolview-sample, key: "bash", active: true` → 复用内置卡片，本插件不提供 client bundle |
| 文件变更后的生效方式 | cordis 不会因源码文件变化自动重载本插件；必须 `remove_bundle` + `install_bundle` 才会加载新代码 |

## 实测（全部在本会话直接调用 `bash` 工具）

| 用例 | 命令 / 参数 | 观察结果 |
| --- | --- | --- |
| 基础输出 + stderr | `printf 'hello\n'; pwd; echo $USERNAME; echo $DSH_PROFILE; printf 'to stderr\n' >&2`，`workdir=B:\vibe_program\dsh-bash` | stdout 正常，`[stderr]` 段落正确，`$DSH_PROFILE=desktop` |
| 更名后冒烟 | `printf 'renamed plugin works\n'; pwd; echo $DSH_PROFILE; printf 'err-line\n' >&2; exit 4` | 输出来自 `dsh-bash` 目录，`[stderr] err-line`，`[exit code: 4]` |
| UTF-8 | `echo "中文 UTF-8 test ✅"` | 无乱码 |
| 非零退出 | `exit 3`（修复后又测 `exit 2`） | 正文 + `[exit code: 3]` / `[exit code: 2]`，不是 isError |
| 超时转后台 | `echo starting; sleep 4; echo finished`，`timeoutMs: 1000` | `starting` + `[still running after 1000ms; moved to background job bash-…]`；`job_output` 收到 `finished` 与 `[status: completed, exit code: 0]` |
| 后台任务 | `for i in $(seq 1 60); do echo tick $i; sleep 1; done`，`run_in_background: true` | 立即返回 jobId；`job_output` 增量输出 `tick 1..6`；`job_kill` 后 `[status: killed, killed before exit; <reason>]` |
| 后台正常结束 | `echo bg-done`，`run_in_background: true` | `[status: completed, exit code: 0]` |
| 输出截断 | `seq 1 20000` | 只保留尾部，附 `[output truncated; full output: …\dsh-subprocess-…-stdout.log]` |
| 无效 workdir（前台） | `workdir=B:\vibe_program\definitely-not-a-real-directory` | 工具报错 `spawn …\bash.exe ENOENT`（fail-fast，命令未执行） |
| 无效 workdir（后台） | 同上 + `run_in_background` | `[stderr] subprocess failed before reporting an outcome: spawn … ENOENT`，`[status: killed, killed before exit]`（与原生 bash-local 的失败语义对齐） |
| Git Bash 环境 | `git --version`、`uname -s`、`/c/Windows` | `git version 2.53.0.windows.2`、`MINGW64_NT-10.0-26100`、`/c` 挂载可用 |
| env 覆盖 | `echo $TERM $NO_COLOR $PAGER` | `dumb 1 cat`，与原生执行器一致 |
| pwsh 并存 | `pwsh` 调用 | 正常，两个工具互不影响 |
| 探测单测 | `npm test` | 10/10 通过 |

## npm 发布（2026-10-18）

| 检查项 | 结果 |
| --- | --- |
| 包名 / 版本 | `@wjunhere/dsh-bash@0.1.0`，`dist-tags.latest = 0.1.0`，public |
| 发布命令 | `npm publish`（`publishConfig.access = public`）；registry 返回 `PUT 202`，约 5 分钟后 packument 可读 |
| tarball 内容 | `LICENSE`、`README.md`、`cordis.patch.yml`、`index.js`、`lib/git-bash.js`、`lib/index.js`、`package.json`（7 个文件） |
| 干净安装 | 空目录 `npm install @wjunhere/dsh-bash` → 28 个包，`node -e "import('@wjunhere/dsh-bash')"` 导出 `Config/apply/inject/name` |
| 本地 profile | 依赖改为 `@wjunhere/dsh-bash: link:B:/vibe_program/dsh-bash`，bundle 行同步；重装后 `bash` 工具冒烟通过 |
| 发布副作用 | registry packument 里多出 npm 对新包自动创建的 `0.0.0-stage` 占位版本；`latest` 与安装解析不受影响，`npm unpublish` 被 granular token 的 2FA 策略拒绝，暂不处理 |

## v0.2.0：description 可选 + 智能超时（2026-10-19）

单测 `npm test` 20/20（`test/git-bash.test.js` 10 + `test/smart-timeout.test.js` 10）。

现场验证：临时在 profile 里把 `smartTimeout.defaultSeconds` 设为 3（验证完已删除）后重装 bundle。

| 用例 | 调用 | 结果 |
| --- | --- | --- |
| 不传 `description` | `echo "no-description-ok"; echo "DSH_PROFILE=$DSH_PROFILE"` | 正常执行，无参数校验错误 |
| 普通命令走 default 桶 | `echo probe-default-start; sleep 8; echo probe-default-end`（3s 配置） | 3000ms 后 `[still running after 3000ms; moved to background job …]`，job 后续 `[status: completed, exit code: 0]` |
| 长任务走 long 桶 | `echo probe-long-start; sleep 25; echo probe-long-end` | 25s 前台跑完（`sleep N≥20` 命中长任务规则），没有转后台 |
| 内层 timeout 保护 | `timeout 5 sleep 20; echo "inner-done code=$?"` | 5s 后内层触发，`inner-done code=124`，外层没抢跑 |
| 显式 timeoutMs 优先 | `sleep 8` + `timeoutMs: 5000` | `[still running after 5000ms; …]`（不是配置里的 3000ms） |
| 恢复默认配置 | 删除临时配置、重装后 `echo default-restored; sleep 8; echo done` | 前台 8s 完成，未触发转后台 |

## 未验证（明确限制）

- **沙箱拒绝 / 提权 / runner 失败**：本 profile 默认 `danger-full-access`，`ctx.sandbox.confine` 与 `sandbox_permissions` 审批路径没有被实际触发。需要在 `read-only` 或 `workspace-write` 会话里复测，尤其是 Windows ACL runner 能否包住 `bash.exe`。runner 失败时前台会抛 `SandboxUnavailableError`，只有代码审查与单测覆盖，没有现场证据。
- **工具卡片视觉**：只确认了 Keyed `bash` toolview 的存在与返回的 `presentCall`/`presentResult` 与原生一致；没有截图核验渲染效果。
- **重启后加载**：profile 已持久化 bundle 行与 `link:` 依赖，重启后应当可用；本次会话未重启 DSH，因此未把「重启后可用」列为已验证。
- **调用中断（abort）**：未主动中断 bash 调用；abort 文本路径可用，但结构化 `error.info` 因跨模块实例丢失（见 AGENTS.md 已知限制）。
