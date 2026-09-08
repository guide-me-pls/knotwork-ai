import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProviderRegistry } from "../src/workers/provider-catalog.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities, SubagentWorkOrder } from "../src/core/contracts.ts";
import { classifyFailure, loadOutcomeCatalog } from "../src/core/failure-analysis.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { JsonWorkspaceCheckpointStore, snapshotWorkspace } from "../src/core/workspace-evidence.ts";
import { workspaceExecutionLock } from "../src/core/workspace-lock.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";

class RecoveringAdapter implements RuntimeAdapter {
  readonly id = "worker";
  readonly providerId = "recovery-test";
  calls = 0;
  readonly #writeFile: string | undefined;

  constructor(writeFilePath?: string) {
    this.#writeFile = writeFilePath;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["drafting", "filesystem_write"],
      evidenceKinds: ["artifact", "observation"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    this.calls += 1;
    if (this.#writeFile !== undefined) {
      await mkdir(join(input.workspacePath ?? process.cwd(), "out"), { recursive: true });
      await writeFile(join(input.workspacePath ?? process.cwd(), this.#writeFile), "recovered", "utf8");
    }
    yield {
      type: "evidence",
      evidence: {
        kind: "artifact",
        summary: "The recovery test produced a durable artifact.",
        locator: this.#writeFile ?? "test://artifact",
      },
    };
    yield { type: "completed", summary: "The recovery test completed." };
  }
}

class ConcurrentWriter implements RuntimeAdapter {
  readonly id: string;
  readonly providerId = "concurrency-test";
  readonly #workspaceFile: string;
  readonly #state: { active: number; maximum: number };

  constructor(id: string, workspaceFile: string, state: { active: number; maximum: number }) {
    this.id = id;
    this.#workspaceFile = workspaceFile;
    this.#state = state;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      resume: false,
      cancellation: false,
      approvalCallback: false,
      parallelAssignments: true,
      work: ["drafting", "filesystem_write"],
      evidenceKinds: ["artifact"],
    };
  }

  async *execute(input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    this.#state.active += 1;
    this.#state.maximum = Math.max(this.#state.maximum, this.#state.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await mkdir(join(input.workspacePath ?? process.cwd(), "out"), { recursive: true });
      await writeFile(join(input.workspacePath ?? process.cwd(), this.#workspaceFile), this.id, "utf8");
      yield { type: "evidence", evidence: { kind: "artifact", summary: "writer produced a file", locator: this.#workspaceFile } };
      yield { type: "completed", summary: `${this.id} completed.` };
    } finally {
      this.#state.active -= 1;
    }
  }
}

function workOrder(id: string, agentId = "worker"): SubagentWorkOrder {
  return {
    id,
    agentId,
    role: "maker",
    title: `Work ${id}`,
    objective: `Produce artifact ${id}.`,
    inputs: [],
    requiredCapabilities: ["drafting", "filesystem_write"],
    expectedArtifacts: [{ id: `${id}-artifact`, kind: "artifact", description: "A durable file.", required: true }],
    acceptanceCriteria: ["The file exists."],
    risk: "reversible_write",
    budget: { maxDurationMs: 10_000, maxModelCalls: 2, maxToolCalls: 2, maxAttempts: 1 },
  };
}

async function prepareInterruptedRun(
  t: { after(callback: () => void | Promise<void>): void },
  options: { baselineFile?: string; risk?: "read_only" | "reversible_write"; hashOnly?: boolean } = {},
): Promise<{
  directory: string;
  workspace: string;
  journal: JsonlJournalStore;
  store: JsonWorkspaceCheckpointStore;
  runId: string;
  stepId: string;
  order: SubagentWorkOrder;
}> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-recovery-"));
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-recovery-workspace-"));
  t.after(async () => {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  if (options.baselineFile !== undefined) {
    await mkdir(join(workspace, "out"), { recursive: true });
    await writeFile(join(workspace, options.baselineFile), "before", "utf8");
  }
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const store = new JsonWorkspaceCheckpointStore(join(directory, "workspace-checkpoints"));
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    workspacePath: workspace,
    workspaceCheckpointStore: store,
  });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "Recover a black-box task", payload: {} });
  const order = workOrder("recover");
  order.risk = options.risk ?? "reversible_write";
  await runtime.attachPlan(run.id, {
    summary: "Recover one bounded black-box task.",
    steps: [{
      id: "step-1",
      title: "Recover task",
      instructions: "Recover the task from the Workspace.",
      risk: order.risk,
      acceptanceCriteria: ["The artifact is verified."],
      subagents: [order],
    }],
  });

  const checkpoint = await store.save(`${run.id}/${order.id}/attempt-1`, await snapshotWorkspace(workspace));
  if (options.hashOnly === true) {
    await rm(join(directory, "workspace-checkpoints", `${checkpoint}.files`), { recursive: true, force: true });
  }
  const now = new Date().toISOString();
  await journal.append({
    type: "run.status_changed",
    taskId: run.taskId,
    runId: run.id,
    payload: { status: "running", activeStepId: "step-1" },
  });
  await journal.append({
    type: "subagent.dispatched",
    taskId: run.taskId,
    runId: run.id,
    payload: {
      id: "subagent-1",
      runId: run.id,
      stepId: "step-1",
      workOrderId: order.id,
      agentId: "worker",
      providerId: "recovery-test",
      role: order.role,
      title: order.title,
      status: "running",
      workspaceCheckpoint: checkpoint,
      workspacePath: workspace,
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      authorizedEvidenceKinds: ["artifact", "observation"],
      memoryItemIds: [],
    },
  });
  return { directory, workspace, journal, store, runId: run.id, stepId: "step-1", order };
}

test("a restarted Kernel reruns a black-box task only after confirming no Workspace side effect", async (t) => {
  const prepared = await prepareInterruptedRun(t);
  const adapter = new RecoveringAdapter("out/recovered.md");
  const runtime = new CloneRuntime({
    journal: new JsonlJournalStore(join(prepared.directory, "journal.jsonl")),
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(new JsonlJournalStore(join(prepared.directory, "journal.jsonl"))),
    workspacePath: prepared.workspace,
    workspaceCheckpointStore: prepared.store,
  });

  const result = await runtime.execute(prepared.runId, new StaticAgentRegistry([adapter]));

  assert.equal(result.status, "completed");
  assert.equal(adapter.calls, 1);
  assert.match(await readFile(join(prepared.workspace, "out/recovered.md"), "utf8"), /recovered/);
  const events = await runtime.getEventsForRun(prepared.runId);
  assert.ok(events.includes("subagent.recovery_decided"));
  assert.ok(events.includes("subagent.resumed"));
});

test("a deleted file after a black-box crash is restored from checkpoint then rerun", async (t) => {
  const prepared = await prepareInterruptedRun(t, { baselineFile: "out/original.md" });
  await rm(join(prepared.workspace, "out/original.md"));
  const adapter = new RecoveringAdapter("out/recovered.md");
  const journal = new JsonlJournalStore(join(prepared.directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
    workspacePath: prepared.workspace,
    workspaceCheckpointStore: prepared.store,
  });

  const result = await runtime.execute(prepared.runId, new StaticAgentRegistry([adapter]));

  assert.equal(result.status, "completed");
  assert.equal(adapter.calls, 1);
  assert.equal(await readFile(join(prepared.workspace, "out/original.md"), "utf8"), "before");
  const events = await journal.list();
  const recovery = events.find((event) => event.type === "subagent.recovery_decided");
  assert.equal((recovery?.payload as { decision?: string }).decision, "rerun");
});

test("a hash-only checkpoint still blocks recovery when files were deleted", async (t) => {
  const prepared = await prepareInterruptedRun(t, { baselineFile: "out/original.md", hashOnly: true });
  await rm(join(prepared.workspace, "out/original.md"));
  const adapter = new RecoveringAdapter("out/should-not-run.md");
  const journal = new JsonlJournalStore(join(prepared.directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
    workspacePath: prepared.workspace,
    workspaceCheckpointStore: prepared.store,
  });

  const result = await runtime.execute(prepared.runId, new StaticAgentRegistry([adapter]));

  assert.equal(result.status, "failed");
  assert.equal(adapter.calls, 0);
  const events = await journal.list();
  const recovery = events.find((event) => event.type === "subagent.recovery_decided");
  assert.equal((recovery?.payload as { decision?: string }).decision, "blocked");
});

test("a complete file left by a crashed black box is reconciled without a second process", async (t) => {
  const prepared = await prepareInterruptedRun(t);
  await mkdir(join(prepared.workspace, "out"), { recursive: true });
  await writeFile(join(prepared.workspace, "out/recovered.md"), "already written", "utf8");
  const adapter = new RecoveringAdapter("out/should-not-run.md");
  const journal = new JsonlJournalStore(join(prepared.directory, "journal.jsonl"));
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory: new MemoryPipeline(journal),
    workspacePath: prepared.workspace,
    workspaceCheckpointStore: prepared.store,
  });

  const result = await runtime.execute(prepared.runId, new StaticAgentRegistry([adapter]));

  assert.equal(result.status, "completed");
  assert.equal(adapter.calls, 0);
  assert.ok((await runtime.getEventsForRun(prepared.runId)).includes("subagent.verified"));
});

test("a lock owned by a dead Supervisor is reclaimed", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-stale-lock-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, ".clone-ai"), { recursive: true });
  await writeFile(
    join(workspace, ".clone-ai", "workspace-execution.lock"),
    JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date().toISOString() }),
    "utf8",
  );

  let entered = false;
  await workspaceExecutionLock.run(workspace, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test("ready writers sharing one Workspace never overlap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-lock-"));
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-lock-workspace-"));
  t.after(async () => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
  ]));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const memory = new MemoryPipeline(journal);
  const runtime = new CloneRuntime({
    journal,
    policy: new DefaultPolicyEngine(),
    verifier: new EvidenceVerifier(),
    memory,
    workspacePath: workspace,
    workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(join(directory, "workspace-checkpoints")),
  });
  const { run } = await runtime.acceptTrigger({ kind: "manual", summary: "Serialize writers", payload: {} });
  const first = workOrder("first", "writer-a");
  const second = workOrder("second", "writer-b");
  await runtime.attachPlan(run.id, {
    summary: "Run two independent writers safely.",
    steps: [{
      id: "step-1",
      title: "Write files",
      instructions: "Write two independent files.",
      risk: "reversible_write",
      acceptanceCriteria: ["Both files exist."],
      subagents: [first, second],
    }],
  });
  const state = { active: 0, maximum: 0 };
  const agents = new StaticAgentRegistry([
    new ConcurrentWriter("writer-a", "out/a.md", state),
    new ConcurrentWriter("writer-b", "out/b.md", state),
  ]);

  const result = await runtime.execute(run.id, agents);

  assert.equal(result.status, "completed");
  assert.equal(state.maximum, 1);
});

test("an owner failures.json can add diagnostic guidance without source changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-outcomes-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "outcomes"), { recursive: true });
  await writeFile(join(directory, "outcomes", "failures.json"), JSON.stringify({
    patterns: [{ category: "owner_auth_failure", match: "magic auth failed", guidance: "Refresh the local login." }],
    fallbackCategory: "owner_unknown",
    inconclusiveCategories: ["owner_unknown"],
  }), "utf8");

  const catalog = await loadOutcomeCatalog(directory);
  const result = classifyFailure("provider says magic auth failed", "owner_unknown", catalog);
  assert.equal(result.category, "owner_auth_failure");
  assert.equal(result.guidance, "Refresh the local login.");
});

test("a user providers.json adds a provider without source changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-provider-json-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "providers.json"), JSON.stringify({
    providers: [{
      id: "user-agent",
      label: "User Agent",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: ["USER_AGENT_HOME"],
      work: ["research"],
    }],
  }), "utf8");

  const registry = await loadProviderRegistry(directory);
  const definition = registry.get("user-agent");
  assert.equal(definition?.label, "User Agent");
  const adapter = registry.createAdapter("user-agent", {
    agentId: "context-researcher",
    role: "research",
    workCapabilities: ["research"],
    dataDirectory: directory,
  });
  assert.equal(adapter.providerId, "user-agent");
});
