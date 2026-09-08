/**
 * One companion-facing query through the Main Agent. The session is the
 * persistent clone-main conversation; the reply is the agent's words, and the
 * accepted runs are read back from the Kernel journal — the caller gets both,
 * clearly separated, because words are not evidence.
 * 面向 companion 的一次 Main Agent 查询。会话即持久的 clone-main 对话；reply 是 Agent
 * 的话语，acceptedRuns 则从 Kernel Journal 读回——两者分开返回，因为话语不是证据。
 */
import type { Run } from "../core/contracts.ts";
import { createKernelRuntime } from "../main-agent/tools/kernel-tools.ts";
import { createMainAgentSession } from "../main-agent/session.ts";
import { withMainAgentLock } from "../main-agent/prompt-lock.ts";

export interface MainAgentQueryResult {
  reply: string;
  /** Runs that appeared in the Kernel journal during this query. 本次查询期间出现在 Kernel Journal 中的 Run。 */
  newRuns: Array<Pick<Run, "id" | "status" | "planId">>;
}

export interface MainAgentQueryOptions {
  /**
   * Called for each token as the agent produces it. The deltas exist either
   * way; without a sink they are merely accumulated and delivered at the end,
   * which makes a slow model look like a frozen interface.
   * Agent 每产出一个 token 就会调用。增量本来就存在；没有接收方时它们只是被累加、最后
   * 一次性交付，而这会让一个慢模型看起来像界面卡死。
   */
  onDelta?: (delta: string) => void;
}

export async function runMainAgentQuery(
  dataDirectory: string,
  text: string,
  options: MainAgentQueryOptions = {},
): Promise<MainAgentQueryResult> {
  return withMainAgentLock(dataDirectory, async () => {
    const before = new Set((await createKernelRuntime(dataDirectory)).listRuns().map((run) => run.id));

    const { session } = await createMainAgentSession({ dataDirectory });
    let reply = "";
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        reply += delta;
        // A failing sink must not abort the run: the owner would lose the work
        // over a broken pipe to a window they already closed.
        // 接收方出错不能中断本次运行：否则所有者会因为一个已关闭窗口的断开管道而丢掉工作。
        try {
          options.onDelta?.(delta);
        } catch {
          // The transport is gone; the reply is still assembled and returned.
          // 传输已断开；回复仍会被组装并返回。
        }
      }
    });
    try {
      await session.prompt(text);
    } finally {
      session.dispose();
    }

    const runtime = await createKernelRuntime(dataDirectory);
    const newRuns = runtime
      .listRuns()
      .filter((run) => !before.has(run.id))
      .map((run) => ({ id: run.id, status: run.status, planId: run.planId }));
    return { reply: reply.trim(), newRuns };
  });
}
