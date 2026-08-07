"use strict";
// #131 leg 2: a repo secret must not be able to name itself into the guard-exempt
// infra list. Secret NAMES are tenant-controlled verbatim (routes/secrets.ts takes
// the name from the URL path), so `X_BASE_URL=http://169.254.169.254` used to make
// the proxy treat cloud metadata as operator-trusted infra — a self-service
// exemption from the SSRF guard, under every policy including `egress: none`.
//   node --test packages/runner/test/infra-hosts.test.cjs

const test = require("node:test");
const assert = require("node:assert/strict");

const { hostOf, AI_PROVIDER_HOSTS, deriveInfraHosts, deriveSoftInfraHosts } = require("../infra-hosts.cjs");

const HOSTILE_SECRETS = {
  X_BASE_URL: "http://169.254.169.254",
  OPENAI_BASE_URL: "http://127.0.0.1:5432",
  ANOTHER_BASE_URL: "http://10.0.0.7",
  CLAWHUB_URL: "http://172.17.0.1:3000",
};

test("hostOf: URL, bare host:port, bracketed AND bare v6, garbage", () => {
  assert.equal(hostOf("https://Api.Example.com/v1/x"), "api.example.com");
  assert.equal(hostOf("api.example.com:8443"), "api.example.com");
  assert.equal(hostOf("http://[::ffff:7f00:1]:80"), "::ffff:7f00:1");
  // A BARE IPv6 literal is not a valid URL authority without brackets, so it must
  // be recognised first — otherwise the operator escape hatch below silently
  // swallows the most natural way to spell an infra address.
  assert.equal(hostOf("fd00::1"), "fd00::1");
  assert.equal(hostOf("FD00::1"), "fd00::1");
  assert.equal(hostOf("[fd00::2]"), "fd00::2");
  assert.equal(hostOf(undefined), null);
  assert.equal(hostOf(""), null);
  assert.equal(hostOf("http://"), null);
});

test("hard infra comes ONLY from runner config — no CI secret can enter it", () => {
  const infra = deriveInfraHosts({ baseUrl: "https://api.useclawhub.com", env: {} });
  assert.deepEqual(infra, ["api.useclawhub.com"]);
  // A pipeline run passes NO serverBuiltSecrets, so the hostile bag cannot reach
  // the guard-exempt tier however it is named.
  const pipelineRun = deriveInfraHosts({ baseUrl: "https://api.useclawhub.com", env: {}, serverBuiltSecrets: null });
  for (const bad of ["169.254.169.254", "127.0.0.1", "10.0.0.7", "172.17.0.1"]) {
    assert.ok(!pipelineRun.includes(bad), `${bad} must never be guard-exempt infra`);
  }
  assert.deepEqual(pipelineRun, ["api.useclawhub.com"]);
});

// A STANDING run's bag is authored end-to-end by the API (standingRunEnv), so its
// CLAWHUB_URL is the operator's public URL — the one self-host case that genuinely
// needs the exemption. Only that key is trusted, never the tenant *_BASE_URL keys.
test("a standing run's server-built CLAWHUB_URL is hard infra; its other keys are not", () => {
  const infra = deriveInfraHosts({
    baseUrl: "http://localhost:3000", env: {},
    serverBuiltSecrets: { CLAWHUB_URL: "http://192.168.1.10:3000", ANTHROPIC_BASE_URL: "http://169.254.169.254" },
  });
  assert.deepEqual(infra.sort(), ["192.168.1.10", "localhost"]);
  assert.ok(!infra.includes("169.254.169.254"));
});

test("a legitimately-private operator base URL is still hard infra (single-box self-host)", () => {
  assert.deepEqual(deriveInfraHosts({ baseUrl: "http://10.0.0.5:3000", env: {} }), ["10.0.0.5"]);
  assert.deepEqual(deriveInfraHosts({ baseUrl: "http://host.docker.internal:3000", env: {} }), ["host.docker.internal"]);
});

test("the operator escape hatch adds hosts (incl. a bare IPv6); a tenant has no equivalent", () => {
  const infra = deriveInfraHosts({
    baseUrl: "https://api.useclawhub.com",
    env: { CLAWHUB_RUNNER_INFRA_HOSTS: "models.internal:8000, 10.1.2.3 , fd00::1,[fd00::2]," },
  });
  assert.deepEqual(infra.sort(), ["10.1.2.3", "api.useclawhub.com", "fd00::1", "fd00::2", "models.internal"]);
});

test("tenant *_BASE_URL and the secrets CLAWHUB_URL land in SOFT infra, which stays guarded", () => {
  const soft = deriveSoftInfraHosts(HOSTILE_SECRETS);
  // They ARE reachable-by-policy (so a real BYO gateway keeps working)...
  assert.ok(soft.includes("169.254.169.254"));
  assert.ok(soft.includes("172.17.0.1"));
  // ...but soft infra is subject to the private-IP guard, so the proxy refuses
  // them anyway. That contract is asserted in egress-proxy.test.cjs; here the
  // point is simply that they are NOT in the guard-exempt list.
  const hard = deriveInfraHosts({ baseUrl: "https://api.useclawhub.com", env: {} });
  for (const h of soft) if (h !== "api.useclawhub.com") assert.ok(!hard.includes(h), `${h} leaked into hard infra`);
});

test("soft infra keeps a legitimate BYO gateway and the provider domains", () => {
  const soft = deriveSoftInfraHosts({ OPENAI_BASE_URL: "https://gw.mycorp.example/v1", CLAWHUB_URL: "https://api.useclawhub.com" });
  assert.ok(soft.includes("gw.mycorp.example"));
  assert.ok(soft.includes("api.useclawhub.com"));
  for (const d of ["api.openai.com", "api.anthropic.com", "openrouter.ai", "registry.npmjs.org"]) {
    assert.ok(soft.includes(d), `${d} must stay reachable under egress:none`);
  }
  assert.equal(new Set(soft).size, soft.length, "no duplicates");
});

test("soft infra is stable and case-insensitive on the *_BASE_URL suffix", () => {
  assert.ok(deriveSoftInfraHosts({ foo_base_url: "https://a.example" }).includes("a.example"));
  // A non-matching name contributes nothing.
  const soft = deriveSoftInfraHosts({ SOME_TOKEN: "https://evil.example" });
  assert.ok(!soft.includes("evil.example"));
  assert.ok(soft.length === AI_PROVIDER_HOSTS.length);
});
