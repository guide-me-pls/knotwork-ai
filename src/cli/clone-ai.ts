#!/usr/bin/env node
/**
 * The clone-ai command line. One binary, subcommands, no npm scripts.
 *
 * `clone-ai "..."` is a conversation with the Main Agent, exactly like the
 * other coding agents on your machine. Everything else is a subcommand.
 *
 * clone-ai 命令行：一个可执行文件、若干子命令，不再需要 npm scripts。
 *
 * `clone-ai "..."` 就是与 Main Agent 对话，用法与你机器上其他 Coding Agent 一致；
 * 其余功能都是子命令。
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { createMainAgentSession } from "../main-agent/session.ts";
import { createKernelRuntime } from "../main-agent/tools/kernel-tools.ts";
import { MainAgentBusyError, withMainAgentLock } from "../main-agent/prompt-lock.ts";
import { BadCaseLog } from "../reporting/bad-case-log.ts";
import { OpportunityService } from "../opportunity/opportunity-service.ts";
import { createJournalStore } from "../core/sqlite-journal.ts";
import { WorkerRegistry } from "../workers/worker-registry.ts";
import { MdMemoryStore } from "../memory/md-memory-store.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `clone-ai — your local digital twin runtime

Usage:
  clone-ai "<请求>"              Talk to the Main Agent (default)
  clone-ai app [--port <n>]      Open the desktop app window (closing it exits)
  clone-ai gui [--port <n>]      Same server, opened in your default browser
  clone-ai status                Show runs, workers, memory, and bad cases
  clone-ai workers               List worker CLIs and whether they are installed
  clone-ai install <worker>      Install a missing worker (npm global)
  clone-ai sessions              List Main Agent conversations
  clone-ai resume <n>            Continue conversation number <n> (see sessions)
  clone-ai new "<请求>"           Start a fresh conversation
  clone-ai memory [query]        List or search reviewed memories
  clone-ai cases                 Print the local bad-case log
  clone-ai opportunities         List open opportunity cards
  clone-ai approve <runId>       Approve a run waiting for confirmation
  clone-ai reject <runId>        Reject a run waiting for confirmation
  clone-ai cancel <runId>        Cancel a queued, running, or waiting run
  clone-ai bench [--provider p]  Run the reliability benchmark
  clone-ai doctor                Check the local setup
  clone-ai --help | --version

Data lives in your clone home (~/.clone-ai by default, or CLONE_AI_DATA_DIR).`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
    console.log(pkg.version);
    return 0;
  }

  const paths = resolveClonePaths();
  await prepareCloneHome(paths);
  await migrateLegacyCloneHome({
    legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
    targetDirectory: paths.dataDirectory,
  });

  switch (command) {
    case "app": return startApp(argv.slice(1), paths.dataDirectory);
    case "gui": return startGui(argv.slice(1));
    case "status": return showStatus(paths.dataDirectory);
    case "workers": return listWorkers(paths.dataDirectory);
    case "install": return installWorker(paths.dataDirectory, argv[1]);
    case "sessions": return listSessions(paths.dataDirectory);
    case "resume": return resumeSession(paths.dataDirectory, argv[1]);
    case "new": return converse(paths.dataDirectory, argv.slice(1).join(" ").trim(), true);
    case "memory": return showMemory(paths.dataDirectory, argv.slice(1).join(" ").trim());
    case "cases": return showCases(paths.dataDirectory);
    case "opportunities": return showOpportunities(paths.dataDirectory);
    case "approve": return decideRun(paths.dataDirectory, argv[1], "approve");
    case "reject": return decideRun(paths.dataDirectory, argv[1], "reject");
    case "cancel": return decideRun(paths.dataDirectory, argv[1], "cancel");
    case "bench": return runBench(argv.slice(1));
    case "doctor": return doctor(paths.dataDirectory);
    default: return converse(paths.dataDirectory, argv.join(" ").trim());
  }
}

/** Default path: a conversation turn with the Main Agent. 默认路径：与 Main Agent 的一轮对话。 */
async function converse(dataDirectory: string, query: string, fresh = false): Promise<number> {
  if (query.length < 2) {
    console.error('Please describe what you want. Example: clone-ai "整理今天要推进的事情"');
    return 1;
  }
  try {
    await withMainAgentLock(dataDirectory, async () => {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const { session } = await createMainAgentSession({
        dataDirectory,
        // A fresh conversation is explicit; the default continues the last one.
        // 新会话是显式选择；默认续上一次对话。
        ...(fresh ? { sessionManager: SessionManager.create(dataDirectory, join(dataDirectory, "pi-sessions", "main-agent")) } : {}),
      });
      if (fresh) {
        const file = session.sessionManager.getSessionFile();
        if (file !== undefined) {
          const { writeCurrentSessionPointer } = await import("../main-agent/session.ts");
          await writeCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"), file);
        }
      }
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
      });
      try {
        await session.prompt(query);
        process.stdout.write("\n");
      } finally {
        session.dispose();
      }
    });
  } catch (error: unknown) {
    if (error instanceof MainAgentBusyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  await drainQueuedRuns(dataDirectory);
  return 0;
}

/**
 * Executes whatever the conversation just queued, before the process exits.
 *
 * The Main Agent proposes plans through the Kernel, which journals them as
 * `queued`. In the GUI a long-lived consumer picks those up; in the CLI there
 * is none, so without this the twin would say "I've started on that" and then
 * exit having run nothing. The rule is that the system never claims to have
 * accepted work it has no intention of performing: either an executor takes
 * over here, or the owner is told the work is only saved.
 *
 * 在进程退出前，执行本次对话刚刚排队的工作。
 *
 * Main Agent 通过 Kernel 提案，Kernel 会把它们以 `queued` 记入 Journal。GUI 里有常驻
 * 消费者会接走；CLI 里没有，因此若不做这件事，分身会说“我已经开始做了”然后什么都没
 * 跑就退出。规则是：系统绝不声称接受了一份它根本不打算执行的工作——要么这里有执行者
 * 接手，要么明确告知所有者“仅保存、尚未执行”。
 */
async function drainQueuedRuns(dataDirectory: string): Promise<void> {
  const { createRuntimeAssembly } = await import("../core/runtime-factory.ts");
  const { RunQueueConsumer } = await import("../application/run-queue.ts");
  const { createConfiguredAgentRegistry } = await import("../workers/configured-worker-registry.ts");
  const { WorkerSettingsStore } = await import("../config/worker-settings.ts");

  const paths = resolveClonePaths({ dataDirectory });
  const assembly = await createRuntimeAssembly({ dataDirectory });
  const { runtime, journal } = assembly;
  try {
    await runtime.refresh();
    const pending = runtime.listRuns().filter((run) => run.status === "queued");
    if (pending.length === 0) return;

    const settings = new WorkerSettingsStore(paths.legacyAgentsFile);
    const consumer = new RunQueueConsumer({
      runtime,
      journal,
      registry: async () => createConfiguredAgentRegistry(
        (await settings.get()).agents,
        { dataDirectory, workspacePath: paths.workspacePath },
      ),
      onError: (runId, error) => {
        console.error(`\nRun ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    console.log(`\nExecuting ${pending.length} queued run(s)...`);
    const started = await consumer.tick();
    await consumer.stop();
    await runtime.refresh();

    for (const runId of started) {
      const run = runtime.getRun(runId);
      console.log(`  ${run.status === "completed" ? "✓" : run.status === "waiting_approval" ? "⏸" : "✗"} ${runId.slice(0, 8)} → ${run.status}`);
    }
    // A run another process already claimed is not silently dropped: the owner
    // is told where it went. 已被其他进程领取的 Run 不会被静默丢弃：告知所有者它去了哪里。
    const unclaimed = pending.filter((run) => !started.includes(run.id));
    if (unclaimed.length > 0) {
      console.log(`  ${unclaimed.length} run(s) are being executed by another Clone AI process.`);
    }
  } finally {
    assembly.close();
  }
}

/**
 * The desktop experience: a real window, and the daemon lives exactly as long
 * as that window does.
 * 桌面体验：一个真实窗口，daemon 的生命周期与该窗口完全一致。
 */
async function startApp(args: string[], dataDirectory: string): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? args[portIndex + 1] : undefined;
  const { startCompanionServer } = await import("../companion-server.ts");
  const { openAppWindow, appProfileDirectory } = await import("./app-window.ts");
  const server = await startCompanionServer(port === undefined ? {} : { port: Number(port) });

  const window = openAppWindow({ url: server.url, profileDirectory: appProfileDirectory(dataDirectory) });
  if (window === undefined) {
    console.log(`No Chromium-family engine found for an app window. Serving at ${server.url}`);
    console.log("Install Microsoft Edge or Google Chrome, or use: clone-ai gui");
    openBrowser(server.url);
    await new Promise<void>((resolve) => process.on("SIGINT", () => void server.close().then(resolve, resolve)));
    return 0;
  }

  console.log(`clone-ai is running in a desktop window (${server.url}). Close the window to exit.`);
  await Promise.race([
    window.closed,
    new Promise<void>((resolve) => process.on("SIGINT", resolve)),
  ]);
  await server.close();
  return 0;
}

/** Starts the companion daemon and opens the browser at its URL. 启动 companion 并在浏览器打开。 */
async function startGui(args: string[]): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? args[portIndex + 1] : undefined;
  const { startCompanionServer } = await import("../companion-server.ts");
  const server = await startCompanionServer(port === undefined ? {} : { port: Number(port) });
  console.log(`clone-ai GUI: ${server.url}`);
  openBrowser(server.url);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      void server.close().then(resolve, resolve);
    });
  });
  return 0;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
}

async function showStatus(dataDirectory: string): Promise<number> {
  const runtime = await createKernelRuntime(dataDirectory);
  const runs = runtime.listRuns();
  const recent = runs.slice(-5).reverse();
  const workers = await new WorkerRegistry(dataDirectory).list();
  const store = new MdMemoryStore({ dataDirectory });
  const memory = await store.stats();
  store.close();
  const cases = (await new BadCaseLog({ dataDirectory }).readLog()).split("\n").filter((line) => line.startsWith("- [seq")).length;

  console.log(`Runs: ${runs.length} total`);
  for (const run of recent) console.log(`  ${run.id.slice(0, 8)}  ${run.status.padEnd(16)} ${run.updatedAt}`);
  console.log(`Workers: ${workers.filter((worker) => worker.installed).map((worker) => worker.id).join(", ") || "none installed"}`);
  console.log(`Memory: ${memory.active} active, ${memory.archived} archived`);
  console.log(`Bad cases logged: ${cases}`);
  return 0;
}

async function listWorkers(dataDirectory: string): Promise<number> {
  for (const worker of await new WorkerRegistry(dataDirectory).list()) {
    const mark = worker.installed ? "✓" : worker.installable ? "·" : "✗";
    console.log(`${mark} ${worker.id.padEnd(14)} ${worker.command.padEnd(16)} ${worker.version ?? (worker.installed ? "" : "not installed")}`);
  }
  console.log("\n✓ installed · installable (clone-ai install <id>) ✗ no automatic installer");
  return 0;
}

async function installWorker(dataDirectory: string, id: string | undefined): Promise<number> {
  if (id === undefined) {
    console.error("Usage: clone-ai install <worker-id>");
    return 1;
  }
  const { installWorkerAgent } = await import("../main-agent/tools/kernel-tools.ts");
  const result = await installWorkerAgent(dataDirectory, id);
  console.log(result.installed ? `Installed ${id}${result.version ? ` (${result.version})` : ""}.` : `Failed: ${result.error}`);
  return result.installed ? 0 : 1;
}

/** Lists persisted Main Agent conversations, newest first. 列出已持久化的 Main Agent 对话，新的在前。 */
async function listSessions(dataDirectory: string): Promise<number> {
  const { listOwnerConversations, readCurrentSessionPointer } = await import("../main-agent/session.ts");
  const rows = await listOwnerConversations(dataDirectory);
  if (rows.length === 0) {
    console.log('No conversations yet. Start one: clone-ai "你好"');
    return 0;
  }
  const current = await readCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"));
  console.log("  #  when              msgs  preview");
  for (const [index, row] of rows.entries()) {
    const marker = row.path === current ? "*" : " ";
    const when = new Date(row.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
    console.log(`${marker} ${String(index + 1).padStart(2)}  ${when}  ${String(row.messages).padStart(4)}  ${row.preview}`);
  }
  console.log('\n* is the conversation `clone-ai "..."` continues. Switch with `clone-ai resume <n>`, or start fresh with `clone-ai new "..."`.');
  return 0;
}

/** Points every entry point (CLI and GUI) at the chosen conversation. 把所有入口（CLI 与 GUI）指向所选对话。 */
async function resumeSession(dataDirectory: string, choice: string | undefined): Promise<number> {
  const { listOwnerConversations, writeCurrentSessionPointer } = await import("../main-agent/session.ts");
  const rows = await listOwnerConversations(dataDirectory);
  const index = Number(choice);
  if (!Number.isInteger(index) || index < 1 || index > rows.length) {
    console.error(`Usage: clone-ai resume <n>  (1..${rows.length || 1}; see clone-ai sessions)`);
    return 1;
  }
  const row = rows[index - 1]!;
  await writeCurrentSessionPointer(join(dataDirectory, "pi-sessions", "main-agent"), row.path);
  console.log(`Continuing conversation #${index} (${row.messages} msgs): ${row.preview || "(no preview)"}`);
  console.log("The GUI and the CLI now share this conversation.");
  return 0;
}

async function showMemory(dataDirectory: string, query: string): Promise<number> {
  const store = new MdMemoryStore({ dataDirectory });
  try {
    if (query.length > 0) {
      const matches = await store.recall(query);
      if (matches.length === 0) console.log("No matching memories.");
      for (const match of matches) console.log(`[${match.score.toFixed(2)}] ${match.entry.summary}`);
      return 0;
    }
    const entries = await store.list({ status: "active" });
    if (entries.length === 0) console.log("No memories yet.");
    for (const entry of entries) console.log(`- (${entry.type}) ${entry.summary}`);
    return 0;
  } finally {
    store.close();
  }
}

async function showCases(dataDirectory: string): Promise<number> {
  const text = await new BadCaseLog({ dataDirectory }).readLog();
  console.log(text.trim().length === 0 ? "No bad cases recorded yet." : text);
  return 0;
}

async function showOpportunities(dataDirectory: string): Promise<number> {
  const journal = createJournalStore(dataDirectory);
  try {
    const service = new OpportunityService(journal);
    await service.scanAndRecord();
    const cards = await service.list();
    if (cards.length === 0) console.log("No open opportunities.");
    for (const card of cards) console.log(`- [${card.source}] ${card.title}\n    ${card.whyNow}`);
    return 0;
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function decideRun(dataDirectory: string, runId: string | undefined, action: "approve" | "reject" | "cancel"): Promise<number> {
  if (runId === undefined || runId.trim().length === 0) {
    console.error(`Usage: clone-ai ${action} <runId>`);
    return 1;
  }
  const { approveQueryRun, cancelQueryRun, rejectQueryRun } = await import("../application/run-query.ts");
  const fn = action === "approve" ? approveQueryRun : action === "reject" ? rejectQueryRun : cancelQueryRun;
  const result = await fn(dataDirectory, runId.trim());
  console.log(`${action} ${result.runId.slice(0, 8)} → ${result.status}`);
  return 0;
}

async function runBench(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(packageRoot, "benchmark", "run.ts"), ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function doctor(dataDirectory: string): Promise<number> {
  console.log(`clone home: ${dataDirectory}`);
  console.log(`node: ${process.version} (${process.platform})`);
  const workers = await new WorkerRegistry(dataDirectory).list();
  const installed = workers.filter((worker) => worker.installed);
  console.log(`workers installed: ${installed.length}/${workers.length}`);
  for (const worker of workers) {
    console.log(`  ${worker.installed ? "✓" : "✗"} ${worker.id} → ${worker.command}`);
  }
  if (installed.length === 0) {
    console.log("\nNo worker CLI found. Install one, e.g.: clone-ai install pi");
    return 1;
  }
  console.log("\nReady. Try: clone-ai \"读一下 README 并总结三点\"");
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
