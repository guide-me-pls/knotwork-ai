import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { RiskClass } from "./contracts.ts";
import {
  artifactChanges,
  diffWorkspace,
  snapshotWorkspace,
  WORKSPACE_IGNORED_DIRECTORIES,
} from "./workspace-evidence.ts";

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

export interface IsolatedApplySkip {
  path: string;
  reason: string;
}

/**
 * What happened when verified files were offered back to the owner tree.
 * 把已验证文件交回所有者树时发生了什么。
 */
export interface IsolatedApplyResult {
  copied: string[];
  skipped: IsolatedApplySkip[];
  leftover: string[];
  sandboxRetained: boolean;
  isolatedPath: string;
  ownerPath: string;
}

const MAX_APPLY_BYTES = 2_000_000;

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

/**
 * A plan or artifact contract that names a relative file, not a sentence.
 * 计划或产物合同点名的相对文件路径，而不是一句话。
 */
export function looksLikeRelativeFile(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}$/.test(trimmed) && !trimmed.includes("..");
}

/**
 * True when `relativePath` is the named file, or a nested path ending at it.
 * 当 relativePath 就是点名的文件，或以其为结尾的嵌套路径时为真。
 */
export function matchesNamedFile(relativePath: string, named: string): boolean {
  const file = normalizeRelative(relativePath);
  const hint = normalizeRelative(named);
  if (file.length === 0 || hint.length === 0) return false;
  return file === hint || file.endsWith(`/${hint}`) || hint.endsWith(`/${file}`);
}

/**
 * Copy only files the plan named. Other isolated writes stay in the sandbox:
 * merging every diff would let a black-box CLI rewrite the live project.
 * 只拷贝计划点名的文件。其余隔离写入留在沙箱：若把全部 diff 合回去，黑盒 CLI
 * 就能改写活项目。
 */
export async function applyIsolatedArtifacts(options: {
  isolatedPath: string;
  ownerPath: string;
  namedFiles: readonly string[];
}): Promise<IsolatedApplyResult> {
  const isolatedPath = resolve(options.isolatedPath);
  const ownerPath = resolve(options.ownerPath);
  const isolatedSnap = await snapshotWorkspace(isolatedPath);
  const ownerSnap = await snapshotWorkspace(ownerPath);
  const changedPaths = artifactChanges(diffWorkspace(ownerSnap, isolatedSnap)).map((change) => change.path);
  const named = options.namedFiles.map(normalizeRelative).filter((path) => path.length > 0);

  const copied: string[] = [];
  const skipped: IsolatedApplySkip[] = [];
  for (const relativePath of changedPaths) {
    if (!named.some((hint) => matchesNamedFile(relativePath, hint))) continue;
    const outcome = await copyNamedIsolatedFile({
      isolatedPath,
      ownerPath,
      relativePath,
      isolatedHash: isolatedSnap.files.get(relativePath),
      ownerHash: ownerSnap.files.get(relativePath),
    });
    if (outcome === "copied" || outcome === "identical") copied.push(relativePath);
    else skipped.push({ path: relativePath, reason: outcome });
  }

  const settled = new Set([...copied, ...skipped.map((item) => item.path)]);
  const leftover = changedPaths.filter((path) => !settled.has(path)).sort();
  return {
    copied,
    skipped,
    leftover,
    sandboxRetained: leftover.length > 0 || skipped.length > 0,
    isolatedPath,
    ownerPath,
  };
}

function normalizeRelative(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeRelative(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0") || path.includes("\\")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function copyNamedIsolatedFile(input: {
  isolatedPath: string;
  ownerPath: string;
  relativePath: string;
  isolatedHash?: string;
  ownerHash?: string;
}): Promise<string> {
  if (!isSafeRelative(input.relativePath)) return "path is not a safe relative file";
  const from = join(input.isolatedPath, ...input.relativePath.split("/"));
  const to = join(input.ownerPath, ...input.relativePath.split("/"));
  if (!isInsideRoot(input.isolatedPath, from) || !isInsideRoot(input.ownerPath, to)) {
    return "path escapes the workspace";
  }
  let source;
  try {
    source = lstatSync(from);
  } catch {
    return "missing in the isolated workspace";
  }
  if (source.isSymbolicLink() || !source.isFile()) return "not a regular file";
  if (source.size > MAX_APPLY_BYTES) return "larger than 2MB; inspect the sandbox instead";

  try {
    const destination = lstatSync(to);
    if (destination.isSymbolicLink() || !destination.isFile()) {
      return "destination exists and is not a regular file";
    }
    if (input.isolatedHash !== undefined && input.ownerHash !== undefined && input.isolatedHash === input.ownerHash) {
      return "identical";
    }
    return "owner already has a different file at this path";
  } catch {
    // Destination is absent: the named artifact can land without clobbering.
    // 目标不存在：点名产物可以落下，而不会覆盖已有文件。
  }
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return "copied";
}
