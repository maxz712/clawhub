import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASELINE_SENSITIVE_GLOBS, touchesBaselineSensitive } from "../src/services/merge-policy.js";
import { CONTAINER_TOPOLOGY_GLOBS, isMediumSensitivePath } from "../src/services/risk-engine.js";
import { selectVerifyTier, type VerifyYmlInfo } from "../src/services/verify-tier.js";

// #188 — the sensitive-path merge gate was spelling-dependent: `**/Dockerfile` +
// root-anchored `docker-compose*.yml` missed Dockerfile.prod, the .yaml spelling,
// non-root compose files, and compose.yaml — the file `docker compose` PREFERS
// and what self-deploy.sh's flag-less invocation reads. One shared taxonomy
// (CONTAINER_TOPOLOGY_GLOBS) now feeds the baseline, the risk floor and the
// verify-tier topology floor; this matrix is the issue's verified table, one row
// per spelling so a future addition is one line.

const info = (o: Partial<VerifyYmlInfo> = {}): VerifyYmlInfo => ({
  tier: null, hasServe: true, serveUsesDocker: false, hasServices: false, hasUrl: true, ...o,
});

describe("container/compose surface — every real-world spelling gates (#188)", () => {
  const containerPaths = [
    "Dockerfile",
    "Dockerfile.dev",
    "Dockerfile.prod",
    "Dockerfile.api",
    "api.Dockerfile",
    "docker/Dockerfile.web",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.prod.yaml",
    "compose.yaml",
    "compose.yml",
    "ops/docker-compose.yml",
    "packages/api/docker-compose.yml",
  ];

  it.each(containerPaths)("%s hits the sensitive baseline (forces human code review)", p => {
    expect(touchesBaselineSensitive([p])).toBe(true);
  });

  it.each(containerPaths)("%s floors risk at MEDIUM", p => {
    expect(isMediumSensitivePath(p)).toBe(true);
  });

  it.each(containerPaths)("%s floors the verify tier at dind (topology)", p => {
    expect(selectVerifyTier({ changedPaths: [p], verifyYml: info() }).tier).toBe("dind");
  });
});

describe("IaC surface — *.tf is no longer root-anchored (#188)", () => {
  it.each(["main.tf", "infra/main.tf", "terraform/prod/main.tf", "infra/variables.tfvars"])("%s floors at MEDIUM", p => {
    expect(isMediumSensitivePath(p)).toBe(true);
  });
});

describe("no regression — prior matches hold, benign paths stay benign", () => {
  it.each(["deploy/x.sh", "scripts/self-deploy.sh", ".clawhub/ci/test.yml", "drizzle/0001.sql"])("%s still hits the baseline", p => {
    expect(touchesBaselineSensitive([p])).toBe(true);
  });
  it.each(["packages/api/src/routes/repos.ts", "README.md", "docs/ci.md", "composer.json"])("%s matches neither list", p => {
    expect(touchesBaselineSensitive([p])).toBe(false);
    expect(isMediumSensitivePath(p)).toBe(false);
  });
});

describe("the dashboard copy cannot drift from the server list (#188)", () => {
  it("merge-policy-editor.tsx's BASELINE_SENSITIVE_GLOBS is byte-identical to the server's", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../dashboard/src/components/merge-policy-editor.tsx", import.meta.url)),
      "utf8",
    );
    const m = /const BASELINE_SENSITIVE_GLOBS = \[([\s\S]*?)\];/.exec(src);
    expect(m, "dashboard BASELINE_SENSITIVE_GLOBS literal not found").toBeTruthy();
    const dashboardGlobs = [...m![1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
    expect(dashboardGlobs).toEqual(BASELINE_SENSITIVE_GLOBS);
  });
});

describe("CONTAINER_TOPOLOGY_GLOBS is spread into its consumers", () => {
  it("the baseline embeds the shared taxonomy verbatim", () => {
    for (const g of CONTAINER_TOPOLOGY_GLOBS) expect(BASELINE_SENSITIVE_GLOBS).toContain(g);
  });
});
