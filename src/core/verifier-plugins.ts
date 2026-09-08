import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { Evidence, PlanStep, Verifier, VerificationResult } from "./contracts.ts";

/**
 * A Verifier that only speaks when the step asked for something it can check.
 * Steps that mention neither tests nor diffs return an empty pass so a
 * CompositeVerifier can keep the Kernel's file/receipt checks in charge.
 * 只在步骤点名了它能检查的东西时才发言的 Verifier。既不提测试也不提 diff 的步骤
 * 返回空通过，好让 CompositeVerifier 继续把关 Kernel 的文件 / Receipt 检查。
 */
export function silentPass(runId: string): VerificationResult {
  return {
    runId,
    passed: true,
    summary: "",
    checkedEvidenceIds: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Runs a named test command in the owner's workspace when the plan asked for
 * it. The command is taken from the step, never invented. Recursion into this
 * repo's own `npm test` only happens if a plan targeting this workspace says
 * so — production workspaces are the owner's.
 * 当计划要求时，在所有者的 Workspace 里跑具名测试命令。命令来自步骤，绝不编造。
 * 只有当一份针对本仓库的计划这么写时，才会递归进本仓库自己的 `npm test`——生产
 * Workspace 是所有者的。
 */
export class TestCommandVerifier implements Verifier {
  readonly #workspacePath?: string;
  readonly #timeoutMs: number;
  readonly #runner: typeof runProcess;

  constructor(options: { workspacePath?: string; timeoutMs?: number; runner?: typeof runProcess } = {}) {
    this.#workspacePath = options.workspacePath;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#runner = options.runner ?? runProcess;
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const failures: string[] = [];
    const checked: string[] = [];
    for (const step of input.plan.steps) {
      const command = extractTestCommand(step);
      if (command !== undefined) {
        if (this.#workspacePath === undefined) {
          failures.push(`${step.title}: named a test command but no workspace is configured`);
          continue;
        }
        const result = await this.#runner(command, this.#workspacePath, this.#timeoutMs);
        if (result.code !== 0) {
          failures.push(`${step.title}: \`${command.join(" ")}\` exited ${result.code}`);
        }
        continue;
      }
      if (!mentionsTests(step)) continue;
      const testEvidence = input.evidence.filter((item) => item.stepId === step.id && item.kind === "test");
      const withLocator = testEvidence.find((item) => item.locator !== undefined);
      if (withLocator?.locator === undefined) {
        failures.push(`${step.title}: a test step needs test evidence with a locator`);
        continue;
      }
      checked.push(withLocator.id);
      const problem = await this.readTestOutput(withLocator);
      if (problem !== undefined) failures.push(`${step.title}: ${problem}`);
    }
    if (failures.length === 0 && checked.length === 0 && !input.plan.steps.some((step) => extractTestCommand(step) !== undefined || mentionsTests(step))) {
      return silentPass(input.run.id);
    }
    const passed = failures.length === 0;
    return {
      runId: input.run.id,
      passed,
      summary: passed ? "Test contract checked." : `Test verification failed. ${failures.join("; ")}.`,
      checkedEvidenceIds: checked,
      createdAt: new Date().toISOString(),
    };
  }

  private async readTestOutput(evidence: Evidence): Promise<string | undefined> {
    const locator = evidence.locator;
    if (locator === undefined) return "test evidence has no locator";
    const path = resolveLocator(locator, this.#workspacePath);
    if (path === undefined) return `"${locator}" could not be resolved`;
    let contents: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) return `"${locator}" is not a file`;
      contents = await readFile(path, "utf8");
    } catch {
      return `"${locator}" does not exist on disk`;
    }
    if (contents.trim().length === 0) return `"${locator}" is empty`;
    if (/\b(fail(ed|ing|ures?)|error)\b/i.test(contents) && !/\b0 failed\b/i.test(contents)) {
      return `"${locator}" reports failing tests`;
    }
    return undefined;
  }
}

/**
 * Reads a unified diff the plan promised, instead of trusting a worker's
 * "looks good" sentence.
 * 去读计划承诺过的 unified diff，而不是相信 Worker 一句“看起来没问题”。
 */
export class DiffFileVerifier implements Verifier {
  readonly #workspacePath?: string;

  constructor(options: { workspacePath?: string } = {}) {
    this.#workspacePath = options.workspacePath;
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const failures: string[] = [];
    const checked: string[] = [];
    let relevant = false;
    for (const step of input.plan.steps) {
      if (!mentionsDiff(step)) continue;
      relevant = true;
      const candidates = input.evidence.filter((item) => item.stepId === step.id && item.locator !== undefined);
      const diffEvidence = candidates.find((item) => looksLikeDiffLocator(item.locator ?? ""));
      if (diffEvidence?.locator === undefined) {
        failures.push(`${step.title}: a diff review needs a .diff / .patch locator`);
        continue;
      }
      checked.push(diffEvidence.id);
      const path = resolveLocator(diffEvidence.locator, this.#workspacePath);
      if (path === undefined) {
        failures.push(`${step.title}: "${diffEvidence.locator}" could not be resolved`);
        continue;
      }
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch {
        failures.push(`${step.title}: "${diffEvidence.locator}" does not exist on disk`);
        continue;
      }
      if (contents.trim().length === 0) {
        failures.push(`${step.title}: "${diffEvidence.locator}" is empty`);
        continue;
      }
      if (!/^(diff --git |--- |\+\+\+ )/m.test(contents)) {
        failures.push(`${step.title}: "${diffEvidence.locator}" is not a unified diff`);
      }
    }
    if (!relevant) return silentPass(input.run.id);
    const passed = failures.length === 0;
    return {
      runId: input.run.id,
      passed,
      summary: passed ? "Diff contract checked." : `Diff verification failed. ${failures.join("; ")}.`,
      checkedEvidenceIds: checked,
      createdAt: new Date().toISOString(),
    };
  }
}

export function extractTestCommand(step: PlanStep): string[] | undefined {
  const text = [step.instructions, ...step.acceptanceCriteria].join("\n");
  const explicit = text.match(/test command:\s*`([^`]+)`/i) ?? text.match(/test command:\s*([^\n]+)/i);
  if (explicit?.[1] !== undefined) {
    const args = splitArgs(explicit[1]);
    return args.length === 0 ? undefined : args;
  }
  if (/\bnpm test\b/.test(text)) return ["npm", "test"];
  if (/\bpytest\b/.test(text)) return ["pytest"];
  if (/\bcargo test\b/.test(text)) return ["cargo", "test"];
  if (/\bgo test\b/.test(text)) return ["go", "test"];
  return undefined;
}

export function mentionsTests(step: PlanStep): boolean {
  const text = [step.instructions, ...step.acceptanceCriteria].join("\n");
  return /(?:\btests?\b|跑测试|运行测试|单元测试)/i.test(text);
}

export function mentionsDiff(step: PlanStep): boolean {
  const text = [step.instructions, ...step.acceptanceCriteria].join("\n");
  return /(?:\bdiff\b|\.patch\b|unified diff|差异|补丁)/i.test(text);
}

function looksLikeDiffLocator(locator: string): boolean {
  return /\.(diff|patch)$/i.test(locator) || /diff/i.test(locator);
}

function splitArgs(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

function resolveLocator(locator: string, workspacePath: string | undefined): string | undefined {
  const cleaned = locator.replace(/^file:\/\//, "");
  if (isAbsolute(cleaned)) return cleaned;
  if (workspacePath === undefined) return undefined;
  return resolve(workspacePath, cleaned);
}

export async function runProcess(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  const [bin, ...args] = command;
  if (bin === undefined) return { code: 1, output: "empty command" };
  return await new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}
