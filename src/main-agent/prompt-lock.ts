import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Exclusive lock around one Main Agent prompt for a clone home.
 *
 * The Pi session file is one thread. Two concurrent prompts — GUI stream plus
 * CLI, or two tabs — would interleave writes. This lock fails closed: a second
 * caller is refused rather than queued, so the owner sees the collision.
 *
 * 针对一个 clone home 的 Main Agent prompt 互斥锁。
 *
 * Pi 会话文件是一条线索。两次并发 prompt——GUI 流加上 CLI，或两个标签页——会交错写入。
 * 这把锁失败即关闭：第二次调用被拒绝而不是排队，好让所有者看见碰撞。
 */
export class MainAgentBusyError extends Error {
  constructor() {
    super("The Main Agent is already answering another request in this clone home.");
    this.name = "MainAgentBusyError";
  }
}

export function mainAgentLockPath(dataDirectory: string): string {
  return join(dataDirectory, "pi-sessions", "main-agent", "prompt.lock");
}

export async function withMainAgentLock<T>(dataDirectory: string, run: () => Promise<T>): Promise<T> {
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  const handle = await tryAcquire(path);
  if (handle === undefined) throw new MainAgentBusyError();
  try {
    return await run();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}

async function tryAcquire(path: string): Promise<FileHandle | undefined> {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    if (await isStale(path)) {
      await unlink(path).catch(() => undefined);
      return tryAcquire(path);
    }
    return undefined;
  }
}

async function isStale(path: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return isGone(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "EEXIST";
}

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code: string }).code === "ESRCH" || (error as { code: string }).code === "ENOENT");
}
