import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CLONE_DIRECTORY_NAME,
  defaultLegacyDirectory,
  migrateLegacyCloneHome,
  prepareCloneHome,
  resolveClonePaths,
} from "../src/config/clone-home.ts";
import { CloneConfigStore } from "../src/config/clone-config.ts";
import { writeJsonAtomic } from "../src/config/json-file.ts";
import {
  listEffectiveProviderConfigs,
  readUserProviderConfigs,
  removeUserProviderConfig,
  upsertUserProviderConfig,
} from "../src/config/provider-config-store.ts";

async function tempDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the owner's home is the default, and CLONE_HOME overrides it", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const workspace = await tempDirectory(t, "clone-ws-");

  // Data belongs to the person, not to whichever directory a command ran in.
  // 数据属于人，而不属于命令碰巧在哪个目录执行。
  const fromHome = resolveClonePaths({
    env: { HOME: home, USERPROFILE: home },
    cwd: workspace,
  });
  assert.equal(fromHome.dataDirectory, join(home, CLONE_DIRECTORY_NAME));
  assert.equal(fromHome.workspacePath, workspace);
  // Project-scoped state stays with the project.
  // 项目级状态留在项目里。
  assert.equal(fromHome.workspaceRuntimeDirectory, join(workspace, CLONE_DIRECTORY_NAME));

  const explicit = await tempDirectory(t, "clone-explicit-");
  const overridden = resolveClonePaths({
    env: { HOME: home, USERPROFILE: home, CLONE_HOME: explicit },
    cwd: workspace,
  });
  assert.equal(overridden.dataDirectory, explicit);
});

test("the legacy CLONE_AI_DATA_DIR variable still works", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const legacy = await tempDirectory(t, "clone-legacy-env-");

  const paths = resolveClonePaths({ env: { HOME: home, USERPROFILE: home, CLONE_AI_DATA_DIR: legacy } });
  assert.equal(paths.dataDirectory, legacy);
});

test("CLONE_HOME wins over the older variable when both are set", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const preferred = await tempDirectory(t, "clone-new-");
  const older = await tempDirectory(t, "clone-old-");

  const paths = resolveClonePaths({
    env: { HOME: home, USERPROFILE: home, CLONE_HOME: preferred, CLONE_AI_DATA_DIR: older },
  });
  assert.equal(paths.dataDirectory, preferred);
});

test("migration copies legacy data without overwriting what the owner already has", async (t) => {
  const legacy = await tempDirectory(t, "clone-legacy-");
  const target = await tempDirectory(t, "clone-target-");

  await writeFile(join(legacy, "memory.json"), '{"from":"legacy"}', "utf8");
  await writeFile(join(legacy, "journal.jsonl"), "legacy-event\n", "utf8");
  await mkdir(join(legacy, "outcomes"), { recursive: true });
  await writeFile(join(legacy, "outcomes", "failures.json"), '{"patterns":[]}', "utf8");
  // Already migrated once, then edited by the owner: must survive untouched.
  // 已经迁移过一次并被所有者编辑过：必须原样保留。
  await writeFile(join(target, "memory.json"), '{"from":"owner"}', "utf8");

  const first = await migrateLegacyCloneHome({ legacyDirectory: legacy, targetDirectory: target });
  assert.equal(first.copied, 2);
  assert.equal(await readFile(join(target, "memory.json"), "utf8"), '{"from":"owner"}');
  assert.equal(await readFile(join(target, "journal.jsonl"), "utf8"), "legacy-event\n");
  assert.equal(await readFile(join(target, "outcomes", "failures.json"), "utf8"), '{"patterns":[]}');

  // Re-running an interrupted upgrade must be safe and copy nothing new.
  // 重跑被中断的升级必须安全，且不再复制任何东西。
  const second = await migrateLegacyCloneHome({ legacyDirectory: legacy, targetDirectory: target });
  assert.equal(second.copied, 0);
});

test("migration is a no-op when there is no legacy directory", async (t) => {
  const target = await tempDirectory(t, "clone-target-");
  const result = await migrateLegacyCloneHome({
    legacyDirectory: join(target, "does-not-exist"),
    targetDirectory: target,
  });
  assert.equal(result.copied, 0);
});

test("preparing the home creates the runtime directories only", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const workspace = await tempDirectory(t, "clone-ws-");
  const paths = resolveClonePaths({ dataDirectory: join(home, ".clone"), workspacePath: workspace });

  await prepareCloneHome(paths);

  for (const directory of [paths.dataDirectory, paths.outcomesDirectory, paths.checkpointsDirectory, paths.workspaceRuntimeDirectory]) {
    assert.equal((await stat(directory)).isDirectory(), true, `${directory} should exist`);
  }
  // JSON files stay absent until a feature writes one.
  // JSON 文件在真正被写入前不应存在。
  await assert.rejects(readFile(paths.configFile, "utf8"));
  await assert.rejects(readFile(paths.providersFile, "utf8"));
});

test("config writes are atomic and leave no partial file behind", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const workspace = await tempDirectory(t, "clone-ws-");
  const paths = resolveClonePaths({ dataDirectory: join(home, ".clone"), workspacePath: workspace });
  const store = new CloneConfigStore(paths);

  const initial = await store.get();
  assert.equal(initial.workspacePath, workspace);

  const updated = await store.update({ workspacePath: "/somewhere/else", locale: "en" });
  assert.equal(updated.workspacePath, "/somewhere/else");
  assert.equal(updated.locale, "en");
  assert.equal(updated.mainAgentModel, undefined);

  const withModel = await store.update({ mainAgentModel: "anthropic/claude-sonnet-4-5" });
  assert.equal(withModel.mainAgentModel, "anthropic/claude-sonnet-4-5");
  const reloaded = await store.get();
  assert.deepEqual(reloaded, withModel);
  const raw = JSON.parse(await readFile(paths.configFile, "utf8")) as { version: number };
  assert.equal(raw.version, 1);
});

test("CLONE_AI_MAIN_MODEL overrides config.json for the Main Agent model", async (t) => {
  const home = await tempDirectory(t, "clone-home-");
  const workspace = await tempDirectory(t, "clone-ws-");
  const paths = resolveClonePaths({ dataDirectory: join(home, ".clone"), workspacePath: workspace });
  await new CloneConfigStore(paths).update({ mainAgentModel: "from-config" });
  const { readMainAgentModelPreference } = await import("../src/main-agent/session.ts");
  assert.equal(await readMainAgentModelPreference(paths.dataDirectory, {}), "from-config");
  assert.equal(
    await readMainAgentModelPreference(paths.dataDirectory, { CLONE_AI_MAIN_MODEL: "from-env" }),
    "from-env",
  );
});

test("a third-party provider is stored, listed with built-ins, and removed", async (t) => {
  const dataDirectory = await tempDirectory(t, "clone-providers-");

  assert.deepEqual(await readUserProviderConfigs(dataDirectory), []);

  // Integrating a new agent is a config edit; no source change is involved.
  // 接入新 Agent 是改配置，不涉及任何源码改动。
  await upsertUserProviderConfig(dataDirectory, {
    id: "opencode",
    command: "opencode",
    args: ["run", "{{prompt}}"],
    env: ["ANTHROPIC_API_KEY"],
  });

  const effective = await listEffectiveProviderConfigs(dataDirectory);
  assert.ok(effective.some((provider) => provider.id === "opencode"));
  assert.ok(effective.some((provider) => provider.id === "claude-code"), "built-ins remain available");

  await removeUserProviderConfig(dataDirectory, "opencode");
  assert.deepEqual(await readUserProviderConfigs(dataDirectory), []);
});

test("a provider declaration may name environment variables but never hold a value", async (t) => {
  const dataDirectory = await tempDirectory(t, "clone-providers-");

  // The whole point of storing names only: a config file must never become a
  // place where a credential can sit.
  // 只存变量名的意义所在：配置文件绝不能变成凭据的存放处。
  await assert.rejects(
    upsertUserProviderConfig(dataDirectory, {
      id: "leaky",
      command: "leaky",
      env: ["ANTHROPIC_API_KEY=sk-not-a-real-key"],
    }),
    /env must contain variable names only/,
  );

  await assert.rejects(
    upsertUserProviderConfig(dataDirectory, { id: "bad id!", command: "x" }),
    /needs a valid id/,
  );
  await assert.rejects(
    upsertUserProviderConfig(dataDirectory, { id: "nocommand", command: "  " }),
    /needs a non-empty command/,
  );
});

test("a malformed providers file is reported instead of silently ignored", async (t) => {
  const dataDirectory = await tempDirectory(t, "clone-providers-");
  await writeJsonAtomic(join(dataDirectory, "providers.json"), { providers: [{ id: "dup", command: "a" }, { id: "dup", command: "b" }] });

  await assert.rejects(readUserProviderConfigs(dataDirectory), /declared more than once/);
});
