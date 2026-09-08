import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeCompanionRequest,
  injectCompanionToken,
  isLoopbackHostname,
  loopbackHostname,
  originIsLoopback,
  tokensMatch,
} from "../src/companion-auth.ts";

test("loopback hostnames are the only accepted Host values", () => {
  assert.equal(loopbackHostname("127.0.0.1:4317"), "127.0.0.1");
  assert.equal(loopbackHostname("localhost:4317"), "localhost");
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("evil.example"), false);
});

test("an Origin on another host or port is refused", () => {
  assert.equal(originIsLoopback(undefined, 4317), true);
  assert.equal(originIsLoopback("http://127.0.0.1:4317", 4317), true);
  assert.equal(originIsLoopback("http://127.0.0.1:9999", 4317), false);
  assert.equal(originIsLoopback("http://example.com", 4317), false);
});

test("bearer comparison is length-safe and rejects a missing token", () => {
  assert.equal(tokensMatch("abcd", "abcd"), true);
  assert.equal(tokensMatch("abcd", "abce"), false);
  assert.equal(tokensMatch("abcd", undefined), false);
});

test("unauthenticated approve is 401; a non-loopback Host is 403", () => {
  const denied = authorizeCompanionRequest({
    method: "POST",
    pathname: "/api/runs/run-1/approve",
    hostHeader: "127.0.0.1:4317",
    originHeader: undefined,
    authorization: undefined,
    token: "secret",
    listenPort: 4317,
  });
  assert.deepEqual(denied, { ok: false, status: 401, error: "Companion APIs require a bearer token." });

  const foreign = authorizeCompanionRequest({
    method: "POST",
    pathname: "/api/runs/run-1/approve",
    hostHeader: "evil.example",
    originHeader: undefined,
    authorization: "Bearer secret",
    token: "secret",
    listenPort: 4317,
  });
  assert.deepEqual(foreign, { ok: false, status: 403, error: "Companion APIs are loopback-only." });
});

test("health and the GUI assets stay reachable without a bearer", () => {
  for (const pathname of ["/", "/style.css", "/app.js", "/api/health"]) {
    const allowed = authorizeCompanionRequest({
      method: "GET",
      pathname,
      hostHeader: "127.0.0.1:4317",
      originHeader: undefined,
      authorization: undefined,
      token: "secret",
      listenPort: 4317,
    });
    assert.equal(allowed.ok, true, pathname);
  }
});

test("the served HTML receives the companion token", () => {
  const html = injectCompanionToken("<html><head></head><body></body></html>", "tok");
  assert.match(html, /window\.CLONE_AI_TOKEN="tok"/);
});
