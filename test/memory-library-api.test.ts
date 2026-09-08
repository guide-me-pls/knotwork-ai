/**
 * The memory library as the owner experiences it: a folder of .md files that
 * the GUI and a text editor can both write to.
 *
 * The property under test is that neither one wins. A memory edited in the GUI
 * must land in the file, and a memory edited in the file must reach the index
 * without the owner having to know an index exists — otherwise "your memory,
 * your files" is only true until the two disagree.
 *
 * 所有者所体验到的记忆库：一个 GUI 与文本编辑器都能写的 .md 文件夹。
 *
 * 被测的性质是两者都不会压倒对方。在 GUI 里改的记忆必须落到文件里；在文件里改的记忆
 * 必须进入索引，而所有者无需知道索引的存在——否则"记忆是你的、文件是你的"这句话
 * 只在两者不冲突之前成立。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { companionFetch } from "./helpers/companion-api.ts";

interface LibraryMemory {
  id: string;
  summary: string;
  content: string;
  type: string;
  status: string;
  sensitivity: string;
  confidence: string;
}

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-library-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-library-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

async function library(url: string, token: string): Promise<{ memories: LibraryMemory[]; stats: { active: number; archived: number; contentDirectory: string } }> {
  const response = await companionFetch(url, token, "/api/memory/governed");
  assert.equal(response.status, 200);
  return await response.json() as never;
}

test("a memory written in the GUI becomes a file the owner can open", async (t) => {
  const { url, token } = await companion(t);

  const created = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      summary: "发布前必须完成风险评审",
      content: "任何对外发布都要先过一次风险评审。\n例外：纯文档改动。",
      type: "preference",
      sensitivity: "private",
    }),
  });
  assert.equal(created.status, 201);
  const { memory } = await created.json() as { memory: LibraryMemory };

  const view = await library(url, token);
  const stored = view.memories.find((item) => item.id === memory.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.type, "preference");
  // Owner-authored memory is the owner speaking, not an inference about them.
  // 所有者手写的记忆是所有者本人在说话，而不是对他的推断。
  assert.equal(stored.confidence, "high");

  const file = await readFile(join(view.stats.contentDirectory, `${memory.id}.md`), "utf8");
  assert.match(file, /发布前必须完成风险评审/);
  assert.match(file, /例外：纯文档改动/);
  assert.match(file, /^---\n/, "the file must carry front matter the owner can read and edit");
});

test("an edit made in the GUI rewrites the file", async (t) => {
  const { url, token } = await companion(t);
  const created = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "初始摘要内容", content: "初始正文" }),
  });
  const { memory } = await created.json() as { memory: LibraryMemory };

  const patched = await companionFetch(url, token, `/api/memory/governed/${memory.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "修正后的摘要", content: "修正后的正文", type: "decision" }),
  });
  assert.equal(patched.status, 200);

  const view = await library(url, token);
  const file = await readFile(join(view.stats.contentDirectory, `${memory.id}.md`), "utf8");
  assert.match(file, /修正后的正文/);
  assert.doesNotMatch(file, /初始正文/);
  assert.match(file, /type: decision/);
});

test("a memory hand-edited on disk reaches the index without a GUI action", async (t) => {
  const { url, token } = await companion(t);
  const created = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "会被手动改掉的摘要", content: "旧正文" }),
  });
  const { memory } = await created.json() as { memory: LibraryMemory };
  const { stats } = await library(url, token);
  const path = join(stats.contentDirectory, `${memory.id}.md`);

  // The owner opens the file in an editor, as they are invited to.
  // 所有者按邀请在编辑器里打开文件。
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace("会被手动改掉的摘要", "在编辑器里改过的摘要").replace("旧正文", "新正文"), "utf8");

  const reread = await library(url, token);
  const synced = reread.memories.find((item) => item.id === memory.id);
  assert.equal(synced?.summary, "在编辑器里改过的摘要");
  assert.equal(synced?.content, "新正文");
});

test("archiving moves the file out of the active folder and restoring brings it back", async (t) => {
  const { url, token } = await companion(t);
  const created = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "不再适用的偏好设置" }),
  });
  const { memory } = await created.json() as { memory: LibraryMemory };
  const { stats } = await library(url, token);

  await companionFetch(url, token, `/api/memory/governed/${memory.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  assert.deepEqual(await readdir(stats.contentDirectory).then((names) => names.filter((name) => name.endsWith(".md"))), []);
  assert.ok((await readdir(join(stats.contentDirectory, "archived"))).includes(`${memory.id}.md`));
  assert.equal((await library(url, token)).stats.archived, 1);

  await companionFetch(url, token, `/api/memory/governed/${memory.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  const restored = await library(url, token);
  assert.equal(restored.stats.active, 1);
  assert.equal(restored.memories.find((item) => item.id === memory.id)?.status, "active");
});

test("every governance decision is journaled, including the owner's own writing", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const created = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "需要被审计到的记忆" }),
  });
  const { memory } = await created.json() as { memory: LibraryMemory };
  await companionFetch(url, token, `/api/memory/governed/${memory.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "改过一次", status: "archived" }),
  });

  const { createJournalStore } = await import("../src/core/sqlite-journal.ts");
  const journal = createJournalStore(dataDirectory);
  const events = await journal.list();
  (journal as { close?: () => void }).close?.();
  const types = events.map((event) => event.type);
  assert.ok(types.includes("memory.authored"), "the owner writing a memory must be journaled");
  assert.ok(types.includes("memory.updated"), "an edit must be journaled");
  // An archive carries its own reason; folding it into the edit would lose why
  // the memory went out of use. 归档带着自己的原因入账；并进编辑就会丢掉"为什么不再使用"。
  assert.ok(types.includes("memory.archived"), "an archive must be journaled separately");
});

test("a memory rejected for being too short never reaches the folder", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/memory/governed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "短" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await library(url, token)).memories.length, 0);
});
