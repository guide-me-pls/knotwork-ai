import { lstat, mkdir, readdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CLONE_DIRECTORY_NAME = ".clone";
export const LEGACY_CLONE_DIRECTORY_NAME = ".clone-ai";

export interface ClonePaths {
  /** User-owned global data directory. 用户拥有的全局数据目录。 */
  dataDirectory: string;
  /** Workspace controlled by the current desktop/runtime session. 当前桌面 Runtime 控制的项目目录。 */
  workspacePath: string;
  configFile: string;
  agentsFile: string;
  legacyAgentsFile: string;
  providersFile: string;
  memoryFile: string;
  schedulesFile: string;
  sessionsFile: string;
  journalJsonlFile: string;
  journalSqliteFile: string;
  outcomesDirectory: string;
  checkpointsDirectory: string;
  sessionsDirectory: string;
  workspaceRuntimeDirectory: string;
  workspaceLockFile: string;
  /**
   * Sandboxes for external/irreversible steps. Lives in clone home, not the
   * owner's project, so a worker cannot walk `..` into live files.
   * 外部/不可逆步骤的沙箱。放在 clone home 而不是所有者项目里，Worker 就不能靠 `..` 走进活文件。
   */
  isolatedWorkspacesDirectory: string;
}

export interface ClonePathOptions {
  dataDirectory?: string;
  workspacePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve every persistent path from one place. Explicit test paths win,
 * then CLONE_HOME/CLONE_AI_DATA_DIR, then the user's home directory.
 * 所有持久化路径都从一个地方解析：测试显式路径优先，其次是环境变量，最后才是用户主目录。
 */
export function resolveClonePaths(options: ClonePathOptions = {}): ClonePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = userHomeDirectory(env);
  const dataDirectory = resolve(
    options.dataDirectory
      ?? env.CLONE_HOME
      ?? env.CLONE_AI_HOME
      ?? env.CLONE_AI_DATA_DIR
      ?? join(home, CLONE_DIRECTORY_NAME),
  );
  const workspacePath = resolve(options.workspacePath ?? env.CLONE_AI_WORKSPACE ?? cwd);
  const workspaceRuntimeDirectory = join(workspacePath, CLONE_DIRECTORY_NAME);

  return {
    dataDirectory,
    workspacePath,
    configFile: join(dataDirectory, "config.json"),
    agentsFile: join(dataDirectory, "agents.json"),
    legacyAgentsFile: join(dataDirectory, "settings.json"),
    providersFile: join(dataDirectory, "providers.json"),
    memoryFile: join(dataDirectory, "memory.json"),
    schedulesFile: join(dataDirectory, "schedules.json"),
    sessionsFile: join(dataDirectory, "sessions.json"),
    journalJsonlFile: join(dataDirectory, "journal.jsonl"),
    journalSqliteFile: join(dataDirectory, "journal.sqlite3"),
    outcomesDirectory: join(dataDirectory, "outcomes"),
    checkpointsDirectory: join(dataDirectory, "checkpoints"),
    sessionsDirectory: join(dataDirectory, "sessions"),
    workspaceRuntimeDirectory,
    workspaceLockFile: join(workspaceRuntimeDirectory, "workspace-execution.lock"),
    isolatedWorkspacesDirectory: join(dataDirectory, "isolated-workspaces"),
  };
}

/**
 * Create only the directories the Runtime owns; JSON files remain absent until
 * a feature needs them. 只创建 Runtime 拥有的目录，JSON 文件在真正需要时再产生。
 */
export async function prepareCloneHome(paths: ClonePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.dataDirectory, { recursive: true }),
    mkdir(paths.outcomesDirectory, { recursive: true }),
    mkdir(paths.checkpointsDirectory, { recursive: true }),
    mkdir(paths.sessionsDirectory, { recursive: true }),
    mkdir(paths.workspaceRuntimeDirectory, { recursive: true }),
    mkdir(paths.isolatedWorkspacesDirectory, { recursive: true }),
  ]);
}

/**
 * Copy legacy files without overwriting anything the owner has already placed
 * in the new home. This is deliberately recoverable and can be run repeatedly.
 * 只复制旧目录中尚不存在的文件，不覆盖新目录内容；可重复运行且可恢复。
 */
export async function migrateLegacyCloneHome(input: {
  legacyDirectory: string;
  targetDirectory: string;
}): Promise<{ copied: number }> {
  const legacyDirectory = resolve(input.legacyDirectory);
  const targetDirectory = resolve(input.targetDirectory);
  if (legacyDirectory === targetDirectory || !(await isDirectory(legacyDirectory))) return { copied: 0 };

  await mkdir(targetDirectory, { recursive: true });
  return { copied: await copyMissingTree(legacyDirectory, targetDirectory) };
}

export function defaultLegacyDirectory(cwd = process.cwd()): string {
  return join(resolve(cwd), LEGACY_CLONE_DIRECTORY_NAME);
}

function userHomeDirectory(env: NodeJS.ProcessEnv): string {
  const configured = process.platform === "win32"
    ? env.USERPROFILE ?? env.HOME
    : env.HOME ?? env.USERPROFILE;
  return resolve(configured ?? homedir());
}

async function copyMissingTree(source: string, target: string): Promise<number> {
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      copied += await copyMissingTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || await pathExists(targetPath)) continue;
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }
  return copied;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error: unknown) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
