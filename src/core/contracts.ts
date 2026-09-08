/**
 * A Run may start from an owner query or from a governed non-query source.
 * A signal can request planning; it never grants execution authority itself.
 *
 * Run 既可以由用户 Query 发起，也可以由受治理的非 Query 来源发起。Signal 只能请求规划，
 * 绝不会自行授予执行权限。
 */
import type { FailureReport, OutcomeCatalog } from "./failure-analysis.ts";

export type TriggerKind = "query" | "schedule" | "signal" | "manual";

export type RunStatus =
  | "created"
  | "planning"
  | "queued"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type RiskClass =
  | "read_only"
  | "reversible_write"
  | "external_side_effect"
  | "irreversible";

export interface Trigger {
  id: string;
  kind: TriggerKind;
  occurredAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface Task {
  id: string;
  triggerId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  createdAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  instructions: string;
  risk: RiskClass;
  acceptanceCriteria: string[];
  /**
   * A single bounded executor for this step. Mutually exclusive with subagents.
   * 该步骤的单个有边界执行者；不能与 subagents 同时存在。
   */
  agentId?: string;
  /**
   * Required when agentId is present; the Runtime checks it before execution.
   * 指定 agentId 时必须提供；Runtime 会在执行前检查。
   */
  requiredCapabilities?: string[];
  /**
   * Work orders supervised by this step. They may run in dependency-aware waves.
   * 由该步骤监督的工作单；可按依赖关系分批执行。
   */
  subagents?: SubagentWorkOrder[];
}

export interface WorkOrderInput {
  /**
   * Stable name used when building the bounded agent prompt.
   * 构建有边界 Agent Prompt 时使用的稳定名称。
   */
  name: string;
  description: string;
  /**
   * When present, the Runtime injects evidence produced by this dependency.
   * 存在时，Runtime 会注入该依赖产生的 Evidence。
   */
  sourceWorkOrderId?: string;
  required: boolean;
}

export interface ArtifactContract {
  id: string;
  kind: Evidence["kind"];
  description: string;
  required: boolean;
  /**
   * Receipts and files generally need a durable location, not only prose.
   * Receipt 和文件通常需要一个持久定位地址，不能只有文字说明。
   */
  locatorRequired?: boolean;
}

export interface WorkOrderBudget {
  maxDurationMs: number;
  maxAttempts: number;
  /**
   * Advisory only. Black-box CLI workers do not expose model or tool counts,
   * so the Kernel cannot enforce these ceilings. Duration and attempts are
   * the budgets that actually stop work.
   * 仅作声明。黑盒 CLI Worker 不暴露模型或工具调用次数，Kernel 无法执行这两个上限。
   * 真正能停住工作的预算是时长与尝试次数。
   */
  maxModelCalls?: number;
  maxToolCalls?: number;
}

/**
 * A work order is deliberately smaller than a task. It has no authority over
 * personal state, policy, or the final outcome. It is an executable contract:
 * an agent receives bounded inputs and authority, then returns named artifacts
 * and evidence that the supervisor verifies.
 *
 * WorkOrder 被刻意设计得比 Task 更小。它无权修改个人状态、Policy 或最终结果；它是一份
 * 可执行合同：Agent 只获得有边界的输入与权限，返回具名的 Artifact 和 Evidence，再由
 * Supervisor 验收。
 */
export interface SubagentWorkOrder {
  id: string;
  /**
   * Optional routing preference. The dispatcher still checks capabilities.
   * 可选的路由偏好；Dispatcher 仍然必须检查能力。
   */
  agentId?: string;
  role: "researcher" | "maker" | "reviewer" | "custom";
  title: string;
  objective: string;
  inputs: WorkOrderInput[];
  requiredCapabilities: string[];
  expectedArtifacts: ArtifactContract[];
  acceptanceCriteria: string[];
  risk: RiskClass;
  budget: WorkOrderBudget;
  dependsOn?: string[];
}

export interface WorkPlan {
  id: string;
  runId: string;
  summary: string;
  steps: PlanStep[];
  createdAt: string;
  /**
   * The commitment this plan exists to satisfy, when the work was raised from
   * the owner's stated obligations rather than a fresh request. This is the
   * linkage the reconcile loop reads: when the run completes and verifies, the
   * commitment is settled (marked met, or advanced to its next occurrence) —
   * without it, "every Friday" happens exactly once and never again.
   * 本计划所要满足的承诺（当工作源自所有者声明过的义务而非新请求时）。这是收敛环读取
   * 的联动关系：Run 完成并验证后，承诺被结算（标记 met，或推进到下一次）——没有它，
   * “每周五”只发生一次，再也不会有第二次。
   */
  servesCommitmentId?: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  activeStepId?: string;
}

export interface ApprovalGrant {
  id: string;
  runId: string;
  stepId: string;
  grantedAt: string;
  grantedBy: "user" | "standing_policy";
  note?: string;
}

export interface Evidence {
  id: string;
  runId: string;
  stepId: string;
  /**
   * Present when the evidence came from a child-agent work order.
   * Evidence 来自子 Agent WorkOrder 时才存在。
   */
  workOrderId?: string;
  producedBy?: string;
  kind: "artifact" | "tool_result" | "receipt" | "test" | "observation";
  summary: string;
  locator?: string;
  createdAt: string;
}

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRun {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  agentId: string;
  /**
   * Concrete provider pinned when the work order first starts.
   * WorkOrder 第一次启动时固定下来的具体 Provider。
   */
  providerId?: string;
  sessionId?: string;
  /** Durable pre-dispatch Workspace checkpoint used for black-box recovery. 黑盒恢复所用的派发前持久 Workspace 检查点。 */
  workspaceCheckpoint?: string;
  workspacePath?: string;
  attempt: number;
  role: SubagentWorkOrder["role"];
  title: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export interface SubagentVerificationResult {
  id: string;
  runId: string;
  stepId: string;
  workOrderId: string;
  passed: boolean;
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export interface VerificationResult {
  runId: string;
  passed: boolean;
  summary: string;
  checkedEvidenceIds: string[];
  createdAt: string;
}

export type MemoryType = "fact" | "preference" | "procedure" | "decision" | "commitment";
export type MemorySensitivity = "public" | "private" | "secret";

export interface MemoryCandidate {
  id: string;
  runId: string;
  sourceEvidenceIds: string[];
  summary: string;
  confidence: "low" | "medium" | "high";
  status: "proposed" | "committed" | "rejected";
  createdAt: string;
  /** Suggested classification from the mining worker, kept for the commit step. 提炼 Worker 建议的分类，供提交时沿用。 */
  type?: MemoryType;
  sensitivity?: MemorySensitivity;
  expiresAt?: string;
}

export type JournalEventType =
  | "trigger.received"
  | "task.created"
  | "run.created"
  | "run.status_changed"
  | "plan.created"
  | "policy.decided"
  | "approval.granted"
  | "execution.started"
  | "execution.progress"
  // A routing decision is not a dispatch: it records which worker was chosen
  // and why, before any process exists to dispatch to.
  // 路由决策不是一次派发：它在任何可派发的进程存在之前，记录选了哪个 Worker、为什么。
  // What a connector saw. Journaled so a later proposal can be traced back to
  // the observation that prompted it.
  // Connector 看到了什么。写入 Journal，使日后的提案能回溯到引发它的那次观察。
  | "observation.recorded"
  | "dispatch.decided"
  | "dispatch.steps_assigned"
  | "dispatch.blocked"
  | "subagent.dispatched"
  | "subagent.resumed"
  | "subagent.session_started"
  | "subagent.progress"
  | "subagent.completed"
  | "subagent.failed"
  | "subagent.cancelled"
  | "subagent.recovery_decided"
  | "subagent.verified"
  | "agent.message_delta"
  | "agent.tool_started"
  | "agent.tool_completed"
  | "evidence.recorded"
  | "verification.completed"
  | "memory.candidate.requested"
  | "memory.candidate.proposed"
  | "memory.candidate.promoted"
  | "memory.candidate.rejected"
  // The owner writing a memory by hand. Distinct from a promoted candidate:
  // it cites no evidence because the owner is the evidence.
  // 所有者手写的一条记忆。与被提升的候选不同：它不引用任何证据，因为所有者本人就是证据。
  | "memory.authored"
  | "memory.updated"
  | "memory.archived"
  | "memory.restored"
  | "memory.recalled"
  // Personal state is journal-projected like every other durable fact, so the
  // owner's model of themselves survives a deleted projection.
  // 个人状态与其他持久事实一样由 Journal 投影得出，因此即使投影被删除，所有者对自身的
  // 建模依然能够重建。
  | "state.self_model.recorded"
  | "state.self_model.updated"
  | "state.self_model.archived"
  | "state.goal.recorded"
  | "state.goal.updated"
  | "state.goal.archived"
  | "state.commitment.recorded"
  | "state.commitment.updated"
  | "state.commitment.archived"
  | "opportunity.proposed"
  | "opportunity.resolved"
  | "agent.installed"
  | "agent.install_failed"
  // Model turn cost/duration. Copied from session metadata when the SDK has
  // tokens; otherwise duration and model id still land so the ledger is not empty.
  // 模型回合的费用/时长。SDK 有 token 时从会话元数据抄来；否则仍记下时长与模型 id，
  // 账本不会是空的。
  | "usage.recorded";

export interface JournalEvent {
  id: string;
  sequence: number;
  type: JournalEventType;
  occurredAt: string;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface NewJournalEvent {
  type: JournalEventType;
  taskId?: string;
  runId?: string;
  payload: unknown;
}

export interface ExecutionAssignment {
  run: Run;
  task: Task;
  step: PlanStep;
  /**
   * The concrete adapter selected by the Runtime, not merely a planning hint.
   * Runtime 选择的具体 Adapter，而不只是 Planner 的建议。
   */
  executor: {
    agentId: string;
    providerId: string;
  };
  /**
   * Defined only for a child agent. The parent Runtime remains the supervisor.
   * 只为子 Agent 定义；父 Runtime 始终是 Supervisor。
   */
  workOrder?: SubagentWorkOrder;
  /**
   * Evidence from completed dependencies, curated by the supervisor.
   * 已完成依赖产生且由 Supervisor 筛选过的 Evidence。
   */
  dependencyEvidence?: Evidence[];
  /**
   * The scoped memory packet compiled by the Kernel for this assignment —
   * never the whole store. Workers receive it as background facts; every item
   * must already be journaled as memory.recalled for this run.
   * Kernel 为本次派发编译的有作用域记忆包——绝不是整个记忆库。Worker 只把它当背景事实；
   * 每一条都必须已作为本 Run 的 memory.recalled 记入 Journal。
   */
  memoryContext?: MemoryContextPacket;
  /** Owner-editable failure taxonomy used only for diagnostics. 所有者可编辑的失败分类，仅用于诊断。 */
  failureCatalog?: OutcomeCatalog;
  workspacePath?: string;
}

export interface MemoryContextPacket {
  items: Array<{ id: string; summary: string }>;
  /** Why these items reached this worker. 这些条目为何到达该 Worker。 */
  selectedBy: { query: string };
}

/**
 * The narrow recall port the Kernel uses to compile worker memory packets.
 * The owner's switches (recall enabled, per-task cap) stay inside the store,
 * so the Kernel cannot widen its own access.
 * Kernel 编译 Worker 记忆包所用的窄召回端口。所有者的开关（是否启用召回、每任务上限）
 * 留在 Store 内部，因此 Kernel 无法自行放宽访问范围。
 */
export interface WorkerMemorySource {
  recall(query: string, runId: string): Promise<Array<{
    memory: { id: string; summary: string };
    score: number;
    matchedTerms: string[];
  }>>;
}

export type ExecutionEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_started"; toolCallId: string; tool: string; inputSummary?: string }
  | { type: "tool_completed"; toolCallId: string; tool: string; isError: boolean }
  | { type: "progress"; message: string }
  | { type: "evidence"; evidence: Omit<Evidence, "id" | "runId" | "stepId" | "createdAt"> }
  | { type: "completed"; summary: string }
  | { type: "failed"; message: string; report?: FailureReport };

export interface RuntimeCapabilities {
  resume: boolean;
  cancellation: boolean;
  approvalCallback: boolean;
  parallelAssignments: boolean;
  /**
   * Domain abilities used by the dispatcher; tool access remains adapter-owned.
   * Dispatcher 使用的领域能力；Tool 权限仍由 Adapter 自己持有。
   */
  work: string[];
  /**
   * Evidence kinds this adapter may record. Omitted means every kind except
   * "receipt": a receipt attests that an external action really happened, so
   * an adapter must declare it explicitly, and only when its receipts come
   * from a trusted runtime rather than from worker-controlled output.
   * 该 Adapter 允许记录的 Evidence 类型。省略时默认允许除 "receipt" 外的全部类型：
   * Receipt 用于证明外部动作确实发生，Adapter 必须显式声明，且只有当 Receipt 来自
   * 可信运行时（而非 Worker 可控输出）时才可以声明。
   */
  evidenceKinds?: Evidence["kind"][];
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly providerId: string;

  capabilities(): Promise<RuntimeCapabilities>;

  execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  resume?(sessionId: string, input: ExecutionAssignment): AsyncIterable<ExecutionEvent>;

  cancel?(sessionId: string): Promise<void>;
}

/**
 * Maps a work order to a replaceable agent adapter.
 * 将 WorkOrder 映射到可替换的 Agent Adapter；Adapter 不拥有 Run 状态。
 */
export interface AgentRegistry {
  get(agentId: string): RuntimeAdapter | undefined;
  list(): RuntimeAdapter[];
}

export interface PolicyDecision {
  outcome: "allowed" | "approval_required" | "denied";
  reason: string;
}

export interface PolicyEngine {
  evaluate(input: { run: Run; task: Task; step: PlanStep; approved: boolean }): PolicyDecision;
}

export interface Verifier {
  verify(input: { run: Run; plan: WorkPlan; evidence: Evidence[] }): Promise<VerificationResult>;
}
