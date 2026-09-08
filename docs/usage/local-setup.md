# Local setup guide

**English** · [简体中文](local-setup.zh-CN.md)

Clone AI runs on your machine as a normal command-line tool, next to the other
coding agents you already have. Nothing leaves the device unless you configure
an external integration.

## 1. Install

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
npm install --ignore-scripts
npm link          # makes `clone-ai` available everywhere (npm i -g . also works)
```

Requirements: **Node.js 24+** (it runs TypeScript directly, no build step).

Verify:

```bash
clone-ai --version
clone-ai doctor
```

`doctor` prints your clone home, Node version, and which worker CLIs are
installed.

## 2. Use it

```bash
clone-ai "读一下 README 并总结三点"        # talk to the Main Agent
clone-ai "用 pi 调研这个项目并写份笔记"      # explicitly choose a worker
clone-ai app                              # desktop window (recommended)
clone-ai gui                              # or open in your browser
clone-ai status                           # runs, workers, memory, bad cases
clone-ai workers                          # which worker CLIs are installed
clone-ai install codex-cli                # install a missing worker
clone-ai memory "发布流程"                  # search reviewed memories
clone-ai cases                            # the local bad-case log
clone-ai opportunities                    # open opportunity cards
clone-ai bench                            # reliability benchmark
```

The default subcommand is a conversation: `clone-ai "<request>"` behaves like
`pi "..."` or `claude -p "..."`, except the Main Agent routes the work to a
worker and the Kernel verifies the result.

## 3. The desktop app

```bash
clone-ai app                # a real window: no address bar, no tabs
clone-ai app --port 4399    # pick a port
clone-ai gui                # same thing in your default browser instead
```

`clone-ai app` opens a dedicated application window using the Chromium engine
already installed on the machine (Edge or Chrome), with its own profile
directory under the clone home — your everyday browser session, extensions, and
cookies are never involved. Closing the window stops the daemon.

There is no separate download. If you want a single-file native executable
instead, the Tauri shell is optional and requires the Rust toolchain:

```bash
npm run desktop:build
# then run apps/desktop/src-tauri/target/.../clone-ai-desktop.exe
```

## 4. Workers (the agents that do the work)

Clone AI does not implement a coding agent; it supervises the ones you have.

| Worker | Windows command | macOS command | Install |
| --- | --- | --- | --- |
| Claude Code | `claude.cmd` | `claude` | `clone-ai install claude-code` |
| Codex CLI | `codex.cmd` | `codex` | `clone-ai install codex-cli` |
| Pi | `pi.cmd` | `pi` | `clone-ai install pi` |
| opencode | `opencode.cmd` | `opencode` | install manually |

Recipes live in `src/workers/providers.json`; override or add your own in
`<clone home>/providers.json`. Only environment **variable names** belong in a
recipe — never credential values.

Note: desktop apps (Claude Code Desktop, opencode Desktop) are not usable as
workers. Clone AI needs a headless CLI it can run with a prompt and a workspace.

## 5. Where your data lives

| Item | Location |
| --- | --- |
| Clone home | `~/.clone` (or `CLONE_AI_DATA_DIR`) |
| Journal | `<clone home>/journal.jsonl` (`CLONE_AI_JOURNAL=sqlite` for WAL) |
| Memory | `<clone home>/memory-index.db` + `<clone home>/memory/*.md` |
| Bad cases | `<clone home>/reporting/bad-cases.md` |
| Provider overrides | `<clone home>/providers.json` |
| Failure taxonomy | `<clone home>/outcomes/failures.json` |
| Isolated workspaces | `<clone home>/isolated-workspaces/` |
| Env template | `.env.example` in the repo (names only, never secret values) |

## 6. Platform notes

- **Windows**: `.cmd` shims are resolved to their real executables (no shell, so
  prompts cannot be injected as arguments); worker process trees are terminated
  with `taskkill /T` on timeout, so no orphaned agent processes remain.
- **macOS**: workers run in their own POSIX process group and are terminated as
  a group. Recipes use bare command names.

## 7. First-run checklist

1. `clone-ai doctor` → at least one worker installed.
2. `clone-ai "你好"` → the Main Agent replies.
3. `clone-ai gui` → the browser opens the local dashboard.
4. Run a real task, then `clone-ai status` shows it.
5. `clone-ai cases` accumulates failures — that file drives your optimization.
