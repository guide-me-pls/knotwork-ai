/**
 * DailyReportRunner: sends at most one report email per local day.
 *
 * The "last sent" marker is a small JSON file, so a restart in the middle of
 * the day does not double-send. Sending is deliberately conservative: no
 * configured SMTP, no email.
 *
 * DailyReportRunner：每个本地日最多发送一封报告邮件。
 *
 * "上次发送"标记是一个小 JSON 文件，因此当天中途重启不会重复发送。发送刻意保守：
 * 未配置 SMTP 就不发邮件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JournalStore } from "../core/journal.ts";
import type { SmtpConfig } from "./smtp-sender.ts";
import { sendEmail } from "./smtp-sender.ts";
import { buildDailyReport } from "./daily-report.ts";
import type { OpportunityCard } from "../opportunity/opportunity.ts";

export interface DailyReportSettings {
  enabled: boolean;
  smtp: SmtpConfig;
  /** Local hour to send, 0-23. 本地发送时刻（小时）。 */
  hour?: number;
}

export interface DailyReportRunnerOptions {
  journal: JournalStore;
  dataDirectory: string;
  settings: DailyReportSettings;
  opportunities: () => Promise<OpportunityCard[]>;
  now?: () => Date;
}

export class DailyReportRunner {
  readonly #journal: JournalStore;
  readonly #settings: DailyReportSettings;
  readonly #markerPath: string;
  readonly #opportunities: () => Promise<OpportunityCard[]>;
  readonly #now: () => Date;

  constructor(options: DailyReportRunnerOptions) {
    this.#journal = options.journal;
    this.#settings = options.settings;
    this.#markerPath = join(options.dataDirectory, "reporting", "last-sent.json");
    this.#opportunities = options.opportunities;
    this.#now = options.now ?? (() => new Date());
  }

  /** Called on a tick; sends only when the local day changed since last send. 在 tick 中调用；仅当本地日变化后才发送。 */
  async maybeSend(): Promise<"sent" | "skipped" | "disabled"> {
    if (!this.#settings.enabled) return "disabled";
    const now = this.#now();
    const hour = this.#settings.hour;
    if (hour !== undefined) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new Error("Daily report hour must be an integer 0-23.");
      }
      // hour is local. Sending before it would ignore the owner's chosen time.
      // hour 是本地时。在此之前发送等于忽略所有者选定的时刻。
      if (now.getHours() < hour) return "skipped";
    }
    const today = localDayKey(now);
    if (today === await this.#lastSentDay()) return "skipped";
    await this.#send(now);
    await this.#remember(today);
    return "sent";
  }

  async #send(now: Date): Promise<void> {
    const events = await this.#journal.list();
    const since = new Date(now);
    since.setDate(since.getDate() - 1);
    const recent = events.filter((event) => new Date(event.occurredAt) >= since);
    const opportunities = await this.#opportunities();
    const report = buildDailyReport({ events: recent, opportunities, date: now });
    await sendEmail(this.#settings.smtp, { subject: report.subject, text: report.text });
  }

  async #lastSentDay(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#markerPath, "utf8")) as { day?: unknown };
      return typeof parsed.day === "string" ? parsed.day : undefined;
    } catch {
      return undefined;
    }
  }

  async #remember(day: string): Promise<void> {
    await mkdir(dirname(this.#markerPath), { recursive: true });
    await writeFile(this.#markerPath, `${JSON.stringify({ day })}\n`, "utf8");
  }
}

/** Local calendar day key, e.g. 2026-08-19. 本地日历日键。 */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
