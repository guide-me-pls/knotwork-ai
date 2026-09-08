import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { logJson } from "../src/observability/json-log.ts";
import { summarizeRuns } from "../src/observability/run-metrics.ts";
import { collectSessionUsage, recordUsage } from "../src/observability/usage.ts";
import type { Run } from "../src/core/contracts.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-obs-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("JSON logs are one object per stderr line", () => {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encoding === "function") encoding(null);
    callback?.(null);
    return true;
  }) as typeof process.stderr.write;
  try {
    logJson("error", "Run failed", { runId: "run-1" });
  } finally {
    process.stderr.write = original;
  }
  const line = chunks.join("").trim();
  const parsed = JSON.parse(line) as { level: string; msg: string; runId: string; ts: string };
  assert.equal(parsed.level, "error");
  assert.equal(parsed.msg, "Run failed");
  assert.equal(parsed.runId, "run-1");
  assert.equal(typeof parsed.ts, "string");
});

test("run metrics count status and mean terminal duration", () => {
  const runs: Run[] = [
    { id: "a", taskId: "t", status: "completed", createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:00:02.000Z" },
    { id: "b", taskId: "t", status: "failed", createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:00:04.000Z" },
    { id: "c", taskId: "t", status: "queued", createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:00:00.000Z" },
  ];
  const metrics = summarizeRuns(runs);
  assert.equal(metrics.byStatus.completed, 1);
  assert.equal(metrics.byStatus.failed, 1);
  assert.equal(metrics.byStatus.queued, 1);
  assert.equal(metrics.terminalCount, 2);
  assert.equal(metrics.averageDurationMs, 3_000);
});

test("usage records duration and optional token delta", async (t) => {
  const dataDirectory = await tempDir(t);
  const session = {
    model: { id: "test-model", provider: "test" },
    getSessionStats: () => ({ tokens: { input: 10, output: 4, total: 14 }, cost: 0.02 }),
  };
  const before = { tokens: { input: 2, output: 1, total: 3 }, cost: 0.01 };
  const record = collectSessionUsage(session, 1500, before);
  assert.equal(record.source, "main-agent");
  assert.equal(record.modelId, "test-model");
  assert.equal(record.provider, "test");
  assert.equal(record.durationMs, 1500);
  assert.equal(record.inputTokens, 8);
  assert.equal(record.outputTokens, 3);
  assert.equal(record.totalTokens, 11);
  assert.equal(record.costUsd, 0.01);

  await recordUsage(dataDirectory, record);
  const journal = createJournalStore(dataDirectory);
  t.after(() => (journal as { close?: () => void }).close?.());
  const events = await journal.list();
  assert.equal(events.at(-1)?.type, "usage.recorded");
  assert.equal((events.at(-1)?.payload as { modelId?: string }).modelId, "test-model");
});
