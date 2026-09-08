/**
 * The queue consumer: what turns an accepted plan into actual work.
 *
 * A Run reaching `queued` means the Kernel accepted the plan — not that
 * anything ran. Without a consumer the GUI shows "in progress" while nothing
 * executes, which is the worst possible failure: the owner believes work is
 * happening. This closes that gap for every entry point at once, because it
 * watches Run state rather than being called by one particular caller.
 *
 * 队列消费者：把已接受的计划变成真正的工作。
 *
 * Run 到达 `queued` 只意味着 Kernel 接受了计划，并不意味着有任何东西在跑。没有消费者
 * 时，GUI 会显示"正在推进"而实际什么都没执行——这是最糟的失败形态：所有者以为工作
 * 正在发生。本模块一次性为所有入口补上这一环，因为它观察的是 Run 状态，而不是被某个
 * 特定调用方调用。
 */
import { randomUUID } from "node:crypto";

import type { AgentRegistry } from "../core/contracts.ts";
import type { CloneRuntime } from "../core/runtime.ts";
import type { JournalStore } from "../core/journal.ts";
import { reconcileCommitments } from "../state/commitment-reconciler.ts";
import { logJson } from "../observability/json-log.ts";

export interface RunQueueOptions {
  runtime: CloneRuntime;
  /** Resolved per tick so a settings change takes effect without a restart. 每次 tick 解析一次，使设置变更无需重启即可生效。 */
  registry: () => Promise<AgentRegistry>;
  intervalMs?: number;
  onError?: (runId: string, error: unknown) => void;
  /**
   * The journal used to claim runs. Without it the consumer falls back to
   * in-process de-duplication only, which is safe for a single daemon but
   * cannot stop a second process from executing the same run.
   * 用于领取 Run 的 Journal。没有它时，消费者只能做进程内去重：对单 Daemon 安全，
   * 但无法阻止第二个进程执行同一个 Run。
   */
  journal?: JournalStore;
  /** Identifies this consumer in a claim. 在领取中标识本消费者。 */
  ownerId?: string;
  /** How long a claim stays valid without renewal. 一次领取在不续期时的有效时长。 */
  leaseMs?: number;
}

export class RunQueueConsumer {
  readonly #options: RunQueueOptions;
  readonly #inFlight = new Set<string>();
  readonly #ownerId: string;
  readonly #leaseMs: number;
  #timer?: NodeJS.Timeout;
  #ticking = false;

  constructor(options: RunQueueOptions) {
    this.#options = options;
    this.#ownerId = options.ownerId ?? `consumer-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.#leaseMs = options.leaseMs ?? 5 * 60_000;
  }

  /** The identity this consumer claims runs under. 本消费者领取 Run 所用的身份。 */
  get ownerId(): string {
    return this.#ownerId;
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? 2_000);
    this.#timer.unref();
  }

  /**
   * Stops scanning and waits for in-flight work to settle.
   *
   * Returning while a Run is still executing would let the consumer keep
   * writing into a data directory its owner believes is closed — during
   * shutdown that is a corrupted journal, and in tests a directory that cannot
   * be removed.
   * 停止扫描并等待进行中的工作落定。
   *
   * 在仍有 Run 执行时就返回，会让消费者继续往一个所有者认为已关闭的数据目录里写——
   * 在关闭流程中这意味着损坏的 Journal，在测试中则是一个删不掉的目录。
   */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (let attempt = 0; attempt < 200 && (this.#inFlight.size > 0 || this.#ticking); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Executes every queued Run once. Runs waiting for approval are left alone:
   * the owner's decision is not something a background loop may supply.
   * 每次把所有排队中的 Run 执行一遍。等待审批的 Run 不动：所有者的决定不是后台循环
   * 可以替他给出的东西。
   */
  async tick(): Promise<string[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const started: string[] = [];
    try {
      // Runs are created by other processes (Main Agent, CLI, scheduler), so
      // the projection must be replayed before looking for work.
      // Run 由其他进程创建（Main Agent、CLI、调度器），因此必须先重放投影再找活干。
      await this.#options.runtime.refresh();
      // A dead executor's runs come back to life here — re-queued when the work
      // is reversible, failed when a retry could duplicate an external effect —
      // so the filter below can pick them up in the same tick. Recovery is
      // claim-driven: a run with a live lease is somebody else's, in flight
      // right now, and is not touched.
      // 死掉的执行者的 Run 在这里复活——可逆的工作回到队列，重试可能复制外部影响的
      // 工作转为失败——这样下面的过滤能在同一次 tick 里接走它们。恢复由领取驱动：
      // 带着存活租约的 Run 属于别人、正在飞行中，不会被碰。
      try {
        await this.#options.runtime.recoverOrphanedRuns();
      } catch (error: unknown) {
        // Recovery failing must not stop the tick from running the healthy
        // queue; the next tick retries the recovery itself.
        // 恢复失败不能阻止本次 tick 运行健康的队列；下一次 tick 会重试恢复本身。
        logJson("error", "orphan recovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const queued = this.#options.runtime.listRuns().filter((run) => run.status === "queued");
      for (const run of queued) {
        if (this.#inFlight.has(run.id)) continue;
        // Claim before dispatching: the projection said `queued`, but another
        // consumer may already be acting on that same reading.
        // 先领取再派发：投影说它是 `queued`，但另一个消费者可能已经在处理同一次读数。
        const claimed = await this.#claim(run.id);
        if (!claimed) continue;
        this.#inFlight.add(run.id);
        started.push(run.id);
        void this.#execute(run.id);
      }
      return started;
    } finally {
      this.#ticking = false;
    }
  }

  /** Runs currently executing in this process. 本进程中正在执行的 Run。 */
  inFlight(): string[] {
    return [...this.#inFlight];
  }

  async #claim(runId: string): Promise<boolean> {
    const journal = this.#options.journal;
    if (journal?.claimRun === undefined) return true;
    try {
      const claim = await journal.claimRun({ runId, ownerId: this.#ownerId, leaseMs: this.#leaseMs });
      return claim !== undefined;
    } catch (error: unknown) {
      this.#options.onError?.(runId, error);
      return false;
    }
  }

  async #execute(runId: string): Promise<void> {
    // Renew while the worker runs so a slow but healthy run keeps its claim.
    // 工作期间续期，使慢但健康的 Run 保住领取。
    const renew = setInterval(() => {
      void this.#options.journal?.renewClaim?.({ runId, ownerId: this.#ownerId, leaseMs: this.#leaseMs })
        ?.catch(() => undefined);
    }, Math.max(1_000, Math.floor(this.#leaseMs / 3)));
    renew.unref();
    try {
      const registry = await this.#options.registry();
      await this.#options.runtime.execute(runId, registry);
    } catch (error: unknown) {
      // The Kernel already journaled the failure; surfacing it here keeps the
      // daemon's log useful without turning a worker failure into a crash.
      // Kernel 已经把失败写入 Journal；这里只是让 daemon 日志保持有用，而不会把一次
      // Worker 失败变成进程崩溃。
      this.#options.onError?.(runId, error);
    } finally {
      clearInterval(renew);
      // Release so a terminal run's claim does not linger, and a failed one can
      // be retried without waiting out the lease.
      // 释放领取，使终态 Run 不会残留占用，失败的 Run 也无需等租约到期即可重试。
      await this.#options.journal?.releaseClaim?.({ runId, ownerId: this.#ownerId })?.catch(() => undefined);
      this.#inFlight.delete(runId);
      // Work landing is what moves the owner's obligations: a run that served a
      // commitment settles it, and a failed one leaves the occurrence unsatisfied
      // for the next pass to advance. Idempotent and failure-tolerant — the
      // maintenance timer makes the same call, so this is an early convergence,
      // not a single point of it.
      // 工作落地才会推动所有者的义务：服务过某个承诺的 Run 结算它，失败的 Run 则把该次
      // 周期留给下一次扫描推进。幂等且容忍失败——维护定时器会做同样的调用，因此这里
      // 是更早的一次收敛，而不是收敛的唯一机会。
      try {
        if (this.#options.journal !== undefined) await reconcileCommitments(this.#options.journal);
      } catch {
        // The state plane must never take the consumer down. 状态平面绝不能弄垮消费者。
      }
    }
  }
}
