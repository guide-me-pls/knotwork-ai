import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { MainAgentBusyError, mainAgentLockPath, withMainAgentLock } from "../src/main-agent/prompt-lock.ts";

test("a second Main Agent prompt is refused while the first still holds the lock", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-prompt-lock-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = withMainAgentLock(dataDirectory, async () => {
    await held;
    return "first";
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await withMainAgentLock(dataDirectory, async () => "second");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error: unknown) {
      assert.ok(error instanceof MainAgentBusyError);
      release();
      assert.equal(await first, "first");
      assert.equal(await withMainAgentLock(dataDirectory, async () => "after"), "after");
      return;
    }
  }
  throw new Error("the second prompt was never refused");
});

test("a lock file whose owner is gone is stolen rather than wedging the session", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-stale-lock-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "99999999\n", "utf8");

  assert.equal(await withMainAgentLock(dataDirectory, async () => "reclaimed"), "reclaimed");
});
