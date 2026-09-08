import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { BlackBoxCliWorker, buildWorkerPrompt, resolveWindowsCommand, terminateProcessTree, type BlackBoxProviderConfig } from "../src/workers/black-box-cli-worker.ts";
import { corroborateFailures, classifyFailure, failureSignature } from "../src/core/failure-analysis.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";
import { diffWorkspace, snapshotWorkspace } from "../src/core/workspace-evidence.ts";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.cjs", import.meta.url));

function providerConfig(overrides: Partial<BlackBoxProviderConfig> = {}): BlackBoxProviderConfig {
  return {
    id: "fake-agent",
    command: process.execPath,
    args: [fakeAgent, "{{prompt}}"],
    env: ["FAKE_AGENT_MODE", "FAKE_AGENT_OUTPUT"],
    ...overrides,
  };
}

function assignment(workspacePath: string, requireArtifact = true): ExecutionAssignment {
  const createdAt = "2026-08-19T00:00:00.000Z";
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt, updatedAt: createdAt },
    task: { id: "task-1", triggerId: "trigger-1", title: "Report", objective: "Produce a report", acceptanceCriteria: ["A report exists"], createdAt },
    step: {
      id: "step-1",
      title: "Produce the report",
      instructions: "Write the report.",
      risk: "reversible_write",
      acceptanceCriteria: ["A report exists"],
      agentId: "worker",
      requiredCapabilities: ["drafting"],
    },
    executor: { agentId: "worker", providerId: "fake-agent" },
    workOrder: {
      id: "order-1",
      role: "maker",
      title: "Produce the report",
      objective: "Write the report into the workspace.",
      inputs: [],
      requiredCapabilities: ["drafting"],
      expectedArtifacts: [{ id: "report", kind: "artifact", description: "The report.", required: requireArtifact }],
      acceptanceCriteria: ["A report exists"],
      risk: "reversible_write",
      budget: { maxDurationMs: 20_000, maxModelCalls: 4, maxToolCalls: 4, maxAttempts: 1 },
    },
    workspacePath,
  };
}

async function runAgent(
  t: TestContext,
  options: { mode?: string; config?: Partial<BlackBoxProviderConfig>; requireArtifact?: boolean; maxDurationMs?: number } = {},
): Promise<{ events: ExecutionEvent[]; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-blackbox-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const previous = process.env.FAKE_AGENT_MODE;
  if (options.mode === undefined) delete process.env.FAKE_AGENT_MODE;
  else process.env.FAKE_AGENT_MODE = options.mode;
  try {
    const adapter = new BlackBoxCliWorker({
      agentId: "worker",
      config: providerConfig(options.config),
      workCapabilities: ["drafting"],
    });
    const input = assignment(workspace, options.requireArtifact ?? true);
    if (options.maxDurationMs !== undefined && input.workOrder !== undefined) {
      input.workOrder.budget.maxDurationMs = options.maxDurationMs;
    }
    const events: ExecutionEvent[] = [];
    for await (const event of adapter.execute(input)) events.push(event);
    return { events, workspace };
  } finally {
    if (previous === undefined) delete process.env.FAKE_AGENT_MODE;
    else process.env.FAKE_AGENT_MODE = previous;
  }
}

test("a file the agent wrote becomes artifact evidence without the agent declaring it", async (t) => {
  const { events, workspace } = await runAgent(t);

  const artifacts = events.filter((event) => event.type === "evidence" && event.evidence.kind === "artifact");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.type === "evidence" && artifacts[0].evidence.locator, "out/report.md");
  assert.ok(events.some((event) => event.type === "completed"));
  // The evidence is a fact about the filesystem, checkable independently.
  // 证据是关于文件系统的事实，可以独立复核。
  assert.match(await readFile(join(workspace, "out/report.md"), "utf8"), /# report/);
});

test("an agent that claims success but writes nothing fails the work order", async (t) => {
  const { events } = await runAgent(t, { mode: "talks-but-writes-nothing" });

  const failed = events.find((event) => event.type === "failed");
  assert.ok(failed, "a clean exit with no artifact must not be accepted as completion");
  assert.equal(failed.type === "failed" && failed.report?.category, "no_artifact");
  assert.ok(!events.some((event) => event.type === "completed"));
});

test("the same agent is accepted when the work order requires no artifact", async (t) => {
  const { events } = await runAgent(t, { mode: "talks-but-writes-nothing", requireArtifact: false });

  assert.ok(events.some((event) => event.type === "completed"));
  const evidence = events.filter((event) => event.type === "evidence");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.type === "evidence" && evidence[0].evidence.kind, "observation");
});

test("a missing command fails the step instead of crashing the supervisor", async (t) => {
  const { events } = await runAgent(t, { config: { command: join(tmpdir(), "clone-ai-not-installed") } });

  const failed = events.find((event) => event.type === "failed");
  assert.equal(failed?.type === "failed" && failed.report?.category, "launch_failed");
});

test("a hanging agent is killed at the duration budget", async (t) => {
  const startedAt = Date.now();
  const { events } = await runAgent(t, { mode: "hang", maxDurationMs: 400 });

  const failed = events.find((event) => event.type === "failed");
  assert.equal(failed?.type === "failed" && failed.report?.category, "timeout");
  assert.ok(Date.now() - startedAt < 10_000, "the supervisor must not wait on a wedged agent");
});

test("terminating a worker also kills its grandchild process", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-tree-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const pidFile = join(workspace, "grandchild.pid");
  process.env.FAKE_GRANDCHILD_PID_FILE = pidFile;
  t.after(() => {
    delete process.env.FAKE_GRANDCHILD_PID_FILE;
  });
  const { events } = await runAgent(t, { mode: "hang-with-child", maxDurationMs: 2_500, config: { env: ["FAKE_AGENT_MODE", "FAKE_AGENT_OUTPUT", "FAKE_GRANDCHILD_PID_FILE"] } });

  const failed = events.find((event) => event.type === "failed");
  assert.equal(failed?.type === "failed" && failed.report?.category, "timeout");
  const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "the grandchild must have recorded its pid");
  // Give taskkill a moment, then assert the grandchild is gone.
  // 给 taskkill 一点时间，然后断言孙进程已消失。
  await new Promise((resolve) => setTimeout(resolve, 500));
  let alive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the grandchild must die with its worker");
});

test("an oversized worker prompt is refused before any process starts", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-prompt-budget-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const adapter = new BlackBoxCliWorker({
    agentId: "worker",
    config: providerConfig(),
    workCapabilities: ["drafting"],
  });
  const input = assignment(workspace);
  if (input.workOrder !== undefined) {
    input.workOrder.objective = "x".repeat(40_000);
  }

  await assert.rejects(async () => {
    for await (const _event of adapter.execute(input)) {
      // Drain the generator so the promise settles. 排空生成器使 Promise 落定。
    }
  }, /30000-character budget/i);
});

test("only allowlisted environment variables reach the agent", async (t) => {
  process.env.CLONE_AI_TEST_SECRET = "super-secret";
  t.after(() => {
    delete process.env.CLONE_AI_TEST_SECRET;
  });

  const hidden = await runAgent(t, { mode: "env-probe", requireArtifact: false });
  assert.match(progressText(hidden.events), /probe=absent/);

  const granted = await runAgent(t, {
    mode: "env-probe",
    requireArtifact: false,
    config: { env: ["FAKE_AGENT_MODE", "CLONE_AI_TEST_SECRET"] },
  });
  assert.match(progressText(granted.events), /probe=super-secret/);
});

test("the worker prompt tells the agent that unsaved work counts as work not done", () => {
  const prompt = buildWorkerPrompt(assignment("/tmp/workspace"));

  assert.match(prompt, /Write every deliverable to a file in this workspace/);
  assert.match(prompt, /the supervisor inspects the workspace, not your message/i);
  // No provider-specific convention is imposed on a black-box agent.
  // 不对黑盒 Agent 强加任何 Provider 专属约定。
  assert.doesNotMatch(prompt, /CLONE_AI_EVIDENCE/);
});

test("an isolated assignment tells the worker it is not in the owner's live tree", () => {
  const prompt = buildWorkerPrompt({
    ...assignment("/tmp/sandbox"),
    workspaceIsolation: { kind: "directory_copy", ownerPath: "/tmp/owner" },
  });
  assert.match(prompt, /Isolated working directory: directory_copy/);
  assert.match(prompt, /\/tmp\/owner/);
  assert.match(prompt, /Do not leave this directory/);
});

test("a .cmd shim is resolved to its real executable without a shell", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-shim-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  // On non-Windows hosts there is no shim concept; the command passes through.
  // 非 Windows 平台没有垫片概念，命令原样透传。
  if (process.platform !== "win32") {
    assert.deepEqual(resolveWindowsCommand("tool.cmd"), { command: "tool.cmd", prefixArgs: [] });
    return;
  }
  await mkdir(join(directory, "node_modules", "pkg", "bin"), { recursive: true });
  // An exe shim points straight at the binary.
  // exe 垫片直接指向二进制。
  await writeFile(join(directory, "tool.cmd"), `@ECHO off\n"%dp0%\\node_modules\\pkg\\bin\\tool.exe"  %*\n`, "utf8");
  const exe = resolveWindowsCommand(join(directory, "tool.cmd"));
  assert.equal(exe.command.toLowerCase().endsWith("tool.exe"), true);
  assert.deepEqual(exe.prefixArgs, []);

  // A node shim resolves to process.execPath plus the script.
  // node 垫片解析为 process.execPath 加脚本路径。
  await writeFile(join(directory, "node-tool.cmd"), `@ECHO off\nSETLOCAL\n"%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\n`, "utf8");
  const node = resolveWindowsCommand(join(directory, "node-tool.cmd"));
  assert.equal(node.command, process.execPath);
  assert.equal(node.prefixArgs[0]?.toLowerCase().endsWith("cli.js"), true);

  // A non-shim command passes through untouched.
  // 非垫片命令原样返回。
  assert.deepEqual(resolveWindowsCommand("claude.exe"), { command: "claude.exe", prefixArgs: [] });
});

test("environment allowlist supports prefix wildcards for provider recipes", async (t) => {
  process.env.CLONE_AI_TEST_SECRET = "wildcard-value";
  t.after(() => {
    delete process.env.CLONE_AI_TEST_SECRET;
  });

  const { events } = await runAgent(t, {
    mode: "env-probe",
    requireArtifact: false,
    config: { env: ["FAKE_AGENT_MODE", "CLONE_AI_TEST_*"] },
  });
  assert.match(progressText(events), /probe=wildcard-value/);
});

test("two providers failing the same way corroborate a task-level obstacle", () => {
  const claude = {
    providerId: "claude-code",
    agentId: "worker",
    category: classifyFailure("Error: ANTHROPIC_API_KEY is missing. Not logged in, please authenticate.").category,
    signature: failureSignature("Error: ANTHROPIC_API_KEY is missing. Not logged in, please authenticate."),
    detail: "…",
  };
  const codex = {
    providerId: "codex-cli",
    agentId: "worker",
    category: classifyFailure("fatal: unauthorized — no api key found for this account; authentication failed").category,
    signature: failureSignature("fatal: unauthorized — no api key found for this account; authentication failed"),
    detail: "…",
  };

  assert.equal(claude.category, "missing_credential");
  assert.equal(codex.category, "missing_credential");
  const verdict = corroborateFailures([claude, codex]);
  assert.equal(verdict.corroborated, true);
  assert.match(verdict.summary, /task or environment, not the agent/);
});

test("one provider alone never corroborates, and unrelated failures do not either", () => {
  const credential = {
    providerId: "claude-code",
    agentId: "worker",
    category: classifyFailure("no api key found; unauthorized").category,
    signature: failureSignature("no api key found; unauthorized"),
    detail: "…",
  };
  assert.equal(corroborateFailures([credential]).corroborated, false);
  assert.equal(corroborateFailures([credential, { ...credential, providerId: "claude-code" }]).corroborated, false);

  const unrelated = {
    providerId: "codex-cli",
    agentId: "worker",
    category: classifyFailure("panic: internal assertion tripped while compacting the arena").category,
    signature: failureSignature("panic: internal assertion tripped while compacting the arena"),
    detail: "…",
  };
  assert.equal(corroborateFailures([credential, unrelated]).corroborated, false);
});

test("workspace snapshots see additions, modifications, and deletions", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-snapshot-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src/keep.ts"), "keep", "utf8");
  await writeFile(join(workspace, "src/edit.ts"), "before", "utf8");
  await writeFile(join(workspace, "src/drop.ts"), "drop", "utf8");
  // Ignored directories must not register as work.
  // 被忽略的目录不能被算作工作成果。
  await mkdir(join(workspace, "node_modules"), { recursive: true });

  const before = await snapshotWorkspace(workspace);
  await writeFile(join(workspace, "src/edit.ts"), "after", "utf8");
  await writeFile(join(workspace, "src/new.ts"), "new", "utf8");
  await writeFile(join(workspace, "node_modules/noise.js"), "noise", "utf8");
  await rm(join(workspace, "src/drop.ts"));

  const changes = diffWorkspace(before, await snapshotWorkspace(workspace));
  assert.deepEqual(changes, [
    { path: "src/drop.ts", change: "deleted" },
    { path: "src/edit.ts", change: "modified" },
    { path: "src/new.ts", change: "added" },
  ]);
});

function progressText(events: ExecutionEvent[]): string {
  return events
    .filter((event): event is Extract<ExecutionEvent, { type: "progress" }> => event.type === "progress")
    .map((event) => event.message)
    .join("\n");
}
