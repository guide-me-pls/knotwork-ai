# Changelog

All notable changes to clone-ai are listed here. Dates are UTC+8.

clone-ai 的可见变化记在这里。日期为北京时间。

## Unreleased

### Isolated work can return named files

External and irreversible steps still run in a git worktree or a copied tree under clone home. After a successful step, files the plan actually named (for example `` `receipt.md` ``) are copied into the owner's live project **only when that path does not already exist with different contents**. Other writes stay in the sandbox. The journal records `workspace.isolation.applied` with copied / leftover paths and whether the sandbox was kept, so the owner can open that directory instead of guessing.

外部与不可逆步骤仍在 clone home 下的 git worktree 或目录副本里运行。步骤成功后，计划真正点名的文件（例如 `` `receipt.md` ``）会拷进所有者的活项目——**仅当该路径尚未被不同内容占用**。其余写入留在沙箱。Journal 记下 `workspace.isolation.applied`（已拷贝 / 残留路径、沙箱是否保留），所有者可以直接打开那个目录，而不用猜。

### Memory promotion hygiene

Promoting a candidate now refuses an active memory with the same folded summary, redacts emails / tokens / keys / obvious phone and card patterns, and stores any PII-bearing memory as `secret` so default recall will not serve it. `GET /api/memory/candidates` includes `piiFindings`.

提升候选时，若已有折叠后摘要相同的活跃记忆则拒绝；对邮箱 / token / 密钥 / 明显电话与卡号做脱敏；含 PII 的记忆存为 `secret`，默认召回不会把它交给 Worker。`GET /api/memory/candidates` 带上 `piiFindings`。

## 0.1.0

Shipped on `origin/main` before this slice:

- Companion loopback bearer token plus Host/Origin checks; HTTP and CLI cancel/reject; Main Agent single-flight lock; advisory model/tool call caps; ToolAuthority not wired into the black-box CLI; SMTP From/To, TLS verify, daily report hour; `GET /api/health`; SIGTERM; esbuild; planner 429/5xx retry.
- JSON stderr logs; health run metrics; `mainAgentModel` in `config.json`; journal `usage.recorded` for the Main Agent; GitHub Actions `npm test` + typecheck; verifier plugins (test command + diff); restorable checkpoints for reversible work.
- External/irreversible steps in a git worktree or copied tree; `workspaceIsolation` journaled; planner `usage.recorded`; `config.locale` drives desktop chrome; `.env.example` names only.

此前已在 `origin/main` 上线：

- Companion loopback bearer 与 Host/Origin 校验；HTTP 与 CLI 的 cancel/reject；Main Agent 单飞锁；模型/工具次数上限为声明而非假执行；ToolAuthority 未接入黑盒 CLI；SMTP From/To、TLS 校验、日报小时；`GET /api/health`；SIGTERM；esbuild；Planner 对 429/5xx 重试。
- JSON stderr 日志；健康检查中的 Run 计数；`config.json` 的 `mainAgentModel`；Main Agent 的 `usage.recorded`；GitHub Actions 跑 `npm test` 与 typecheck；测试命令与 diff 的 Verifier 插件；可逆工作的可还原检查点。
- 外部/不可逆步骤进入 git worktree 或目录副本；Journal 记录 `workspaceIsolation`；Planner 记 `usage.recorded`；`config.locale` 驱动桌面文案；`.env.example` 只写变量名。
