/**
 * Cheap local checks before a candidate becomes durable memory: fingerprint
 * dedup and a regex PII sweep. Not a vector index and not a compliance scanner.
 * 候选成为持久记忆前的廉价本地检查：指纹去重与正则 PII 扫描。不是向量索引，
 * 也不是合规扫描器。
 */
import { createHash } from "node:crypto";

export type MemoryPiiKind = "email" | "phone" | "private_key" | "token" | "payment_card";

interface PiiRule {
  kind: MemoryPiiKind;
  pattern: RegExp;
  replace: string;
}

const PII_RULES: readonly PiiRule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    replace: "[redacted private key]",
  },
  { kind: "token", pattern: /\b(sk|rk)-[A-Za-z0-9_-]{8,}\b/g, replace: "[redacted token]" },
  { kind: "token", pattern: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: "[redacted token]" },
  { kind: "token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, replace: "Bearer [redacted]" },
  {
    kind: "token",
    pattern: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi,
    replace: "$1=[redacted]",
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[redacted email]",
  },
  {
    kind: "phone",
    pattern: /\b(?:\+?\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    replace: "[redacted phone]",
  },
  { kind: "phone", pattern: /\b1[3-9]\d{9}\b/g, replace: "[redacted phone]" },
  {
    kind: "payment_card",
    pattern: /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,
    replace: "[redacted card]",
  },
];

/**
 * Stable identity of a memory summary after Unicode and whitespace folding.
 * 折叠 Unicode 与空白后的记忆摘要稳定身份。
 */
export function memoryFingerprint(text: string): string {
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function scanMemoryPii(text: string): MemoryPiiKind[] {
  const found = new Set<MemoryPiiKind>();
  for (const rule of PII_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (pattern.test(text)) found.add(rule.kind);
  }
  return [...found];
}

export function redactMemoryPii(text: string): { text: string; kinds: MemoryPiiKind[] } {
  const kinds = scanMemoryPii(text);
  let next = text;
  for (const rule of PII_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    next = next.replace(pattern, rule.replace);
  }
  return { text: next, kinds };
}
