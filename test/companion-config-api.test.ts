import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { companionFetch } from "./helpers/companion-api.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

test("the config endpoint reports where the owner's data lives", async (t) => {
  const { url, token, dataDirectory } = await companion(t);

  const response = await companionFetch(url, token, "/api/config");
  assert.equal(response.status, 200);
  const body = await response.json() as { config: { workspacePath: string; locale: string }; paths: Record<string, string> };

  assert.equal(body.paths.dataDirectory, dataDirectory);
  assert.match(body.paths.providersFile, /providers\.json$/);
  assert.equal(body.config.locale, "zh-CN");
  // A settings payload must never become a place a credential could appear.
  // 设置响应绝不能成为凭据可能出现的地方。
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the owner can change the workspace and locale through the API", async (t) => {
  const { url, token } = await companion(t);

  const updated = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacePath: "/tmp/another-project", locale: "en" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { config: { locale: string } }).config.locale, "en");

  // The change is durable, not just echoed back.
  // 变更是持久的，而不只是被回显。
  const reread = await (await companionFetch(url, token, "/api/config")).json() as { config: { workspacePath: string; locale: string } };
  assert.equal(reread.config.workspacePath, "/tmp/another-project");
  assert.equal(reread.config.locale, "en");

  const empty = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
});

test("the owner can set and clear the Main Agent model in config.json", async (t) => {
  const { url, token } = await companion(t);

  const updated = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentModel: "anthropic/claude-sonnet-4-5" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(
    (await updated.json() as { config: { mainAgentModel?: string } }).config.mainAgentModel,
    "anthropic/claude-sonnet-4-5",
  );

  const cleared = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentModel: "  " }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { config: { mainAgentModel?: string } }).config.mainAgentModel, undefined);
});

test("a third-party agent is added, listed, and removed without touching source", async (t) => {
  const { url, token } = await companion(t);

  const before = await (await companionFetch(url, token, "/api/settings/providers")).json() as { providers: Array<{ id: string }>; userDefined: unknown[] };
  assert.equal(before.userDefined.length, 0);
  assert.ok(before.providers.some((provider) => provider.id === "claude-code"), "built-ins are listed");

  const created = await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "opencode", command: "opencode", args: ["run", "{{prompt}}"], env: ["ANTHROPIC_API_KEY"] }),
  });
  assert.equal(created.status, 200);

  const after = await (await companionFetch(url, token, "/api/settings/providers")).json() as { providers: Array<{ id: string }> };
  assert.ok(after.providers.some((provider) => provider.id === "opencode"));

  const removed = await companionFetch(url, token, "/api/settings/providers/opencode", { method: "DELETE" });
  assert.equal(removed.status, 200);
  const final = await (await companionFetch(url, token, "/api/settings/providers")).json() as { userDefined: unknown[] };
  assert.equal(final.userDefined.length, 0);
});

test("the API refuses a provider declaration that carries a credential value", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "leaky", command: "leaky", env: ["ANTHROPIC_API_KEY=sk-not-a-real-key"] }),
  });

  // Rejected at the boundary: config stores variable names, never values.
  // 在边界处拒绝：配置只存变量名，绝不存值。
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /variable names only/);

  const stored = await (await companionFetch(url, token, "/api/settings/providers")).json() as { userDefined: unknown[] };
  assert.equal(stored.userDefined.length, 0);
});

test("memory candidates can be listed and promoted through the API", async (t) => {
  // Write the proposed candidate before the server starts, so its journal
  // instance loads it from disk.
  // 在 Server 启动前写入提案候选，使其 Journal 实例从磁盘加载到它。
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-memory-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-memory-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  // Seed through the same seam the daemon uses, so the fixture lands in
  // whichever journal the server will actually read.
  // 通过 Daemon 使用的同一 seam 写入，使夹具数据落在服务端真正会读的那本 Journal 里。
  const journal = createJournalStore(dataDirectory);
  await journal.append({
    type: "evidence.recorded",
    runId: "run-1",
    payload: {
      id: "ev-1", runId: "run-1", stepId: "s1", producedBy: "worker", kind: "artifact",
      summary: "deliverable produced", createdAt: new Date().toISOString(),
    },
  });
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: {
      id: "c-1", runId: "run-1", sourceEvidenceIds: ["ev-1"],
      summary: "用户偏好：发布前必须完成风险评审", confidence: "high", status: "proposed",
      createdAt: new Date().toISOString(), type: "preference", sensitivity: "private",
    },
  });
  // Release the seeding handle before the server opens its own: the fixture is
  // written, and holding the database open would block cleanup on Windows.
  // 在服务端打开自己的句柄之前先释放播种用的句柄：夹具已写入，而押着数据库会在
  // Windows 上阻碍清理。
  (journal as { close?: () => void }).close?.();
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  const url = server.url;
  const token = server.token;

  const listed = await (await companionFetch(url, token, "/api/memory/candidates")).json() as { candidates: Array<{ id: string }> };
  assert.deepEqual(listed.candidates.map((item) => item.id), ["c-1"]);

  const promoted = await companionFetch(url, token, "/api/memory/candidates/c-1/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(promoted.status, 201);
  const body = await promoted.json() as { memory: { id: string; summary: string } };
  assert.match(body.memory.summary, /发布前必须完成风险评审/);

  const after = await (await companionFetch(url, token, "/api/memory/candidates")).json() as { candidates: unknown[] };
  assert.equal(after.candidates.length, 0);
});

test("installed agents are reported generically, including user-declared ones", async (t) => {
  const { url, token } = await companion(t);

  await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "opencode", command: "opencode-not-installed", args: ["run"] }),
  });

  const agents = await (await companionFetch(url, token, "/api/agents")).json() as { providers: Array<{ id: string; installed: boolean }> };
  const opencode = agents.providers.find((provider) => provider.id === "opencode");
  assert.ok(opencode, "a user-declared agent must appear in the agent list");
  // A missing command is reported, not thrown: the GUI stays usable.
  // 命令缺失是被报告而不是抛出：GUI 仍然可用。
  assert.equal(opencode.installed, false);
});

test("connector declarations round-trip through the API and reject credential values", async (t) => {
  const { url, token } = await companion(t);

  const empty = await (await companionFetch(url, token, "/api/connectors")).json() as { connectors: unknown[] };
  assert.deepEqual(empty.connectors, []);

  const created = await companionFetch(url, token, "/api/connectors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectors: [{ id: "local-files", enabled: true, target: "/notes" }] }),
  });
  assert.equal(created.status, 200);
  const stored = await (await companionFetch(url, token, "/api/connectors")).json() as { connectors: Array<{ id: string }> };
  assert.deepEqual(stored.connectors.map((item) => item.id), ["local-files"]);

  // The same rule as providers: a config file must never hold a credential.
  // 与 Provider 同一条规则：配置文件绝不能存放凭据。
  const leaky = await companionFetch(url, token, "/api/connectors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectors: [{ id: "leaky", enabled: true, env: ["TOKEN=sk-not-real"] }] }),
  });
  assert.equal(leaky.status, 400);
  assert.match((await leaky.json() as { error: string }).error, /variable names only/);
});

test("the situation endpoint reports what the twin knows, with no credential content", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/situation");
  assert.equal(response.status, 200);
  const body = await response.json() as { text: string; overdue: unknown[]; activeGoals: unknown[] };

  assert.equal(typeof body.text, "string");
  assert.ok(Array.isArray(body.overdue));
  assert.ok(Array.isArray(body.activeGoals));
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the streaming endpoint validates input before opening a stream", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });

  // Rejected as JSON with a status the client can still read; once the stream
  // is open a status code is no longer available to report a refusal.
  // 以 JSON 和客户端仍可读取的状态码拒绝；流一旦打开，状态码就无法再用来报告拒绝。
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match((await response.json() as { error: string }).error, /at least three characters/);
});
