import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Loopback-only access control for the companion daemon.
 *
 * Binding to 127.0.0.1 is not authentication: any local process, or a
 * browser page that rebinds DNS onto loopback, can otherwise approve runs
 * and install CLIs. A per-boot bearer plus a Host/Origin check closes that.
 *
 * Companion Daemon 的仅回环访问控制。
 *
 * 绑到 127.0.0.1 不是鉴权：本机任意进程，或把 DNS  rebound 到回环的网页，都能批准
 * Run、安装 CLI。每次启动一张 bearer，再加上 Host/Origin 检查，才能把这个口封上。
 */
export function issueCompanionToken(): string {
  return randomBytes(32).toString("hex");
}

export async function persistCompanionToken(dataDirectory: string, token: string): Promise<string> {
  const path = join(dataDirectory, "companion.token");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows cannot always chmod 0600; the file still lives in the owner's home.
    // Windows 不一定能 chmod 0600；文件仍然只在所有者主目录里。
  }
  return path;
}

export function loopbackHostname(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.trim().length === 0) return undefined;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function originIsLoopback(origin: string | undefined, listenPort: number): boolean {
  if (origin === undefined || origin.length === 0) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!isLoopbackHostname(url.hostname.toLowerCase())) return false;
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return port === listenPort;
  } catch {
    return false;
  }
}

export function readBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}

export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isUnauthenticatedCompanionPath(method: string, pathname: string): boolean {
  if (method === "GET" && pathname === "/api/health") return true;
  if (method === "GET" && (pathname === "/" || pathname === "/style.css" || pathname === "/app.js")) return true;
  return false;
}

export function authorizeCompanionRequest(input: {
  method: string;
  pathname: string;
  hostHeader: string | undefined;
  originHeader: string | undefined;
  authorization: string | undefined;
  token: string;
  listenPort: number;
}): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  if (isUnauthenticatedCompanionPath(input.method, input.pathname)) return { ok: true };
  const hostname = loopbackHostname(input.hostHeader);
  if (!isLoopbackHostname(hostname)) {
    return { ok: false, status: 403, error: "Companion APIs are loopback-only." };
  }
  if (!originIsLoopback(input.originHeader, input.listenPort)) {
    return { ok: false, status: 403, error: "Companion APIs reject a non-loopback Origin." };
  }
  if (!tokensMatch(input.token, readBearerToken(input.authorization))) {
    return { ok: false, status: 401, error: "Companion APIs require a bearer token." };
  }
  return { ok: true };
}

export function injectCompanionToken(html: string, token: string): string {
  const tag = `<script>window.CLONE_AI_TOKEN=${JSON.stringify(token)};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
}
