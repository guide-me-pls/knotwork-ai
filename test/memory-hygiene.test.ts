import assert from "node:assert/strict";
import test from "node:test";

import { memoryFingerprint, redactMemoryPii, scanMemoryPii } from "../src/memory/memory-hygiene.ts";

test("memory fingerprints ignore case and extra whitespace", () => {
  assert.equal(
    memoryFingerprint("Release  Review"),
    memoryFingerprint("release review"),
  );
});

test("PII scan finds an email and redacts it", () => {
  const text = "Write to owner@example.com before the release.";
  assert.deepEqual(scanMemoryPii(text), ["email"]);
  const redacted = redactMemoryPii(text);
  assert.match(redacted.text, /\[redacted email\]/);
  assert.doesNotMatch(redacted.text, /owner@example.com/);
});
