/**
 * One-line JSON logs for the daemon. Journal remains the source of truth;
 * these lines exist so a stuck queue or a failed Run is greppable without
 * opening SQLite. Stderr so CLI stdout stays a human transcript.
 * Daemon 的单行 JSON 日志。Journal 仍是事实来源；这些行的存在，是为了卡住的队列
 * 或失败的 Run 不用打开 SQLite 也能被 grep 到。写到 stderr，好让 CLI 的 stdout
 * 继续是给人读的记录。
 */

export type LogLevel = "info" | "warn" | "error";

export function logJson(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  process.stderr.write(`${line}\n`);
}
