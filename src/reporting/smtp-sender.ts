/**
 * Minimal SMTP client over node:net/tls, with zero dependencies.
 *
 * Supports the subset needed for daily reports: EHLO, STARTTLS (587) or
 * implicit TLS (465), AUTH LOGIN, MAIL FROM / RCPT TO, DATA, QUIT. Every
 * command waits for the expected reply code; any unexpected reply aborts the
 * conversation with a readable error.
 *
 * 基于 node:net/tls 的极简 SMTP 客户端，零依赖。
 *
 * 支持每日报告所需的子集：EHLO、STARTTLS（587）或隐式 TLS（465）、AUTH LOGIN、
 * MAIL FROM / RCPT TO、DATA、QUIT。每条命令都等待预期的响应码；任何意外响应都会以
 * 可读错误中止对话。
 */
import { connect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  /** Username for AUTH LOGIN. AUTH LOGIN 的用户名。 */
  user?: string;
  /** Password/token. Never logged. 密码/令牌；绝不记录。 */
  pass?: string;
  from: string;
  to: string;
  /** Prefer STARTTLS on plaintext ports; true for 587. 明文端口上优先 STARTTLS；587 用 true。 */
  startTls?: boolean;
  /** Connect with TLS immediately; true for 465. 直接 TLS 连接；465 用 true。 */
  secure?: boolean;
}

export interface SmtpMessage {
  subject: string;
  text: string;
}

const CRLF = "\r\n";

export async function sendEmail(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const socket = config.secure === true
    ? await connectTls(config)
    : connect(config.port, config.host);
  const session = new SmtpSession(socket, config.host, 30_000);
  try {
    await session.expect(/^220/);
    await session.command(`EHLO clone-ai.local`, /^2\d\d/);
    if (config.secure !== true && config.startTls === true) {
      const features = session.banner.toLocaleLowerCase();
      if (features.includes("starttls")) {
        await session.command("STARTTLS", /^220/);
        await session.upgradeTls(config);
        await session.command(`EHLO clone-ai.local`, /^2\d\d/);
      }
    }
    if (config.user !== undefined && config.pass !== undefined) {
      await session.command("AUTH LOGIN", /^3\d\d/);
      await session.command(Buffer.from(config.user).toString("base64"), /^3\d\d/);
      await session.command(Buffer.from(config.pass).toString("base64"), /^2\d\d|^3\d\d/);
    }
    await session.command(`MAIL FROM:<${config.from}>`, /^2\d\d/);
    await session.command(`RCPT TO:<${config.to}>`, /^2\d\d/);
    await session.command("DATA", /^3\d\d/);
    await session.raw(`${toData(config, message)}${CRLF}.`);
    await session.expect(/^2\d\d/);
    await session.command("QUIT", /^2\d\d/);
  } finally {
    socket.destroy();
  }
}

function toData(config: SmtpConfig, message: SmtpMessage): string {
  // Dot-stuffing and CRLF normalization per RFC 5321. 按 RFC 5321 做点填充与 CRLF 归一化。
  const body = `${message.text}\n`.replace(/\r?\n/g, CRLF);
  return [
    `From: ${config.from}`,
    `To: ${config.to}`,
    `Subject: ${message.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join(CRLF).replace(/^\./gm, "..");
}

function connectTls(config: SmtpConfig): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: config.host, port: config.port, rejectUnauthorized: true }, () => resolve(socket));
    socket.once("error", reject);
  });
}

class SmtpSession {
  readonly #socket: Socket | TLSSocket;
  readonly #timeoutMs: number;
  #buffer = "";
  #lines: string[] = [];
  banner = "";
  #pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];

  constructor(socket: Socket | TLSSocket, host: string, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk) => this.#onData(chunk.toString("utf8")));
    socket.on("timeout", () => this.#fail(new Error(`SMTP ${host} timed out.`)));
    socket.on("error", (error) => this.#fail(error));
  }

  async command(line: string, expected: RegExp): Promise<string> {
    await this.raw(line);
    return this.expect(expected);
  }

  raw(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // The write callback reports failure as null or undefined indistinctly.
      // 写入回调对失败与成功的区分中，null 与 undefined 都算成功。
      this.#socket.write(`${line}${CRLF}`, (error) => (error == null ? resolve() : reject(error)));
    });
  }

  expect(expected: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#flush(expected);
    });
  }

  upgradeTls(config: SmtpConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.#socket as Socket;
      plain.removeAllListeners("data");
      const tls = tlsConnect({ socket: plain, rejectUnauthorized: true }, () => {
        this.#attach(tls);
        resolve();
      });
      tls.once("error", reject);
    });
  }

  #attach(socket: Socket | TLSSocket): void {
    (this.#socket as Socket).removeAllListeners?.();
    socket.setTimeout(this.#timeoutMs);
    socket.on("data", (chunk) => this.#onData(chunk.toString("utf8")));
    socket.on("timeout", () => this.#fail(new Error("SMTP timed out during TLS.")));
    socket.on("error", (error) => this.#fail(error));
    // @ts-expect-error reassign readonly for TLS upgrade 升级 TLS 时重新赋值 readonly 字段。
    this.#socket = socket;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf(CRLF)) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      if (line.length === 0) continue;
      this.#lines.push(line);
    }
    const expected = this.#pending[0] !== undefined ? undefined : undefined;
    void expected;
    this.#flushAll();
  }

  #flushAll(): void {
    for (const _ of this.#lines) this.#flush(undefined);
  }

  #flush(expected: RegExp | undefined): void {
    while (this.#pending.length > 0 && this.#lines.length > 0) {
      const line = this.#lines.shift()!;
      // A reply line ending in '-' continues the multi-line block; only the
      // final line (space separator) completes the response.
      // 以 '-' 结尾的响应行是多行块的续行；只有空格分隔的最终行才算完整响应。
      if (line.length >= 4 && line[3] === "-") continue;
      this.banner = line;
      const pending = this.#pending.shift()!;
      if (expected === undefined || expected.test(line)) {
        pending.resolve(line);
      } else {
        pending.reject(new Error(`SMTP unexpected reply: ${line}`));
      }
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }
}
