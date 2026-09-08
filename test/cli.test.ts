import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/clone-ai.ts", import.meta.url));

/** Runs the CLI in a temporary clone home so tests never touch the owner's data. 在临时 clone home 中运行 CLI，测试绝不触碰所有者数据。 */
async function runCli(t: TestContext, args: string[]): Promise<{ code: number; stdout: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-cli-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-cli-ws-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, CLONE_AI_DATA_DIR: dataDirectory, CLONE_AI_WORKSPACE: workspacePath },
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

test("clone-ai --help lists the subcommands a new owner needs", async (t) => {
  const { code, stdout } = await runCli(t, ["--help"]);

  assert.equal(code, 0);
  for (const command of ["gui", "status", "workers", "install", "memory", "cases", "opportunities", "approve", "reject", "cancel", "doctor"]) {
    assert.match(stdout, new RegExp(`clone-ai ${command}`), `help must document ${command}`);
  }
});

test("clone-ai --version prints the package version", async (t) => {
  const { code, stdout } = await runCli(t, ["--version"]);

  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("clone-ai workers reports install state without touching the network", async (t) => {
  const { code, stdout } = await runCli(t, ["workers"]);

  assert.equal(code, 0);
  // Built-in recipes are always listed, installed or not.
  // 内建配方无论是否安装都会列出。
  for (const worker of ["claude-code", "codex-cli", "pi", "opencode"]) {
    assert.match(stdout, new RegExp(worker));
  }
});

test("clone-ai cases reports an empty log on a fresh home", async (t) => {
  const { code, stdout } = await runCli(t, ["cases"]);

  assert.equal(code, 0);
  assert.match(stdout, /No bad cases recorded yet/);
});

test("an empty conversation request is refused with an example", async (t) => {
  const { code, stdout } = await runCli(t, [""]);

  assert.equal(code, 1);
  assert.match(stdout, /clone-ai "/);
});
