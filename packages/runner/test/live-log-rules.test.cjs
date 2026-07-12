"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { liveLogSnapshot } = require("../live-log-rules.cjs");

test("liveLogSnapshot: no in-flight step returns rawLogs unchanged", () => {
  const finished = "=== step: build ===\nexit code: 0\n\n";
  assert.equal(liveLogSnapshot(finished, "", ""), finished);
  // A label with no output yet (command just started, nothing streamed) stays a no-op.
  assert.equal(liveLogSnapshot(finished, "step: test", ""), finished);
});

test("liveLogSnapshot: appends the live tail under an '(in progress)' header", () => {
  const finished = "=== step: build ===\nexit code: 0\n\n";
  const out = liveLogSnapshot(finished, "step: test", "running tests...\n3 passed\n");
  assert.equal(out, `${finished}=== step: test (in progress) ===\nrunning tests...\n3 passed\n`);
});

test("liveLogSnapshot: grows monotonically as more output streams in (poll-friendly)", () => {
  const a = liveLogSnapshot("", "build", "compiling");
  const b = liveLogSnapshot("", "build", "compiling...\ndone");
  assert.ok(b.length > a.length);
  assert.ok(b.startsWith(a));
});

test("liveLogSnapshot: never mutates the finalized rawLogs it was given", () => {
  const finished = "=== step: a ===\nexit code: 0\n\n";
  liveLogSnapshot(finished, "step: b", "some output");
  assert.equal(finished, "=== step: a ===\nexit code: 0\n\n");
});
