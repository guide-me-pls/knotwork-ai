import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JournalEvent, MemoryCandidate, MemorySensitivity, MemoryType, Run, Task } from "./core/contracts.ts";
import { createJournalStore } from "./core/sqlite-journal.ts";
import { replay } from "./core/run-state.ts";
import { approveQueryRun, cancelQueryRun, rejectQueryRun, runQuery } from "./application/run-query.ts";
import { LocalScheduler } from "./scheduling/local-scheduler.ts";
import { describeSchedule, ScheduleStore, type LocalSchedule, type ScheduleKind } from "./scheduling/schedule-store.ts";
import { SessionStore } from "./sessions/session-store.ts";
import { loadProviderRegistry } from "./workers/provider-catalog.ts";
import { WorkerSettingsStore } from "./config/worker-settings.ts";
import { WorkerRegistry } from "./workers/worker-registry.ts";
import { runMainAgentQuery } from "./application/run-main-query.ts";
import { MainAgentBusyError } from "./main-agent/prompt-lock.ts";
import {
  authorizeCompanionRequest,
  injectCompanionToken,
  issueCompanionToken,
  persistCompanionToken,
} from "./companion-auth.ts";
import { MemoryGovernance } from "./memory/memory-governance.ts";
import { OpportunityService } from "./opportunity/opportunity-service.ts";
import { RunQueueConsumer } from "./application/run-queue.ts";
import { createRuntimeAssembly } from "./core/runtime-factory.ts";
import { createConfiguredAgentRegistry } from "./workers/configured-worker-registry.ts";
import { DailyReportRunner, type DailyReportSettings } from "./reporting/daily-report-runner.ts";
import { BadCaseLog } from "./reporting/bad-case-log.ts";
import { readJsonFile } from "./config/json-file.ts";
import { MdMemoryStore, GovernedMemorySource } from "./memory/md-memory-store.ts";
import type { JournalStore } from "./core/journal.ts";
import type { CloneRuntime } from "./core/runtime.ts";
import { logJson } from "./observability/json-log.ts";
import { emptyRunMetrics, summarizeRuns } from "./observability/run-metrics.ts";
import {
  defaultLegacyDirectory,
  migrateLegacyCloneHome,
  prepareCloneHome,
  resolveClonePaths,
  type ClonePaths,
} from "./config/clone-home.ts";
import { CloneConfigStore } from "./config/clone-config.ts";
import { readConnectorSettings, writeConnectorSettings } from "./connectors/connector-registry.ts";
import { compileBriefing } from "./main-agent/situation-briefing.ts";
import { buildFallbackPlan } from "./planning/fallback-planner.ts";
import { reconcileCommitments } from "./state/commitment-reconciler.ts";
import { describeHistory, mainAgentSessionDirectory, searchHistory } from "./main-agent/conversation-history.ts";
import { listOwnerConversations, readCurrentSessionPointer } from "./main-agent/session.ts";
import {
  listEffectiveProviderConfigs,
  readUserProviderConfigs,
  removeUserProviderConfig,
  upsertUserProviderConfig,
} from "./config/provider-config-store.ts";

export interface CompanionServerOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  workspacePath?: string;
  clientPath?: string;
}

export interface RunningCompanionServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Local-only daemon transport used by the desktop shell. The shipped Tauri
 * window opens this loopback URL; it is never a hosted web service.
 *
 * 桌面 Shell 使用的仅本地 Daemon Transport。发布的 Tauri Window 会打开这个 Loopback URL；
 * 它绝不是托管 Web 服务。
 */
export async function startCompanionServer(options: CompanionServerOptions = {}): Promise<RunningCompanionServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.CLONE_AI_PORT, 4317);
  // One resolver owns every persistent path, so the daemon, the CLI, and the
  // Main Agent cannot disagree about where the owner's data lives.
  // 由唯一的解析器决定所有持久化路径，使 Daemon、CLI 与 Main Agent 不会对
  // "所有者数据在哪里" 产生分歧。
  const paths = resolveClonePaths({
    ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
  });
  await prepareCloneHome(paths);
  // Copying is additive and never overwrites a file the owner already has in
  // the new home, so an interrupted upgrade can simply be run again.
  // 复制只做增量、绝不覆盖新目录中已存在的文件，因此升级中断后可以直接重跑。
  await migrateLegacyCloneHome({
    legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
    targetDirectory: paths.dataDirectory,
  });
  const dataDirectory = paths.dataDirectory;
  const workspacePath = paths.workspacePath;
  // The GUI assets ship with the package, so they must be resolved relative to
  // this module — `clone-ai gui` runs from whatever directory the owner is in.
  // GUI 资源随包发布，因此必须相对本模块解析——`clone-ai gui` 会在所有者当前所在的
  // 任意目录下运行。
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const clientPath = options.clientPath ?? join(packageRoot, "apps", "desktop", "ui", "index.html");
  const clientDirectory = dirname(clientPath);
  const [client, clientCss, clientJs] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(join(clientDirectory, "style.css"), "utf8"),
    readFile(join(clientDirectory, "app.js"), "utf8"),
  ]);
  const token = issueCompanionToken();
  await persistCompanionToken(paths.dataDirectory, token);
  const clientHtml = injectCompanionToken(client, token);
  const startedAt = Date.now();
  const schedules = new ScheduleStore(paths.schedulesFile);
  const sessions = new SessionStore(paths.sessionsFile);
  const providers = await loadProviderRegistry(dataDirectory);
  const agentSettings = new WorkerSettingsStore(paths.legacyAgentsFile, providers);
  const agentRegistry = new WorkerRegistry(dataDirectory);
  // One Runtime assembly, and therefore one journal, shared by every module in
  // this process. Separate stores over the same file each keep their own
  // sequence counter and their own cached view, which is how duplicate
  // sequences and stale reads appear.
  // 本进程内所有模块共用一个 Runtime 组装，因而共用一本 Journal。针对同一文件建多个
  // Store，每个都持有自己的 sequence 计数器和缓存视图——重复 sequence 与陈旧读数正是这么来的。
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath });
  const journal = assembly.journal;
  const memoryGovernance = new MemoryGovernance({
    journal,
    store: new MdMemoryStore({ dataDirectory }),
  });
  const config = new CloneConfigStore(paths);
  const scheduler = new LocalScheduler({
    store: schedules,
    run: async (schedule) => {
      await runQuery(dataDirectory, schedule.query, {
        kind: "schedule",
        payload: { scheduleId: schedule.id, scheduleKind: schedule.kind, scheduleDescription: describeSchedule(schedule) },
      }, await agentSettings.get(), { workspacePath });
    },
  });
  // The opportunity plane and the daily bad-case report share the same
  // journal. The report is opt-in: without reporting.json there is no email.
  // 机会平面与每日坏案例报告共享同一本 Journal。报告是显式开启的：没有 reporting.json
  // 就不会发邮件。
  // Accepted plans must actually run. Without this consumer a Run reaching
  // "queued" would sit there while the GUI claims progress.
  // 已接受的计划必须真的跑起来。没有这个消费者，到达 "queued" 的 Run 会一直停在那里，
  // 而 GUI 却宣称正在推进。
  const { runtime: queueRuntime } = assembly;
  const runQueue = new RunQueueConsumer({
    runtime: queueRuntime,
    journal,
    registry: async () => createConfiguredAgentRegistry((await agentSettings.get()).agents, { dataDirectory, workspacePath }),
    onError: (runId, error) => {
      logJson("error", "Run failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  runQueue.start();
  const opportunityService = new OpportunityService(journal);
  const badCaseLog = new BadCaseLog({ dataDirectory });
  await badCaseLog.appendNew(await journal.list()).catch(() => undefined);
  const reporting = await readJsonFile<DailyReportSettings>(join(dataDirectory, "reporting.json"));
  const reportRunner = reporting === undefined || reporting.enabled !== true
    ? undefined
    : new DailyReportRunner({
        journal,
        dataDirectory,
        settings: reporting,
        opportunities: () => opportunityService.list(),
      });
  if (reportRunner !== undefined) {
    // Check hourly; the runner itself sends at most once per local day.
    // 每小时检查一次；Runner 自身保证每个本地日最多发送一封。
    const reportTimer = setInterval(() => {
      void reportRunner.maybeSend().catch(() => undefined);
    }, 3_600_000);
    reportTimer.unref();
  }

  /**
   * The background loop that keeps the twin's own state moving.
   *
   * Two things previously only happened at startup or not at all: scanning for
   * opportunities, and turning a completed run's `memory.candidate.requested`
   * into a reviewable candidate. Both are what makes the twin appear to notice
   * things and learn, so both belong on a timer rather than on a user action.
   *
   * 让分身自身状态持续推进的后台循环。
   *
   * 之前有两件事只在启动时发生、或根本不发生：扫描机会，以及把已完成 Run 的
   * `memory.candidate.requested` 转成可审核的候选。这两件事正是“分身会注意到事情、会
   * 学习”的来源，因此它们属于定时器，而不是属于某个用户动作。
   */
  const runMaintenance = async (): Promise<void> => {
    // The reconcile pass runs before the scan and settles what landed since
    // the last tick — commitments served by verified runs, occurrences that
    // passed unsatisfied. The scan then reads the advanced due dates, so a
    // settled Friday proposes next Friday's card instead of re-proposing a
    // past one. Order is the loop: observe, settle, then look for new diffs.
    // 收敛扫描先于机会扫描运行，结算自上次 tick 以来落地的东西——被已验证 Run 服务过的
    // 承诺、未被满足而错过的周期。机会扫描随后读到推进后的到期时间，因此被结算的周五
    // 提出的是下一个周五的卡片，而不是重复提出已过去的那个。顺序即环路：观察、结算、
    // 再找新的差异。
    await reconcileCommitments(journal).catch(() => undefined);
    // Drain every pending candidate: a completed run must not wait for the
    // next tick to become something the owner can review.
    // 排空所有待处理候选：已完成的 Run 不应等到下一次 tick 才变成所有者可审核的东西。
    try {
      await assembly.memory.rebuild();
      for (let drained = 0; drained < 50; drained += 1) {
        const produced = await assembly.memory.processNext();
        if (produced.length === 0) break;
      }
    } catch {
      // Memory mining must never take the daemon down. 记忆提炼绝不能弄崩 Daemon。
    }
    await opportunityService.scanAndRecord().catch(() => undefined);
    await badCaseLog.appendNew(await journal.list()).catch(() => undefined);
  };
  await runMaintenance();
  const maintenance = setInterval(() => void runMaintenance(), 5 * 60_000);
  maintenance.unref();

  const bound = { port };
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, {
        host,
        listenPort: bound.port,
        token,
        startedAt,
        dataDirectory,
        workspacePath,
        paths,
        config,
        client: clientHtml,
        clientCss,
        clientJs,
        schedules,
        sessions,
        agentSettings,
        agentRegistry,
        memoryGovernance,
        opportunityService,
        badCaseLog,
        journal,
        runtime: queueRuntime,
        runQueue,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The local runtime encountered an unexpected error.";
      sendJson(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local companion did not expose a TCP address.");
  }
  const url = `http://${host}:${address.port}`;
  bound.port = address.port;
  scheduler.start();
  return {
    url,
    token,
    // Shutdown waits for the queue: a consumer still writing into the data
    // directory after close() resolves is a corrupted journal.
    // 关闭要等待队列：close() 返回后仍在往数据目录写入的消费者，意味着损坏的 Journal。
    close: async () => {
      scheduler.stop();
      clearInterval(maintenance);
      await runQueue.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await memoryGovernance.close();
      // Release the journal last: the queue and governance above may still be
      // finishing writes, and closing the database under them would lose those
      // records or fail the shutdown.
      // 最后释放 Journal：上面的队列与记忆治理可能仍在收尾写入，在它们下面关掉数据库
      // 会丢记录或让关停失败。
      assembly.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    host: string;
    listenPort: number;
    token: string;
    startedAt: number;
    dataDirectory: string;
    workspacePath: string;
    paths: ClonePaths;
    config: CloneConfigStore;
    client: string;
    clientCss: string;
    clientJs: string;
    schedules: ScheduleStore;
    sessions: SessionStore;
    agentSettings: WorkerSettingsStore;
    agentRegistry: WorkerRegistry;
    memoryGovernance: MemoryGovernance;
    opportunityService: OpportunityService;
    badCaseLog: BadCaseLog;
    journal: JournalStore;
    runtime: CloneRuntime;
    runQueue: RunQueueConsumer;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${context.host}`);
  const method = request.method ?? "GET";
  const authorized = authorizeCompanionRequest({
    method,
    pathname: url.pathname,
    hostHeader: headerValue(request.headers.host),
    originHeader: headerValue(request.headers.origin),
    authorization: headerValue(request.headers.authorization),
    token: context.token,
    listenPort: context.listenPort,
  });
  if (!authorized.ok) {
    sendJson(response, authorized.status, { error: authorized.error });
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    let journal: "ok" | "error" = "ok";
    try {
      await context.journal.list();
    } catch {
      journal = "error";
    }
    let runs = emptyRunMetrics();
    try {
      await context.runtime.refresh();
      runs = summarizeRuns(context.runtime.listRuns());
    } catch {
      // Health still answers; missing run counts are better than a 500.
      // Health 仍然应答；缺 Run 计数好过 500。
    }
    sendJson(response, journal === "ok" ? 200 : 503, {
      ok: journal === "ok",
      pid: process.pid,
      uptimeMs: Date.now() - context.startedAt,
      journal,
      queue: { inFlight: context.runQueue.inFlight().length },
      runs,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(context.client);
    return;
  }
  if (request.method === "GET" && url.pathname === "/style.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, await buildDashboard(context.dataDirectory, context.sessions));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    // Paths are shown so the owner can find and inspect their own data; no
    // credential value is ever part of this payload.
    // 展示路径是为了让所有者能找到并检查自己的数据；该响应从不包含任何凭据值。
    sendJson(response, 200, {
      config: await context.config.get(),
      paths: {
        dataDirectory: context.paths.dataDirectory,
        workspacePath: context.paths.workspacePath,
        configFile: context.paths.configFile,
        providersFile: context.paths.providersFile,
        memoryDirectory: join(context.dataDirectory, "memory"),
        outcomesDirectory: context.paths.outcomesDirectory,
        workspaceRuntimeDirectory: context.paths.workspaceRuntimeDirectory,
      },
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/config") {
    const body = await readJsonBody(request);
    const update: { workspacePath?: string; locale?: "zh-CN" | "en"; mainAgentModel?: string } = {};
    if (typeof body.workspacePath === "string" && body.workspacePath.trim().length > 0) {
      update.workspacePath = body.workspacePath.trim();
    }
    if (body.locale === "zh-CN" || body.locale === "en") update.locale = body.locale;
    if ("mainAgentModel" in body) {
      if (typeof body.mainAgentModel !== "string") {
        sendJson(response, 400, { error: "mainAgentModel must be a string (empty clears it)." });
        return;
      }
      update.mainAgentModel = body.mainAgentModel.trim();
    }
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "Provide a workspacePath, locale, or mainAgentModel to change." });
      return;
    }
    sendJson(response, 200, { config: await context.config.update(update) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings/providers") {
    sendJson(response, 200, {
      providers: await listEffectiveProviderConfigs(context.dataDirectory),
      userDefined: await readUserProviderConfigs(context.dataDirectory),
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings/providers") {
    const body = await readJsonBody(request);
    try {
      // Validation lives in the store, so the GUI cannot write a declaration
      // the Runtime would later refuse to launch.
      // 校验在 Store 内进行，因此 GUI 无法写入 Runtime 之后会拒绝启动的声明。
      const providers = await upsertUserProviderConfig(context.dataDirectory, body as never);
      sendJson(response, 200, { providers });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid provider declaration." });
    }
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/settings\/providers\/([^/]+)$/);
  if (request.method === "DELETE" && providerMatch?.[1] !== undefined) {
    const providers = await removeUserProviderConfig(context.dataDirectory, decodeURIComponent(providerMatch[1]));
    sendJson(response, 200, { providers });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/connectors") {
    // Declarations only. A connector's target is a path the owner chose; the
    // env list holds variable names, so nothing here can carry a credential.
    // 只返回声明。target 是所有者选定的路径；env 只有变量名，因此这里不可能携带凭据。
    sendJson(response, 200, { connectors: await readConnectorSettings(context.dataDirectory) });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/connectors") {
    const body = await readJsonBody(request);
    const entries = Array.isArray(body.connectors) ? body.connectors : undefined;
    if (entries === undefined) {
      sendJson(response, 400, { error: "Provide a connectors array." });
      return;
    }
    try {
      sendJson(response, 200, { connectors: await writeConnectorSettings(context.dataDirectory, entries) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid connector declaration." });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/situation") {
    // Read the shared journal rather than opening a new store, and do not let
    // a GUI poll trigger connector writes: observation is the background
    // loop's job, so refreshing a panel cannot append duplicate observations.
    // 读共享的 Journal，而不是新开一个 Store；且不让 GUI 轮询触发 Connector 写入：
    // 观察是后台循环的职责，因此刷新面板不会重复追加观察事件。
    const briefing = await compileBriefing({
      journal: context.journal,
      dataDirectory: context.dataDirectory,
      workspacePath: context.workspacePath,
      includeObservations: false,
    });
    sendJson(response, 200, {
      text: briefing.text,
      overdue: briefing.situation.overdueCommitments,
      dueSoon: briefing.situation.dueSoonCommitments,
      activeGoals: briefing.situation.activeGoals,
      selfModel: briefing.situation.selfModel,
      observations: briefing.observations.map((result) => ({
        connectorId: result.connectorId,
        count: result.observations.length,
        error: result.error,
      })),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, await context.agentSettings.get());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, { providers: await context.agentRegistry.list() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agents/install-missing") {
    try {
      const providers = await context.agentRegistry.list();
      const installed = [];
      for (const provider of providers.filter((provider) => !provider.installed)) {
        installed.push(await context.agentRegistry.install(provider.id));
      }
      sendJson(response, 200, { installed, providers: await context.agentRegistry.list() });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/governed/recall") {
    // The owner's way of asking "what will the twin actually remember from
    // this?" — recall against the one governed library, not a panel-only copy.
    // The answer is exactly what a worker assignment would receive.
    // 所有者问"分身到底会从这句话里想起什么"的方式——对唯一的受治理库做召回，
    // 而不是某个只在面板里存在的副本。答案就是 Worker 派发会收到的东西。
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) {
      sendJson(response, 400, { error: "A recall test needs at least two characters." });
      return;
    }
    const source = new GovernedMemorySource(context.dataDirectory);
    const matches = await source.recall(query, "recall-test");
    sendJson(response, 200, {
      query,
      matches: matches.map((match) => ({
        summary: match.memory.summary,
        score: match.score,
        matchedTerms: match.matchedTerms,
      })),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/reporting/bad-cases") {
    const text = await context.badCaseLog.readLog();
    sendJson(response, 200, { text });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/opportunities") {
    const opportunities = await context.opportunityService.list();
    sendJson(response, 200, { opportunities });
    return;
  }
  const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/(accept|dismiss)$/);
  if (request.method === "POST" && opportunityMatch?.[1] !== undefined && opportunityMatch?.[2] !== undefined) {
    const cardId = decodeURIComponent(opportunityMatch[1]);
    const accepted = opportunityMatch[2] === "accept";
    try {
      const card = await context.opportunityService.find(cardId);
      await context.opportunityService.resolve(cardId, accepted ? "accepted" : "dismissed");
      // Accepting must produce work, not just a resolved card. The trigger
      // alone leaves the run in `planning`, which no consumer ever picks up —
      // so the deterministic planner attaches a plan here and the run reaches
      // `queued`, where the same consumer that serves the chat takes it.
      // Otherwise "accept" is a button that creates a run which forever sits
      // unstarted, which is worse than no run at all: it looks like a promise.
      // 接受必须产生工作，而不只是一张被处置的卡片。仅 acceptTrigger 会把 Run 留在
      // `planning`，而没有任何消费者会捡起它——因此这里用确定性规划器附上计划，让 Run
      // 进入 `queued`，交给与聊天同一个消费者。否则“接受”就是一个创建出永远不启动的
      // Run 的按钮，比没有 Run 更糟：它看起来像一句承诺。
      let runId: string | undefined;
      if (accepted && card !== undefined) {
        const { run } = await context.runtime.acceptTrigger({
          kind: "signal",
          summary: card.title,
          payload: { opportunityId: card.id, source: card.source, whyNow: card.whyNow, trigger: "opportunity.accepted" },
        });
        const settings = await context.agentSettings.get();
        const enabled = new Set(settings.agents.filter((agent) => agent.enabled).map((agent) => agent.id));
        const plan = buildFallbackPlan(`${card.title}。${card.proposedResult}`, enabled);
        await context.runtime.attachPlan(run.id, {
          ...plan,
          // The card knew which commitment it served; the plan inheriting that
          // link is what lets the reconcile loop settle the commitment when
          // this run lands. Without it the run completes and the Friday it was
          // for stays open forever.
          // 卡片知道自己服务的是哪个承诺；计划继承这条联动，收敛环才能在这个 Run 落地时
          // 结算该承诺。没有它，Run 完成了，而它为之而做的那个周五永远悬而未结。
          ...(card.serves?.kind === "commitment" ? { servesCommitmentId: card.serves.id } : {}),
        });
        runId = run.id;
      }
      sendJson(response, 200, { decided: cardId, ...(runId === undefined ? {} : { runId }) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The opportunity could not be resolved." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/candidates") {
    const candidates = await context.memoryGovernance.pendingCandidates();
    sendJson(response, 200, { candidates });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory/governed") {
    // The .md files are the content layer the owner owns, and a hand edit made
    // in a text editor is as legitimate as one made here — so fold those edits
    // in before reading, or the GUI would show a stale view and quietly
    // overwrite work done outside it.
    // .md 文件是所有者拥有的内容层，在文本编辑器里做的手改与在这里做的一样正当——
    // 所以先把这些改动折回再读，否则 GUI 会显示过期视图，并悄悄覆盖在它之外完成的工作。
    let syncError: string | undefined;
    try {
      await context.memoryGovernance.syncFromFiles();
    } catch (error: unknown) {
      syncError = error instanceof Error ? error.message : "The memory files could not be read.";
    }
    const [memories, stats] = await Promise.all([
      context.memoryGovernance.list(),
      context.memoryGovernance.stats(),
    ]);
    sendJson(response, 200, { memories, stats, ...(syncError === undefined ? {} : { syncError }) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memory/governed/sync") {
    try {
      sendJson(response, 200, { synced: await context.memoryGovernance.syncFromFiles() });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The memory files could not be synced." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memory/governed") {
    const body = await readJsonBody(request);
    if (typeof body.summary !== "string" || body.summary.trim().length < 3) {
      sendJson(response, 400, { error: "A memory needs a summary of at least three characters." });
      return;
    }
    try {
      const memory = await context.memoryGovernance.author({
        summary: body.summary,
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(isMemoryType(body.type) ? { type: body.type } : {}),
        ...(isSensitivity(body.sensitivity) ? { sensitivity: body.sensitivity } : {}),
        ...(isConfidence(body.confidence) ? { confidence: body.confidence } : {}),
      });
      sendJson(response, 201, { memory });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be created." });
    }
    return;
  }
  const governedMatch = url.pathname.match(/^\/api\/memory\/governed\/([^/]+)$/);
  if (request.method === "PATCH" && governedMatch?.[1] !== undefined) {
    const id = decodeURIComponent(governedMatch[1]);
    const body = await readJsonBody(request);
    const update: Parameters<MemoryGovernance["update"]>[1] = {};
    if (typeof body.summary === "string") update.summary = body.summary;
    if (typeof body.content === "string") update.content = body.content;
    if (isMemoryType(body.type)) update.type = body.type;
    if (isSensitivity(body.sensitivity)) update.sensitivity = body.sensitivity;
    if (isConfidence(body.confidence)) update.confidence = body.confidence;
    const status = body.status === "active" || body.status === "archived" ? body.status : undefined;
    if (Object.keys(update).length === 0 && status === undefined) {
      sendJson(response, 400, { error: "A memory update needs at least one field." });
      return;
    }
    try {
      // Content first, then status: an archive is recorded with its own reason,
      // so folding it into the edit would lose why the memory went out of use.
      // 先内容后状态：归档会带着自己的原因入账，把它并进编辑就会丢掉"为什么不再使用"。
      let memory = Object.keys(update).length === 0
        ? undefined
        : await context.memoryGovernance.update(id, update);
      if (status !== undefined) {
        memory = status === "archived"
          ? await context.memoryGovernance.archive(id)
          : await context.memoryGovernance.restore(id);
      }
      sendJson(response, 200, { memory });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory could not be updated." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/context") {
    sendJson(response, 200, await buildContextView(context.dataDirectory));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/context/search") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) {
      sendJson(response, 400, { error: "A history search needs at least two characters." });
      return;
    }
    sendJson(response, 200, { query, excerpts: await searchHistory(context.dataDirectory, query, { limit: 12 }) });
    return;
  }
  const candidateDecisionMatch = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/(promote|reject)$/);
  if (request.method === "POST" && candidateDecisionMatch?.[1] !== undefined && candidateDecisionMatch?.[2] !== undefined) {
    const candidateId = decodeURIComponent(candidateDecisionMatch[1]);
    const action = candidateDecisionMatch[2];
    const body = await readJsonBody(request);
    try {
      if (action === "promote") {
        const candidate = (await context.memoryGovernance.pendingCandidates()).find((item) => item.id === candidateId);
        if (candidate === undefined) {
          sendJson(response, 404, { error: "The requested memory candidate does not exist or was already decided." });
          return;
        }
        const memory = await context.memoryGovernance.promote(candidate, {
          ...(typeof body.type === "string" ? { type: body.type as MemoryType } : {}),
          ...(typeof body.sensitivity === "string" ? { sensitivity: body.sensitivity as MemorySensitivity } : {}),
        });
        sendJson(response, 201, { memory });
      } else {
        await context.memoryGovernance.reject(candidateId, typeof body.reason === "string" ? body.reason : undefined);
        sendJson(response, 200, { decided: candidateId, action: "rejected" });
      }
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The memory decision could not be recorded." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    sendJson(response, 200, { schedules: (await context.schedules.list()).map(toScheduleView) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query : "";
    const kind = isScheduleKind(body.kind) ? body.kind : "daily";
    const time = typeof body.time === "string" ? body.time : undefined;
    const weekdays = Array.isArray(body.weekdays) && body.weekdays.every((day) => typeof day === "number") ? body.weekdays : undefined;
    const dayOfMonth = typeof body.dayOfMonth === "number" ? body.dayOfMonth : undefined;
    const month = typeof body.month === "number" ? body.month : undefined;
    const cron = typeof body.cron === "string" ? body.cron : undefined;
    const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : undefined;
    try {
      sendJson(response, 201, { schedule: toScheduleView(await context.schedules.add({ query, kind, time, weekdays, dayOfMonth, month, cron, intervalMinutes })) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The schedule is invalid." });
    }
    return;
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (request.method === "PATCH" && scheduleMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (typeof body.enabled !== "boolean") {
      sendJson(response, 400, { error: "A schedule update needs an enabled boolean." });
      return;
    }
    try {
      sendJson(response, 200, { schedule: toScheduleView(await context.schedules.setEnabled(decodeURIComponent(scheduleMatch[1]), body.enabled)) });
    } catch (error: unknown) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : "The schedule was not found." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/main-agent/stream") {
    const body = await readJsonBody(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 3) {
      sendJson(response, 400, { error: "Please describe the request in at least three characters." });
      return;
    }
    // Delay the SSE headers until the Main Agent lock is held. A busy session
    // must remain a readable 409, not an already-open stream.
    // 等到拿到 Main Agent 锁再发 SSE 头。会话正忙时必须仍是可读的 409，而不是已经打开的流。
    let streamOpen = false;
    const ensureStream = (): void => {
      if (streamOpen) return;
      streamOpen = true;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    };
    const send = (event: string, data: unknown): void => {
      ensureStream();
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await runMainAgentQuery(context.dataDirectory, text, {
        onDelta: (delta) => send("delta", { delta }),
      });
      send("done", result);
    } catch (error: unknown) {
      if (!streamOpen) {
        const busy = error instanceof MainAgentBusyError;
        sendJson(response, busy ? 409 : 500, {
          error: error instanceof Error ? error.message : "The Main Agent failed.",
        });
        return;
      }
      send("failed", { error: error instanceof Error ? error.message : "The Main Agent failed." });
    } finally {
      if (streamOpen) response.end();
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/main-agent/query") {
    const body = await readJsonBody(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 3) {
      sendJson(response, 400, { error: "Please describe the request in at least three characters." });
      return;
    }
    try {
      const result = await runMainAgentQuery(context.dataDirectory, text);
      sendJson(response, 200, result);
    } catch (error: unknown) {
      if (error instanceof MainAgentBusyError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/requests") {    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 3) {
      sendJson(response, 400, { error: "Please describe the work in at least three characters." });
      return;
    }
    const result = await runQuery(
      context.dataDirectory,
      query,
      {},
      await context.agentSettings.get(),
      { workspacePath: context.workspacePath },
    );
    sendJson(response, 201, result);
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    if (await context.sessions.isDeleted(runId)) {
      sendJson(response, 404, { error: "This session was removed from the local conversation list." });
      return;
    }
    sendJson(response, 200, await buildSession(context.dataDirectory, runId, await context.agentSettings.get()));
    return;
  }
  if (request.method === "DELETE" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    const { runs } = await loadRuntimeView(context.dataDirectory);
    if (!runs.some((run) => run.id === runId)) {
      sendJson(response, 404, { error: "The requested local session does not exist." });
      return;
    }
    await context.sessions.delete(runId);
    sendJson(response, 204, undefined);
    return;
  }

  const agentSettingMatch = url.pathname.match(/^\/api\/settings\/agents\/([^/]+)$/);
  if (request.method === "PATCH" && agentSettingMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    const update: { enabled?: boolean; providerId?: string } = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (typeof body.providerId === "string" && body.providerId.trim().length > 0) update.providerId = body.providerId;
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "An agent setting update needs an enabled boolean or providerId." });
      return;
    }
    try {
      sendJson(response, 200, await context.agentSettings.updateAgent(decodeURIComponent(agentSettingMatch[1]), update));
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The agent setting could not be updated." });
    }
    return;
  }

  const agentInstallMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/install$/);
  if (request.method === "POST" && agentInstallMatch?.[1] !== undefined) {
    const id = decodeURIComponent(agentInstallMatch[1]);
    if (id !== "codex-cli" && id !== "claude-code" && id !== "pi") {
      sendJson(response, 404, { error: "The requested local Agent is not supported." });
      return;
    }
    try {
      sendJson(response, 200, { provider: await context.agentRegistry.install(id) });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/memory/settings") {
    // Retired with the legacy memory store: recall is governed by the library
    // itself, and a second settings surface would describe a system that no
    // longer exists. Kept as an explicit 410 so a stale client learns why
    // instead of reading a 404 as "wrong path".
    // 随 legacy 记忆存储一同退役：召回由记忆库本身治理，第二个设置界面描述的是一套
    // 已不存在的系统。保留显式 410，使旧客户端能知道原因，而不是把 404 当成"路径错了"。
    sendJson(response, 410, { error: "The legacy memory store was retired; use the governed memory library." });
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
  if (request.method === "POST" && approvalMatch?.[1] !== undefined) {
    try {
      const result = await approveQueryRun(
        context.dataDirectory,
        decodeURIComponent(approvalMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be approved." });
    }
    return;
  }
  const rejectMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch?.[1] !== undefined) {
    try {
      const result = await rejectQueryRun(
        context.dataDirectory,
        decodeURIComponent(rejectMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be rejected." });
    }
    return;
  }
  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
    try {
      const result = await cancelQueryRun(
        context.dataDirectory,
        decodeURIComponent(cancelMatch[1]),
        await context.agentSettings.get(),
        { workspacePath: context.workspacePath },
      );
      sendJson(response, 200, result);
    } catch (error: unknown) {
      sendJson(response, runActionStatus(error), { error: error instanceof Error ? error.message : "The run could not be cancelled." });
    }
    return;
  }
  sendJson(response, 404, { error: "The local companion endpoint was not found." });
}

async function buildDashboard(dataDirectory: string, sessions: SessionStore): Promise<DashboardView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const deletedRunIds = await sessions.deletedRunIds();
  const visibleRuns = runs.filter((run) => !deletedRunIds.has(run.id));
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));

  const approvals = visibleRuns
    .filter((run) => run.status === "waiting_approval" && run.activeStepId !== undefined)
    .map((run) => ({
      runId: run.id,
      title: titleFor(run, tasks),
      stepId: run.activeStepId!,
      description: "The next step can affect an external system and needs your approval.",
    }));
  const active = visibleRuns
    .filter((run) => ["planning", "queued", "running", "verifying"].includes(run.status))
    .slice(0, 4)
    .map((run) => compactRun(run, tasks));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => visibleRunIds.has(subagent.runId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((subagent) => ({
      runId: subagent.runId,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const completed = visibleRuns
    .filter((run) => run.status === "completed")
    .slice(0, 4)
    .map((run) => ({ ...compactRun(run, tasks), evidenceCount: (state.evidenceByRun[run.id] ?? []).length }));
  const memories = events
    .filter((event) => event.type === "memory.candidate.proposed")
    .slice(-4)
    .reverse()
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        summary: typeof payload.summary === "string" ? payload.summary : "The system proposed a memory candidate.",
        confidence: typeof payload.confidence === "string" ? payload.confidence : "unknown",
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    counts: { approvals: approvals.length, active: active.length, completed: visibleRuns.filter((run) => run.status === "completed").length },
    approvals,
    active,
    subagents,
    completed,
    memories,
    sessions: visibleRuns.slice(0, 40).map((run) => toSessionSummary(run, tasks)),
    timeline: events.slice(-12).reverse().map(toTimelineItem),
  };
}

async function buildSession(dataDirectory: string, runId: string, settings: { agents: Array<{ id: string; providerId: string }> }): Promise<SessionView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error("The requested local session does not exist.");
  }

  const task = tasks[run.taskId];
  const trigger = events.find((event) => event.type === "trigger.received" && asRecord(event.payload).id === task?.triggerId);
  const query = typeof asRecord(trigger?.payload).summary === "string" ? String(asRecord(trigger?.payload).summary) : titleFor(run, tasks);
  const providerByRole = new Map(settings.agents.map((agent) => [agent.id, agent.providerId]));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => subagent.runId === run.id)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .map((subagent) => ({
      id: subagent.id,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      providerId: subagent.providerId ?? providerByRole.get(subagent.agentId) ?? "unknown",
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const evidenceCount = (state.evidenceByRun[run.id] ?? []).length;
  const plan = run.planId === undefined ? undefined : state.plans[run.planId];
  const approvals = run.status === "waiting_approval" && run.activeStepId !== undefined
    ? [{ runId: run.id, stepId: run.activeStepId, description: "下一步会影响外部系统，需要你的确认。" }]
    : [];
  const runEvents = events.filter((event) => event.runId === run.id);
  const recalledMemories = runEvents
    .filter((event) => event.type === "memory.recalled")
    .flatMap((event) => {
      const payload = asRecord(event.payload);
      const memories = Array.isArray(payload.memories) ? payload.memories : [];
      return memories.map((memory) => asRecord(memory)).filter((memory) => typeof memory.summary === "string").map((memory) => ({
        id: String(memory.id ?? ""),
        summary: String(memory.summary),
        score: typeof memory.score === "number" ? memory.score : 0,
        matchedTerms: Array.isArray(memory.matchedTerms) ? memory.matchedTerms.filter((term): term is string => typeof term === "string") : [],
      }));
    });

  return {
    ...toSessionSummary(run, tasks),
    query,
    evidenceCount,
    plan: plan === undefined
      ? undefined
      : {
        summary: displayPlanSummary(plan.summary),
        steps: plan.steps.map((step) => ({
          id: step.id,
          title: displayPlanStepTitle(step.title),
          risk: step.risk,
          delegated: step.subagents !== undefined,
        })),
      },
    subagents,
    approvals,
    messages: buildConversation(run, query, subagents.length, evidenceCount, runEvents, recalledMemories.length),
    recalledMemories,
    activity: runEvents.slice(-16).reverse().map(toTimelineItem),
    trace: runEvents.map(toTraceItem),
  };
}

async function loadRuntimeView(dataDirectory: string) {
  // Read through the same seam the writers use: hardcoding JSONL here would
  // silently show an empty history whenever the owner enables SQLite.
  // 通过写入端使用的同一 seam 读取：在此写死 JSONL 会导致所有者启用 SQLite 后
  // 界面悄悄显示空历史。
  const journal = createJournalStore(dataDirectory);
  try {
    const events = await journal.list();
    const state = replay(events);
    const tasks = state.tasks;
    const runs = Object.values(state.runs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { events, state, tasks, runs };
  } finally {
    // This runs per request; an unclosed SQLite handle would accumulate one
    // open file per page view. 每个请求都会走到这里；不关闭的 SQLite 句柄会随着每次
    // 页面访问不断累积。
    (journal as { close?: () => void }).close?.();
  }
}

function toSessionSummary(run: Run, tasks: Record<string, Task>): SessionSummary {
  return {
    id: run.id,
    title: titleFor(run, tasks),
    status: run.status,
    updatedAt: run.updatedAt,
    preview: previewForStatus(run.status),
  };
}

function buildConversation(
  run: Run,
  query: string,
  subagentCount: number,
  evidenceCount: number,
  events: JournalEvent[],
  recalledMemoryCount: number,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ id: `user-${run.id}`, role: "person", text: query, occurredAt: run.createdAt }];
  const plan = events.find((event) => event.type === "plan.created");
  if (plan !== undefined) {
    messages.push({
      id: `plan-${run.id}`,
      role: "clone",
      text: subagentCount > 0
        ? `我已把这件事拆成 ${subagentCount} 个可追踪的子任务，并会在每一步保留证据。`
        : "我已准备好一份有边界的执行计划，并会在关键动作前检查权限。",
      occurredAt: plan.occurredAt,
    });
  }

  if (recalledMemoryCount > 0) {
    messages.push({
      id: `memory-${run.id}`,
      role: "clone",
      text: `I used ${recalledMemoryCount} active local memory item${recalledMemoryCount === 1 ? "" : "s"} as context for this work.`,
      occurredAt: plan?.occurredAt ?? run.createdAt,
    });
  }

  if (run.status === "waiting_approval") {
    messages.push({
      id: `approval-${run.id}`,
      role: "clone",
      text: "准备工作已经完成。下一步会影响外部系统，我需要你确认后才会继续。",
      occurredAt: run.updatedAt,
      tone: "approval",
    });
  } else if (run.status === "completed") {
    messages.push({
      id: `complete-${run.id}`,
      role: "clone",
      text: `已完成并验证结果${evidenceCount > 0 ? `，附有 ${evidenceCount} 条证据` : ""}。你可以在下方查看执行记录。`,
      occurredAt: run.updatedAt,
      tone: "success",
    });
  } else if (run.status === "failed" || run.status === "cancelled") {
    messages.push({
      id: `blocked-${run.id}`,
      role: "clone",
      text: "这条工作暂时没有安全地完成。我保留了当前进度和原因，等待你决定下一步。",
      occurredAt: run.updatedAt,
      tone: "warning",
    });
  } else {
    messages.push({
      id: `progress-${run.id}`,
      role: "clone",
      text: "我正在按计划推进，并持续检查权限、证据和可恢复性。",
      occurredAt: run.updatedAt,
    });
  }
  return messages;
}

function previewForStatus(status: Run["status"]): string {
  if (status === "waiting_approval") return "等待你的确认";
  if (status === "completed") return "已完成并验证";
  if (status === "failed" || status === "cancelled") return "需要处理";
  return "正在推进";
}

function compactRun(run: Run, tasks: Record<string, Task>): { runId: string; title: string; status: string; updatedAt: string } {
  return { runId: run.id, title: titleFor(run, tasks), status: run.status, updatedAt: run.updatedAt };
}

function titleFor(run: Run, tasks: Record<string, Task>): string {
  return tasks[run.taskId]?.title ?? "Unnamed work";
}

function displayPlanSummary(summary: string): string {
  return summary === "Prepare with parallel child agents, review their evidence, then wait before an external action."
    ? "旧版演示会先在本地准备，再在外部动作前等待你的确认。"
    : summary;
}

function displayPlanStepTitle(title: string): string {
  const legacyTitles: Record<string, string> = {
    "Prepare the work safely": "在本地准备结果",
    "Perform the external action": "执行外部操作",
  };
  return legacyTitles[title] ?? title;
}

function toScheduleView(schedule: LocalSchedule): ScheduleView {
  return {
    id: schedule.id,
    query: schedule.query,
    kind: schedule.kind,
    time: schedule.time,
    weekdays: schedule.weekdays,
    dayOfMonth: schedule.dayOfMonth,
    month: schedule.month,
    cron: schedule.cron,
    intervalMinutes: schedule.intervalMinutes,
    description: describeSchedule(schedule),
    enabled: schedule.enabled,
    lastRunKey: schedule.lastRunKey,
  };
}

function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly" || value === "cron" || value === "interval";
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === "fact" || value === "preference" || value === "procedure" || value === "decision" || value === "commitment";
}

function isSensitivity(value: unknown): value is MemorySensitivity {
  return value === "public" || value === "private" || value === "secret";
}

function isConfidence(value: unknown): value is MemoryCandidate["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * What the Main Agent's context looks like right now.
 *
 * The number worth showing is entriesOutOfContext: how much of the
 * conversation the model can no longer see but that is still on disk. Every
 * other figure here is scale; that one is the gap search_history closes.
 *
 * Main Agent 当前上下文的样子。
 *
 * 真正值得展示的数字是 entriesOutOfContext：对话中模型已经看不到、但仍在磁盘上的
 * 那部分有多少。这里其他数字都只是规模；只有这一个，是 search_history 所要弥合的缺口。
 */
async function buildContextView(dataDirectory: string) {
  const [history, conversations, current] = await Promise.all([
    describeHistory(dataDirectory),
    listOwnerConversations(dataDirectory),
    readCurrentSessionPointer(mainAgentSessionDirectory(dataDirectory)),
  ]);
  const active = current ?? conversations[0]?.path;
  return {
    ...history,
    directory: mainAgentSessionDirectory(dataDirectory),
    ...(active === undefined ? {} : { activeSession: active }),
    conversations: conversations.map((row) => ({
      path: row.path,
      messages: row.messages,
      preview: row.preview,
      updatedAt: new Date(row.mtimeMs).toISOString(),
      active: row.path === active,
    })),
  };
}

function toTraceItem(event: JournalEvent): TraceItem {
  return { ...toTimelineItem(event), sequence: event.sequence, type: event.type };
}

function toTimelineItem(event: JournalEvent): { label: string; detail: string; occurredAt: string } {
  const payload = asRecord(event.payload);
  const labels: Partial<Record<JournalEvent["type"], string>> = {
    "trigger.received": "Received a trigger",
    "task.created": "Created work",
    "run.created": "Started a run",
    "run.status_changed": "Updated run status",
    "plan.created": "Prepared a plan",
    "policy.decided": "Checked authority",
    "approval.granted": "Recorded your approval",
    "execution.started": "Started a step",
    "execution.progress": "Execution progress",
    "subagent.dispatched": "Dispatched a child agent",
    "subagent.resumed": "Resumed a child agent",
    "subagent.session_started": "Child-agent session started",
    "subagent.progress": "Child-agent progress",
    "subagent.completed": "Child agent returned evidence",
    "subagent.failed": "Child agent failed",
    "subagent.cancelled": "Child agent cancelled",
    "subagent.verified": "Verified child-agent evidence",
    "dispatch.decided": "Routed to a worker",
    "dispatch.blocked": "Dispatch blocked",
    "agent.installed": "Installed a worker",
    "agent.install_failed": "Worker installation failed",
    "agent.message_delta": "Agent streamed a message",
    "agent.tool_started": "Agent started a tool",
    "agent.tool_completed": "Agent finished a tool",
    "evidence.recorded": "Recorded evidence",
    "verification.completed": "Verified the result",
    "memory.candidate.requested": "Queued memory review",
    "memory.candidate.proposed": "Proposed memory candidate",
    "memory.recalled": "Recalled local memory",
  };
  return { label: labels[event.type] ?? event.type, detail: detailFor(event.type, payload), occurredAt: event.occurredAt };
}

function detailFor(type: JournalEvent["type"], payload: Record<string, unknown>): string {
  if ((type === "execution.progress" || type === "subagent.progress") && typeof payload.message === "string") {
    return payload.message;
  }
  if (type === "subagent.resumed") {
    return `Attempt ${String(payload.attempt ?? "?")} resumed for ${String(payload.workOrderId ?? "a work order")}.`;
  }
  if (type === "subagent.session_started" && typeof payload.sessionId === "string") {
    return `Session ${payload.sessionId} started.`;
  }
  if (type === "subagent.verified" && typeof payload.summary === "string") {
    return payload.summary;
  }
  if (type === "agent.message_delta" && typeof payload.text === "string") {
    return payload.text;
  }
  if ((type === "agent.tool_started" || type === "agent.tool_completed") && typeof payload.tool === "string") {
    return String(payload.tool);
  }
  if (type === "policy.decided") {
    const decision = asRecord(payload.decision);
    return decision.outcome === "approval_required"
      ? "An external action needs your approval."
      : decision.outcome === "allowed"
        ? "This local, reversible step may continue."
        : "The current policy did not allow this step.";
  }
  if (type === "verification.completed") {
    return typeof payload.summary === "string" ? payload.summary : "Recorded the verification result.";
  }
  if (type === "memory.recalled") {
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    return `Used ${memories.length} active local memory item${memories.length === 1 ? "" : "s"} as task context.`;
  }
  if (type === "dispatch.decided") {
    const sourceLabels: Record<string, string> = {
      explicit: "the owner explicitly requested",
      rule: "capability and priority rules",
      memory: "past outcomes in memory",
      description: "worker self-descriptions",
    };
    const source = typeof payload.source === "string" ? payload.source : "rule";
    const worker = typeof payload.selectedAgentId === "string" ? payload.selectedAgentId : "?";
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return `Selected ${worker} (${sourceLabels[source] ?? source})${reason ? `. ${reason}` : ""}`;
  }
  if (type === "dispatch.blocked") {
    const code = typeof payload.code === "string" ? payload.code : "";
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    return `No worker could run this task (${code}). ${reason}`;
  }
  if (type === "agent.installed") {
    return `Installed ${String(payload.agentId ?? "a worker")}${typeof payload.version === "string" ? ` (${payload.version})` : ""}.`;
  }
  if (type === "agent.install_failed") {
    return `Installation of ${String(payload.agentId ?? "a worker")} failed: ${String(payload.message ?? "")}`;
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  if (typeof payload.title === "string") {
    return payload.title;
  }
  return "Recorded in the local journal.";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Candidates are no longer synced into any recall source.
 *
 * A mined candidate is a proposal. Copying it into an active memory store made
 * it reachable by the next task's recall before the owner ever saw it — the
 * exact memory pollution the governance layer exists to prevent. Candidates now
 * stay in the journal until the owner promotes them through MemoryGovernance.
 *
 * 候选不再被同步进任何召回来源。
 *
 * 提炼出的候选只是提案。把它拷贝进活跃记忆库，会让它在所有者见到之前就能被下一个任务
 * 召回——这正是治理层要防止的记忆污染。候选现在留在 Journal 中，直到所有者经
 * MemoryGovernance 提升它们。
 */

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_000) {
      throw new Error("The local request body is too large.");
    }
  }
  return body.length === 0 ? {} : asRecord(JSON.parse(body) as unknown);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function runActionStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Unknown run:")) return 404;
  if (message.includes("is not waiting for an approval") || message.includes("cannot be cancelled")) return 409;
  return 500;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("CLONE_AI_PORT must be a TCP port between 0 and 65535.");
  }
  return port;
}

interface DashboardView {
  generatedAt: string;
  counts: { approvals: number; active: number; completed: number };
  approvals: Array<{ runId: string; title: string; stepId: string; description: string }>;
  active: Array<{ runId: string; title: string; status: string; updatedAt: string }>;
  subagents: Array<{ runId: string; title: string; agentId: string; role: string; status: string; summary?: string; updatedAt: string }>;
  completed: Array<{ runId: string; title: string; status: string; updatedAt: string; evidenceCount: number }>;
  memories: Array<{ summary: string; confidence: string }>;
  sessions: SessionSummary[];
  timeline: Array<{ label: string; detail: string; occurredAt: string }>;
}

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  preview: string;
}

interface ConversationMessage {
  id: string;
  role: "person" | "clone";
  text: string;
  occurredAt: string;
  tone?: "approval" | "success" | "warning";
}

interface SessionView extends SessionSummary {
  query: string;
  evidenceCount: number;
  plan?: {
    summary: string;
    steps: Array<{ id: string; title: string; risk: string; delegated: boolean }>;
  };
  subagents: Array<{ id: string; title: string; agentId: string; role: string; providerId: string; status: string; summary?: string; updatedAt: string }>;
  approvals: Array<{ runId: string; stepId: string; description: string }>;
  messages: ConversationMessage[];
  recalledMemories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>;
  activity: Array<{ label: string; detail: string; occurredAt: string }>;
  trace: TraceItem[];
}

interface TraceItem {
  sequence: number;
  type: string;
  label: string;
  detail: string;
  occurredAt: string;
}

interface ScheduleView {
  id: string;
  query: string;
  kind: ScheduleKind;
  time?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  cron?: string;
  intervalMinutes?: number;
  description: string;
  enabled: boolean;
  lastRunKey?: string;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/companion-server.ts") === true) {
  void startCompanionServer()
    .then((companion) => {
      console.log(`clone-ai desktop companion preview: ${companion.url}`);
      const shutdown = (): void => {
        void companion.close().then(() => process.exit(0), () => process.exit(1));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      logJson("error", "companion failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}
