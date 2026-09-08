import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelQueryRun, rejectQueryRun } from "../src/application/run-query.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { createScriptedAgentRegistry } from "./fixtures/scripted-adapter.ts";

async function waitingApprovalHome(): Promise<{ dataDirectory: string; runId: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-run-control-"));
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    const { run } = await assembly.runtime.acceptTrigger({
      kind: "query",
      summary: "Send the approved update.",
      payload: {},
    });
    await assembly.runtime.attachPlan(run.id, {
      summary: "Needs the owner before an external action.",
      steps: [{
        id: "send",
        agentId: "external-operator",
        requiredCapabilities: ["external_action"],
        title: "Send update",
        instructions: "Send the already-approved update.",
        risk: "external_side_effect",
        acceptanceCriteria: ["Delivery receipt exists"],
      }],
    });
    const result = await assembly.runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(result.status, "waiting_approval");
    return { dataDirectory, runId: run.id };
  } finally {
    assembly.close();
  }
}

test("reject ends a waiting_approval run as failed", async (t) => {
  const { dataDirectory, runId } = await waitingApprovalHome();
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  const result = await rejectQueryRun(dataDirectory, runId, undefined, {
    agents: createScriptedAgentRegistry(),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.runId, runId);
});

test("cancel ends a waiting_approval run as cancelled", async (t) => {
  const { dataDirectory, runId } = await waitingApprovalHome();
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  const result = await cancelQueryRun(dataDirectory, runId, undefined, {
    agents: createScriptedAgentRegistry(),
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.runId, runId);
});
