"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_MAX_AGE_MS, janitorMaxAgeMs,
  isSandboxContainerName, isSandboxNetworkName,
  isStaleSandboxContainer, isStaleSandboxNetwork,
} = require("../janitor-rules.cjs");

const NOW = 1_800_000_000_000;
const H = 3600_000;

test("janitorMaxAgeMs: default on unset/empty/garbage; 0 disables", () => {
  assert.equal(janitorMaxAgeMs(undefined), DEFAULT_MAX_AGE_MS);
  assert.equal(janitorMaxAgeMs(""), DEFAULT_MAX_AGE_MS);       // compose ${VAR:-} empty string
  assert.equal(janitorMaxAgeMs("garbage"), DEFAULT_MAX_AGE_MS);
  assert.equal(janitorMaxAgeMs("0"), 0);
  assert.equal(janitorMaxAgeMs("-5"), 0);
  assert.equal(janitorMaxAgeMs("7200000"), 7_200_000);
});

test("name matchers accept only the exact sandbox scheme", () => {
  assert.ok(isSandboxContainerName("clawhub-run-8ac4c99e7f514a0cbb"));
  assert.ok(isSandboxContainerName("clawhub-prx-8ac4c99e7f514a0cbb"));
  assert.ok(isSandboxNetworkName("clawhub-egr-8ac4c99e7f514a0cbb"));
  // Never touch the product's own services or anything else on the host.
  assert.ok(!isSandboxContainerName("clawhub-postgres-1"));
  assert.ok(!isSandboxContainerName("clawhub-api-1"));
  assert.ok(!isSandboxContainerName("clawhub-run-"));
  assert.ok(!isSandboxContainerName("clawhub-run-UPPER!"));
  assert.ok(!isSandboxNetworkName("bridge"));
  assert.ok(!isSandboxNetworkName("clawhub_default"));
});

test("containers: stale only past maxAge; age alone decides (running or not)", () => {
  const name = "clawhub-run-abcdef123456";
  assert.ok(isStaleSandboxContainer({ name, createdAtMs: NOW - 4 * H }, NOW, 3 * H));
  assert.ok(!isStaleSandboxContainer({ name, createdAtMs: NOW - 2 * H }, NOW, 3 * H));
  // disabled janitor never matches; bad timestamps never match
  assert.ok(!isStaleSandboxContainer({ name, createdAtMs: NOW - 40 * H }, NOW, 0));
  assert.ok(!isStaleSandboxContainer({ name, createdAtMs: NaN }, NOW, 3 * H));
  // non-sandbox names never match even when ancient
  assert.ok(!isStaleSandboxContainer({ name: "clawhub-postgres-1", createdAtMs: NOW - 40 * H }, NOW, 3 * H));
});

test("networks: stale only when EMPTY and past maxAge", () => {
  const name = "clawhub-egr-abcdef123456";
  assert.ok(isStaleSandboxNetwork({ name, createdAtMs: NOW - 4 * H, containerCount: 0 }, NOW, 3 * H));
  // a network still holding containers is left for the next sweep
  assert.ok(!isStaleSandboxNetwork({ name, createdAtMs: NOW - 40 * H, containerCount: 1 }, NOW, 3 * H));
  assert.ok(!isStaleSandboxNetwork({ name, createdAtMs: NOW - 2 * H, containerCount: 0 }, NOW, 3 * H));
  assert.ok(!isStaleSandboxNetwork({ name: "bridge", createdAtMs: NOW - 40 * H, containerCount: 0 }, NOW, 3 * H));
});
