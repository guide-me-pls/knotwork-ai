import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import type { ClonePaths } from "./clone-home.ts";

export interface CloneConfig {
  version: 1;
  workspacePath: string;
  locale: "zh-CN" | "en";
  /**
   * Pi model reference for the Main Agent, e.g. `anthropic/claude-sonnet-4-5`.
   * When omitted, the Pi SDK default (settings / first available) is used.
   * `CLONE_AI_MAIN_MODEL` overrides this for one-off runs.
   * 主 Agent 的 Pi 模型引用，例如 `anthropic/claude-sonnet-4-5`。省略时使用 Pi SDK
   * 默认（设置 / 第一个可用模型）。`CLONE_AI_MAIN_MODEL` 可覆盖本次运行。
   */
  mainAgentModel?: string;
}

export class CloneConfigStore {
  readonly #paths: ClonePaths;
  readonly #defaultWorkspace: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(paths: ClonePaths) {
    this.#paths = paths;
    this.#defaultWorkspace = paths.workspacePath;
  }

  async get(): Promise<CloneConfig> {
    const value = await readJsonFile<Partial<CloneConfig>>(this.#paths.configFile);
    return normalizeConfig(value, this.#defaultWorkspace);
  }

  async update(update: Partial<Pick<CloneConfig, "workspacePath" | "locale" | "mainAgentModel">>): Promise<CloneConfig> {
    const current = await this.get();
    const next = normalizeConfig({ ...current, ...update }, this.#defaultWorkspace);
    const write = this.#writes.then(() => writeJsonAtomic(this.#paths.configFile, next));
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
    return next;
  }
}

function normalizeConfig(value: Partial<CloneConfig> | undefined, defaultWorkspace: string): CloneConfig {
  const mainAgentModel = typeof value?.mainAgentModel === "string" && value.mainAgentModel.trim().length > 0
    ? value.mainAgentModel.trim()
    : undefined;
  return {
    version: 1,
    workspacePath: typeof value?.workspacePath === "string" && value.workspacePath.trim().length > 0
      ? value.workspacePath
      : defaultWorkspace,
    locale: value?.locale === "en" ? "en" : "zh-CN",
    ...(mainAgentModel === undefined ? {} : { mainAgentModel }),
  };
}
