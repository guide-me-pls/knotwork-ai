import { randomUUID } from "node:crypto";

import type { RiskClass } from "./contracts.ts";

/**
 * Risk-classified tool authorization for in-process tools, independent of any
 * agent loop.
 *
 * Production workers are black-box CLIs (`src/workers/black-box-cli-worker.ts`).
 * Their inner tools are invisible to the Kernel, so this module is not wired
 * onto that path and must not be described as if it were. Keep it for a future
 * in-process tool surface; do not pretend the CLI workers run through it.
 *
 * 面向进程内 Tool 的、与任何 Agent Loop 无关的按风险分级授权层。
 *
 * 生产路径上的 Worker 是黑盒 CLI（`src/workers/black-box-cli-worker.ts`）。它们内部的
 * Tool 对 Kernel 不可见，因此本模块没有接到那条路上，文档也不得写成好像接上了。留给
 * 将来的进程内工具面；不要假装 CLI Worker 会经过这里。
 *
 * This is the layer that decides whether a tool may run at all, times it out,
 * cancels it by a stable id, and answers the only question that matters after
 * a crash: did this operation already take effect? Reads may be replayed
 * freely; anything that touched the outside world needs an explicit answer
 * rather than an optimistic guess.
 *
 * 这一层决定某个 Tool 是否允许运行、限制其执行时间、按稳定 ID 取消它，并回答崩溃后唯一
 * 重要的问题：这次操作是否已经生效？读取可以自由重放；任何触碰外部世界的操作都需要一个
 * 明确答复，而不是乐观猜测。
 */

export type ToolRisk = RiskClass;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecution {
  runId: string;
  call: ToolCall;
  operationId: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface ToolReceipt {
  operationId: string;
  status: "completed" | "failed";
  evidence: Array<{ kind: string; summary: string }>;
}

export type ToolReconcileResult =
  | { status: "completed"; result: ToolResult; receipt: ToolReceipt }
  | { status: "not_started" }
  | { status: "unknown"; reason: string };

export type ToolAuthorization =
  | { outcome: "allowed" }
  | { outcome: "approval_required"; reason: string }
  | { outcome: "denied"; reason: string };

export interface AuthorizedTool {
  name: string;
  risk?: ToolRisk;
  execute(
    args: Record<string, unknown>,
    context: { operationId: string; signal: AbortSignal },
  ): Promise<ToolResult>;
  /** Answers whether an interrupted operation already took effect. 回答被中断的操作是否已经生效。 */
  reconcile?(execution: ToolExecution): Promise<ToolReconcileResult>;
}

export interface ToolPolicy {
  authorize(input: { execution: ToolExecution; tool: AuthorizedTool }): ToolAuthorization;
}

/**
 * Safe default while no owner-configured standing policy exists: local and
 * reversible work runs, external effects pause for approval, and irreversible
 * work is refused outright rather than guessed at.
 * 所有者尚未配置长期 Policy 时的安全默认值：本地与可逆工作直接运行，外部副作用暂停等待
 * 审批，不可逆工作直接拒绝而不是靠猜。
 */
export class DefaultToolPolicy implements ToolPolicy {
  authorize(input: { execution: ToolExecution; tool: AuthorizedTool }): ToolAuthorization {
    switch (input.tool.risk ?? "read_only") {
      case "read_only":
      case "reversible_write":
        return { outcome: "allowed" };
      case "external_side_effect":
        return { outcome: "approval_required", reason: `${input.execution.call.name} affects an external system.` };
      case "irreversible":
        return { outcome: "denied", reason: `${input.execution.call.name} is irreversible and needs an explicit policy.` };
    }
  }
}

export interface ToolAuthorityOptions {
  defaultTimeoutMs?: number;
  policy?: ToolPolicy;
}

export class ToolAuthority {
  readonly #tools = new Map<string, AuthorizedTool>();
  readonly #defaultTimeoutMs: number;
  readonly #active = new Map<string, AbortController>();
  readonly #policy: ToolPolicy;

  constructor(tools: readonly AuthorizedTool[], options: ToolAuthorityOptions = {}) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#policy = options.policy ?? new DefaultToolPolicy();
  }

  createOperationId(): string {
    return randomUUID();
  }

  authorize(execution: ToolExecution): ToolAuthorization {
    const tool = this.#tools.get(execution.call.name);
    if (tool === undefined) return { outcome: "denied", reason: `Unknown tool: ${execution.call.name}` };
    return this.#policy.authorize({ execution, tool });
  }

  async execute(
    execution: ToolExecution,
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<{ result: ToolResult; receipt: ToolReceipt }> {
    const tool = this.#tools.get(execution.call.name);
    if (tool === undefined) {
      const result = { ok: false, content: `Unknown tool: ${execution.call.name}` };
      return { result, receipt: receiptFor(execution.operationId, result) };
    }

    const controller = new AbortController();
    this.#active.set(execution.operationId, controller);
    const timeout = setTimeout(() => controller.abort(new Error(`Tool timed out after ${timeoutMs}ms.`)), timeoutMs);
    try {
      const result = await tool.execute(execution.call.arguments, {
        operationId: execution.operationId,
        signal: controller.signal,
      });
      return { result, receipt: receiptFor(execution.operationId, result) };
    } catch (error: unknown) {
      const result = { ok: false, content: error instanceof Error ? error.message : String(error) };
      return { result, receipt: receiptFor(execution.operationId, result) };
    } finally {
      clearTimeout(timeout);
      this.#active.delete(execution.operationId);
    }
  }

  async cancel(operationId: string): Promise<boolean> {
    const controller = this.#active.get(operationId);
    if (controller === undefined) return false;
    controller.abort(new Error("Tool cancelled by the runtime."));
    return true;
  }

  /**
   * After a crash, a read may simply be repeated; a write that touched the
   * outside world must say what happened, and silence is reported as unknown
   * so a human decides rather than the runtime assuming.
   * 崩溃之后，读取可以直接重做；触碰过外部世界的写入必须说明发生了什么，沉默会被报告为
   * unknown，交由人来决定而不是由 Runtime 擅自假定。
   */
  async reconcile(execution: ToolExecution): Promise<ToolReconcileResult> {
    const tool = this.#tools.get(execution.call.name);
    if (tool === undefined) return { status: "unknown", reason: `Unknown tool: ${execution.call.name}` };
    if (tool.risk === undefined || tool.risk === "read_only") return { status: "not_started" };
    if (tool.reconcile === undefined) {
      return { status: "unknown", reason: `Tool ${execution.call.name} has no recovery reconciliation handler.` };
    }
    return tool.reconcile(execution);
  }
}

function receiptFor(operationId: string, result: ToolResult): ToolReceipt {
  return {
    operationId,
    status: result.ok ? "completed" : "failed",
    evidence: [{ kind: "observation", summary: result.content }],
  };
}
