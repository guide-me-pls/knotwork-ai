import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runQuery } from "../src/application/run-query.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { createScriptedAgentRegistry } from "./fixtures/scripted-adapter.ts";
import { LlmWorkPlanner, OpenAIResponsesPlannerModel, type PlanningAgent, type StructuredPlannerModel } from "../src/planning/llm-planner.ts";

const agents: PlanningAgent[] = [
  { id: "direct-responder", providerId: "codex-cli", role: "direct", capabilities: ["direct_response"] },
  { id: "context-researcher", providerId: "claude-code", role: "research", capabilities: ["research", "filesystem_read"] },
  { id: "evidence-reviewer", providerId: "pi", role: "review", capabilities: ["review"] },
];

test("LLM planner converts a bounded structured proposal into a WorkPlan", async () => {
  const planner = new LlmWorkPlanner(new ScriptedPlannerModel([directPlan()]));

  const plan = await planner.plan({ query: "解释术语", recalledMemories: ["回答尽量简洁"], availableAgents: agents });

  assert.equal(plan.steps[0]?.agentId, "direct-responder");
  assert.deepEqual(plan.steps[0]?.requiredCapabilities, ["direct_response"]);
});

test("LLM planner requests one correction when the model selects a missing capability", async () => {
  const invalid = directPlan();
  const execution = invalid.steps[0]?.execution as Record<string, unknown>;
  execution.requiredCapabilities = ["external_action"];
  const model = new ScriptedPlannerModel([invalid, directPlan()]);
  const planner = new LlmWorkPlanner(model);

  const plan = await planner.plan({ query: "解释术语", recalledMemories: [], availableAgents: agents });

  assert.equal(plan.steps[0]?.id, "answer");
  assert.match(model.corrections[1] ?? "", /previous work-plan proposal was rejected/i);
});

test("LLM planner rejects an external work order without a durable receipt", async () => {
  const unsafe = {
    summary: "Publish a note.",
    steps: [{
      id: "publish",
      title: "Publish",
      instructions: "Publish the approved note.",
      risk: "external_side_effect",
      acceptanceCriteria: ["A receipt exists."],
      execution: {
        kind: "subagents",
        agentId: null,
        requiredCapabilities: [],
        orders: [{
          id: "publish-note",
          agentId: null,
          role: "custom",
          title: "Publish note",
          objective: "Publish a note.",
          requiredCapabilities: ["review"],
          expectedArtifacts: [{ id: "note", kind: "artifact", description: "A note", required: true, locatorRequired: false }],
          acceptanceCriteria: ["It is published."],
          risk: "external_side_effect",
          dependsOn: [],
        }],
      },
    }],
  };
  const planner = new LlmWorkPlanner(new ScriptedPlannerModel([unsafe, unsafe]));

  await assert.rejects(
    () => planner.plan({ query: "发布", recalledMemories: [], availableAgents: agents }),
    /durable receipt contract/,
  );
});

test("LLM planner permits a first-wave work order with no dependencies", async () => {
  const planner = new LlmWorkPlanner(new ScriptedPlannerModel([researchPlan()]));

  const plan = await planner.plan({ query: "调研这个主题", recalledMemories: [], availableAgents: agents });

  const [order] = plan.steps[0]?.subagents ?? [];
  assert.equal(order?.id, "research");
  assert.deepEqual(order?.dependsOn, undefined);
  assert.deepEqual(order?.inputs.map((input) => input.name), ["request"]);
});

test("OpenAI Responses planner forces exactly one structured function call", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const model = new OpenAIResponsesPlannerModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        output: [{ type: "function_call", name: "create_work_plan", arguments: JSON.stringify(directPlan()) }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const proposal = await model.createWorkPlan({ planning: { query: "解释术语", recalledMemories: [], availableAgents: agents } });

  assert.equal((requestBody?.tool_choice as { name?: string }).name, "create_work_plan");
  assert.equal(((requestBody?.tools as Array<{ strict?: boolean }>)[0]?.strict), true);
  assert.equal((proposal as { summary?: string }).summary, "Answer directly.");
});

test("OpenAI Responses planner copies token usage from the API body", async () => {
  const model = new OpenAIResponsesPlannerModel({
    apiKey: "test-key",
    model: "test-model",
    fetcher: async () => new Response(JSON.stringify({
      output: [{ type: "function_call", name: "create_work_plan", arguments: JSON.stringify(directPlan()) }],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  await model.createWorkPlan({ planning: { query: "解释术语", recalledMemories: [], availableAgents: agents } });
  const usage = model.takeLastUsage();
  assert.equal(usage?.modelId, "test-model");
  assert.equal(usage?.provider, "openai");
  assert.equal(usage?.inputTokens, 11);
  assert.equal(usage?.outputTokens, 7);
  assert.equal(usage?.totalTokens, 18);
});

test("OpenAI Responses planner retries 429 then succeeds", async () => {
  let calls = 0;
  const model = new OpenAIResponsesPlannerModel({
    apiKey: "test-key",
    model: "test-model",
    retryDelaysMs: [0],
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        output: [{ type: "function_call", name: "create_work_plan", arguments: JSON.stringify(directPlan()) }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const proposal = await model.createWorkPlan({ planning: { query: "解释术语", recalledMemories: [], availableAgents: agents } });
  assert.equal(calls, 2);
  assert.equal((proposal as { summary?: string }).summary, "Answer directly.");
});

test("OpenAI Responses planner does not retry a 400", async () => {
  let calls = 0;
  const model = new OpenAIResponsesPlannerModel({
    apiKey: "test-key",
    model: "test-model",
    retryDelaysMs: [0],
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await assert.rejects(
    () => model.createWorkPlan({ planning: { query: "解释术语", recalledMemories: [], availableAgents: agents } }),
    /OpenAI Responses API error \(400\)/,
  );
  assert.equal(calls, 1);
});

test("workflow uses an injected LLM planner before it dispatches an executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-llm-planner-"));
  try {
    const model = new ScriptedPlannerModel([directPlan()]);
    // The registry is injected explicitly: production has no implicit fake
    // fallback, so a test that must not reach a real provider says so.
    // Registry 显式注入：生产环境没有隐式的假 Registry 回退，因此不希望触达真实
    // Provider 的测试必须自己声明。
    const result = await runQuery(directory, "解释这个术语", {}, undefined, {
      planner: new LlmWorkPlanner(model),
      agents: createScriptedAgentRegistry(),
    });

    assert.equal(result.status, "completed");
    assert.equal(model.corrections.length, 1);
    const journal = createJournalStore(directory);
    try {
      const usage = (await journal.list()).filter((event) => event.type === "usage.recorded");
      assert.ok(usage.length >= 1, "the planner turn must land in the journal");
      assert.equal((usage[0]?.payload as { source?: string }).source, "planner");
      assert.equal(typeof (usage[0]?.payload as { durationMs?: number }).durationMs, "number");
    } finally {
      (journal as { close?: () => void }).close?.();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class ScriptedPlannerModel implements StructuredPlannerModel {
  readonly #responses: unknown[];
  readonly corrections: Array<string | undefined> = [];

  constructor(responses: unknown[]) {
    this.#responses = responses;
  }

  async createWorkPlan(input: { correction?: string }): Promise<unknown> {
    this.corrections.push(input.correction);
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("The scripted planner ran out of responses.");
    return structuredClone(next);
  }
}

function directPlan() {
  return {
    summary: "Answer directly.",
    steps: [{
      id: "answer",
      title: "Answer",
      instructions: "Explain the requested term clearly.",
      risk: "read_only",
      acceptanceCriteria: ["A clear answer is prepared."],
      execution: {
        kind: "single",
        agentId: "direct-responder",
        requiredCapabilities: ["direct_response"],
        orders: [],
      },
    }],
  };
}

function researchPlan() {
  return {
    summary: "Research before deciding.",
    steps: [{
      id: "prepare",
      title: "Research",
      instructions: "Collect the facts needed for a later decision.",
      risk: "read_only",
      acceptanceCriteria: ["A source-backed research note exists."],
      execution: {
        kind: "subagents",
        agentId: null,
        requiredCapabilities: [],
        orders: [{
          id: "research",
          agentId: null,
          role: "researcher",
          title: "Research the topic",
          objective: "Collect reliable facts and uncertainty.",
          requiredCapabilities: ["research", "filesystem_read"],
          expectedArtifacts: [{ id: "research-note", kind: "artifact", description: "A research note", required: true, locatorRequired: false }],
          acceptanceCriteria: ["The note names sources and uncertainty."],
          risk: "read_only",
          dependsOn: [],
        }],
      },
    }],
  };
}
