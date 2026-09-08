import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AgentRegistry,
  ApprovalGrant,
  Evidence,
  ExecutionAssignment,
  ExecutionEvent,
  MemoryContextPacket,
  PlanStep,
  PolicyEngine,
  RiskClass,
  Run,
  RunStatus,
  RuntimeAdapter,
  RuntimeCapabilities,
  SubagentRun,
  SubagentWorkOrder,
  Task,
  Trigger,
  VerificationResult,
  Verifier,
  WorkPlan,
  WorkerMemorySource,
} from "./contracts.ts";
import type { JournalStore } from "./journal.ts";
import { approvalKey, emptyProjection, reduceEvent, replay, subagentKey, type RuntimeProjection } from "./run-state.ts";
import { MemoryPipeline } from "../memory/memory-pipeline.ts";
import { CapabilityDispatcher } from "../workers/capability-dispatcher.ts";
import { BUILT_IN_CATALOG, corroborateFailures, failureSignature, type FailureCategory, type FailureReport, type OutcomeCatalog } from "./failure-analysis.ts";
import {
  artifactChanges,
  diffWorkspace,
  JsonWorkspaceCheckpointStore,
  snapshotWorkspace,
  type WorkspaceChange,
  type WorkspaceCheckpointStore,
} from "./workspace-evidence.ts";
import { workspaceExecutionLock } from "./workspace-lock.ts";
import {
  applyIsolatedArtifacts,
  looksLikeRelativeFile,
  prepareIsolatedWorkspace,
  requiresIsolatedWorkspace,
  type IsolatedWorkspace,
} from "./isolated-workspace.ts";
import { extractFileExpectations } from "./verification.ts";
import { CLONE_DIRECTORY_NAME } from "../config/clone-home.ts";

export interface CloneRuntimeOptions {
  journal: JournalStore;
  policy: PolicyEngine;
  verifier: Verifier;
  memory: MemoryPipeline;
  /**
   * Optional recall port. When present, the Kernel compiles a scoped memory
   * packet for each assignment so any worker — Pi, a coding CLI, or a future
   * provider — receives the same owner-governed context without the memory
   * ever living inside the tool.
   * 可选的召回端口。存在时，Kernel 会为每次派发编译有作用域的记忆包，使任何 Worker
   * （Pi、Coding CLI 或未来的 Provider）都收到同一份由所有者治理的上下文，而记忆
   * 从不驻留在工具内部。
   */
  memorySource?: WorkerMemorySource;
  /** Owner-editable failure taxonomy used for diagnostics. 所有者可编辑的失败分类目录。 */
  failureCatalog?: OutcomeCatalog;
  /** Workspace supervised by this Runtime. 工作本次 Runtime 监督的 Workspace。 */
  workspacePath?: string;
  /** Optional durable checkpoint store; a JSON store is created when omitted. 可选的持久检查点 Store。 */
  workspaceCheckpointStore?: WorkspaceCheckpointStore;
  /** Optional directory used by the default checkpoint store. 默认检查点目录。 */
  workspaceCheckpointDirectory?: string;
  /**
   * Where external/irreversible steps get an isolated tree. Defaults to a temp
   * directory so a missing option never sandboxes inside the owner's project.
   * 外部/不可逆步骤获得隔离树的位置。默认用临时目录，避免漏传选项时沙箱落在所有者项目里。
   */
  isolatedWorkspaceRoot?: string;
  /**
   * The executor ids the Kernel will accept in a plan, resolved at proposal
   * time.
   *
   * Without it a plan naming a worker that does not exist is journaled as
   * `queued` and only fails once a consumer tries to dispatch it: the owner
   * sees an accepted run that can never run. Validating the name at the gate
   * turns a silent future failure into an immediate, fixable rejection.
   *
   * 由 Kernel 在提案时解析、可被计划接受的执行者 id。
   *
   * 没有它时，写了不存在 Worker 的计划会以 `queued` 记入 Journal，直到消费者尝试派发
   * 才失败：所有者看到的是一个永远跑不起来的已接受 Run。在入口校验名称，把一次沉默的
   * 未来失败变成即时且可修复的拒绝。
   */
  knownAgentIds?: () => Set<string>;
}

export interface DispatchResult {
  run: Run;
  status: "completed" | "waiting_approval" | "failed";
  verification?: VerificationResult;
}

/**
 * The Runtime is the supervisor. It owns state transitions, authority,
 * evidence, verification, and memory requests. An agent only receives a
 * bounded execution assignment or child work order; it cannot close a Run.
 *
 * Runtime 负责状态流转、授权、证据、验证与记忆请求。Agent 只能收到受边界
 * 约束的执行 Assignment 或子 WorkOrder，绝不能自行关闭 Run。
 */
/** Carries a black-box worker's structured failure report up to the retry loop. 把黑盒 Worker 的结构化失败报告带到重试循环。 */
export class WorkerFailure extends Error {
  readonly report?: FailureReport;

  constructor(message: string, report?: FailureReport) {
    super(message);
    this.name = "WorkerFailure";
    if (report !== undefined) this.report = report;
  }
}

export class CloneRuntime {
  readonly #journal: JournalStore;
  readonly #policy: PolicyEngine;
  readonly #verifier: Verifier;
  readonly #memory: MemoryPipeline;
  readonly #memorySource?: WorkerMemorySource;
  readonly #failureCatalog: OutcomeCatalog;
  readonly #workspacePath?: string;
  readonly #workspaceCheckpoints?: WorkspaceCheckpointStore;
  readonly #isolatedWorkspaceRoot: string;
  readonly #knownAgentIds?: () => Set<string>;
  #state: RuntimeProjection = emptyProjection();
  #hydrated = false;

  constructor(options: CloneRuntimeOptions) {
    this.#journal = options.journal;
    this.#policy = options.policy;
    this.#verifier = options.verifier;
    this.#memory = options.memory;
    this.#memorySource = options.memorySource;
    this.#failureCatalog = options.failureCatalog ?? BUILT_IN_CATALOG;
    this.#knownAgentIds = options.knownAgentIds;
    this.#workspacePath = options.workspacePath === undefined ? undefined : resolve(options.workspacePath);
    this.#workspaceCheckpoints = this.#workspacePath === undefined
      ? undefined
      : options.workspaceCheckpointStore
        ?? new JsonWorkspaceCheckpointStore(
          options.workspaceCheckpointDirectory
            ?? join(this.#workspacePath, CLONE_DIRECTORY_NAME, "workspace-checkpoints"),
        );
    this.#isolatedWorkspaceRoot = resolve(options.isolatedWorkspaceRoot ?? join(tmpdir(), "clone-ai-isolated"));
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) {
      return;
    }
    this.#state = replay(await this.#journal.list());
    await this.#memory.rebuild();
    this.#hydrated = true;
  }

  /**
   * Rebuilds the projection from the journal.
   *
   * A long-lived Runtime holds an in-memory projection that only grows through
   * its own writes. Another process — the Main Agent proposing a plan, the CLI,
   * a second daemon — appends to the same journal, and those runs are invisible
   * here until the projection is replayed. Anything that watches for work
   * created elsewhere must refresh before it looks.
   *
   * 从 Journal 重建投影。
   *
   * 长生命周期的 Runtime 持有的内存投影只会因它自己的写入而增长。另一个进程——正在
   * 提案的 Main Agent、CLI、第二个 daemon——会向同一本 Journal 追加事件，而那些 Run
   * 在重放之前对这里是不可见的。任何要观察"别处创建的工作"的组件，都必须先刷新再看。
   */
  async refresh(): Promise<void> {
    await this.#journal.reload?.();
    this.#state = replay(await this.#journal.list());
    this.#hydrated = true;
  }

  /**
   * Recovers runs orphaned by a dead executor.
   *
   * A process killed mid-execution leaves its run in `running` (or `verifying`)
   * forever: the queue only picks up `queued`, so the lease being stealable
   * meant nothing — there was no work left in a claimable state to steal. This
   * is the missing half of the crash story: liveness is decided by the claim,
   * not guessed from the status.
   *
   * The probe is the claim, and only the claim: a run mid-execution with a
   * live lease belongs to whoever holds it and is left alone. A run whose
   * lease is gone has no executor —
   *
   *   - reversible work (read-only or reversible_write steps) goes back to the
   *     queue: re-execution overwrites, it does not duplicate;
   *   - external or irreversible work fails instead, because a retry cannot
   *     know whether the email was sent, and the honest outcome is a failed
   *     run the opportunity engine turns into a follow-up card for the owner;
   *   - a run orphaned mid-verification fails the same way: the work happened,
   *     the verdict did not, and a verdict that cannot be reconstructed must
   *     not be invented.
   *
   * Only stores that support claims can be probed; a single-process store has
   * no orphans by construction, and this method leaves those runs untouched.
   *
   * 恢复被死掉的执行者丢下的 Run。
   *
   * 执行中途被杀的进程会把它的 Run 永远留在 `running`（或 `verifying`）：队列只认
   * `queued`，因此"租约可抢占"毫无意义——根本没有留在可领取状态里的工作可抢。这是
   * 崩溃故事的缺失一半：活性由领取判定，而不是从状态猜测。
   *
   * 探针是领取，且只是领取：带着存活租约的执行中 Run 属于持有者，不去碰。租约已消失
   * 的 Run 没有执行者——
   *
   *   - 可逆的工作（read-only 或 reversible_write 步骤）回到队列：重执行是覆盖，
   *     不是复制；
   *   - 外部或不可逆的工作改为失败，因为重试无法知道邮件是否已发出，而诚实的结局是
   *     一个失败的 Run，由机会引擎转成给所有者的跟进卡片；
   *   - 在验证中途被丢下的 Run 同样失败：工作发生了，结论没有，而无法重建的结论
   *     绝不能被编造。
   *
   * 只有支持领取的存储可被探测；单进程存储按构造没有孤儿，本方法不碰那些 Run。
   */
  async recoverOrphanedRuns(): Promise<Array<{ runId: string; action: "requeued" | "failed"; reason: string }>> {
    await this.hydrate();
    if (this.#journal.readClaim === undefined) return [];
    const now = Date.now();
    const recovered: Array<{ runId: string; action: "requeued" | "failed"; reason: string }> = [];

    for (const run of Object.values(this.#state.runs)) {
      if (run.status !== "running" && run.status !== "verifying") continue;
      const claim = await this.#journal.readClaim(run.id);
      if (claim !== undefined && Date.parse(claim.leaseUntil) > now) continue;

      const external = run.planId === undefined
        ? false
        : (this.#state.plans[run.planId]?.steps ?? []).some((step) => (
          step.risk === "external_side_effect" || step.risk === "irreversible"
          || step.subagents?.some((order) => order.risk === "external_side_effect" || order.risk === "irreversible")
        ));

      if (run.status === "verifying" || external) {
        const reason = run.status === "verifying"
          ? "executor died while verifying; the verdict cannot be reconstructed"
          : "executor died with external-effect steps; a retry could duplicate the side effect";
        await this.record({
          type: "run.status_changed",
          taskId: run.taskId,
          runId: run.id,
          payload: { status: "failed", activeStepId: run.activeStepId, reason },
        });
        recovered.push({ runId: run.id, action: "failed", reason });
        continue;
      }

      await this.record({
        type: "run.status_changed",
        taskId: run.taskId,
        runId: run.id,
        payload: {
          status: "queued",
          activeStepId: run.activeStepId,
          reason: "executor died; lease expired, work returned to the queue",
        },
      });
      recovered.push({ runId: run.id, action: "requeued", reason: "executor died; lease expired" });
    }
    return recovered;
  }

  async acceptTrigger(input: Omit<Trigger, "id" | "occurredAt">): Promise<{ task: Task; run: Run }> {
    await this.hydrate();

    const trigger: Trigger = { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
    const task: Task = {
      id: randomUUID(),
      triggerId: trigger.id,
      title: trigger.summary,
      objective: trigger.summary,
      acceptanceCriteria: ["A plan exists", "Execution is verified or explicitly blocked"],
      createdAt: new Date().toISOString(),
    };
    const run: Run = {
      id: randomUUID(),
      taskId: task.id,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.record({ type: "trigger.received", payload: trigger });
    await this.record({ type: "task.created", taskId: task.id, payload: task });
    await this.record({ type: "run.created", taskId: task.id, runId: run.id, payload: run });
    await this.changeStatus(run.id, "planning");
    return { task, run: this.requireRun(run.id) };
  }

  async attachPlan(runId: string, input: Omit<WorkPlan, "id" | "runId" | "createdAt">): Promise<WorkPlan> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status !== "planning") {
      throw new Error(`A plan can only be attached while planning; run is ${run.status}.`);
    }
    assertPlanIsExecutable(input.steps, this.#knownAgentIds?.());

    const plan: WorkPlan = { ...input, id: randomUUID(), runId, createdAt: new Date().toISOString() };
    await this.record({ type: "plan.created", taskId: run.taskId, runId, payload: plan });
    await this.changeStatus(runId, "queued");
    return plan;
  }

  /**
   * Close a run that can no longer proceed (for example a rejected plan
   * proposal). A journaled terminal status keeps the projection honest;
   * abandoned runs must not linger as if they were still planning.
   * 关闭无法继续的 Run（例如被拒绝的计划提案）。记入 Journal 的终态让投影保持诚实；
   * 被放弃的 Run 不能像仍在规划中一样滞留。
   */
  async failRun(runId: string, reason: string): Promise<void> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${runId} already reached terminal status ${run.status}.`);
    }
    await this.record({
      type: "run.status_changed",
      taskId: run.taskId,
      runId,
      payload: { status: "failed", reason: redactAuditText(reason) },
    });
  }

  async grantApproval(runId: string, stepId: string, note?: string): Promise<ApprovalGrant> {    await this.hydrate();
    const run = this.requireRun(runId);
    const plan = this.requirePlan(run);
    if (!plan.steps.some((step) => step.id === stepId)) {
      throw new Error(`Step ${stepId} is not part of run ${runId}.`);
    }

    const approval: ApprovalGrant = {
      id: randomUUID(),
      runId,
      stepId,
      grantedAt: new Date().toISOString(),
      grantedBy: "user",
      note,
    };
    await this.record({ type: "approval.granted", taskId: run.taskId, runId, payload: approval });
    return approval;
  }

  async execute(runId: string, agents: AgentRegistry): Promise<DispatchResult> {
    await this.hydrate();
    let run = this.requireRun(runId);
    const task = this.requireTask(run.taskId);
    const plan = this.requirePlan(run);

    if (run.status !== "queued" && run.status !== "waiting_approval" && run.status !== "running") {
      throw new Error(`Run ${run.id} cannot execute while ${run.status}.`);
    }

    for (const step of plan.steps) {
      if (this.stepHasCompletedEvidence(run.id, step)) {
        continue;
      }

      const approved = this.#state.approvals[approvalKey(run.id, step.id)] !== undefined;
      const decision = this.#policy.evaluate({ run, task, step, approved });
      await this.record({ type: "policy.decided", taskId: task.id, runId: run.id, payload: { stepId: step.id, decision } });

      if (decision.outcome === "denied") {
        await this.changeStatus(run.id, "failed", step.id);
        return { run: this.requireRun(run.id), status: "failed" };
      }
      if (decision.outcome === "approval_required") {
        await this.changeStatus(run.id, "waiting_approval", step.id);
        return { run: this.requireRun(run.id), status: "waiting_approval" };
      }

      if (this.requireRun(run.id).status !== "running") {
        await this.changeStatus(run.id, "running", step.id);
      }
      run = this.requireRun(run.id);

      try {
        if (step.subagents !== undefined) {
          await this.executeSubagents({ run, task, step, agents });
        } else {
          await this.executeSingleAgent({ run, task, step, agents });
        }
      } catch (error: unknown) {
        await this.changeStatus(run.id, "failed", step.id);
        return { run: this.requireRun(run.id), status: "failed" };
      }
    }

    await this.changeStatus(run.id, "verifying");
    const verification = await this.#verifier.verify({
      run: this.requireRun(run.id),
      plan,
      evidence: this.#state.evidenceByRun[run.id] ?? [],
    });
    await this.record({ type: "verification.completed", taskId: task.id, runId: run.id, payload: verification });

    if (!verification.passed) {
      await this.changeStatus(run.id, "failed");
      return { run: this.requireRun(run.id), status: "failed", verification };
    }

    await this.changeStatus(run.id, "completed");
    await this.#memory.request(this.requireRun(run.id), task, this.#state.evidenceByRun[run.id] ?? []);
    return { run: this.requireRun(run.id), status: "completed", verification };
  }

  getRun(runId: string): Run {
    return this.requireRun(runId);
  }

  /** Read-only view of every run in the projection, oldest first. 投影中全部 Run 的只读视图，按创建时间升序。 */
  listRuns(): Run[] {
    return Object.values(this.#state.runs)
      .map((run) => ({ ...run }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getSubagentsForRun(runId: string): SubagentRun[] {
    return Object.values(this.#state.subagents)
      .filter((subagent) => subagent.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getEventsForRun(runId: string): Promise<readonly string[]> {
    return this.#journal.list().then((events) => events.filter((event) => event.runId === runId).map((event) => event.type));
  }

  async cancel(runId: string, agents: AgentRegistry): Promise<Run> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${run.id} cannot be cancelled while ${run.status}.`);
    }

    for (const subagent of this.getSubagentsForRun(runId).filter((item) => item.status === "running")) {
      if (subagent.sessionId !== undefined) {
        const adapter = agents.get(subagent.agentId);
        if (adapter === undefined) {
          throw new Error(`Cannot cancel ${subagent.workOrderId}; adapter ${subagent.agentId} is not registered.`);
        }
        if (subagent.providerId !== undefined && subagent.providerId !== adapter.providerId) {
          throw new Error(
            `Cannot cancel ${subagent.workOrderId}; provider changed from ${subagent.providerId} to ${adapter.providerId}.`,
          );
        }
        if (adapter.cancel === undefined) {
          throw new Error(`Cannot cancel ${subagent.workOrderId}; adapter ${adapter.id} does not support cancellation.`);
        }
        await adapter.cancel(subagent.sessionId);
      }
      await this.record({
        type: "subagent.cancelled",
        taskId: run.taskId,
        runId,
        payload: { workOrderId: subagent.workOrderId, message: "Cancelled by the supervisor." },
      });
    }
    await this.changeStatus(runId, "cancelled", run.activeStepId);
    return this.requireRun(runId);
  }

  /**
   * Records the curated local memories that were actually supplied to this run.
   * 记录实际被筛选并提供给当前 Run 的本地 Memory。
   */
  async recordMemoryRecall(runId: string, query: string, memories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>): Promise<void> {
    await this.hydrate();
    const run = this.requireRun(runId);
    if (memories.length === 0) return;
    await this.record({
      type: "memory.recalled",
      taskId: run.taskId,
      runId,
      payload: { query, memories },
    });
  }

  private async executeSingleAgent(input: { run: Run; task: Task; step: PlanStep; agents: AgentRegistry }): Promise<void> {
    if (this.#workspacePath === undefined) {
      return this.executeSingleAgentUnlocked(input);
    }
    return workspaceExecutionLock.run(this.#workspacePath, () => this.executeSingleAgentUnlocked(input));
  }

  private async executeSingleAgentUnlocked(input: { run: Run; task: Task; step: PlanStep; agents: AgentRegistry }): Promise<void> {
    const agentId = input.step.agentId;
    if (agentId === undefined) {
      throw new Error(`Plan step ${input.step.id} has no executor.`);
    }
    const adapter = input.agents.get(agentId);
    if (adapter === undefined) {
      throw new Error(`No adapter is registered for agent ${agentId}.`);
    }
    const capabilities = await adapter.capabilities();
    const missingCapabilities = (input.step.requiredCapabilities ?? []).filter(
      (capability) => !capabilities.work.includes(capability),
    );
    if (missingCapabilities.length > 0) {
      throw new Error(
        `Agent ${agentId} cannot execute step ${input.step.id}; missing capabilities: ${missingCapabilities.join(", ")}.`,
      );
    }
    const memoryContext = await this.compileMemoryContext({ run: input.run, task: input.task, step: input.step });
    await this.withExecutionWorkspace(input.step.risk, `${input.run.id}-${input.step.id}`, async (workspace) => {
      const assignment: ExecutionAssignment = {
        run: input.run,
        task: input.task,
        step: input.step,
        executor: { agentId: adapter.id, providerId: adapter.providerId },
        ...(memoryContext === undefined ? {} : { memoryContext }),
        failureCatalog: this.#failureCatalog,
        ...this.assignmentWorkspaceFields(workspace),
      };
      const executionAuthorization = evidenceAuthorization(capabilities);
      await this.record({
        type: "execution.started",
        taskId: input.task.id,
        runId: input.run.id,
        payload: {
          stepId: input.step.id,
          adapterId: adapter.id,
          providerId: adapter.providerId,
          // The authorization snapshot makes the journal self-auditing: a later
          // replay can verify every recorded evidence kind against what this
          // adapter was actually allowed to record at dispatch time.
          // 授权快照让 Journal 可以自审计：事后重放能对照派发时该 Adapter 实际被允许的
          // 证据类型，校验每一条已记录的 Evidence。
          authorizedEvidenceKinds: [...executionAuthorization],
          memoryItemIds: memoryContext?.items.map((item) => item.id) ?? [],
          ...isolationAudit(workspace),
        },
      });
      const completion = await this.consumeExecutionEvents(adapter, assignment, executionAuthorization);
      if (completion === undefined) {
        throw new Error(`Agent ${agentId} ended without an explicit completion event.`);
      }
      if (!this.stepHasCompletedEvidence(input.run.id, input.step)) {
        throw new Error(`Agent ${agentId} completed step ${input.step.id} without evidence.`);
      }
      await this.settleIsolatedWorkspace({
        workspace,
        run: input.run,
        task: input.task,
        step: input.step,
      });
    });
  }

  private async executeSubagents(input: { run: Run; task: Task; step: PlanStep; agents: AgentRegistry }): Promise<void> {
    const orders = input.step.subagents ?? [];
    let outstanding = orders.filter((order) => !this.workOrderHasCompletedEvidence(input.run.id, order.id));

    while (outstanding.length > 0) {
      const ready = outstanding.filter((order) => this.dependenciesAreComplete(input.run.id, order));
      if (ready.length === 0) {
        throw new Error(`Subagent work orders for step ${input.step.id} cannot make progress; check dependencies.`);
      }
      await Promise.all(ready.map((order) => this.dispatchSubagent({ ...input, workOrder: order })));
      outstanding = orders.filter((order) => !this.workOrderHasCompletedEvidence(input.run.id, order.id));
    }
  }

  private dependenciesAreComplete(runId: string, order: SubagentWorkOrder): boolean {
    return (order.dependsOn ?? []).every((dependencyId) => this.workOrderHasCompletedEvidence(runId, dependencyId));
  }

  private async dispatchSubagent(input: { run: Run; task: Task; step: PlanStep; workOrder: SubagentWorkOrder; agents: AgentRegistry }): Promise<void> {
    if (this.#workspacePath === undefined) {
      return this.dispatchSubagentUnlocked(input);
    }
    return workspaceExecutionLock.run(this.#workspacePath, () => this.dispatchSubagentUnlocked(input));
  }

  private async dispatchSubagentUnlocked(input: { run: Run; task: Task; step: PlanStep; workOrder: SubagentWorkOrder; agents: AgentRegistry }): Promise<void> {
    const existing = this.#state.subagents[subagentKey(input.run.id, input.workOrder.id)];
    if (existing?.status === "completed") {
      if (await this.ensureWorkOrderVerified(input, existing.agentId)) {
        return;
      }
    }
    if (existing?.status === "cancelled") {
      throw new Error(`Subagent ${input.workOrder.id} was cancelled.`);
    }

    // A fresh work order may be routed by capability. Once started, the
    // concrete adapter identity is pinned so replay cannot silently move the
    // persisted provider session to another configured worker.
    // 新 WorkOrder 可以按能力路由；一旦启动，具体 Adapter 身份会被固定，避免重放时
    // 悄悄把已持久化的 Provider Session 换到另一个 Worker。
    let adapter = await new CapabilityDispatcher(input.agents).select(
      existing === undefined
        ? input.workOrder
        : { ...input.workOrder, agentId: existing.agentId },
    );
    if (existing?.providerId !== undefined && existing.providerId !== adapter.providerId) {
      throw new Error(
        `Work order ${input.workOrder.id} started with provider ${existing.providerId} and cannot resume with ${adapter.providerId}.`,
      );
    }
    const memoryContext = await this.compileMemoryContext({
      run: input.run,
      task: input.task,
      step: input.step,
      workOrder: input.workOrder,
    });
    const assignment: ExecutionAssignment = {
      run: input.run,
      task: input.task,
      step: input.step,
      executor: { agentId: adapter.id, providerId: adapter.providerId },
      workOrder: input.workOrder,
      dependencyEvidence: this.dependencyEvidence(input.run.id, input.workOrder),
      ...(memoryContext === undefined ? {} : { memoryContext }),
      failureCatalog: this.#failureCatalog,
    };
    let allowedEvidenceKinds = evidenceAuthorization(await adapter.capabilities());
    const triedAdapterIds = new Set<string>();
    const failureReports: FailureReport[] = [];

    const previousAttempt = existing?.attempt ?? 1;
    let attempt = existing === undefined
      ? 1
      : existing.status === "running"
        ? previousAttempt
        : previousAttempt + 1;
    let sessionId = existing?.sessionId;
    let lastError: unknown = existing?.status === "completed"
      ? new Error(`Subagent ${input.workOrder.id} did not satisfy its artifact contract.`)
      : undefined;

    // A running/failed record after a process restart is not permission to
    // blindly rerun. First arbitrate the Workspace side effects against the
    // durable pre-dispatch checkpoint.
    // 进程重启后留下的 running/failed 记录不能直接变成盲目重跑许可；先用持久的派发前
    // 检查点裁决 Workspace 副作用。
    if (existing !== undefined && (existing.status === "running" || existing.status === "failed")) {
      const recovery = await this.assessWorkspaceRecovery(input, existing, undefined, allowedEvidenceKinds);
      if (recovery !== undefined) {
        await this.recordRecoveryDecision(input, recovery);
        if (recovery.decision === "blocked") {
          const failure = this.recoveryFailure(input, adapter, recovery);
          await this.recordSubagentFailure(input, adapter, failure);
          throw failure;
        }
        if (recovery.decision === "reconciled") {
          await this.reconcileWorkspaceRecovery(input, adapter, recovery);
          return;
        }
      }
    }

    return this.withExecutionWorkspace(input.workOrder.risk, `${input.run.id}-${input.workOrder.id}`, async (workspace) => {
      Object.assign(assignment, this.assignmentWorkspaceFields(workspace));
      while (attempt <= input.workOrder.budget.maxAttempts) {
      if (existing === undefined && attempt === 1) {
        const startedAt = new Date().toISOString();
        const workspaceCheckpoint = await this.saveWorkspaceCheckpoint(input, attempt, workspace.path);
        const subagent: SubagentRun = {
          id: randomUUID(),
          runId: input.run.id,
          stepId: input.step.id,
          workOrderId: input.workOrder.id,
          agentId: adapter.id,
          providerId: adapter.providerId,
          role: input.workOrder.role,
          title: input.workOrder.title,
          status: "running",
          ...(workspaceCheckpoint === undefined ? {} : { workspaceCheckpoint }),
          ...(workspace.path === undefined ? {} : { workspacePath: workspace.path }),
          attempt,
          startedAt,
          updatedAt: startedAt,
        };
        await this.record({
          type: "subagent.dispatched",
          taskId: input.task.id,
          runId: input.run.id,
          payload: {
            ...subagent,
            authorizedEvidenceKinds: [...allowedEvidenceKinds],
            memoryItemIds: memoryContext?.items.map((item) => item.id) ?? [],
            ...isolationAudit(workspace),
          },
        });
      } else {
        await this.record({
          type: "subagent.resumed",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { workOrderId: input.workOrder.id, sessionId, adapterId: adapter.id, attempt },
        });
      }

      try {
        const stream = sessionId !== undefined && adapter.resume !== undefined
          ? { execute: () => adapter.resume!(sessionId!, assignment) }
          : adapter;
        const completion = await this.consumeExecutionEvents(stream, assignment, allowedEvidenceKinds);
        if (completion === undefined) {
          throw new Error("Subagent ended without an explicit completion event.");
        }
        if (!this.workOrderHasEvidence(input.run.id, input.workOrder.id)) {
          throw new Error("Subagent completed without producing evidence.");
        }
        await this.record({
          type: "subagent.completed",
          taskId: input.task.id,
          runId: input.run.id,
          payload: { workOrderId: input.workOrder.id, summary: redactAuditText(completion) },
        });
        if (!(await this.ensureWorkOrderVerified(input, adapter.id))) {
          throw new Error(`Subagent ${input.workOrder.id} did not satisfy its artifact contract.`);
        }
        await this.settleIsolatedWorkspace({
          workspace,
          run: input.run,
          task: input.task,
          step: input.step,
          workOrder: input.workOrder,
        });
        return;
      } catch (error: unknown) {
        lastError = error;
        const message = redactAuditText(
          error instanceof Error ? error.message : "Unknown subagent failure.",
        );
        const report = error instanceof WorkerFailure ? error.report : undefined;
        const recovery = await this.assessWorkspaceRecovery(input, existing, report, allowedEvidenceKinds);
        if (recovery !== undefined) {
          await this.recordRecoveryDecision(input, recovery);
          if (recovery.decision === "reconciled") {
            await this.reconcileWorkspaceRecovery(input, adapter, recovery);
            await this.settleIsolatedWorkspace({
              workspace,
              run: input.run,
              task: input.task,
              step: input.step,
              workOrder: input.workOrder,
            });
            return;
          }
          if (recovery.decision === "blocked") {
            const failure = this.recoveryFailure(input, adapter, recovery);
            await this.recordSubagentFailure(input, adapter, failure);
            throw failure;
          }
        }
        if (report !== undefined) failureReports.push(report);
        await this.recordSubagentFailure(input, adapter, error, message, report);

        // Two independent agents failing the same way is evidence about the
        // task, not about the agents. Spending another attempt would only
        // reproduce the same wall, so the obstacle goes to the owner instead.
        // 两个独立 Agent 以相同方式失败，这是关于任务的证据而不是关于 Agent 的。
        // 再花一次尝试只会撞上同一堵墙，因此把障碍交给所有者。
        const corroboration = corroborateFailures(failureReports, this.#failureCatalog);
        if (corroboration.corroborated) {
          await this.record({
            type: "subagent.failed",
            taskId: input.task.id,
            runId: input.run.id,
            payload: {
              workOrderId: input.workOrder.id,
              message: redactAuditText(corroboration.summary),
              corroboration: { ...corroboration, providers: failureReports.map((item) => item.providerId) },
            },
          });
          throw new WorkerFailure(corroboration.summary, report);
        }

        if (attempt >= input.workOrder.budget.maxAttempts) throw error;

        // Retry on a different provider: repeating the same black box rarely
        // produces a different outcome, and a second opinion is what makes
        // corroboration possible at all.
        // 换一个 Provider 重试：重复同一个黑盒很少产生不同结果，而第二个意见正是
        // 交叉印证得以成立的前提。
        triedAdapterIds.add(adapter.id);
        const alternative = await this.selectAlternativeAdapter(input, triedAdapterIds);
        if (alternative !== undefined) {
          adapter = alternative;
          allowedEvidenceKinds = evidenceAuthorization(await adapter.capabilities());
          sessionId = undefined;
        } else {
          sessionId = this.#state.subagents[subagentKey(input.run.id, input.workOrder.id)]?.sessionId;
        }
        attempt += 1;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Subagent exhausted its attempt budget.");
    });
  }

  /**
   * External/irreversible work gets a tree that is not the owner's. Reversible
   * work keeps the live project so the owner can keep the files.
   * 外部/不可逆工作拿到的不是所有者那棵树。可逆工作仍用活项目，所有者才能留下文件。
   */
  private async withExecutionWorkspace<T>(
    risk: RiskClass,
    key: string,
    run: (workspace: ExecutionWorkspace) => Promise<T>,
  ): Promise<T> {
    if (this.#workspacePath === undefined || !requiresIsolatedWorkspace(risk)) {
      return run({ path: this.#workspacePath });
    }
    const isolation = await prepareIsolatedWorkspace({
      ownerPath: this.#workspacePath,
      sandboxRoot: this.#isolatedWorkspaceRoot,
      key,
    });
    const workspace: ExecutionWorkspace = { path: isolation.path, isolation, retainSandbox: false };
    try {
      return await run(workspace);
    } finally {
      // Leftover or conflicting writes stay on disk so the owner can inspect them.
      // 未拷回或冲突的写入留在磁盘上，所有者才能查看。
      if (workspace.retainSandbox !== true) await isolation.dispose();
    }
  }

  /**
   * Offers named artifacts back to the live tree, then journals where to look.
   * Unnamed writes are never merged: isolation would otherwise be theater.
   * 把点名产物交回活树，并记入 Journal 供查看。未点名的写入绝不合并：否则隔离只是演戏。
   */
  private async settleIsolatedWorkspace(input: {
    workspace: ExecutionWorkspace;
    run: Run;
    task: Task;
    step: PlanStep;
    workOrder?: SubagentWorkOrder;
  }): Promise<void> {
    const isolation = input.workspace.isolation;
    if (isolation === undefined || this.#workspacePath === undefined) return;

    const namedFiles = namedFilesForIsolation(input.step, input.workOrder);
    let result;
    try {
      result = await applyIsolatedArtifacts({
        isolatedPath: isolation.path,
        ownerPath: this.#workspacePath,
        namedFiles,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "isolated apply failed";
      result = {
        copied: [],
        skipped: [{ path: ".", reason }],
        leftover: [],
        sandboxRetained: true,
        isolatedPath: isolation.path,
        ownerPath: this.#workspacePath,
      };
    }

    input.workspace.retainSandbox = result.sandboxRetained;
    await this.record({
      type: "workspace.isolation.applied",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        stepId: input.step.id,
        ...(input.workOrder === undefined ? {} : { workOrderId: input.workOrder.id }),
        kind: isolation.kind,
        isolatedPath: result.isolatedPath,
        ownerPath: result.ownerPath,
        copied: result.copied,
        skipped: result.skipped,
        leftover: result.leftover,
        sandboxRetained: result.sandboxRetained,
        summary: summarizeIsolatedApply(result),
      },
    });
  }

  private assignmentWorkspaceFields(workspace: { path?: string; isolation?: IsolatedWorkspace }): Pick<ExecutionAssignment, "workspacePath" | "workspaceIsolation"> {
    return {
      ...(workspace.path === undefined ? {} : { workspacePath: workspace.path }),
      ...(workspace.isolation === undefined
        ? {}
        : { workspaceIsolation: { kind: workspace.isolation.kind, ownerPath: workspace.isolation.ownerPath } }),
    };
  }

  private async saveWorkspaceCheckpoint(
    input: { run: Run; workOrder: SubagentWorkOrder },
    attempt: number,
    workspaceRoot = this.#workspacePath,
  ): Promise<string | undefined> {
    if (workspaceRoot === undefined || this.#workspaceCheckpoints === undefined) return undefined;
    const snapshot = await snapshotWorkspace(workspaceRoot);
    return this.#workspaceCheckpoints.save(
      `${input.run.id}/${input.workOrder.id}/attempt-${attempt}`,
      snapshot,
    );
  }

  /**
   * Compares the interrupted Workspace with the durable baseline. A missing
   * baseline is a safety block, never an invitation to rerun blindly.
   * 比较中断后的 Workspace 与持久基线。缺少基线时必须安全阻塞，绝不能变成盲目重跑。
   */
  private async assessWorkspaceRecovery(
    input: { run: Run; step: PlanStep; workOrder: SubagentWorkOrder },
    existing: SubagentRun | undefined,
    report: FailureReport | undefined,
    allowedEvidenceKinds: ReadonlySet<Evidence["kind"]>,
  ): Promise<WorkspaceRecoveryAssessment | undefined> {
    const reportedChanges = report?.workspaceChanges;
    let changes: WorkspaceChange[];
    let checkpointLocator = existing?.workspaceCheckpoint;

    if (reportedChanges !== undefined) {
      changes = [...reportedChanges];
    } else {
      if (this.#workspacePath === undefined || this.#workspaceCheckpoints === undefined) return undefined;
      const current = existing ?? this.#state.subagents[subagentKey(input.run.id, input.workOrder.id)];
      checkpointLocator = current?.workspaceCheckpoint;
      if (checkpointLocator === undefined) {
        return {
          decision: "blocked",
          category: "recovery_blocked",
          reason: "The interrupted WorkOrder has no durable Workspace checkpoint.",
          changes: [],
        };
      }
      let before;
      try {
        before = await this.#workspaceCheckpoints.load(checkpointLocator);
      } catch (error: unknown) {
        return {
          decision: "blocked",
          category: "recovery_blocked",
          reason: `The Workspace checkpoint could not be read: ${error instanceof Error ? error.message : "invalid checkpoint"}.`,
          changes: [],
          checkpoint: checkpointLocator,
        };
      }
      if (before === undefined) {
        return {
          decision: "blocked",
          category: "recovery_blocked",
          reason: `The Workspace checkpoint ${checkpointLocator} is missing.`,
          changes: [],
          checkpoint: checkpointLocator,
        };
      }
      if (before.root !== undefined && before.root !== this.#workspacePath) {
        return {
          decision: "blocked",
          category: "recovery_blocked",
          reason: `The Workspace checkpoint belongs to ${before.root}, not ${this.#workspacePath}.`,
          changes: [],
          checkpoint: checkpointLocator,
        };
      }
      changes = diffWorkspace(before, await snapshotWorkspace(this.#workspacePath));
    }

    const checkpoint = checkpointLocator === undefined ? {} : { checkpoint: checkpointLocator };
    if (changes.length === 0) {
      return {
        decision: "rerun",
        category: "recovery_blocked",
        reason: "The interrupted Workspace has no observed changes; a fresh session may rerun it.",
        changes,
        ...checkpoint,
      };
    }

    const changeSummary = changes.map((change) => `${change.change}:${change.path}`).join(", ");
    if (input.workOrder.risk === "read_only") {
      return {
        decision: "blocked",
        category: "unexpected_side_effect",
        reason: `A read-only WorkOrder changed the Workspace: ${changeSummary}.`,
        changes,
        ...checkpoint,
      };
    }

    const requiredArtifacts = input.workOrder.expectedArtifacts.filter((artifact) => artifact.required);
    const canObserveArtifacts = allowedEvidenceKinds.has("artifact")
      && requiredArtifacts.every((artifact) => artifact.kind === "artifact")
      && artifactChanges(changes).length >= requiredArtifacts.length;
    if (canObserveArtifacts) {
      return {
        decision: "reconciled",
        category: "partial_side_effect",
        reason: `Recovery observed enough durable artifacts to avoid repeating the WorkOrder: ${changeSummary}.`,
        changes,
        ...checkpoint,
      };
    }

    // Reversible work may be rolled back to the pre-dispatch copies when they
    // exist. External and irreversible steps must not be rerun after a restore:
    // that would duplicate a side effect the Kernel cannot see.
    // 可逆工作在派发前副本还在时可以滚回去。外部与不可逆步骤不得在还原后再跑：
    // 那会复制 Kernel 看不见的副作用。
    if (
      input.workOrder.risk === "reversible_write"
      && checkpointLocator !== undefined
      && this.#workspacePath !== undefined
      && this.#workspaceCheckpoints !== undefined
    ) {
      const restored = await this.#workspaceCheckpoints.restore(checkpointLocator, this.#workspacePath);
      if (restored !== undefined && restored.restored.length > 0) {
        return {
          decision: "rerun",
          category: "recovery_blocked",
          reason: `Restored ${restored.restored.length} file(s) from the pre-dispatch checkpoint; a fresh session may rerun it.`,
          changes,
          ...checkpoint,
        };
      }
    }

    if (changes.some((change) => change.change === "deleted")) {
      return {
        decision: "blocked",
        category: "partial_side_effect",
        reason: `Recovery found deleted files and cannot safely rerun: ${changeSummary}.`,
        changes,
        ...checkpoint,
      };
    }

    return {
      decision: "blocked",
      category: "partial_side_effect",
      reason: `Recovery found Workspace changes but not a complete artifact contract: ${changeSummary}.`,
      changes,
      ...checkpoint,
    };
  }

  private async recordRecoveryDecision(
    input: { task: Task; run: Run; step: PlanStep; workOrder: SubagentWorkOrder },
    assessment: WorkspaceRecoveryAssessment,
  ): Promise<void> {
    await this.record({
      type: "subagent.recovery_decided",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        workOrderId: input.workOrder.id,
        stepId: input.step.id,
        decision: assessment.decision,
        category: assessment.category,
        reason: redactAuditText(assessment.reason),
        checkpoint: assessment.checkpoint,
        changes: assessment.changes,
      },
    });
  }

  private recoveryFailure(
    input: { workOrder: SubagentWorkOrder },
    adapter: RuntimeAdapter,
    assessment: WorkspaceRecoveryAssessment,
  ): WorkerFailure {
    const report: FailureReport = {
      providerId: adapter.providerId,
      agentId: adapter.id,
      category: assessment.category,
      signature: failureSignature(assessment.reason),
      detail: redactAuditText(assessment.reason),
      ...(assessment.changes.length === 0 ? {} : { workspaceChanges: assessment.changes }),
    };
    return new WorkerFailure(`Recovery for ${input.workOrder.id} was blocked: ${assessment.reason}`, report);
  }

  private async recordSubagentFailure(
    input: { task: Task; run: Run; workOrder: SubagentWorkOrder },
    adapter: RuntimeAdapter,
    error: unknown,
    message?: string,
    report?: FailureReport,
  ): Promise<void> {
    const resolvedMessage = message
      ?? (error instanceof Error ? redactAuditText(error.message) : "Unknown subagent failure.");
    const resolvedReport = report ?? (error instanceof WorkerFailure ? error.report : undefined);
    await this.record({
      type: "subagent.failed",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        workOrderId: input.workOrder.id,
        adapterId: adapter.id,
        providerId: adapter.providerId,
        message: resolvedMessage,
        report: resolvedReport,
      },
    });
  }

  private async reconcileWorkspaceRecovery(
    input: { task: Task; run: Run; step: PlanStep; workOrder: SubagentWorkOrder },
    adapter: RuntimeAdapter,
    assessment: WorkspaceRecoveryAssessment,
  ): Promise<void> {
    const producedBy = adapter.id;
    for (const change of artifactChanges(assessment.changes)) {
      const evidence: Evidence = {
        id: randomUUID(),
        runId: input.run.id,
        stepId: input.step.id,
        workOrderId: input.workOrder.id,
        producedBy,
        kind: "artifact",
        summary: `Observed durable artifact during recovery: ${change.path}`,
        locator: change.path,
        createdAt: new Date().toISOString(),
      };
      await this.record({ type: "evidence.recorded", taskId: input.task.id, runId: input.run.id, payload: evidence });
    }
    await this.record({
      type: "subagent.completed",
      taskId: input.task.id,
      runId: input.run.id,
      payload: { workOrderId: input.workOrder.id, summary: "Reconciled observed Workspace artifacts after an interrupted black-box session." },
    });
    if (!(await this.ensureWorkOrderVerified(input, producedBy))) {
      const failure = this.recoveryFailure(input, adapter, {
        ...assessment,
        decision: "blocked",
        category: "recovery_blocked",
        reason: "Observed Workspace artifacts still failed the WorkOrder contract.",
      });
      throw failure;
    }
  }

  /**
   * Compiles the scoped memory packet for one assignment and journals exactly
   * which memories reached which worker. Memory is never handed over wholesale:
   * the objective is the query, the store applies the owner's recall switch and
   * per-task cap, and nothing reaches a worker without a memory.recalled event
   * to audit it against.
   * 为一次派发编译有作用域的记忆包，并把"哪些记忆到了哪个 Worker"记入 Journal。
   * 记忆绝不整体移交：以目标为查询、由 Store 施加所有者的召回开关与每任务上限，
   * 且没有 memory.recalled 事件可供对照的记忆不会到达任何 Worker。
   */
  private async compileMemoryContext(input: {
    run: Run;
    task: Task;
    step: PlanStep;
    workOrder?: SubagentWorkOrder;
  }): Promise<MemoryContextPacket | undefined> {
    if (this.#memorySource === undefined) return undefined;
    const query = input.workOrder?.objective ?? input.step.instructions;
    const matches = await this.#memorySource.recall(query, input.run.id);
    if (matches.length === 0) return undefined;

    await this.record({
      type: "memory.recalled",
      taskId: input.task.id,
      runId: input.run.id,
      payload: {
        query,
        scope: { stepId: input.step.id, workOrderId: input.workOrder?.id },
        memories: matches.map((match) => ({
          id: match.memory.id,
          summary: match.memory.summary,
          score: match.score,
          matchedTerms: match.matchedTerms,
        })),
      },
    });
    return {
      items: matches.map((match) => ({ id: match.memory.id, summary: match.memory.summary })),
      selectedBy: { query },
    };
  }

  /**
   * Finds a capable executor that has not already failed this work order.
   * Provider diversity is the point: a second opinion either succeeds or
   * corroborates that the obstacle is in the task itself.
   * 找出尚未在该 WorkOrder 上失败过、且能力匹配的执行者。Provider 多样性正是要点：
   * 第二个意见要么成功，要么印证障碍在任务本身。
   */
  private async selectAlternativeAdapter(
    input: { workOrder: SubagentWorkOrder; agents: AgentRegistry },
    tried: ReadonlySet<string>,
  ): Promise<RuntimeAdapter | undefined> {
    for (const candidate of input.agents.list()) {
      if (tried.has(candidate.id)) continue;
      const capabilities = await candidate.capabilities();
      if (input.workOrder.requiredCapabilities.every((capability) => capabilities.work.includes(capability))) {
        return candidate;
      }
    }
    return undefined;
  }

  private dependencyEvidence(runId: string, order: SubagentWorkOrder): Evidence[] {
    const dependencyIds = new Set(order.dependsOn ?? []);
    return (this.#state.evidenceByRun[runId] ?? []).filter((item) => (
      item.workOrderId !== undefined && dependencyIds.has(item.workOrderId)
    ));
  }

  private async ensureWorkOrderVerified(
    input: { run: Run; task: Task; step: PlanStep; workOrder: SubagentWorkOrder },
    producedBy: string,
  ): Promise<boolean> {
    const key = subagentKey(input.run.id, input.workOrder.id);
    const existing = this.#state.subagentVerificationByKey[key];
    if (existing?.passed === true) return true;

    const evidence = (this.#state.evidenceByRun[input.run.id] ?? []).filter(
      (item) => item.workOrderId === input.workOrder.id,
    );
    const failures: string[] = [];
    const usedEvidenceIds = new Set<string>();
    for (const artifact of input.workOrder.expectedArtifacts.filter((item) => item.required)) {
      const match = evidence.find((item) => (
        !usedEvidenceIds.has(item.id)
        && item.kind === artifact.kind
        && (!artifact.locatorRequired || (item.locator !== undefined && item.locator.length > 0))
      ));
      if (match === undefined) {
        failures.push(artifact.id);
      } else {
        usedEvidenceIds.add(match.id);
      }
    }
    const verification = {
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder.id,
      passed: failures.length === 0 && evidence.length > 0,
      summary: failures.length === 0
        ? `${producedBy} supplied the required evidence contract.`
        : `Missing required artifact evidence: ${failures.join(", ")}.`,
      checkedEvidenceIds: evidence.map((item) => item.id),
      createdAt: new Date().toISOString(),
    };
    await this.record({
      type: "subagent.verified",
      taskId: input.task.id,
      runId: input.run.id,
      payload: verification,
    });
    return verification.passed;
  }

  private async consumeExecutionEvents(
    adapter: { execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> },
    input: ExecutionAssignment,
    allowedEvidenceKinds: ReadonlySet<Evidence["kind"]>,
  ): Promise<string | undefined> {
    let completion: string | undefined;
    for await (const event of adapter.execute(input)) {
      if (event.type === "completed") {
        completion = event.summary;
        continue;
      }
      await this.recordExecutionEvent(input, event, allowedEvidenceKinds);
    }
    return completion;
  }

  private async recordExecutionEvent(
    input: ExecutionAssignment,
    event: Exclude<ExecutionEvent, { type: "completed" }>,
    allowedEvidenceKinds: ReadonlySet<Evidence["kind"]>,
  ): Promise<void> {
    if (event.type === "session_started") {
      await this.record({
        type: input.workOrder === undefined ? "execution.progress" : "subagent.session_started",
        taskId: input.task.id,
        runId: input.run.id,
        payload: input.workOrder === undefined
          ? { stepId: input.step.id, message: `Agent session started: ${event.sessionId}`, sessionId: event.sessionId }
          : { stepId: input.step.id, workOrderId: input.workOrder.id, sessionId: event.sessionId },
      });
      return;
    }
    if (event.type === "message_delta") {
      // Raw model streams may echo file contents or personal data. They remain
      // transient UI events; only the redacted completion/evidence is durable.
      // 原始模型流可能回显文件内容或个人数据，只能作为瞬时 UI 事件；只有脱敏后的
      // completion/evidence 才允许持久化。
      return;
    }
    if (event.type === "tool_started") {
      await this.record({
        type: "agent.tool_started",
        taskId: input.task.id,
        runId: input.run.id,
        payload: {
          stepId: input.step.id,
          workOrderId: input.workOrder?.id,
          ...event,
          inputSummary: event.inputSummary === undefined ? undefined : redactAuditText(event.inputSummary),
        },
      });
      return;
    }
    if (event.type === "tool_completed") {
      await this.record({
        type: "agent.tool_completed",
        taskId: input.task.id,
        runId: input.run.id,
        payload: { stepId: input.step.id, workOrderId: input.workOrder?.id, ...event },
      });
      return;
    }
    if (event.type === "progress") {
      await this.record({
        type: input.workOrder === undefined ? "execution.progress" : "subagent.progress",
        taskId: input.task.id,
        runId: input.run.id,
        payload: input.workOrder === undefined
          ? { stepId: input.step.id, message: redactAuditText(event.message) }
          : {
            stepId: input.step.id,
            workOrderId: input.workOrder.id,
            message: redactAuditText(event.message),
          },
      });
      return;
    }
    if (event.type === "failed") {
      // The structured report travels with the error so the retry loop can
      // compare this failure against what a different provider reported.
      // 结构化报告随错误一起传递，使重试循环能把本次失败与另一个 Provider 的报告比较。
      throw new WorkerFailure(`Agent execution failed: ${event.message}`, event.report);
    }

    // Evidence kinds are an authorization, not a claim: an adapter may only
    // record the kinds it declared, and "receipt" is never granted by default,
    // so no worker can self-certify that an external action really happened.
    // Evidence 类型是授权而非声明：Adapter 只能记录其声明过的类型，"receipt" 默认永不授予，
    // 因此任何 Worker 都无法自证外部动作确实发生。
    if (!allowedEvidenceKinds.has(event.evidence.kind)) {
      throw new Error(
        `Adapter ${input.executor.agentId} is not authorized to record "${event.evidence.kind}" evidence.`,
      );
    }
    const evidence: Evidence = {
      ...event.evidence,
      summary: redactAuditText(event.evidence.summary),
      id: randomUUID(),
      runId: input.run.id,
      stepId: input.step.id,
      workOrderId: input.workOrder?.id,
      producedBy: input.executor.agentId,
      createdAt: new Date().toISOString(),
    };
    await this.record({ type: "evidence.recorded", taskId: input.task.id, runId: input.run.id, payload: evidence });
  }

  private async changeStatus(runId: string, status: RunStatus, activeStepId?: string): Promise<void> {
    const run = this.requireRun(runId);
    await this.record({ type: "run.status_changed", taskId: run.taskId, runId, payload: { status, activeStepId } });
  }

  private async record(input: Parameters<JournalStore["append"]>[0]): Promise<void> {
    const event = await this.#journal.append(input);
    this.#state = reduceEvent(this.#state, event);
  }

  private requireRun(runId: string): Run {
    const run = this.#state.runs[runId];
    if (run === undefined) {
      throw new Error(`Unknown run: ${runId}`);
    }
    return run;
  }

  private requireTask(taskId: string): Task {
    const task = this.#state.tasks[taskId];
    if (task === undefined) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  private requirePlan(run: Run): WorkPlan {
    if (run.planId === undefined || this.#state.plans[run.planId] === undefined) {
      throw new Error(`Run ${run.id} has no plan.`);
    }
    return this.#state.plans[run.planId];
  }

  private stepHasCompletedEvidence(runId: string, step: PlanStep): boolean {
    if (step.subagents === undefined) {
      return (this.#state.evidenceByRun[runId] ?? []).some((item) => item.stepId === step.id && item.workOrderId === undefined);
    }
    return step.subagents.every((order) => this.workOrderHasCompletedEvidence(runId, order.id));
  }

  private workOrderHasEvidence(runId: string, workOrderId: string): boolean {
    return (this.#state.evidenceByRun[runId] ?? []).some((item) => item.workOrderId === workOrderId);
  }

  private workOrderHasCompletedEvidence(runId: string, workOrderId: string): boolean {
    const subagent = this.#state.subagents[subagentKey(runId, workOrderId)];
    const verification = this.#state.subagentVerificationByKey[subagentKey(runId, workOrderId)];
    return subagent?.status === "completed"
      && this.workOrderHasEvidence(runId, workOrderId)
      && verification?.passed === true;
  }
}

interface WorkspaceRecoveryAssessment {
  decision: "rerun" | "reconciled" | "blocked";
  category: FailureCategory;
  reason: string;
  changes: WorkspaceChange[];
  checkpoint?: string;
}

function assertPlanIsExecutable(steps: PlanStep[], knownAgentIds?: Set<string>): void {
  if (steps.length === 0) {
    throw new Error("A plan must contain at least one step.");
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) {
    throw new Error("Plan step identifiers must be unique.");
  }
  const workOrderIds = new Set<string>();
  for (const step of steps) {
    assertNonEmpty(step.id, "Plan step id");
    assertNonEmpty(step.title, `Plan step ${step.id} title`);
    assertNonEmpty(step.instructions, `Plan step ${step.id} instructions`);
    if (!riskClasses.has(step.risk)) {
      throw new Error(`Plan step ${step.id} has an invalid risk class.`);
    }
    if (!Array.isArray(step.acceptanceCriteria) || step.acceptanceCriteria.length === 0) {
      throw new Error(`Plan step ${step.id} needs one or more acceptance criteria.`);
    }
    if ((step.agentId === undefined) === (step.subagents === undefined)) {
      throw new Error(`Plan step ${step.id} must have exactly one executor or one subagent group.`);
    }
    if (
      step.agentId !== undefined
      && (
        !Array.isArray(step.requiredCapabilities)
        || step.requiredCapabilities.length === 0
        || step.requiredCapabilities.some((item) => typeof item !== "string" || item.trim().length === 0)
      )
    ) {
      throw new Error(`Plan step ${step.id} needs one or more required capabilities.`);
    }
    // An executor named here but absent from the registry cannot be caught
    // later without the owner first seeing an accepted run.
    // 在此命名但不在注册表中的执行者，如果不在这里拦住，所有者就会先看到一个已接受的 Run。
    if (step.agentId !== undefined && knownAgentIds !== undefined && !knownAgentIds.has(step.agentId)) {
      throw new Error(
        `Plan step ${step.id} names unknown executor "${step.agentId}". `
        + `Known executors: ${[...knownAgentIds].sort().join(", ") || "(none configured)"}.`,
      );
    }
    // The risk class is a proposal; the capabilities are what the work actually
    // needs. A step that requires filesystem_write but declares itself
    // read_only would execute writes behind a label the policy engine treats
    // as safe — the floor is recalculated from the capabilities, so the label
    // cannot undersell the work.
    // 风险等级只是提案；能力才是工作真正需要的东西。一个要求 filesystem_write 却自称
    // read_only 的步骤，会在 Policy 引擎视为安全的标签背后执行写入——下限由能力重新
    // 计算，因此标签无法贱卖工作。
    assertRiskFloor(step.id, "Plan step", step.risk, step.requiredCapabilities);
    if (step.subagents !== undefined) {
      for (const order of step.subagents) {
        if (workOrderIds.has(order.id)) {
          throw new Error(`Work order identifier ${order.id} must be unique across the whole plan.`);
        }
        workOrderIds.add(order.id);
      }
      assertSubagentOrders(step.id, step.subagents, step.risk, knownAgentIds);
    }
  }
}

function assertSubagentOrders(
  stepId: string,
  orders: SubagentWorkOrder[],
  stepRisk: RiskClass,
  knownAgentIds?: Set<string>,
): void {
  if (orders.length === 0) {
    throw new Error(`Plan step ${stepId} has an empty subagent group.`);
  }
  const ids = new Set(orders.map((order) => order.id));
  if (ids.size !== orders.length) {
    throw new Error(`Subagent work order identifiers for step ${stepId} must be unique.`);
  }
  for (const order of orders) {
    assertNonEmpty(order.id, `Work order id in step ${stepId}`);
    assertNonEmpty(order.title, `Work order ${order.id} title`);
    assertNonEmpty(order.objective, `Work order ${order.id} objective`);
    if (
      !Array.isArray(order.acceptanceCriteria)
      || order.acceptanceCriteria.length === 0
      || order.acceptanceCriteria.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error(`Subagent work order ${order.id} needs one or more acceptance criteria.`);
    }
    if (
      !Array.isArray(order.requiredCapabilities)
      || order.requiredCapabilities.length === 0
      || order.requiredCapabilities.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new Error(`Subagent work order ${order.id} needs one or more required capabilities.`);
    }
    if (!riskClasses.has(order.risk)) {
      throw new Error(`Subagent work order ${order.id} has an invalid risk class.`);
    }
    // Same recalculated floor as the step above, for the same reason.
    // 与上面步骤相同的重算下限，理由也相同。
    assertRiskFloor(order.id, "Subagent work order", order.risk, order.requiredCapabilities);
    // The step's risk is what the policy engine gates on and what the verifier
    // demands receipts for. A child order that is riskier than the step it
    // hangs under would execute an irreversible action behind a `read_only`
    // label, bypassing both. Risk may narrow going down the tree, never widen.
    // 步骤的 risk 是 Policy 引擎把关的依据，也是 Verifier 索要 receipt 的依据。比所挂靠步骤
    // 更危险的子工作单，会在 `read_only` 标签背后执行不可逆动作，同时绕过两者。
    // 风险沿树向下只能收窄，绝不能放宽。
    if (riskRank(order.risk) > riskRank(stepRisk)) {
      throw new Error(
        `Subagent work order ${order.id} has risk "${order.risk}", which exceeds the risk "${stepRisk}" of step ${stepId}. `
        + `Raise the step's risk class to at least "${order.risk}" so approval and verification apply.`,
      );
    }
    if (order.agentId !== undefined && knownAgentIds !== undefined && !knownAgentIds.has(order.agentId)) {
      throw new Error(
        `Subagent work order ${order.id} names unknown executor "${order.agentId}". `
        + `Known executors: ${[...knownAgentIds].sort().join(", ") || "(none configured)"}.`,
      );
    }
    if (!Array.isArray(order.inputs)) {
      throw new Error(`Subagent work order ${order.id} needs an input contract.`);
    }
    if (!Array.isArray(order.expectedArtifacts) || order.expectedArtifacts.length === 0) {
      throw new Error(`Subagent work order ${order.id} needs an artifact contract.`);
    }
    for (const artifact of order.expectedArtifacts) {
      assertNonEmpty(artifact.id, `Artifact id in work order ${order.id}`);
      assertNonEmpty(artifact.description, `Artifact ${artifact.id} description in work order ${order.id}`);
      if (!evidenceKinds.has(artifact.kind)) {
        throw new Error(`Artifact ${artifact.id} in work order ${order.id} has an invalid evidence kind.`);
      }
    }
    const artifactIds = new Set(order.expectedArtifacts.map((artifact) => artifact.id));
    if (artifactIds.size !== order.expectedArtifacts.length) {
      throw new Error(`Subagent work order ${order.id} has duplicate artifact contract ids.`);
    }
    if (!order.expectedArtifacts.some((artifact) => artifact.required)) {
      throw new Error(`Subagent work order ${order.id} must require at least one artifact.`);
    }
    assertBudget(order);
    if (
      (order.risk === "external_side_effect" || order.risk === "irreversible")
      && order.budget.maxAttempts !== 1
    ) {
      throw new Error(
        `Subagent work order ${order.id} can cause external or irreversible effects and must use maxAttempts=1.`,
      );
    }
    if (order.dependsOn !== undefined && !Array.isArray(order.dependsOn)) {
      throw new Error(`Subagent work order ${order.id} dependencies must be an array.`);
    }
    for (const dependencyId of order.dependsOn ?? []) {
      if (!ids.has(dependencyId) || dependencyId === order.id) {
        throw new Error(`Subagent work order ${order.id} has an invalid dependency: ${dependencyId}.`);
      }
    }
    for (const workInput of order.inputs) {
      assertNonEmpty(workInput.name, `Input name in work order ${order.id}`);
      assertNonEmpty(workInput.description, `Input ${workInput.name} description in work order ${order.id}`);
      if (
        workInput.sourceWorkOrderId !== undefined
        && !(order.dependsOn ?? []).includes(workInput.sourceWorkOrderId)
      ) {
        throw new Error(
          `Input ${workInput.name} in work order ${order.id} references ${workInput.sourceWorkOrderId} without a dependency.`,
        );
      }
    }
  }
  assertAcyclicWorkOrders(stepId, orders);
}

function assertAcyclicWorkOrders(stepId: string, orders: SubagentWorkOrder[]): void {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Subagent work orders for step ${stepId} contain a dependency cycle at ${id}.`);
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const order of orders) visit(order.id);
}

function isolationAudit(workspace: { isolation?: IsolatedWorkspace }): Record<string, unknown> {
  if (workspace.isolation === undefined) return {};
  return {
    workspaceIsolation: {
      kind: workspace.isolation.kind,
      path: workspace.isolation.path,
      ownerPath: workspace.isolation.ownerPath,
    },
  };
}

interface ExecutionWorkspace {
  path?: string;
  isolation?: IsolatedWorkspace;
  retainSandbox?: boolean;
}

function namedFilesForIsolation(step: PlanStep, workOrder?: SubagentWorkOrder): string[] {
  const names = extractFileExpectations(step).map((item) => item.path);
  for (const artifact of workOrder?.expectedArtifacts ?? []) {
    if (looksLikeRelativeFile(artifact.description)) names.push(artifact.description.trim());
  }
  return [...new Set(names)];
}

function summarizeIsolatedApply(result: {
  copied: string[];
  skipped: Array<{ path: string; reason: string }>;
  leftover: string[];
  sandboxRetained: boolean;
  isolatedPath: string;
}): string {
  const copied = result.copied.length === 0
    ? "No named files were copied into the live project."
    : `Copied into the live project: ${result.copied.join(", ")}.`;
  if (!result.sandboxRetained) return `${copied} Isolated sandbox removed.`;
  const leftover = result.leftover.length === 0
    ? "No extra isolated writes."
    : `Leftover isolated writes: ${result.leftover.join(", ")}.`;
  const skipped = result.skipped.length === 0
    ? ""
    : ` Not copied: ${result.skipped.map((item) => `${item.path} (${item.reason})`).join("; ")}.`;
  return `${copied} ${leftover}${skipped} Inspect ${result.isolatedPath}.`;
}

function assertBudget(order: SubagentWorkOrder): void {
  if (typeof order.budget !== "object" || order.budget === null) {
    throw new Error(`Subagent work order ${order.id} needs an execution budget.`);
  }
  // Duration and attempts are the limits the Kernel and black-box workers
  // actually apply. Model/tool ceilings are optional declarations: a CLI
  // subprocess cannot report those counts, so requiring them was a lie.
  // 时长与尝试次数才是 Kernel 和黑盒 Worker 真正执行的上限。模型/工具次数是可选声明：
  // CLI 子进程报不出这些计数，强制要求它们等于在合同里撒谎。
  for (const name of ["maxDurationMs", "maxAttempts"] as const) {
    if (!Number.isInteger(order.budget[name]) || order.budget[name] < 1) {
      throw new Error(`Subagent work order ${order.id} has an invalid budget value for ${name}.`);
    }
  }
  for (const name of ["maxModelCalls", "maxToolCalls"] as const) {
    const value = order.budget[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Subagent work order ${order.id} has an invalid advisory budget value for ${name}.`);
    }
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} cannot be empty.`);
}

const riskClasses = new Set(["read_only", "reversible_write", "external_side_effect", "irreversible"]);

/**
 * Risk ordered by how hard the effect is to take back. Comparison is what lets
 * the Kernel refuse a plan that hides a dangerous child under a safe parent.
 * 按“后果有多难收回”排序的风险等级。有了可比较性，Kernel 才能拒绝把危险子项藏在安全
 * 父项下的计划。
 */
const RISK_ORDER: RiskClass[] = ["read_only", "reversible_write", "external_side_effect", "irreversible"];

function riskRank(risk: RiskClass): number {
  return RISK_ORDER.indexOf(risk);
}

/**
 * The risk floor implied by what the work says it needs.
 *
 * The risk class on a step is the model's proposal. The Kernel recalculates a
 * floor from the required capabilities — the step's own declaration of what
 * will actually be done — and refuses any label that undersells it. This is
 * the boundary the review asked for: the model proposes the risk, the Kernel
 * derives what the risk must at least be, and the larger of the two governs.
 *
 * 由工作自称所需的能力推出的风险下限。
 *
 * 步骤上的风险等级是模型的提案。Kernel 从 requiredCapabilities——步骤自己对将要做什么
 * 的声明——重算一个下限，并拒绝任何贱卖它的标签。这正是评审要的那条边界：模型提议
 * 风险，Kernel 推导风险至少必须是什么，两者之中更大者生效。
 */
function assertRiskFloor(id: string, what: string, declared: RiskClass, requiredCapabilities: unknown): void {
  if (!Array.isArray(requiredCapabilities)) return;
  const capabilities = requiredCapabilities.filter((item): item is string => typeof item === "string");
  let floor: RiskClass = "read_only";
  if (capabilities.includes("external_action")) {
    floor = "external_side_effect";
  } else if (capabilities.includes("filesystem_write")) {
    floor = "reversible_write";
  }
  if (riskRank(declared) < riskRank(floor)) {
    throw new Error(
      `${what} ${id} declares risk "${declared}" but requires ${capabilities.includes("external_action") ? "external_action" : "filesystem_write"}. `
      + `The risk class is recalculated from the capabilities: raise it to at least "${floor}" `
      + `so approval and verification see the work for what it does.`,
    );
  }
}
const evidenceKinds = new Set(["artifact", "tool_result", "receipt", "test", "observation"]);

/**
 * Receipts attest that an external action really happened, so an adapter must
 * opt in explicitly; every other evidence kind is granted by default.
 * Receipt 用于证明外部动作确实发生，Adapter 必须显式声明才可记录；其余 Evidence 类型默认授予。
 */
function evidenceAuthorization(capabilities: RuntimeCapabilities): ReadonlySet<Evidence["kind"]> {
  return new Set(capabilities.evidenceKinds ?? ["artifact", "tool_result", "test", "observation"]);
}

function redactAuditText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}
