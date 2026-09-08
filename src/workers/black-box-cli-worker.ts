/**
 * Black-box CLI workers. ToolAuthority is intentionally unused here: the Kernel
 * cannot authorize, time out, or reconcile individual tools inside
 * claude/codex/pi. Duration and attempt budgets on the WorkOrder are the
 * contract that still applies.
 *
 * 黑盒 CLI Worker。这里故意不走 ToolAuthority：Kernel 无法对 claude/codex/pi 内部的
 * 单个 Tool 做授权、超时或崩溃对账。仍然生效的合同是 WorkOrder 上的时长与尝试次数。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
} from "../core/contracts.ts";
import { BUILT_IN_CATALOG, classifyFailure, failureSignature, type FailureCategory, type FailureReport, type OutcomeCatalog } from "../core/failure-analysis.ts";
import {
  artifactChanges,
  describeChanges,
  diffWorkspace,
  snapshotWorkspace,
  type WorkspaceChange,
} from "../core/workspace-evidence.ts";
import type { AgentRole } from "../config/worker-settings.ts";

export interface BlackBoxProviderConfig {
  id: string;
  label?: string;
  /** Executable to run, e.g. "claude", "codex", "opencode". 要运行的可执行文件。 */
  command: string;
  /** Argument template; {{prompt}} and {{workspace}} are substituted. 参数模板；{{prompt}} 与 {{workspace}} 会被替换。 */
  args?: string[];
  /** Send the prompt on stdin instead of as an argument. 通过 stdin 而非参数传入 Prompt。 */
  promptVia?: "arg" | "stdin";
  /** Environment variable names allowed through; everything else is withheld. 允许透传的环境变量名；其余一律不给。 */
  env?: string[];
  /** Domain capabilities this agent may be dispatched for. 该 Agent 可被派发的领域能力。 */
  work?: string[];
  supportedRoles?: readonly AgentRole[];
  roleRestrictionReason?: string;
  timeoutMs?: number;
}

const DEFAULT_WORK = [
  "research",
  "drafting",
  "review",
  "direct_response",
  "implementation",
  "filesystem_read",
  "filesystem_write",
  "external_action",
];

/**
 * A coding agent as a black box. Clone AI supplies a prompt and a workspace,
 * then judges the result by observation alone: the process exit status and
 * what actually changed on disk. Nothing about the agent's internal protocol,
 * streaming format, or session model is parsed or relied upon, which is what
 * makes any headless agent integrable by configuration instead of by code.
 *
 * Authority is unchanged: budgets, the hard deadline, termination, evidence
 * kinds, and the completion decision all stay here. The worker cannot report
 * its own success — success means the workspace shows the contracted artifact.
 *
 * 把 Coding Agent 当作黑盒。Clone AI 只提供 Prompt 与 Workspace，然后仅凭观察判断结果：
 * 进程退出状态，以及磁盘上真正发生了什么变化。不解析也不依赖该 Agent 的内部协议、流式
 * 格式或会话模型——正因如此，任何无头 Agent 都能靠配置而不是靠写代码接入。
 *
 * 权限边界不变：预算、硬截止、终止、Evidence 类型与完成判定仍然在这里。Worker 无法
 * 自报成功——成功意味着 Workspace 上出现了合同约定的产物。
 */
export class BlackBoxCliWorker implements RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;
  readonly #config: BlackBoxProviderConfig;
  readonly #workCapabilities: string[];
  readonly #catalog: OutcomeCatalog;
  readonly #active = new Map<string, ChildProcess>();

  constructor(input: {
    agentId: string;
    config: BlackBoxProviderConfig;
    workCapabilities?: string[];
    /** Owner-authored failure catalog; the built-in minimum is used when absent. 所有者自撰的失败目录；缺省时使用内建最小集合。 */
    failureCatalog?: OutcomeCatalog;
  }) {
    this.id = input.agentId;
    this.providerId = input.config.id;
    this.#config = input.config;
    this.#workCapabilities = input.workCapabilities ?? input.config.work ?? DEFAULT_WORK;
    this.#catalog = input.failureCatalog ?? BUILT_IN_CATALOG;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      // A black box exposes no session identity, so a crashed run restarts
      // rather than resumes. That is the honest cost of not parsing protocols.
      // 黑盒不暴露会话身份，因此崩溃后是重跑而不是续跑。这是不解析协议的诚实代价。
      resume: false,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: [...this.#workCapabilities],
      // Receipts attest that an external action really happened and can never
      // come from a worker; artifacts are proven by the workspace itself.
      // Receipt 证明外部动作确实发生，永远不能来自 Worker；Artifact 由 Workspace 自身证明。
      evidenceKinds: ["artifact", "observation"],
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const child = this.#active.get(sessionId);
    if (child === undefined) return;
    this.#active.delete(sessionId);
    terminateProcessTree(child);
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    const config = this.#config;
    const workspace = resolve(input.workspacePath ?? process.cwd());
    const budgetMs = input.workOrder?.budget.maxDurationMs ?? config.timeoutMs ?? 20 * 60_000;
    const sessionId = randomUUID();
    const prompt = buildWorkerPrompt(input);
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`The worker prompt exceeds the ${MAX_PROMPT_CHARS}-character budget (${prompt.length}).`);
    }

    yield { type: "session_started", sessionId };

    // Observed before the work starts; the diff afterwards is the evidence.
    // 在工作开始前观察；之后的差异就是证据。
    const before = await snapshotWorkspace(workspace);

    const usesStdin = config.promptVia === "stdin";
    const args = (config.args ?? []).map((argument) => argument
      .replaceAll("{{prompt}}", usesStdin ? "" : prompt)
      .replaceAll("{{workspace}}", workspace));
    // Windows cannot spawn a .cmd shim without a shell, and spawning through a
    // shell would open the prompt to argument injection. Resolve the real
    // executable behind the shim instead.
    // Windows 不能用无 shell 的 spawn 启动 .cmd 垫片，而走 shell 又会让 Prompt 暴露在
    // 参数注入之下；因此改为解析垫片背后的真实可执行文件。
    const resolved = resolveWindowsCommand(config.command);
    const spawnArgs = usesStdin ? args : args.length > 0 ? args : [prompt];
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...spawnArgs], {
      cwd: workspace,
      env: buildEnvironment(config.env ?? []),
      stdio: usesStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: own process group so the whole tree can be terminated.
      // POSIX：独立进程组，以便能终止整棵进程树。
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    this.#active.set(sessionId, child);
    // Exit and error are observed immediately: an unobserved ChildProcess
    // "error" event would crash the supervisor when a command is missing.
    // 立刻观察 exit 与 error：命令不存在时，无人监听的 ChildProcess "error" 事件
    // 会让 Supervisor 崩溃。
    const exited = observeExit(child);
    if (usesStdin && child.stdin !== null) {
      child.stdin.end(prompt);
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Kill the whole process tree, not just the CLI: headless agents spawn
      // their own children, and an orphaned grandchild keeps retrying forever
      // (observed with claude.exe).
      // 终止整棵进程树而不是只杀 CLI：无头 Agent 会派生自己的子进程，孤儿孙进程会
      // 永远重试（claude.exe 残留即由此而来）。
      terminateProcessTree(child);
    }, budgetMs);
    timeout.unref();

    const output = new OutputTail();
    try {
      for await (const line of readLines(child.stdout)) {
        output.push(line);
        // Provider text is progress, never a completion claim.
        // Provider 的文本只是进度，绝不是完成声明。
        if (line.trim().length > 0) yield { type: "progress", message: truncate(redactFreeText(line), 500) };
      }
      const stderr = await output.drainStderr(child.stderr);
      const exit = await exited;
      clearTimeout(timeout);

      const after = await snapshotWorkspace(workspace);
      const changes = diffWorkspace(before, after);
      const produced = artifactChanges(changes);
      const detail = redactFreeText([output.text(), stderr].filter(Boolean).join("\n")).trim();

      const failure = judgeFailure({
        providerId: this.providerId,
        agentId: this.id,
        timedOut,
        exit,
        detail,
        changes,
        produced,
        requiresArtifact: (input.workOrder?.expectedArtifacts ?? []).some((artifact) => artifact.required),
        catalog: this.#catalog,
      });
      if (failure !== undefined) {
        yield { type: "failed", message: `${failure.category}: ${failure.detail.slice(0, 500) || "no output"}`, report: failure };
        return;
      }

      for (const change of produced.slice(0, 20)) {
        yield {
          type: "evidence",
          evidence: {
            kind: "artifact",
            summary: `${change.change} by ${this.providerId}: ${change.path}`,
            locator: change.path,
          },
        };
      }
      yield {
        type: "evidence",
        evidence: {
          kind: "observation",
          summary: truncate(`${this.providerId} session ${sessionId}: ${describeChanges(changes)}. ${detail}`, 2_000),
          locator: `${this.providerId}://${sessionId}`,
        },
      };
      yield { type: "completed", summary: truncate(detail || `${this.providerId} completed its WorkOrder.`, 2_000) };
    } finally {
      clearTimeout(timeout);
      this.#active.delete(sessionId);
      // An abandoned generator must never leave the agent running unsupervised.
      // 被放弃的 Generator 绝不能留下脱管运行的 Agent。
      if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child);
    }
  }
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

function judgeFailure(input: {
  providerId: string;
  agentId: string;
  timedOut: boolean;
  exit: ProcessExit;
  detail: string;
  changes: WorkspaceChange[];
  produced: WorkspaceChange[];
  requiresArtifact: boolean;
  catalog: OutcomeCatalog;
}): FailureReport | undefined {
  const base = { providerId: input.providerId, agentId: input.agentId, exitCode: input.exit.code };
  const report = (category: FailureCategory, detail: string, guidance?: string): FailureReport => ({
    ...base,
    category,
    detail,
    signature: failureSignature(detail),
    ...(guidance === undefined ? {} : { guidance }),
    ...(input.changes.length === 0 ? {} : { workspaceChanges: input.changes }),
  });

  if (input.exit.error !== undefined) return report("launch_failed", input.exit.error);
  if (input.timedOut) return report("timeout", `exceeded the WorkOrder duration budget. ${input.detail}`);
  if (input.exit.signal !== null) return report("aborted", `terminated by signal ${input.exit.signal}. ${input.detail}`);
  if (input.exit.code !== 0) {
    // The agent's own words decide the category; the exit code only says it failed.
    // 类别由 Agent 自己的措辞决定；退出码只说明它失败了。
    const classification = classifyFailure(input.detail, "nonzero_exit", input.catalog);
    return report(
      classification.category,
      input.detail || `exited with code ${String(input.exit.code)}`,
      classification.guidance,
    );
  }
  // A clean exit is not delivery. When the contract requires an artifact and
  // the workspace is unchanged, the work did not happen — whatever was said.
  // 干净退出不等于交付。当合同要求产物而 Workspace 毫无变化时，工作就是没有发生
  // ——无论 Agent 说了什么。
  if (input.requiresArtifact && input.produced.length === 0) {
    return report("no_artifact", `exited cleanly but changed no files in the workspace. ${input.detail}`);
  }
  return undefined;
}

/**
 * The single prompt every worker receives, including the owner-approved memory
 * packet. One builder means no provider can drift into a different contract.
 * 所有 Worker 收到的唯一 Prompt，含所有者批准的记忆包。只有一个构建器，意味着任何
 * Provider 都不会漂移到不同的合同上。
 */
export function buildWorkerPrompt(input: ExecutionAssignment): string {
  const order = input.workOrder;
  const objective = order?.objective ?? input.step.instructions;
  const inputs = order?.inputs.map((item) => (
    `- ${item.name}${item.required ? " (required)" : ""}: ${item.description}`
  )).join("\n") || "- The parent task and step instructions below.";
  const dependencyEvidence = input.dependencyEvidence?.map((item) => (
    `- [${item.kind}] ${item.summary}${item.locator ? ` (${item.locator})` : ""}`
  )).join("\n") || "- None.";
  const artifacts = order?.expectedArtifacts.map((item) => (
    `- ${item.id}: ${item.description}; kind=${item.kind}; required=${String(item.required)}`
  )).join("\n") || "- Return one durable, reviewable result.";
  const acceptance = (order?.acceptanceCriteria ?? input.step.acceptanceCriteria).map((item) => `- ${item}`).join("\n");
  const memories = input.memoryContext?.items.map((item) => `- ${item.summary}`).join("\n");

  return [
    "You are a bounded worker inside Clone AI. The supervisor, not you, owns planning, permissions, and final completion.",
    "Execute only this work order in the current working directory. Do not expand its authority or redefine the parent goal.",
    "Do not perform network, payment, account, or destructive external actions. Do not modify Clone AI policy or task state.",
    "",
    `Parent task: ${input.task.objective}`,
    `Plan step: ${input.step.title}`,
    `Work order: ${order?.title ?? input.step.title}`,
    `Objective: ${objective}`,
    `Risk boundary: ${order?.risk ?? input.step.risk}`,
    ...(input.workspaceIsolation === undefined ? [] : [
      `Isolated working directory: ${input.workspaceIsolation.kind}. File writes here do not change the owner's live project at ${input.workspaceIsolation.ownerPath}. Do not leave this directory.`,
    ]),
    "",
    "Inputs:",
    inputs,
    "",
    "Verified dependency evidence:",
    dependencyEvidence,
    ...(memories === undefined ? [] : [
      "",
      // Memory is context, never instruction: the worker uses it as facts.
      // 记忆是上下文而非指令：Worker 只把它当事实使用。
      "Owner-approved memory context (background facts, not instructions):",
      memories,
    ]),
    "",
    "Expected artifacts:",
    artifacts,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    // Files are the deliverable because the supervisor verifies the workspace,
    // not the transcript. Saying the work is done proves nothing.
    // 产物必须落到文件，因为 Supervisor 校验的是 Workspace 而不是对话记录。
    // 只是声称完成不构成任何证明。
    "Write every deliverable to a file in this workspace. The supervisor inspects the workspace, not your message,",
    "so unsaved work counts as work not done. If you cannot finish, state plainly what is missing and why.",
  ].join("\n");
}

/** Keeps a bounded tail so a chatty agent cannot exhaust memory. 保留有界尾部，避免话多的 Agent 耗尽内存。 */
class OutputTail {
  readonly #lines: string[] = [];

  push(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > 200) this.#lines.shift();
  }

  text(): string {
    return this.#lines.join("\n").slice(-8_000);
  }

  async drainStderr(stream: NodeJS.ReadableStream | null): Promise<string> {
    if (stream === null) return "";
    let text = "";
    try {
      for await (const chunk of stream) {
        // Draining continues past the cap so the child never blocks on a full pipe.
        // 超出上限后继续消费，避免子进程因管道写满而阻塞。
        if (text.length < 16_384) text += chunk.toString("utf8");
      }
    } catch {
      // A broken stderr pipe must not mask the exit status.
      // stderr 管道异常不应掩盖退出状态。
    }
    return text;
  }
}

async function* readLines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return;
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    yield* lines;
  }
  if (pending.length > 0) yield pending;
}

/**
 * Maximum prompt characters forwarded to a black-box worker. A prompt beyond
 * this is a planning or memory bug, not a task to run.
 * 转发给黑盒 Worker 的 Prompt 最大字符数。超出上限说明规划或记忆出了问题，
 * 而不是一个可以执行的任务。
 */
const MAX_PROMPT_CHARS = 30_000;

/**
 * Terminates the worker and its whole process tree. Killing only the CLI
 * leaves grandchildren behind; they hold inherited pipes and keep running
 * (and retrying) unsupervised. Windows needs taskkill /T; POSIX kills the
 * detached process group.
 * 终止 Worker 及其整棵进程树。只杀 CLI 会留下孙进程；它们持有继承的管道并继续
 * （反复重试地）运行。Windows 用 taskkill /T；POSIX 杀 detached 进程组。
 */
export function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill enumerates and kills the tree, but it can take seconds under
    // load. Start it first (so grandchildren are still attached), then kill
    // the direct child immediately: the supervisor's stream loop must end now,
    // not when taskkill finishes.
    // taskkill 会枚举并杀掉整棵树，但系统繁忙时可能要数秒。先启动它（此时孙进程
    // 仍挂在树上），然后立即杀掉直接子进程：Supervisor 的流循环必须现在结束，
    // 而不是等 taskkill 完成。
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
      // 进程已经不存在。
    }
  }
}

function observeExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

/**
 * The worker process starts from an empty environment and receives only the
 * variables named in its configuration, so credentials for other providers
 * stay invisible to it.
 * Worker 进程从空环境启动，只拿到其配置中点名的变量，因此其他 Provider 的凭据对它
 * 始终不可见。
 */
function buildEnvironment(additionalNames: readonly string[]): NodeJS.ProcessEnv {
  const names = new Set([
    "PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "LANG", "LC_ALL", "TERM", "NO_COLOR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ]);
  // A trailing "*" matches every variable with that prefix, so provider
  // recipes stay stable while owners forward e.g. all ANTHROPIC_* settings.
  // 尾部 "*" 匹配同前缀的所有变量：配方保持稳定，同时所有者可以把例如全部
  // ANTHROPIC_* 设置透传给 Provider。
  const wildcards: string[] = [];
  for (const name of additionalNames) {
    if (name.endsWith("*")) wildcards.push(name.slice(0, -1));
    else names.add(name);
  }
  const environment: NodeJS.ProcessEnv = Object.fromEntries(
    [...names]
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  for (const prefix of wildcards) {
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith(prefix) && environment[name] === undefined && value !== undefined) {
        environment[name] = value;
      }
    }
  }
  return environment;
}

export function redactFreeText(value: string): string {
  return value
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

/**
 * Windows cannot spawn a .cmd shim without going through a shell, which would
 * expose the prompt to argument injection. This resolves the shim to its real
 * executable: an .exe directly, or a node script through process.execPath.
 * Windows 无法在不用 shell 的情况下启动 .cmd 垫片，而走 shell 会把 Prompt 暴露给参数注入；
 * 这里把垫片解析为真实可执行文件：.exe 直接启动，node 脚本则经由 process.execPath。
 */
export function resolveWindowsCommand(command: string): { command: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { command, prefixArgs: [] };
  if (!/\.(?:cmd|bat)$/i.test(command)) return { command, prefixArgs: [] };

  const shim = findWindowsShim(command);
  if (shim === undefined) return { command, prefixArgs: [] };
  let source: string;
  try {
    source = readFileSync(shim, "utf8");
  } catch {
    return { command, prefixArgs: [] };
  }
  // npm shims reference the real target inside the dp0 expansion, e.g.
  // "%dp0%\node_modules\pkg\bin\tool.exe" or "%dp0%\node_modules\pkg\dist\cli.js".
  // The last reference is the actual program; earlier ones (like %_prog%=node)
  // are only the launcher.
  // npm 垫片在 dp0 展开中引用真实目标；最后一个引用才是真正的程序，前面的（如
  // %_prog%=node）只是启动器。
  const references = [...source.matchAll(/["']?%?~?dp0%?\\([^"'%\r\n]+)["']?/gi)]
    .map((match) => match[1]!);
  const target = references.length === 0
    ? undefined
    : join(dirname(shim), references[references.length - 1]!);
  if (target === undefined) return { command, prefixArgs: [] };
  if (/\.[a-z0-9]+$/i.test(target) && !/\.exe$/i.test(target)) {
    return { command: process.execPath, prefixArgs: [target] };
  }
  return { command: target, prefixArgs: [] };
}

function findWindowsShim(command: string): string | undefined {
  const candidates: string[] = [];
  if (command.includes("/") || command.includes("\\")) {
    candidates.push(resolve(command));
  } else {
    const directories = (process.env.PATH ?? "").split(";").filter((entry) => entry.trim().length > 0);
    for (const directory of directories) candidates.push(join(directory, command));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}...`;
}
