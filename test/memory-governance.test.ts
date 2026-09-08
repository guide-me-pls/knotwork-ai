import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MemoryGovernance } from "../src/memory/memory-governance.ts";
import { MdMemoryStore } from "../src/memory/md-memory-store.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import type { Evidence, MemoryCandidate } from "../src/core/contracts.ts";

async function setup(t: TestContext): Promise<{ governance: MemoryGovernance; store: MdMemoryStore; journal: JsonlJournalStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-governance-"));
  const store = new MdMemoryStore({ dataDirectory: directory });
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const governance = new MemoryGovernance({ journal, store });
  return { governance, store, journal, directory };
}

function candidate(id: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id,
    runId: "run-1",
    sourceEvidenceIds: ["ev-1"],
    summary: "用户偏好：发布前必须完成风险评审",
    confidence: "high",
    status: "proposed",
    createdAt: new Date().toISOString(),
    type: "preference",
    sensitivity: "private",
    ...overrides,
  };
}

async function journalEvidence(journal: JsonlJournalStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await journal.append({
      type: "evidence.recorded",
      runId: "run-1",
      payload: {
        id,
        runId: "run-1",
        stepId: "s1",
        producedBy: "worker",
        kind: "artifact",
        summary: `Evidence ${id}`,
        createdAt: new Date().toISOString(),
      } satisfies Evidence,
    });
  }
}

test("pendingCandidates lists proposed candidates until they are decided", async (t) => {
  const { governance, journal } = await setup(t);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-2") });

  assert.deepEqual((await governance.pendingCandidates()).map((item) => item.id).sort(), ["c-1", "c-2"]);

  await governance.reject("c-2", "not durable");
  assert.deepEqual((await governance.pendingCandidates()).map((item) => item.id), ["c-1"]);
});

test("promote writes the markdown file, the sqlite row, and the journal event", async (t) => {
  const { governance, store, journal, directory } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const pending = await governance.pendingCandidates();
  assert.equal(pending.length, 1);

  const entry = await governance.promote(pending[0]!);

  assert.equal(entry.type, "preference");
  assert.deepEqual(entry.sourceEvidenceIds, ["ev-1"]);
  assert.equal((await governance.pendingCandidates()).length, 0);
  const events = await journal.list();
  const promoted = events.find((event) => event.type === "memory.candidate.promoted");
  assert.equal((promoted?.payload as { candidateId?: string }).candidateId, "c-1");
  assert.equal((promoted?.payload as { memoryId?: string }).memoryId, entry.id);
  // The content file exists and is readable.
  // 正文文件真实存在且可读。
  const file = await import("node:fs/promises").then((fs) => fs.readFile(join(directory, "memory", `${entry.id}.md`), "utf8"));
  assert.match(file, /发布前必须完成风险评审/);
});

test("promote refuses a candidate that matches an active memory", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1", "ev-2"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  await governance.promote((await governance.pendingCandidates())[0]!);
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: candidate("c-dup", { sourceEvidenceIds: ["ev-2"], summary: "用户偏好：发布前必须完成风险评审" }),
  });

  await assert.rejects(
    governance.promote((await governance.pendingCandidates())[0]!),
    /matches an existing memory/,
  );
});

test("promote redacts PII and stores the memory as secret", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: candidate("c-pii", {
      summary: "联系人是 owner@example.com，发布前必须完成风险评审",
      sensitivity: "public",
    }),
  });

  const entry = await governance.promote((await governance.pendingCandidates())[0]!);
  assert.equal(entry.sensitivity, "secret");
  assert.match(entry.summary, /\[redacted email\]/);
  assert.doesNotMatch(entry.summary, /owner@example.com/);
  const promoted = (await journal.list()).find((event) => event.type === "memory.candidate.promoted");
  assert.deepEqual((promoted?.payload as { piiRedacted?: string[] }).piiRedacted, ["email"]);
});

test("promote refuses a candidate citing evidence that does not exist", async (t) => {
  const { governance, journal } = await setup(t);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1", { sourceEvidenceIds: ["ghost"] }) });

  await assert.rejects(
    governance.promote((await governance.pendingCandidates())[0]!),
    /evidence that does not exist/,
  );
  assert.equal((await governance.pendingCandidates()).length, 1);
});

test("update and archive journal their decisions", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const entry = await governance.promote((await governance.pendingCandidates())[0]!);

  await governance.update(entry.id, { summary: "修正后的偏好" });
  await governance.archive(entry.id, "manual");

  const events = await journal.list();
  const updated = events.find((event) => event.type === "memory.updated");
  assert.equal((updated?.payload as { memoryId?: string }).memoryId, entry.id);
  assert.deepEqual((updated?.payload as { fields?: string[] }).fields, ["summary"]);
  const archived = events.find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "manual");
  assert.equal((await governance.list({ status: "archived" }))[0]?.id, entry.id);
});

test("expireDue archives expired memories with the expired reason", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1", { expiresAt: "2020-01-01T00:00:00.000Z" }) });
  const entry = await governance.promote((await governance.pendingCandidates())[0]!);

  assert.deepEqual(await governance.expireDue(), [entry.id]);
  const archived = (await journal.list()).find((event) => event.type === "memory.archived");
  assert.equal((archived?.payload as { reason?: string }).reason, "expired");
});

test("stats reports active, archived, and pending counts", async (t) => {
  const { governance, journal } = await setup(t);
  await journalEvidence(journal, ["ev-1"]);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-1") });
  const pending = await governance.pendingCandidates();
  await governance.promote(pending[0]!);
  await journal.append({ type: "memory.candidate.proposed", runId: "run-1", payload: candidate("c-2") });

  const stats = await governance.stats();
  // The content directory travels with the stats for the GUI; assert the counts.
  // contentDirectory 随 stats 一起提供给 GUI；这里断言计数部分。
  assert.equal(stats.active, 1);
  assert.equal(stats.archived, 0);
  assert.equal(stats.total, 1);
  assert.equal(stats.pending, 1);
});
