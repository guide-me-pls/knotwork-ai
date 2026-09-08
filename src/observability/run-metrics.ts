import type { Run, RunStatus } from "../core/contracts.ts";

const STATUSES: readonly RunStatus[] = [
  "created",
  "planning",
  "queued",
  "running",
  "waiting_approval",
  "verifying",
  "completed",
  "failed",
  "cancelled",
];

const TERMINAL = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export interface RunMetrics {
  byStatus: Record<RunStatus, number>;
  terminalCount: number;
  /** Mean createdAt→updatedAt for terminal runs; null when none have finished. 终态 Run 的 createdAt→updatedAt 均值；尚无终态时为 null。 */
  averageDurationMs: number | null;
}

export function emptyRunMetrics(): RunMetrics {
  return {
    byStatus: Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>,
    terminalCount: 0,
    averageDurationMs: null,
  };
}

/**
 * Counts every Run and the duration of those that already stopped.
 * Health exposes this; it is not a trace.
 * 统计全部 Run，以及已经停下的那些的耗时。Health 暴露它；它不是一条 trace。
 */
export function summarizeRuns(runs: readonly Run[]): RunMetrics {
  const metrics = emptyRunMetrics();
  let durationSum = 0;
  for (const run of runs) {
    metrics.byStatus[run.status] += 1;
    if (!TERMINAL.has(run.status)) continue;
    const started = Date.parse(run.createdAt);
    const ended = Date.parse(run.updatedAt);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) continue;
    metrics.terminalCount += 1;
    durationSum += ended - started;
  }
  metrics.averageDurationMs = metrics.terminalCount === 0
    ? null
    : Math.round(durationSum / metrics.terminalCount);
  return metrics;
}
