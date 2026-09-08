import { createJournalStore } from "../core/sqlite-journal.ts";
import { logJson } from "./json-log.ts";

/**
 * What the Kernel can honestly say about one model turn.
 * Tokens and dollars are copied from the session when the SDK has them;
 * duration and model id are always available.
 * Kernel 对一次模型回合能诚实说出的内容。Token 与美元在 SDK 有数据时从会话抄来；
 * 时长与模型 id 始终可写。
 */
export interface UsageRecord {
  source: "main-agent" | "planner";
  durationMs: number;
  modelId?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface SessionTokenStats {
  tokens: { input: number; output: number; total: number };
  cost: number;
}

export interface SessionUsageSource {
  getSessionStats(): SessionTokenStats;
  readonly model?: { id?: string; provider?: string };
}

/**
 * Delta of Pi session stats across a prompt, plus wall time.
 * A missing or zero cost is still a record — silence would be the lie.
 * 一次 prompt 前后 Pi 会话统计的差值，再加上墙钟时间。
 * 缺失或为零的费用仍然记一笔——沉默才是撒谎。
 */
export function collectSessionUsage(
  session: SessionUsageSource,
  durationMs: number,
  before?: SessionTokenStats,
): UsageRecord {
  const after = session.getSessionStats();
  const record: UsageRecord = {
    source: "main-agent",
    durationMs: Math.max(0, durationMs),
    ...(typeof session.model?.id === "string" ? { modelId: session.model.id } : {}),
    ...(typeof session.model?.provider === "string" ? { provider: session.model.provider } : {}),
  };
  if (before !== undefined) {
    const inputTokens = Math.max(0, after.tokens.input - before.tokens.input);
    const outputTokens = Math.max(0, after.tokens.output - before.tokens.output);
    const totalTokens = Math.max(0, after.tokens.total - before.tokens.total);
    const costUsd = Math.max(0, after.cost - before.cost);
    if (inputTokens > 0) record.inputTokens = inputTokens;
    if (outputTokens > 0) record.outputTokens = outputTokens;
    if (totalTokens > 0) record.totalTokens = totalTokens;
    if (costUsd > 0) record.costUsd = costUsd;
  } else if (after.tokens.total > 0) {
    record.inputTokens = after.tokens.input;
    record.outputTokens = after.tokens.output;
    record.totalTokens = after.tokens.total;
    if (after.cost > 0) record.costUsd = after.cost;
  }
  return record;
}

/**
 * Appends a usage.recorded event. Failure is logged, never thrown: telemetry
 * must not abort the owner's turn.
 * 追加一条 usage.recorded。失败只记日志、绝不抛出：遥测不能中断所有者的这一轮。
 */
export async function recordUsage(dataDirectory: string, payload: UsageRecord): Promise<void> {
  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({ type: "usage.recorded", payload });
  } catch (error: unknown) {
    logJson("warn", "usage.recorded failed", {
      error: error instanceof Error ? error.message : String(error),
      source: payload.source,
    });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}
