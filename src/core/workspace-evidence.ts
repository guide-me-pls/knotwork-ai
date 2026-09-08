import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface WorkspaceSnapshot {
  /** Absolute root that was observed. 实际被观察的绝对根目录。 */
  root?: string;
  /** Relative path -> content hash. 相对路径 -> 内容哈希。 */
  files: Map<string, string>;
  takenAt: string;
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  /** Why some files could not come back. 部分文件无法还原的原因。 */
  skippedReason?: string;
}

/**
 * A checkpoint is derived evidence, not authority. It lets a fresh Supervisor
 * compare the interrupted Workspace with the state before dispatch without
 * depending on a provider session. 检查点是派生证据而不是权威；它让新的 Supervisor
 * 能比较中断前后的 Workspace，而不依赖 Provider Session。
 */
export interface WorkspaceCheckpointStore {
  save(key: string, snapshot: WorkspaceSnapshot): Promise<string>;
  load(locator: string): Promise<WorkspaceSnapshot | undefined>;
  /**
   * Writes stored file copies back. Hash-only checkpoints (legacy JSON with no
   * sidecar) return skipped files and do not invent contents.
   * 把已存储的文件副本写回去。仅哈希的检查点（没有 sidecar 的旧 JSON）返回跳过的
   * 文件，绝不编造内容。
   */
  restore(locator: string, root: string): Promise<RestoreResult | undefined>;
}

/**
 * JSON checkpoints are intentionally inspectable and editable by the owner.
 * The Kernel still treats them as evidence to arbitrate, never as a completion
 * claim. JSON 检查点刻意保持可查看、可编辑；Kernel 仍只把它当作裁决证据，绝不把它
 * 当成完成声明。
 */
export class JsonWorkspaceCheckpointStore implements WorkspaceCheckpointStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async save(key: string, snapshot: WorkspaceSnapshot): Promise<string> {
    await mkdir(this.#directory, { recursive: true });
    const locator = encodeURIComponent(key);
    const target = join(this.#directory, `${locator}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const serializable = {
      root: snapshot.root,
      takenAt: snapshot.takenAt,
      files: Object.fromEntries(snapshot.files),
    };
    await writeFile(temporary, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    await this.persistFileCopies(locator, snapshot);
    return locator;
  }

  async load(locator: string): Promise<WorkspaceSnapshot | undefined> {
    if (locator.length === 0 || locator.includes("/") || locator.includes("\\") || locator.includes("..")) {
      throw new Error(`Workspace checkpoint locator ${locator} is invalid.`);
    }
    const target = join(this.#directory, `${locator}.json`);
    let source: string;
    try {
      source = await readFile(target, "utf8");
    } catch (error: unknown) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const parsed = JSON.parse(source) as { root?: unknown; takenAt?: unknown; files?: unknown };
    if (
      (parsed.root !== undefined && typeof parsed.root !== "string")
      || typeof parsed.takenAt !== "string"
      || typeof parsed.files !== "object"
      || parsed.files === null
      || Array.isArray(parsed.files)
    ) {
      throw new Error(`Workspace checkpoint ${locator} is malformed.`);
    }
    const files = new Map<string, string>();
    for (const [path, hash] of Object.entries(parsed.files as Record<string, unknown>)) {
      if (typeof hash !== "string") throw new Error(`Workspace checkpoint ${locator} has an invalid file hash.`);
      files.set(path, hash);
    }
    return {
      ...(typeof parsed.root === "string" ? { root: resolve(parsed.root) } : {}),
      files,
      takenAt: parsed.takenAt,
    };
  }

  async restore(locator: string, root: string): Promise<RestoreResult | undefined> {
    const snapshot = await this.load(locator);
    if (snapshot === undefined) return undefined;
    const filesDir = this.filesDirectory(locator);
    let stored: Set<string>;
    try {
      stored = await listStoredFiles(filesDir);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return {
          restored: [],
          skipped: [...snapshot.files.keys()],
          skippedReason: "hash-only checkpoint; file contents were not stored",
        };
      }
      throw error;
    }
    const restored: string[] = [];
    const skipped: string[] = [];
    const destination = resolve(root);
    for (const relativePath of snapshot.files.keys()) {
      if (!isSafeRelativePath(relativePath) || !stored.has(relativePath)) {
        skipped.push(relativePath);
        continue;
      }
      const from = join(filesDir, ...relativePath.split("/"));
      const to = join(destination, ...relativePath.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      restored.push(relativePath);
    }
    return {
      restored,
      skipped,
      ...(skipped.length === 0 ? {} : { skippedReason: "large or unreadable files are hash-only and cannot be restored" }),
    };
  }

  private filesDirectory(locator: string): string {
    return join(this.#directory, `${locator}.files`);
  }

  /**
   * Copies small hashed files beside the JSON. Large files stay hash-only —
   * restoring them would cost more than the work being supervised.
   * 把已哈希的小文件复制到 JSON 旁边。大文件仍只记哈希——还原它们的成本会超过被监督的工作。
   */
  private async persistFileCopies(locator: string, snapshot: WorkspaceSnapshot): Promise<void> {
    if (snapshot.root === undefined) return;
    const filesDir = this.filesDirectory(locator);
    await mkdir(filesDir, { recursive: true });
    for (const [relativePath, hash] of snapshot.files) {
      if (!isSafeRelativePath(relativePath)) continue;
      if (hash.startsWith("meta:") || hash === "unreadable") continue;
      const from = join(snapshot.root, ...relativePath.split("/"));
      const to = join(filesDir, ...relativePath.split("/"));
      try {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      } catch {
        // A file that vanished between hash and copy is not a restoreable baseline.
        // 在哈希与复制之间消失的文件，不能当作可还原基线。
      }
    }
  }
}

export interface WorkspaceChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export interface WorkspaceSnapshotOptions {
  /** Directory names never walked. 永不遍历的目录名。 */
  ignoredDirectories?: readonly string[];
  /** Refuse to snapshot beyond this many files. 超过该文件数即拒绝快照。 */
  maxFiles?: number;
}

export const WORKSPACE_IGNORED_DIRECTORIES = [
  ".git",
  ".clone",
  ".clone-ai",
  "node_modules",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
] as const;

const DEFAULT_IGNORED = WORKSPACE_IGNORED_DIRECTORIES;

const DEFAULT_MAX_FILES = 20_000;

/**
 * Evidence taken by observation rather than by asking. A black-box worker
 * cannot be relied on to announce what it produced — it may not know Clone
 * AI's conventions, may summarize inaccurately, or may claim work it never
 * did. Snapshotting the workspace before and after a dispatch makes the
 * artifacts a fact about the filesystem instead of a claim in the worker's
 * output.
 *
 * 通过观察而非询问获得的证据。黑盒 Worker 不能被指望去申报自己产出了什么——它可能
 * 不知道 Clone AI 的约定、可能总结不准确，也可能声称做了从未做过的事。在派发前后对
 * Workspace 拍快照，使产物成为关于文件系统的事实，而不是 Worker 输出里的一句声称。
 */
export async function snapshotWorkspace(
  root: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = new Map<string, string>();

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is not evidence of a change.
      // 无法读取的目录不构成变更证据。
      return;
    }
    for (const entry of entries) {
      if (files.size >= maxFiles) return;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = relative(root, absolute).split(sep).join("/");
      files.set(key, await hashFile(absolute));
    }
  };

  await walk(root);
  return { root: resolve(root), files, takenAt: new Date().toISOString() };
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const [path, hash] of after.files) {
    const previous = before.files.get(path);
    if (previous === undefined) changes.push({ path, change: "added" });
    else if (previous !== hash) changes.push({ path, change: "modified" });
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changes.push({ path, change: "deleted" });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * A deleted file is a real change but not a durable artifact, so only added
 * and modified files can back an artifact claim.
 * 被删除的文件是真实变更但不是可留存的产物，因此只有新增与修改的文件才能支撑
 * Artifact 声明。
 */
export function artifactChanges(changes: readonly WorkspaceChange[]): WorkspaceChange[] {
  return changes.filter((change) => change.change !== "deleted");
}

export function describeChanges(changes: readonly WorkspaceChange[], limit = 20): string {
  if (changes.length === 0) return "no workspace changes";
  const listed = changes.slice(0, limit).map((change) => `${change.change[0]} ${change.path}`).join(", ");
  return changes.length <= limit ? listed : `${listed}, and ${changes.length - limit} more`;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function listStoredFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      files.add(relative(root, absolute).split(sep).join("/"));
    }
  };
  await walk(root);
  return files;
}

async function hashFile(path: string): Promise<string> {
  try {
    const info = await stat(path);
    // Large files are identified by size and mtime: reading them in full would
    // make snapshotting cost more than the work being supervised.
    // 大文件用大小与修改时间标识：完整读取会让拍快照的成本超过被监督的工作本身。
    if (info.size > 2_000_000) return `meta:${info.size}:${info.mtimeMs}`;
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}
