import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { JsonWorkspaceCheckpointStore, snapshotWorkspace } from "../src/core/workspace-evidence.ts";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a checkpoint with file copies can restore a deleted workspace file", async (t) => {
  const workspace = await tempDir(t, "clone-ai-ckpt-ws-");
  const storeDir = await tempDir(t, "clone-ai-ckpt-store-");
  await mkdir(join(workspace, "out"), { recursive: true });
  await writeFile(join(workspace, "out", "note.md"), "baseline\n", "utf8");
  const store = new JsonWorkspaceCheckpointStore(storeDir);
  const locator = await store.save("run-1/order-1/attempt-1", await snapshotWorkspace(workspace));

  await rm(join(workspace, "out", "note.md"));
  const restored = await store.restore(locator, workspace);
  assert.ok(restored);
  assert.ok(restored.restored.includes("out/note.md"));
  assert.equal(await readFile(join(workspace, "out", "note.md"), "utf8"), "baseline\n");
});

test("a hash-only checkpoint refuses to invent file contents", async (t) => {
  const workspace = await tempDir(t, "clone-ai-ckpt-hash-ws-");
  const storeDir = await tempDir(t, "clone-ai-ckpt-hash-store-");
  await writeFile(join(workspace, "keep.md"), "hello\n", "utf8");
  const store = new JsonWorkspaceCheckpointStore(storeDir);
  const snapshot = await snapshotWorkspace(workspace);
  snapshot.root = undefined;
  const locator = await store.save("hash-only", snapshot);
  await rm(join(workspace, "keep.md"));
  const restored = await store.restore(locator, workspace);
  assert.ok(restored);
  assert.equal(restored.restored.length, 0);
  assert.match(restored.skippedReason ?? "", /hash-only/);
});
