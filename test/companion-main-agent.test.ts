import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";
import { companionFetch } from "./helpers/companion-api.ts";

// The conversation-driven entry exists and validates input without touching a
// model; the full chain is covered by the gated live acceptance test.
// 对话驱动入口存在且不触碰模型就校验输入；完整链路由门控的真实验收测试覆盖。
test("the companion main-agent route rejects an empty request before any model call", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-"));
  const server = await startCompanionServer({ port: 0, dataDirectory });
  // after-hooks run in registration order, so the server (and the SQLite
  // handle it owns) must be closed before the directory is removed; on Windows
  // an open handle makes the unlink fail with EBUSY.
  // after 钩子按注册顺序执行，因此必须先关闭 Server（及其持有的 SQLite 句柄）再删目录；
  // Windows 上未关闭的句柄会让 unlink 以 EBUSY 失败。
  t.after(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const rejected = await companionFetch(server.url, server.token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });
  assert.equal(rejected.status, 400);
  const body = await rejected.json() as { error?: string };
  assert.match(body.error ?? "", /at least three characters/);
});
