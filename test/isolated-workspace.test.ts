import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  applyIsolatedArtifacts,
  matchesNamedFile,
  prepareIsolatedWorkspace,
  requiresIsolatedWorkspace,
  type GitRunner,
} from "../src/core/isolated-workspace.ts";

const execFileAsync = promisify(execFile);

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("only external and irreversible steps require an isolated workspace", () => {
  assert.equal(requiresIsolatedWorkspace("read_only"), false);
  assert.equal(requiresIsolatedWorkspace("reversible_write"), false);
  assert.equal(requiresIsolatedWorkspace("external_side_effect"), true);
  assert.equal(requiresIsolatedWorkspace("irreversible"), true);
});

test("a non-git project is copied, and writes there leave the owner's files alone", async (t) => {
  const owner = await tempDir(t, "clone-iso-owner-");
  const sandboxRoot = await tempDir(t, "clone-iso-box-");
  await writeFile(join(owner, "secret.md"), "owner-only\n", "utf8");
  await mkdir(join(owner, "node_modules"), { recursive: true });
  await writeFile(join(owner, "node_modules", "pkg.js"), "ignored\n", "utf8");

  const isolated = await prepareIsolatedWorkspace({
    ownerPath: owner,
    sandboxRoot,
    key: "run-1/send",
    git: async () => ({ code: 1, stdout: "", stderr: "not a git repo" }),
  });
  t.after(() => isolated.dispose());

  assert.equal(isolated.kind, "directory_copy");
  assert.notEqual(isolated.path, owner);
  assert.equal(await readFile(join(isolated.path, "secret.md"), "utf8"), "owner-only\n");
  await assert.rejects(access(join(isolated.path, "node_modules")), /ENOENT/);

  await writeFile(join(isolated.path, "poison.md"), "worker wrote this\n", "utf8");
  await assert.rejects(access(join(owner, "poison.md")), /ENOENT/);
  assert.equal(await readFile(join(owner, "secret.md"), "utf8"), "owner-only\n");

  await isolated.dispose();
  await assert.rejects(access(isolated.path), /ENOENT/);
});

test("an isolated workspace cannot be created inside the owner's live project", async (t) => {
  const owner = await tempDir(t, "clone-iso-inside-");
  await assert.rejects(
    prepareIsolatedWorkspace({ ownerPath: owner, sandboxRoot: join(owner, "nested"), key: "step" }),
    /cannot be created inside/,
  );
});

test("a git project uses a detached worktree when git is available", async (t) => {
  const owner = await tempDir(t, "clone-iso-git-");
  const sandboxRoot = await tempDir(t, "clone-iso-git-box-");
  await writeFile(join(owner, "tracked.md"), "committed\n", "utf8");
  const gitOk = await initGitRepo(owner);
  if (!gitOk) {
    t.skip("git is not available");
    return;
  }
  await writeFile(join(owner, "dirty.md"), "uncommitted\n", "utf8");

  const isolated = await prepareIsolatedWorkspace({
    ownerPath: owner,
    sandboxRoot,
    key: "worktree-step",
  });
  t.after(() => isolated.dispose());

  assert.equal(isolated.kind, "git_worktree");
  assert.equal(await readFile(join(isolated.path, "tracked.md"), "utf8"), "committed\n");
  await assert.rejects(access(join(isolated.path, "dirty.md")), /ENOENT/);
  await writeFile(join(isolated.path, "poison.md"), "from worktree\n", "utf8");
  await assert.rejects(access(join(owner, "poison.md")), /ENOENT/);
});

test("a failing worktree falls back to a directory copy", async (t) => {
  const owner = await tempDir(t, "clone-iso-fallback-");
  const sandboxRoot = await tempDir(t, "clone-iso-fallback-box-");
  await writeFile(join(owner, "note.md"), "hello\n", "utf8");
  const git: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: `${owner}\n`, stderr: "" };
    }
    return { code: 128, stdout: "", stderr: "worktree add failed" };
  };

  const isolated = await prepareIsolatedWorkspace({
    ownerPath: owner,
    sandboxRoot,
    key: "fallback",
    git,
  });
  t.after(() => isolated.dispose());
  assert.equal(isolated.kind, "directory_copy");
  assert.equal(await readFile(join(isolated.path, "note.md"), "utf8"), "hello\n");
});

test("named isolated files copy into the owner tree; unnamed writes stay behind", async (t) => {
  const owner = await tempDir(t, "clone-iso-apply-owner-");
  const isolated = await tempDir(t, "clone-iso-apply-box-");
  await writeFile(join(owner, "keep.md"), "owner\n", "utf8");
  await writeFile(join(isolated, "keep.md"), "owner\n", "utf8");
  await writeFile(join(isolated, "receipt.md"), "delivered\n", "utf8");
  await writeFile(join(isolated, "poison.md"), "do not merge\n", "utf8");

  const result = await applyIsolatedArtifacts({
    isolatedPath: isolated,
    ownerPath: owner,
    namedFiles: ["receipt.md"],
  });

  assert.deepEqual(result.copied, ["receipt.md"]);
  assert.equal(result.leftover.includes("poison.md"), true);
  assert.equal(result.sandboxRetained, true);
  assert.equal(await readFile(join(owner, "receipt.md"), "utf8"), "delivered\n");
  await assert.rejects(access(join(owner, "poison.md")), /ENOENT/);
  assert.equal(await readFile(join(owner, "keep.md"), "utf8"), "owner\n");
});

test("an existing owner file is not overwritten by isolated apply", async (t) => {
  const owner = await tempDir(t, "clone-iso-conflict-owner-");
  const isolated = await tempDir(t, "clone-iso-conflict-box-");
  await writeFile(join(owner, "receipt.md"), "live\n", "utf8");
  await writeFile(join(isolated, "receipt.md"), "isolated\n", "utf8");

  const result = await applyIsolatedArtifacts({
    isolatedPath: isolated,
    ownerPath: owner,
    namedFiles: ["receipt.md"],
  });

  assert.equal(result.copied.length, 0);
  assert.equal(result.skipped[0]?.reason, "owner already has a different file at this path");
  assert.equal(result.sandboxRetained, true);
  assert.equal(await readFile(join(owner, "receipt.md"), "utf8"), "live\n");
});

test("matchesNamedFile accepts a nested path ending at the named file", () => {
  assert.equal(matchesNamedFile("out/receipt.md", "receipt.md"), true);
  assert.equal(matchesNamedFile("poison.md", "receipt.md"), false);
});

async function initGitRepo(directory: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["init"], { cwd: directory });
    await execFileAsync("git", ["config", "user.email", "clone-ai-test@example.com"], { cwd: directory });
    await execFileAsync("git", ["config", "user.name", "clone-ai-test"], { cwd: directory });
    await execFileAsync("git", ["add", "."], { cwd: directory });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: directory });
    return true;
  } catch {
    return false;
  }
}
