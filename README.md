# dsh-bash

[![npm](https://img.shields.io/npm/v/%40wjunhere%2Fdsh-bash)](https://www.npmjs.com/package/@wjunhere/dsh-bash)
[![GitHub](https://img.shields.io/badge/GitHub-wjunhere%2Fdsh--bash-181717?logo=github)](https://github.com/wjunhere/dsh-bash)

给 **Windows 上的 DSH（DeepSeek Harness）** 提供一个 `bash` 工具，和原生 `pwsh` 平级可用。

它调用 **Git for Windows 自带的 bash.exe**：不依赖 WSL、不用装额外环境，模型拿到的就是一个标准的 `bash -c`。

## 为什么

- DSH 原生 `bash` 工具在 Windows 上依赖 WSL，没装 WSL 就用不了；
- 原生 `pwsh` 能用，但启动慢、日常命令体验不如 bash；
- 装一个 Git for Windows 就有了完整 bash + coreutils + git，插件把它接进 DSH。

## 依赖

只需要 [Git for Windows](https://git-scm.com/download/win)（提供 `bash.exe`）。

插件会按顺序自动探测，找到第一个可用的即可：

1. `C:\Program Files\Git\bin\bash.exe`、`...\usr\bin\bash.exe`
2. 用户级安装 `%LOCALAPPDATA%\Programs\Git\...`
3. scoop：`%SCOOP%\apps\git\current\bin\bash.exe`
4. 从 `PATH` 里的 `git.exe` / `Git\cmd` 目录反推安装根目录
5. `PATH` 里的 `bash.exe`（`System32` 下的 WSL 启动器会被跳过）

都找不到时会报错并列出检查过的路径 —— 不会静默降级。

## 安装

从 npm 安装（推荐）：在 DSH 插件管理器里安装 npm 包 `@wjunhere/dsh-bash`，它会装进当前 profile，重新加载后模型即可见 `bash` 工具。

- npm 页面：<https://www.npmjs.com/package/@wjunhere/dsh-bash>
- 要求 DSH `0.2.1-rc.2`（运行时包取自 npm 的 `next` 标签）

改代码或本地开发：

```sh
git clone https://github.com/wjunhere/dsh-bash.git
cd dsh-bash
npm install
```

然后用插件管理器安装这个目录（等同 `plugin_manager` 的 `install_bundle`）。

> DSH 从软链接的真实路径加载插件，本地目录安装时 `npm install` 不能省。

## 配置

在 profile 的 `cordis.patch.yml` 里给插件行加 `config`：

```yaml
- id: dsh-bash
  name: '@wjunhere/dsh-bash'
  config:
    # 自动探测不到、或想指定某个 Git 安装时
    bashPath: 'D:\software\git\Git\bin\bash.exe'
    # 关闭后台任务 / 超时转后台
    enableRunInBackground: true
    promoteOnTimeout: true
    # 智能超时（默认开启，见下节）
    smartTimeout:
      defaultSeconds: 120
      longSeconds: 1800
      maxSeconds: 3600
      graceSeconds: 30
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `bashPath` | 自动探测 | `bash.exe` 绝对路径；填错直接报错 |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background` 参数（关闭后也不再有超时转后台） |
| `promoteOnTimeout` | `true` | 命令超时后不杀，转成后台 job 继续跑 |
| `smartTimeout.enabled` | `true` | 关掉后回到固定默认 120s / 上限 600s |
| `smartTimeout.defaultSeconds` | `120` | 普通命令的默认超时 |
| `smartTimeout.longSeconds` | `1800` | 跑得久的命令（构建/测试/安装等）的默认超时 |
| `smartTimeout.maxSeconds` | `3600` | 硬上限，显式传的 `timeoutMs` 也受它约束 |
| `smartTimeout.graceSeconds` | `30` | 命令自带 `timeout N` 时额外给的余量 |
| `smartTimeout.longPatterns` | `[]` | 额外的正则，命中就归到 `longSeconds` |

## 智能超时

`timeoutMs` 不填时不再固定 120s，而是按命令内容选一个默认值（参考 [pi-smart-timeout](https://github.com/wjunhere/pi-smart-timeout)）。判断顺序，命中即停：

1. 显式传了 `timeoutMs` → 用它，超过 `maxSeconds` 压到上限；
2. 命令自带 `timeout 30 ...` → 用 `30 + graceSeconds`，让内层先触发，不抢跑；
3. 看起来是长任务（`npm install`、`cargo build`、`pytest`、`git clone`、`docker compose up`、`tail -f`、带 `sleep` 的轮询循环等）→ `longSeconds`；
4. 其他 → `defaultSeconds`。

引号里的文字不参与判断，所以 `grep -n 'npm install' src/`、`echo "make sure"` 仍按普通命令处理；`timeout 0 cmd`（coreutils 里表示不限时）也不算内层保护。想加自己的长任务特征，用 `longPatterns`。

## 工具参数

| 参数 | 说明 |
| --- | --- |
| `command` | 要执行的 bash 命令（`bash -c`）；必填 |
| `description` | 可选的一句话说明（界面展示，不填就用命令本身） |
| `timeoutMs` | 可选；不填就走上面的智能超时，显式传入时受 `maxSeconds` 约束；超时后默认转后台 |
| `workdir` | 工作目录，默认会话目录；相对路径按会话目录解析 |
| `run_in_background` | 后台运行，立即返回 jobId，用 `job_output` / `job_kill` 收集和停止 |
| `sandbox_permissions` / `justification` | 沙箱拒绝后一次性提权重试（组合里配置了沙箱时可用） |

输出与原生 `pwsh` / `bash` 一致：stdout、`[stderr]` 段、`[exit code: N]` 等标记；超长输出截断到尾部并给出完整输出文件路径。

## 与 Git Bash 有关的注意点

Git Bash 是 MSYS2 环境，不是 Linux：

- 路径是 `/c/...`（不是 `/mnt/c`），`/tmp` 在 C 盘；Windows 路径 `C:\...` 也能直接传；
- `ln -s`、`chmod`、执行位基本无效；
- `$USER`/`$LOGNAME` 是空的，用 `$USERNAME`；
- 调原生 Windows 程序时，以 `/` 开头的参数会被 MSYS 改写，必要时加 `MSYS2_ARG_CONV_EXCL='*'`；
- cmd 内建命令输出可能是 GBK，Windows 程序输出带 `\r\n`。

更多细节见 [docs/git-bash-notes.md](docs/git-bash-notes.md)。

## 开发

```sh
npm install
npm test          # 单测：bash.exe 探测逻辑
```

- 架构、DSH API 约定与调试方法见 [AGENTS.md](AGENTS.md)；
- 原生 `bash`/`pwsh` 行为对齐记录见 [docs/parity.md](docs/parity.md)；
- DSH 0.2.1-rc.2 宿主 API 审计见 [docs/api-contract.md](docs/api-contract.md)；
- 独立评审记录见 [docs/review.md](docs/review.md)，实测记录见 [docs/verification.md](docs/verification.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
