import { describe, it, expect, afterEach } from "vitest";
import { repoTrustedForHostExec, resolveCiExecution } from "../src/services/ci-host-exec.js";

// The gate that keeps other people's CI from running host code (killing prod / reading the
// runner's token). The trust anchor is an operator-only env allowlist; a repo that merely
// declares `execution: host` in its own YAML must still resolve to the contained sandbox.

const ENV = "CLAWHUB_CI_HOST_EXEC_REPOS";
afterEach(() => { delete process.env[ENV]; });

describe("repoTrustedForHostExec (operator-only anchor)", () => {
  it("is false for everyone when the allowlist is empty/unset (fail closed)", () => {
    delete process.env[ENV];
    expect(repoTrustedForHostExec("xinmingzhang", "clawhub", "id-1")).toBe(false);
    process.env[ENV] = "";
    expect(repoTrustedForHostExec("xinmingzhang", "clawhub", "id-1")).toBe(false);
  });

  it("trusts only allowlisted ns/repo, case-insensitively", () => {
    process.env[ENV] = "xinmingzhang/clawhub, acme/build";
    expect(repoTrustedForHostExec("xinmingzhang", "clawhub")).toBe(true);
    expect(repoTrustedForHostExec("XinMingZhang", "ClawHub")).toBe(true);   // case-insensitive
    expect(repoTrustedForHostExec("acme", "build")).toBe(true);
    expect(repoTrustedForHostExec("acme", "other")).toBe(false);            // same ns, other repo
    expect(repoTrustedForHostExec("evil", "clawhub")).toBe(false);          // other ns, same name
  });

  it("also matches by repo id when listed", () => {
    process.env[ENV] = "abc-123";
    expect(repoTrustedForHostExec("any", "repo", "abc-123")).toBe(true);
    expect(repoTrustedForHostExec("any", "repo", "def-456")).toBe(false);
    expect(repoTrustedForHostExec("any", "repo")).toBe(false);              // no id, not by name
  });
});

describe("resolveCiExecution (the server-side decision stamped into the payload)", () => {
  it("grants the requested privileged mode ONLY to an allowlisted repo", () => {
    process.env[ENV] = "xinmingzhang/clawhub";
    expect(resolveCiExecution("host", "xinmingzhang", "clawhub")).toBe("host");
    expect(resolveCiExecution("deploy", "xinmingzhang", "clawhub")).toBe("deploy");
    expect(resolveCiExecution("build", "xinmingzhang", "clawhub")).toBe("build");
    expect(resolveCiExecution("build", "attacker", "evil")).toBe("sandbox"); // weaker-seccomp tier not tenant-reachable
  });

  it("DENIES host/deploy to a non-allowlisted repo even if its YAML asks for it (the key guarantee)", () => {
    process.env[ENV] = "xinmingzhang/clawhub";
    expect(resolveCiExecution("host", "attacker", "evil")).toBe("sandbox");   // self-grant blocked
    expect(resolveCiExecution("deploy", "attacker", "evil")).toBe("sandbox"); // a tenant can't deploy the platform
    delete process.env[ENV];
    expect(resolveCiExecution("host", "xinmingzhang", "clawhub")).toBe("sandbox"); // empty allowlist → nobody
  });

  it("is sandbox whenever the pipeline did not request a privileged mode", () => {
    process.env[ENV] = "xinmingzhang/clawhub";
    expect(resolveCiExecution(undefined, "xinmingzhang", "clawhub")).toBe("sandbox");
    expect(resolveCiExecution(undefined, "attacker", "evil")).toBe("sandbox");
  });
});
