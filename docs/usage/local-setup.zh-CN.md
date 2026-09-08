# 本地使用指南

[English](local-setup.md) · **简体中文**

Clone AI 在你的机器上就是一个普通命令行工具，和你已有的 Coding Agent 并列。除非
你配置了外部集成，数据不会离开这台设备。

## 1. 安装

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm link          # 让 `clone-ai` 在任何目录可用（npm i -g . 同样可行）
```

环境要求：**Node.js 24+**（直接运行 TypeScript，无需构建步骤）。

验证：

```bash
clone-ai --version
clone-ai doctor
```

`doctor` 会打印你的 clone home、Node 版本，以及哪些 Worker CLI 已安装。

## 2. 使用

```bash
clone-ai "读一下 README 并总结三点"        # 与 Main Agent 对话
clone-ai "用 pi 调研这个项目并写份笔记"      # 显式指定 Worker
clone-ai app                              # 桌面客户端窗口（推荐）
clone-ai gui                              # 或用默认浏览器打开
clone-ai status                           # Run、Worker、记忆、坏案例概览
clone-ai workers                          # 查看已安装的 Worker CLI
clone-ai install codex-cli                # 安装缺失的 Worker
clone-ai memory "发布流程"                  # 检索已审核的记忆
clone-ai cases                            # 查看本地坏案例日志
clone-ai opportunities                    # 查看待处理的机会卡片
clone-ai bench                            # 运行可靠性基准
```

默认子命令就是对话：`clone-ai "<请求>"` 的用法和 `pi "..."`、`claude -p "..."`
一致，区别在于 Main Agent 会把工作路由给 Worker，并由 Kernel 验证结果。

## 3. 桌面客户端

```bash
clone-ai app                # 真正的窗口：没有地址栏、没有标签页
clone-ai app --port 4399    # 指定端口
clone-ai gui                # 同一个服务，改用默认浏览器打开
```

`clone-ai app` 使用机器上已安装的 Chromium 引擎（Edge 或 Chrome）打开一个独立的
应用窗口，并使用 clone home 下的独立 profile 目录——你日常浏览器的会话、扩展和
Cookie 完全不参与。关闭窗口即停止 daemon。

不需要单独下载。如果你想要单文件原生可执行程序，Tauri 外壳是可选项，需要 Rust 工具链：

```bash
npm run desktop:build
# 然后运行 apps/desktop/src-tauri/target/.../clone-ai-desktop.exe
```

## 4. Worker（真正干活的 Agent）

Clone AI 自己不实现 Coding Agent，它监督你已有的那些。

| Worker | Windows 命令 | macOS 命令 | 安装 |
| --- | --- | --- | --- |
| Claude Code | `claude.cmd` | `claude` | `clone-ai install claude-code` |
| Codex CLI | `codex.cmd` | `codex` | `clone-ai install codex-cli` |
| Pi | `pi.cmd` | `pi` | `clone-ai install pi` |
| opencode | `opencode.cmd` | `opencode` | 手动安装 |

配方位于 `src/workers/providers.json`，可在 `<clone home>/providers.json` 覆盖或
新增。配方里只放环境**变量名**，绝不放凭据值。

注意：桌面应用（Claude Code Desktop、opencode Desktop）不能作为 Worker——Clone AI
需要的是能用「一个 Prompt + 一个工作目录」运行的无头 CLI。

## 5. 数据都在哪里

| 项目 | 位置 |
| --- | --- |
| Clone home | `~/.clone`（或 `CLONE_AI_DATA_DIR`） |
| Journal | `<clone home>/journal.jsonl`（`CLONE_AI_JOURNAL=sqlite` 启用 WAL） |
| 记忆 | `<clone home>/memory-index.db` + `<clone home>/memory/*.md` |
| 坏案例 | `<clone home>/reporting/bad-cases.md` |
| Provider 覆盖 | `<clone home>/providers.json` |
| 失败分类目录 | `<clone home>/outcomes/failures.json` |
| 隔离工作区 | `<clone home>/isolated-workspaces/` |
| 环境变量模板 | 仓库中的 `.env.example`（只有变量名，绝不放密钥值） |

## 6. 平台注意事项

- **Windows**：`.cmd` 垫片会被解析为真实可执行文件（不经 shell，Prompt 无法被当作
  参数注入）；超时时用 `taskkill /T` 终止 Worker 整棵进程树，不留孤儿进程。
- **macOS**：Worker 运行在自己的 POSIX 进程组中并按组终止；配方使用裸命令名。

## 7. 首次运行检查清单

1. `clone-ai doctor` → 至少一个 Worker 已安装。
2. `clone-ai "你好"` → Main Agent 有回复。
3. `clone-ai gui` → 浏览器打开本地面板。
4. 跑一个真实任务，然后 `clone-ai status` 能看到它。
5. `clone-ai cases` 开始累积失败——这份文件驱动你的优化循环。
