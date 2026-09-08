import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CapabilityDispatcher } from "../src/workers/capability-dispatcher.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import { ScriptedExecutionAdapter } from "./fixtures/scripted-adapter.ts";
import type {
  ExecutionAssignment,
  ExecutionEvent,
  RuntimeAdapter,
  RuntimeCapabilities,
  SubagentWorkOrder,
} from "../src/core/contracts.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

test("a cyclic WorkOrder graph is rejected before any agent is dispatched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-work-order-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const { run } = await runtime.acceptTrigger({
    kind: "query",
    summary: "Build and review a result.",
    payload: {},
  });

  await assert.rejects(
    runtime.attachPlan(run.id, {
      summary: "Invalid cyclic plan.",
      steps: [{
        id: "prepare",
        title: "Prepare",
        instructions: "Prepare the result.",
        risk: "reversible_write",
        acceptanceCriteria: ["Result exists"],
        subagents: [
          workOrder({ id: "draft", dependsOn: ["review"] }),
          workOrder({ id: "review", dependsOn: ["draft"] }),
        ],
      }],
    }),
    /dependency cycle/,
  );
  assert.deepEqual(await runtime.getEventsForRun(run.id), [
    "run.created",
    "run.status_changed",
  ]);
});

test("the dispatcher chooses by capability and rejects an incompatible preferred agent", async () => {
  const researcher = new ScriptedExecutionAdapter("researcher", "demo", ["research", "filesystem_read"]);
  const maker = new ScriptedExecutionAdapter("maker", "demo", ["drafting", "filesystem_write"]);
  const registry = new StaticAgentRegistry([maker, researcher]);
  const dispatcher = new CapabilityDispatcher(registry);

  assert.equal((await dispatcher.select(workOrder({ id: "research", agentId: undefined }))).id, "researcher");
  await assert.rejects(
    dispatcher.select(workOrder({ id: "research", agentId: "maker" })),
    /missing capabilities: research, filesystem_read/,
  );
});

test("an external-risk WorkOrder cannot request automatic retries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-work-order-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const { run } = await runtime.acceptTrigger({
    kind: "query",
    summary: "Submit the approved purchase order.",
    payload: {},
  });

  await assert.rejects(
    runtime.attachPlan(run.id, {
      summary: "Invalid risky retry plan.",
      steps: [{
        id: "prepare",
        title: "Prepare",
        instructions: "Prepare the purchase.",
        // The step carries the risk it actually contains: the Kernel refuses a
        // step that hides a riskier child, and this test is about the retry
        // rule, not about that containment check.
        // 步骤携带它实际包含的风险：Kernel 会拒绝藏着更高风险子项的步骤，而本测试要验证的
        // 是重试规则，不是那条包含性检查。
        risk: "external_side_effect",
        acceptanceCriteria: ["Purchase request is ready"],
        subagents: [
          workOrder({
            id: "purchase",
            risk: "external_side_effect",
            budget: {
              maxDurationMs: 60_000,
              maxModelCalls: 5,
              maxToolCalls: 10,
              maxAttempts: 2,
            },
          }),
        ],
      }],
    }),
    /must use maxAttempts=1/,
  );
});

test("capability routing records the concrete executor and retries through the persisted session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-work-order-resume-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { runtime, journal } = await createRuntime(directory);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Research one fact.", payload: {} });
  await runtime.attachPlan(run.id, {
    summary: "Delegate one bounded work order.",
    steps: [{
      id: "prepare",
      title: "Prepare",
      instructions: "Research the fact.",
      risk: "read_only",
      acceptanceCriteria: ["Research evidence exists"],
      subagents: [workOrder({ id: "research", agentId: undefined })],
    }],
  });

  const adapter = new FlakyResumeAdapter();
  const result = await runtime.execute(run.id, new StaticAgentRegistry([adapter]));

  assert.equal(result.status, "completed");
  assert.deepEqual(adapter.resumedSessionIds, ["pi-session-1"]);
  assert.equal(runtime.getSubagentsForRun(run.id)[0]?.attempt, 2);
  const evidenceEvent = (await journal.list()).find((event) => event.type === "evidence.recorded");
  assert.equal((evidenceEvent?.payload as { producedBy?: string }).producedBy, "researcher");
  const eventTypes = await runtime.getEventsForRun(run.id);
  assert.ok(eventTypes.includes("subagent.resumed"));
  assert.equal(eventTypes.includes("agent.message_delta"), false);
});

test("journal recovery resumes the pinned adapter without consuming a new attempt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-work-order-crash-resume-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { runtime, journal } = await createRuntime(directory);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Research one fact.", payload: {} });
  const order = workOrder({ id: "research", agentId: undefined });
  await runtime.attachPlan(run.id, {
    summary: "Delegate one bounded work order.",
    steps: [{
      id: "prepare",
      title: "Prepare",
      instructions: "Research the fact.",
      risk: "read_only",
      acceptanceCriteria: ["Research evidence exists"],
      subagents: [order],
    }],
  });
  const startedAt = new Date().toISOString();
  await journal.append({
    type: "run.status_changed",
    taskId: run.taskId,
    runId: run.id,
    payload: { status: "running", activeStepId: "prepare" },
  });
  await journal.append({
    type: "subagent.dispatched",
    taskId: run.taskId,
    runId: run.id,
    payload: {
      id: "subagent-1",
      runId: run.id,
      stepId: "prepare",
      workOrderId: order.id,
      agentId: "researcher",
      providerId: "pi-test",
      role: order.role,
      title: order.title,
      status: "running",
      attempt: 1,
      startedAt,
      updatedAt: startedAt,
    },
  });
  await journal.append({
    type: "subagent.session_started",
    taskId: run.taskId,
    runId: run.id,
    payload: { stepId: "prepare", workOrderId: order.id, sessionId: "pi-session-1" },
  });

  const recovered = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
  });
  const adapter = new FlakyResumeAdapter();
  const other = new ScriptedExecutionAdapter("other-researcher", "demo", ["research", "filesystem_read"]);
  const result = await recovered.execute(run.id, new StaticAgentRegistry([other, adapter]));

  assert.equal(result.status, "completed");
  assert.deepEqual(adapter.resumedSessionIds, ["pi-session-1"]);
  assert.equal(recovered.getSubagentsForRun(run.id)[0]?.attempt, 1);
});

class FlakyResumeAdapter implements RuntimeAdapter {
  readonly id = "researcher";
  readonly providerId = "pi-test";
  readonly resumedSessionIds: string[] = [];

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: true,
      cancellation: true,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["research", "filesystem_read"],
    };
  }

  async *execute(_input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    yield { type: "session_started", sessionId: "pi-session-1" };
    yield { type: "failed", message: "Transient child-process failure." };
  }

  async *resume(sessionId: string, _input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    this.resumedSessionIds.push(sessionId);
    yield { type: "message_delta", text: "token=must-not-enter-the-immutable-journal" };
    yield {
      type: "evidence",
      evidence: {
        kind: "artifact",
        summary: "Recovered research result.",
        locator: `pi-session://${sessionId}`,
      },
    };
    yield { type: "completed", summary: "Recovered from the persisted session." };
  }

  async cancel(): Promise<void> {}
}

async function createRuntime(directory: string): Promise<{ runtime: CloneRuntime; journal: JsonlJournalStore }> {
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  return {
    journal,
    runtime: new CloneRuntime({
      journal,
      policy: new DefaultPolicyEngine(),
      verifier: new EvidenceVerifier(),
      memory: new MemoryPipeline(journal),
    }),
  };
}

function workOrder(
  overrides: Partial<SubagentWorkOrder> & Pick<SubagentWorkOrder, "id">,
): SubagentWorkOrder {
  return {
    role: "researcher",
    title: `Work ${overrides.id}`,
    objective: "Produce bounded research evidence.",
    inputs: [{ name: "request", description: "The parent request.", required: true }],
    requiredCapabilities: ["research", "filesystem_read"],
    expectedArtifacts: [{
      id: `${overrides.id}-artifact`,
      kind: "artifact",
      description: "A durable research artifact.",
      required: true,
    }],
    acceptanceCriteria: ["Evidence is reviewable"],
    risk: "read_only",
    budget: {
      maxDurationMs: 60_000,
      maxModelCalls: 5,
      maxToolCalls: 10,
      maxAttempts: 2,
    },
    ...overrides,
  };
}

test("a work order may omit advisory model and tool call ceilings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-budget-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { runtime } = await createRuntime(directory);
  const { run } = await runtime.acceptTrigger({ kind: "query", summary: "Research.", payload: {} });

  await runtime.attachPlan(run.id, {
    summary: "Research without pretending the Kernel counts model calls.",
    steps: [{
      id: "prepare",
      title: "Research",
      instructions: "Collect facts.",
      risk: "read_only",
      acceptanceCriteria: ["A note exists"],
      subagents: [
        workOrder({
          id: "research",
          budget: { maxDurationMs: 60_000, maxAttempts: 2 },
        }),
      ],
    }],
  });

  assert.equal(runtime.getRun(run.id).status, "queued");
});
