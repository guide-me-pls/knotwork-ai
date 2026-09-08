import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { mainAgentLockPath } from "../src/main-agent/prompt-lock.ts";
import { companionFetch } from "./helpers/companion-api.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-control-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-control-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

test("health is public; approve without a bearer is 401", async (t) => {
  const { url, token } = await companion(t);

  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  const body = await health.json() as { ok: boolean; journal: string; queue: { inFlight: number } };
  assert.equal(body.ok, true);
  assert.equal(body.journal, "ok");
  assert.equal(typeof body.queue.inFlight, "number");

  const unauthenticated = await fetch(`${url}/api/runs/missing/approve`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`CLONE_AI_TOKEN="${token}"`));
});

test("a non-loopback Origin is refused even with a valid bearer", async (t) => {
  const { url, token } = await companion(t);
  const response = await fetch(`${url}/api/config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://example.com",
    },
  });
  assert.equal(response.status, 403);
});

test("a second Main Agent query is 409 while the session lock is held", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${process.pid}\n`, "utf8");

  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello there" }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /already answering/);
});

test("reject and cancel of an unknown run fail closed", async (t) => {
  const { url, token } = await companion(t);
  const rejected = await companionFetch(url, token, "/api/runs/missing/reject", { method: "POST" });
  assert.equal(rejected.status, 404);
  assert.match((await rejected.json() as { error: string }).error, /Unknown run/);

  const cancelled = await companionFetch(url, token, "/api/runs/missing/cancel", { method: "POST" });
  assert.equal(cancelled.status, 404);
  assert.match((await cancelled.json() as { error: string }).error, /Unknown run/);
});
