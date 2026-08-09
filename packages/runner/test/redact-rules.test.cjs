"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { REDACTED, MIN_SECRET_LENGTH, isMaskableValue, redactionPatterns, redactSecrets, redactDeep } = require("../redact-rules.cjs");

const b64 = s => Buffer.from(s, "utf8").toString("base64");

test("redactSecrets: masks an exact value and one embedded mid-line", () => {
  // The common shapes: a bare `echo $TOK` line and a token spliced into a command.
  const p = redactionPatterns(["ghp_secrettokenvalue"]);
  assert.equal(redactSecrets("ghp_secrettokenvalue", p), REDACTED);
  assert.equal(redactSecrets("prefix_ghp_secrettokenvalue_suffix", p), `prefix_${REDACTED}_suffix`);
  assert.equal(redactSecrets("a ghp_secrettokenvalue b ghp_secrettokenvalue", p), `a ${REDACTED} b ${REDACTED}`);
});

test("redactSecrets: no patterns / no text is a pass-through, never a crash", () => {
  // reportStatus masks EVERY report, including the pre-secrets claim — the
  // empty-pattern path is the hot one, not an edge case.
  const text = "=== git clone ===\nexit code: 0\n";
  assert.equal(redactSecrets(text, []), text);
  assert.equal(redactSecrets(text, null), text);
  assert.equal(redactSecrets("", ["secretvalue"]), "");
  assert.equal(redactSecrets(undefined, ["secretvalue"]), undefined);
});

test("redactionPatterns: base64(value) — a token written into a config file", () => {
  const value = "ghp_secrettokenvalue";
  const p = redactionPatterns([value]);
  assert.ok(p.includes(b64(value)));
  assert.equal(redactSecrets(`config: ${b64(value)}`, p), `config: ${REDACTED}`);
  assert.ok(p.includes(Buffer.from(value, "utf8").toString("base64url")));
});

test("redactionPatterns: base64(user:token) is masked as ONE unit", () => {
  // The docker-config shape a registry login writes. Matching only the raw
  // values would leave the composite (and therefore the credential) intact.
  const user = "ghcr-robot", token = "ghp_secrettokenvalue";
  const p = redactionPatterns([user, token]);
  assert.ok(p.includes(b64(`${user}:${token}`)));
  const docker = `{"auths":{"ghcr.io":{"auth":"${b64(`${user}:${token}`)}"}}}`;
  const out = redactSecrets(docker, p);
  assert.ok(!out.includes(b64(`${user}:${token}`)));
  assert.equal(out, `{"auths":{"ghcr.io":{"auth":"${REDACTED}"}}}`);
});

test("redactionPatterns: the URL-encoded spelling", () => {
  // A token spliced into a query string or form body.
  const value = "p@ss word/with+chars";
  const p = redactionPatterns([value]);
  assert.ok(p.includes(encodeURIComponent(value)));
  assert.equal(redactSecrets(`token=${encodeURIComponent(value)}&x=1`, p), `token=${REDACTED}&x=1`);
});

test("redactionPatterns: ordered longest-first so a composite isn't shredded by its parts", () => {
  const p = redactionPatterns(["alpha-user-name", "beta-token-value"]);
  for (let i = 1; i < p.length; i++) assert.ok(p[i - 1].length >= p[i].length);
});

test("redactionPatterns: duplicate values don't multiply the pattern set", () => {
  const dup = redactionPatterns(["secret-one", "secret-one", "secret-two"]);
  assert.equal(dup.length, redactionPatterns(["secret-one", "secret-two"]).length);
});

test("redactDeep: masks the stepResults sink — nested strings, never keys", () => {
  // stepResults carries up to 8000 chars of raw stdout/stderr per step and is an
  // INDEPENDENT sink from rawLogs; object keys are secret NAMES, not values.
  const p = redactionPatterns(["ghp_secrettokenvalue"]);
  const steps = [
    { name: "login", passed: true, out: "authenticated with ghp_secrettokenvalue", err: "" },
    { name: "publish", passed: false, err: "401 for ghp_secrettokenvalue", nested: { token: "ghp_secrettokenvalue" } },
  ];
  const out = redactDeep(steps, p);
  assert.ok(Array.isArray(out));
  assert.equal(out[0].out, `authenticated with ${REDACTED}`);
  assert.equal(out[1].err, `401 for ${REDACTED}`);
  assert.equal(out[1].nested.token, REDACTED);
  assert.equal(out[0].name, "login");
  assert.ok(!JSON.stringify(out).includes("ghp_secrettokenvalue"));

  const keyed = redactDeep({ GHCR_TOKEN: "ghp_secrettokenvalue" }, p);
  assert.deepEqual(Object.keys(keyed), ["GHCR_TOKEN"]);
  assert.equal(keyed.GHCR_TOKEN, REDACTED);
});

test("redactDeep: non-string scalars pass through untouched", () => {
  const p = redactionPatterns(["ghp_secrettokenvalue"]);
  const out = redactDeep({ exitCode: 1, passed: false, finishedAt: null }, p);
  assert.deepEqual(out, { exitCode: 1, passed: false, finishedAt: null });
  assert.deepEqual(redactDeep({ a: [1, "b"] }, []), { a: [1, "b"] });
});

test("short and deny-listed values produce NO patterns — no `***` soup", () => {
  // A real secret bag holds `DEBUG=1` and `NODE_ENV=production`. Masking those
  // would bury the very signal the log exists for.
  assert.deepEqual(redactionPatterns(["1", "true", "production", "main"]), []);
  const line = "1 test passed in production mode: true (on main)\n";
  assert.equal(redactSecrets(line, redactionPatterns(["1", "true", "production", "main"])), line);

  assert.equal(isMaskableValue("x".repeat(MIN_SECRET_LENGTH - 1)), false);
  assert.equal(isMaskableValue("x".repeat(MIN_SECRET_LENGTH)), true);
  assert.equal(isMaskableValue("  TRUE  "), false); // deny-list is trimmed + case-insensitive
  assert.equal(isMaskableValue(12345678), false);   // only strings are values here
});
