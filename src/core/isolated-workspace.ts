import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { RiskClass } from "./contracts.ts";
import { WORKSPACE_IGNORED_DIRECTORIES } from "./workspace-evidence.ts";

const execFileAsync = promisify(execFile);

export type IsolationKind = "git_worktree" | "directory_copy";

/**
 * A working directory that is not the owner's live project. External and
 * irreversible steps run here so a black-box CLI cannot rewrite the tree
 * the owner actually edits.
 * 不是所有者正在编辑的那棵树。外部与不可逆步骤在这里跑，黑盒 CLI 就不能改所有者
 * 真正在用的目录。
 */
export interface IsolatedWorkspace {
  path: string;
  kind: IsolationKind;
  ownerPath: string;
  dispose(): Promise<void>;
}

export interface IsolatedWorkspaceOptions {
  ownerPath: string;
  /** Absolute directory under which this sandbox is created. 本沙箱创建于其下的绝对目录。 */
  sandboxRoot: string;
  /** Stable per-step id used as the directory name. 用作目录名的每步稳定 id。 */
  key: string;
  git?: GitRunner;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceIsolation {
  kind: IsolationKind;
  path: string;
  ownerPath: string;
}

/**
 * External and irreversible work must not spawn in the owner's live tree.
 * Reversible writes stay on that tree so the owner can see and keep the files.
 * 外部与不可逆工作不得在所有者的活树上 spawn。可逆写入仍落在那棵树上，所有者才能看见并留下文件。
 */
export function requiresIsolatedWorkspace(risk: RiskClass): boolean {
  return risk === "external_side_effect" || risk === "irreversible";
}

/**
 * Prefer a git worktree (cheap, committed snapshot). If the folder is not a
 * repo or git refuses, copy the current files into a sibling tree instead.
 * Never silently fall back to the owner path.
 * 优先 git worktree（便宜，且是已提交快照）。不是仓库或 git 拒绝时，把当前文件复制到
 * 一棵旁路树。绝不悄悄退回所有者路径。
 */
export async function prepareIsolatedWorkspace(options: IsolatedWorkspaceOptions): Promise<IsolatedWorkspace> {
  const ownerPath = resolve(options.ownerPath);
  const sandboxRoot = resolve(options.sandboxRoot);
  const sandboxPath = join(sandboxRoot, sanitizeKey(options.key));
  if (sandboxPath === ownerPath || sandboxPath.startsWith(`${ownerPath}/`) || sandboxPath.startsWith(`${ownerPath}\\`)) {
    throw new Error("An isolated workspace cannot be created inside the owner's live project.");
  }
  await mkdir(sandboxRoot, { recursive: true });
  await rm(sandboxPath, { recursive: true, force: true });

  const git = options.git ?? defaultGitRunner;
  const worktree = await tryGitWorktree(git, ownerPath, sandboxPath);
  if (worktree !== undefined) return worktree;

  await copyOwnerTree(ownerPath, sandboxPath);
  return {
    path: sandboxPath,
    kind: "directory_copy",
    ownerPath,
    dispose: async () => {
      await rm(sandboxPath, { recursive: true, force: true });
    },
  };
}

function sanitizeKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe.length > 0 ? safe : "step").slice(0, 120);
}

async function tryGitWorktree(git: GitRunner, ownerPath: string, sandboxPath: string): Promise<IsolatedWorkspace | undefined> {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], ownerPath);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return undefined;
  const toplevel = await git(["rev-parse", "--show-toplevel"], ownerPath);
  if (toplevel.code !== 0 || toplevel.stdout.trim().length === 0) return undefined;
  const repo = resolve(toplevel.stdout.trim());
  const added = await git(["worktree", "add", "--detach", sandboxPath], repo);
  if (added.code !== 0) return undefined;
  return {
    path: sandboxPath,
    kind: "git_worktree",
    ownerPath,
    dispose: async () => {
      const removed = await git(["worktree", "remove", "--force", sandboxPath], repo);
      if (removed.code !== 0) {
        await rm(sandboxPath, { recursive: true, force: true });
        await git(["worktree", "prune"], repo);
      }
    },
  };
}

async function copyOwnerTree(from: string, to: string): Promise<void> {
  const ignored = new Set<string>(WORKSPACE_IGNORED_DIRECTORIES);
  await cp(from, to, {
    recursive: true,
    errorOnExist: false,
    filter: (source) => {
      const name = basename(source);
      if (source !== from && ignored.has(name)) return false;
      try {
        // A symlink into the owner tree would let the worker write through
        // isolation. Skipping links keeps the copy a dead tree.
        // 指向所有者树的符号链接会让 Worker 穿过隔离去写。跳过链接，副本就是一棵死树。
        return !lstatSync(source).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

export async function defaultGitRunner(args: readonly string[], cwd: string): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error: unknown) {
    const execError = error as { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof execError.code === "number" ? execError.code : 1;
    return {
      code,
      stdout: String(execError.stdout ?? ""),
      stderr: String(execError.stderr ?? (error instanceof Error ? error.message : String(error))),
    };
  }
}
