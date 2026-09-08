import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DailyReportRunner, localDayKey } from "../src/reporting/daily-report-runner.ts";
import { buildDailyReport } from "../src/reporting/daily-report.ts";
import { sendEmail } from "../src/reporting/smtp-sender.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";

/** A scripted SMTP server that records the conversation for assertions. 记录对话的脚本化 SMTP 服务器。 */
async function fakeSmtp(t: TestContext): Promise<{ port: number; transcript: string[] }> {
  const transcript: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.write("220 fake.local ESMTP\r\n");
    let inData = false;
    let dataLines: string[] = [];
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (line.length === 0) continue;
        transcript.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 OK queued\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fake.local\r\n250 AUTH LOGIN\r\n");
        else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
        else if (line === "dXNlcg==") socket.write("334 UGFzc3dvcmQ6\r\n");
        else if (line === "cGFzcw==") socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 End data\r\n"); }
        else if (line === "QUIT") socket.write("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { port: address.port, transcript };
}

const smtpFor = (port: number) => ({
  host: "127.0.0.1",
  port,
  user: "user",
  pass: "pass",
  from: "clone-ai@local",
  to: "owner@example.com",
});

test("sendEmail completes the full SMTP conversation", async (t) => {
  const { port, transcript } = await fakeSmtp(t);

  await sendEmail(smtpFor(port), { subject: "主题", text: "正文" });

  assert.ok(transcript.some((line) => line.startsWith("EHLO")));
  assert.ok(transcript.includes("AUTH LOGIN"));
  assert.ok(transcript.includes("dXNlcg==") && transcript.includes("cGFzcw=="), "AUTH LOGIN must send base64 user and password");
  assert.ok(transcript.some((line) => line.startsWith("MAIL FROM:<clone-ai@local>")));
  assert.ok(transcript.some((line) => line.startsWith("RCPT TO:<owner@example.com>")));
  assert.ok(transcript.some((line) => line === "QUIT"));
  const dataStart = transcript.indexOf("DATA");
  assert.ok(dataStart >= 0);
  const data = transcript.slice(dataStart + 1).join("\n");
  assert.match(data, /From: clone-ai@local/);
  assert.match(data, /To: owner@example.com/);
  assert.match(data, /Subject: 主题/);
  assert.match(data, /正文/);
});

test("buildDailyReport lists yesterday's bad cases with journal sequences", () => {
  const report = buildDailyReport({
    date: new Date("2026-08-19T09:00:00.000Z"),
    events: [
      { id: "a", sequence: 12, type: "run.status_changed", occurredAt: "2026-08-18T10:00:00.000Z", runId: "r1", payload: { status: "failed", reason: "Worker exhausted its budget." } },
      { id: "b", sequence: 13, type: "dispatch.blocked", occurredAt: "2026-08-18T11:00:00.000Z", payload: { reason: "codex not installed" } },
      { id: "c", sequence: 14, type: "run.status_changed", occurredAt: "2026-08-18T12:00:00.000Z", runId: "r2", payload: { status: "completed" } },
    ],
    opportunities: [{ title: "承诺即将到期：提交季度报告", whyNow: "24 小时内", source: "deadline" }],
  });

  assert.equal(report.counts.badCases, 2);
  assert.match(report.text, /\[seq 12\] run.status_changed \(run r1\)/);
  assert.match(report.text, /\[seq 13\] dispatch.blocked/);
  assert.doesNotMatch(report.text, /seq 14/);
  assert.match(report.text, /承诺即将到期/);
});

test("DailyReportRunner sends once per local day and skips afterwards", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  let now = new Date("2026-08-19T09:00:00.000Z");
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: true, smtp: smtpFor(port) },
    opportunities: async () => [],
    now: () => now,
  });

  assert.equal(await runner.maybeSend(), "sent");
  assert.equal(await runner.maybeSend(), "skipped");
  const before = transcript.length;

  // A second day sends again.
  // 第二天会再次发送。
  now = new Date("2026-08-20T09:00:00.000Z");
  assert.equal(await runner.maybeSend(), "sent");
  assert.ok(transcript.length > before);
});

test("disabled reporting never sends and does not write a marker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-off-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: false, smtp: { host: "127.0.0.1", port: 1, from: "a@b", to: "c@d" } },
    opportunities: async () => [],
    now: () => new Date("2026-08-19T09:00:00.000Z"),
  });

  assert.equal(await runner.maybeSend(), "disabled");
  const fs = await import("node:fs/promises");
  await assert.rejects(fs.readFile(join(directory, "reporting", "last-sent.json")));
});

test("DailyReportRunner waits until the configured local hour", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-hour-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  let now = new Date(2026, 7, 19, 8, 0, 0);
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: true, hour: 9, smtp: smtpFor(port) },
    opportunities: async () => [],
    now: () => now,
  });

  assert.equal(await runner.maybeSend(), "skipped");
  assert.equal(transcript.filter((line) => line.startsWith("MAIL FROM")).length, 0);

  now = new Date(2026, 7, 19, 9, 0, 0);
  assert.equal(await runner.maybeSend(), "sent");
  assert.ok(transcript.some((line) => line.startsWith("MAIL FROM")));
});

test("localDayKey uses the local calendar day", () => {
  assert.equal(localDayKey(new Date(2026, 7, 19, 23, 59)), "2026-08-19");
  assert.equal(localDayKey(new Date(2026, 7, 20, 0, 1)), "2026-08-20");
});
