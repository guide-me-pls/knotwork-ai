import { randomUUID } from "node:crypto";

import { createConfiguredAgentRegistry } from "../workers/configured-worker-registry.ts";
import { workCapabilitiesForRole } from "../workers/capabilities.ts";
import { WorkerRegistry } from "../workers/worker-registry.ts";
import type { AgentRegistry, PlanStep, TriggerKind } from "../core/contracts.ts";
import { createRuntimeAssembly } from "../core/runtime-factory.ts";
import type { CloneRuntime, DispatchResult } from "../core/runtime.ts";
import type { JournalStore } from "../core/journal.ts";
import { GovernedMemorySource } from "../memory/md-memory-store.ts";
import { buildFallbackPlan } from "../planning/fallback-planner.ts";
import { reconcileCommitments } from "../state/commitment-reconciler.ts";
import { createEnvironmentWorkPlanner, type PlanningAgent, type WorkPlanner } from "../planning/llm-planner.ts";
import { defaultWorkerProfiles, type CloneSettings, type WorkerProfile } from "../config/worker-settings.ts";
import { classifyIntent } from "../main-agent/intent-classifier.ts";
import { routeTask } from "../main-agent/agent-router.ts";
import { assignWorkersPerStep } from "../main-agent/plan-routing.ts";
import { buildMemoryContextFromCandidates } from "../main-agent/memory-context-builder.ts";
import { describeWorkers } from "../main-agent/worker-descriptors.ts";
import { JournalDispatchRecorder } from "../main-agent/dispatch-recorder.ts";
import type { DispatchBlockedCode } from "../main-agent/dispatch-contracts.ts";
import { recordUsage } from "../observability/usage.ts";

export interface QueryRunResult {
  runId: string;
  status: DispatchResult["status"] | "blocked" | "cancelled";
  activeStepId?: string;
  subagentsCompleted: number;
  memoryCandidatesProposed: number;
  /** Present when routing refused rather than substituting a worker. 路由拒绝而非替换 Worker 时存在。 */
  blocked?: { code: DispatchBlockedCode; reason: string; requestedAgentId?: string };
  /** Which worker the router chose, and why. 路由器选择了哪个 Worker，以及原因。 */
  routing?: { selectedAgentId: string; source: string; usedMemoryIds: readonly string[] };
}

export interface QueryWorkflowOptions {
  workspacePath?: string;
  /**
   * Test seam and future desktop setting: select an explicit planner.
   * 测试切口与未来桌面端设置：选择一个明确的 Planner。
   */
  planner?: WorkPlanner;
  /**
   * Explicit executor registry. Production leaves this unset so providers come
   * from settings; tests inject scripted adapters instead of reaching a real
   * provider. There is deliberately no implicit fake fallback.
   * 显式的执行者 Registry。生产环境不设置它，Provider 由 Settings 决定；测试注入脚本化
   * Adapter 以避免触达真实 Provider。这里刻意没有隐式的假 Registry 回退。
   */
  agents?: AgentRegistry;
}

/**
 * Runs the current Query-to-outcome path: durable trigger, memory recall,
 * planning, Runtime execution, verification, then asynchronous memory work.
 * The function coordinates components; it never lets a planner or worker own
 * the parent Run.
 *
 * 运行当前从 Query 到结果的主链路：持久化触发、记忆召回、规划、Runtime 执行、验证，最后
 * 才异步处理记忆。这个函数只负责协调组件，不会让 Planner 或 Worker 拥有父 Run 的控制权。
 */
export async function runQuery(
  dataDirectory: string,
  query: string,
  trigger: { kind?: TriggerKind; payload?: Record<string, unknown> } = {},
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  const assembly = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  // Every exit from this workflow must release the journal handle: the caller
  // owns the clone home and may move or delete it the moment we return.
  // 本工作流的每一个出口都必须释放 Journal 句柄：调用方拥有 clone home，可能在我们
  // 返回的一瞬间就移动或删除它。
  try {
    return await runQueryWithin(assembly, dataDirectory, query, trigger, settings, options);
  } finally {
    assembly.close();
  }
}

async function runQueryWithin(
  assembly: Awaited<ReturnType<typeof createRuntimeAssembly>>,
  dataDirectory: string,
  query: string,
  trigger: { kind?: TriggerKind; payload?: Record<string, unknown> },
  settings: CloneSettings | undefined,
  options: QueryWorkflowOptions,
): Promise<QueryRunResult> {
  const { runtime, memory, failureCatalog, paths, journal } = assembly;
  const workspacePath = paths.workspacePath;
  const { run } = await runtime.acceptTrigger({
    kind: trigger.kind ?? "query",
    summary: query,
    payload: { source: "desktop-client", ...trigger.payload },
  });

  // The same governed store the Kernel dispatches from. Recalling from a second
  // store here would let this path act on memories the owner never promoted.
  // 与 Kernel 派发时使用的同一个受治理 Store。若在此处从第二个 Store 召回，这条路径就会
  // 基于所有者从未提升过的记忆行事。
  const memoryStore = new GovernedMemorySource(paths.dataDirectory);
  const recalled = await memoryStore.recall(query, run.id);
  await runtime.recordMemoryRecall(run.id, query, recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
    matchedTerms: item.matchedTerms,
  })));
  // Reuses the recall above rather than opening a second store: two views of
  // memory could disagree, and only one of them would be journaled.
  // 复用上面的召回而不是另开一个存储：两份记忆视图可能互相矛盾，而只有一份会被记入 Journal。
  const memoryContext = buildMemoryContextFromCandidates(recalled.map((item) => ({
    id: item.memory.id,
    summary: item.memory.summary,
    score: item.score,
  })));

  const agents = settings?.agents ?? defaultWorkerProfiles();
  const recalledMemories = recalled.map((item) => item.memory.summary);

  // Routing happens before planning: a request the owner made explicitly must
  // be honoured or refused, and refusing after a plan exists would leave a run
  // that looks planned but can never legitimately execute.
  // 路由发生在规划之前：所有者显式提出的请求要么被满足要么被拒绝；若在计划已存在之后
  // 才拒绝，就会留下一个看似已规划、却永远无法合法执行的 Run。
  const intent = classifyIntent(query, { knownAgentIds: agents.map((agent) => agent.id) });
  // An injected registry is itself the statement of what can run here, so
  // probing the filesystem would contradict the caller. Only the production
  // path, which resolves providers from settings, asks what is installed.
  // 注入的 Registry 本身就声明了此处什么能运行，再去探测文件系统等于与调用方矛盾。
  // 只有从 Settings 解析 Provider 的生产路径才需要询问安装状态。
  const workerStatuses = options.agents === undefined
    ? await new WorkerRegistry(dataDirectory).list()
    : options.agents.list().map((adapter) => ({ id: adapter.id, installed: true }));
  const routed = routeTask({
    taskId: run.id,
    intent,
    workers: describeWorkers(agents, workerStatuses),
    ...(memoryContext === undefined ? {} : { memory: memoryContext }),
  });

  const recorder = new JournalDispatchRecorder(journal);
  if (routed.status === "blocked") {
    await recorder.recordBlocked(routed);
    await runtime.failRun(run.id, `${routed.code}: ${routed.reason}`);
    return {
      runId: run.id,
      status: "blocked",
      subagentsCompleted: 0,
      memoryCandidatesProposed: 0,
      blocked: {
        code: routed.code,
        reason: routed.reason,
        ...(routed.requestedAgentId === undefined ? {} : { requestedAgentId: routed.requestedAgentId }),
      },
    };
  }
  await recorder.recordDecision(routed.decision);

  // The planner may only assign the worker routing already settled on, so a
  // model cannot quietly reroute the owner's explicit choice.
  // Planner 只能指派路由已经确定的那个 Worker，因此模型无法悄悄改写所有者的显式选择。
  const selectedId = routed.decision.selectedAgentId;
  // An explicit request is the owner speaking about the whole task, so it pins
  // every step. Otherwise the planner may compose a plan across the configured
  // roles, and per-step routing keeps each assignment authorized.
  // 显式指定是所有者在谈论整个任务，因此它钉住每一个步骤。否则 Planner 可以跨越所有者
  // 配置的角色来编排计划，再由按步骤路由保证每次指派都获得授权。
  const routableAgents = routed.decision.source === "explicit"
    ? agents.filter((agent) => agent.id === selectedId)
    : agents.filter((agent) => agent.enabled);
  const planner = options.planner ?? createEnvironmentWorkPlanner();
  // The LLM planner is opt-in. Without credentials the deterministic local
  // policy still produces a plan and states exactly why it chose that graph.
  // LLM Planner 是显式开启的。没有凭据时，确定性的本地策略仍会产出计划，
  // 并明确说明它为何选择当前任务图。
  let plan;
  if (planner === undefined) {
    plan = buildFallbackPlan(query, new Set(routableAgents.map((agent) => agent.id)), recalledMemories);
  } else {
    const started = Date.now();
    try {
      plan = await planner.plan({
        query,
        recalledMemories,
        availableAgents: planningAgents(routableAgents),
      });
    } finally {
      await recordUsage(dataDirectory, planner.takeUsage?.() ?? {
        source: "planner",
        durationMs: Math.max(0, Date.now() - started),
      });
    }
  }
  const workerDescriptors = describeWorkers(agents, workerStatuses);
  const routedPlan = assignWorkersPerStep(plan, routed.decision, workerDescriptors);
  // Each step's executor is journaled with its reason: a multi-agent plan is
  // only auditable if the owner can see why each worker got its step.
  // 每个步骤的执行者连同原因一起写入 Journal：只有当所有者能看到每个 Worker 为何拿到
  // 它那一步时，多 Agent 计划才是可审计的。
  await recorder.recordStepAssignments(run.id, routedPlan.assignments);
  await runtime.attachPlan(run.id, routedPlan.plan);

  const registry = options.agents ?? await createConfiguredAgentRegistry(agents, {
    dataDirectory,
    workspacePath,
    failureCatalog,
  });
  const result = await executeClaimingRun(journal, runtime, run.id, registry);
  const candidates = result.status === "completed" ? await memory.processNext() : [];
  return {
    ...toQueryResult(runtime, result, candidates.length),
    routing: {
      selectedAgentId: selectedId,
      source: routed.decision.source,
      usedMemoryIds: routed.decision.usedMemoryIds,
    },
  };
}

/**
 * Executes a run while holding a claim.
 *
 * The queue consumer claims before it executes; these direct paths (a query,
 * an approval) must too, or "running without a claim" would stop meaning
 * "the executor died" and orphan recovery would start requeueing runs that
 * are executing right now. A claim held here for the length of one execution
 * keeps the invariant single: running ⟹ someone alive owns it.
 *
 * 在持有领取的情况下执行 Run。
 *
 * 队列消费者先领取再执行；这些直连路径（一次查询、一次批准）也必须如此，否则
 * "运行中且无领取"就不再意味着"执行者死了"，孤儿恢复会开始把正在执行的 Run 重新
 * 入队。在这里为一次执行的时长持有领取，让不变式保持单一：运行中 ⟹ 有活着的所有者。
 */
async function executeClaimingRun(
  journal: JournalStore,
  runtime: CloneRuntime,
  runId: string,
  registry: AgentRegistry,
): Promise<DispatchResult> {
  const ownerId = `direct-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = 10 * 60_000;
  await journal.claimRun?.({ runId, ownerId, leaseMs });
  const renew = setInterval(() => {
    void journal.renewClaim?.({ runId, ownerId, leaseMs })?.catch(() => undefined);
  }, 60_000);
  renew.unref();
  try {
    return await runtime.execute(runId, registry);
  } finally {
    clearInterval(renew);
    await journal.releaseClaim?.({ runId, ownerId })?.catch(() => undefined);
  }
}

function planningAgents(agents: CloneSettings["agents"]): PlanningAgent[] {  return agents
    .filter((agent) => agent.enabled)
    .map((agent) => ({
      id: agent.id,
      providerId: agent.providerId,
      role: agent.role,
      capabilities: workCapabilitiesForRole(agent.role),
    }));
}

export async function approveQueryRun(
  dataDirectory: string,
  runId: string,
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  const assembly = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  try {
    const { runtime, memory, failureCatalog, paths } = assembly;
    const workspacePath = paths.workspacePath;
    const run = runtime.getRun(runId);
    if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
      throw new Error(`Run ${runId} is not waiting for an approval.`);
    }

    await runtime.grantApproval(run.id, run.activeStepId, "Approved from the local desktop companion.");
    const registry = options.agents ?? await createConfiguredAgentRegistry((settings?.agents ?? defaultWorkerProfiles()), {
        dataDirectory,
        workspacePath,
        failureCatalog,
      });
    const result = await executeClaimingRun(assembly.journal, runtime, run.id, registry);
    const candidates = result.status === "completed" ? await memory.processNext() : [];
    // An approved run can serve a stated commitment; settling it here is what
    // lets the owner see "met" (or the next occurrence) immediately after
    // approving, instead of on the next maintenance tick.
    // 被批准的 Run 可能服务某条已声明的承诺；在这里结算它，让所有者在批准后立刻看到
    // "已满足"（或下一次周期），而不是等下一次维护扫描。
    await reconcileCommitments(assembly.journal).catch(() => undefined);
    return toQueryResult(runtime, result, candidates.length);
  } finally {
    // Including the error path above: a rejected approval must not leave the
    // database open. 包括上面的错误路径：被拒绝的审批不能把数据库留在打开状态。
    assembly.close();
  }
}

export async function rejectQueryRun(
  dataDirectory: string,
  runId: string,
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  void settings;
  const assembly = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  try {
    const { runtime } = assembly;
    const run = runtime.getRun(runId);
    if (run.status !== "waiting_approval" || run.activeStepId === undefined) {
      throw new Error(`Run ${runId} is not waiting for an approval.`);
    }
    // A rejected approval is a terminal owner decision, not a pause. failRun
    // journals failed so waiting_approval cannot hang forever.
    // 拒绝审批是所有者的终态决定，不是暂停。failRun 把 failed 记入 Journal，
    // waiting_approval 不能永远挂着。
    await runtime.failRun(run.id, "Rejected by the owner from the local companion.");
    return toQueryResult(runtime, { run: runtime.getRun(run.id), status: "failed" }, 0);
  } finally {
    assembly.close();
  }
}

export async function cancelQueryRun(
  dataDirectory: string,
  runId: string,
  settings?: CloneSettings,
  options: QueryWorkflowOptions = {},
): Promise<QueryRunResult> {
  const assembly = await createRuntimeAssembly({
    dataDirectory,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  try {
    const { runtime, failureCatalog, paths } = assembly;
    const workspacePath = paths.workspacePath;
    const registry = options.agents ?? await createConfiguredAgentRegistry((settings?.agents ?? defaultWorkerProfiles()), {
      dataDirectory,
      workspacePath,
      failureCatalog,
    });
    const cancelled = await runtime.cancel(runId, registry);
    return {
      runId: cancelled.id,
      status: "cancelled",
      activeStepId: cancelled.activeStepId,
      subagentsCompleted: runtime.getSubagentsForRun(cancelled.id).filter((subagent) => subagent.status === "completed").length,
      memoryCandidatesProposed: 0,
    };
  } finally {
    assembly.close();
  }
}

function toQueryResult(runtime: CloneRuntime, result: DispatchResult, memoryCandidatesProposed: number): QueryRunResult {
  return {
    runId: result.run.id,
    status: result.status,
    activeStepId: result.run.activeStepId,
    subagentsCompleted: runtime.getSubagentsForRun(result.run.id).filter((subagent) => subagent.status === "completed").length,
    memoryCandidatesProposed,
  };
}
