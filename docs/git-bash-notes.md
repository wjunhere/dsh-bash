# Git Bash 在 Windows 上的行为差异

本插件执行的是 Git for Windows 的 `bash.exe`（MSYS2），不是 Linux，也不是 WSL。以下是写命令时需要知道的差异。

## 路径

- 挂载点是 `/c`、`/d`，不是 `/mnt/c`；`pwd -W` / `cygpath -w` 可以反查 Windows 路径；
- `/tmp` 实际在 C 盘用户临时目录；
- 传入 Windows 路径 `C:\Users\...` 和 MSYS 路径 `/c/Users/...` 都能用，混用时注意引号。

## 被静默改写的参数

MSYS 会改写「以 `/` 开头、传给原生 PE 程序」的参数：

```
/c → C:/      /tmp → C:/Users/.../Temp      /dev/null → nul     /foo → <GitRoot>/foo
```

bash 内建和 MSYS 程序（`ls`、`grep`）不受影响；`git`、`node`、`rg`、`curl` 这类原生程序全都会触发。
给单条命令加 `MSYS2_ARG_CONV_EXCL='*'` 可关闭改写：

```bash
MSYS2_ARG_CONV_EXCL='*' cmd.exe /c echo hi
```

## 不可用的东西

- `ln -s`、`chmod`、执行位：基本无效（软链接退化成复制）；
- systemd、`sudo`、`apt`、`inotifywait`、`lsof` 都没有；
- `$USER` / `$LOGNAME` 为空，用 `$USERNAME`；`$UID` 不是 1000。

## 输出与编码

- cmd 内建命令输出 GBK，需要 `iconv -f GBK`；bash 本身是 UTF-8，同一管道里可能一半乱码；
- 原生 Windows 程序输出带 `\r`，脚本里比较字符串前先 `tr -d '\r'`；
- 子进程开销约 25ms/次，少用 `$(...)` 和 `for f in $(cmd)`，多用 `while read`、`[[ ]]`。

## 反斜杠

- 未加引号时反斜杠会被吞：`node x.js C:\Users\wjun` 变成 `C:Userswjun`，加单引号即可；
- 交互式 shell 里 `!` 会被历史展开（双引号内尤其危险），用单引号或 `set +H`。

## 沙箱

DSH 的 `read-only` / `workspace-write` 模式会通过 `ctx.sandbox.confine` 把 `bash.exe` 包进 ACL 受限令牌。若该宿主上 ACL runner 起不来，命令会以 `SANDBOX_UNAVAILABLE` 失败而不是裸跑 —— 这是有意的 fail-closed 行为，别绕过。
