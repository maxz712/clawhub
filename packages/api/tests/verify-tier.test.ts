import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectVerifyTier, parseVerifyYmlInfo, type VerifyYmlInfo } from "../src/services/verify-tier.js";

const info = (o: Partial<VerifyYmlInfo>): VerifyYmlInfo => ({
  tier: null, hasServe: false, serveUsesDocker: false, hasServices: false, hasUrl: false, ...o,
});

describe("selectVerifyTier — inference from diff shape", () => {
  it("docs/test/lockfile-only diff → static (no boot)", () => {
    const d = selectVerifyTier({ changedPaths: ["README.md", "docs/x.md", "packages/api/tests/a.test.ts", "package-lock.json"], verifyYml: info({ hasServe: true, hasUrl: true }) });
    expect(d.tier).toBe("static");
  });
  it("single-process serve + url → app (cheap real UI verify)", () => {
    const d = selectVerifyTier({ changedPaths: ["packages/dashboard/src/page.tsx"], verifyYml: info({ hasServe: true, hasUrl: true }) });
    expect(d.tier).toBe("app");
  });
  it("a services: block → services", () => {
    const d = selectVerifyTier({ changedPaths: ["packages/api/src/routes/x.ts"], verifyYml: info({ hasServe: true, hasServices: true, hasUrl: true }) });
    expect(d.tier).toBe("services");
  });
  it("serve uses docker → dind", () => {
    const d = selectVerifyTier({ changedPaths: ["packages/api/src/x.ts"], verifyYml: info({ hasServe: true, serveUsesDocker: true, hasUrl: true }) });
    expect(d.tier).toBe("dind");
  });
  it("no serve declared → static", () => {
    const d = selectVerifyTier({ changedPaths: ["packages/api/src/x.ts"], verifyYml: info({}) });
    expect(d.tier).toBe("static");
  });
});

describe("selectVerifyTier — SERVER floor (must-fix #2: no downgrade attack)", () => {
  it("topology path (docker-compose) floors at dind even for a frontend serve", () => {
    const d = selectVerifyTier({ changedPaths: ["docker-compose.dev.yml"], verifyYml: info({ hasServe: true, hasUrl: true }) });
    expect(d.tier).toBe("dind");
    expect(d.floor).toBe("dind");
  });
  it("Dockerfile / deploy / ci paths floor at dind", () => {
    for (const p of ["packages/api/Dockerfile", "deploy/helm/x.yaml", ".clawhub/ci/test.yml"]) {
      expect(selectVerifyTier({ changedPaths: [p], verifyYml: info({ hasServe: true, hasUrl: true }) }).floor).toBe("dind");
    }
  });
  it("migration / *.sql floors at services", () => {
    for (const p of ["packages/api/src/models/migrations/0040_x.sql", "x.sql"]) {
      expect(selectVerifyTier({ changedPaths: [p], verifyYml: info({ hasServe: true, hasUrl: true }) }).floor).toBe("services");
    }
  });
  it("a change CANNOT request a tier below the floor (clamped up)", () => {
    // attacker pins tier:static on a migration change to skip real verification
    const d = selectVerifyTier({ changedPaths: ["packages/api/src/models/migrations/0040.sql"], verifyYml: info({ tier: "static", hasServe: true, hasUrl: true }) });
    expect(d.tier).toBe("services"); // floor wins
  });
  it("a change MAY request a HEAVIER tier than inferred", () => {
    const d = selectVerifyTier({ changedPaths: ["packages/dashboard/x.tsx"], verifyYml: info({ tier: "services", hasServe: true, hasUrl: true }) });
    expect(d.tier).toBe("services");
  });
  it("high/critical risk floors at services", () => {
    expect(selectVerifyTier({ changedPaths: ["a.ts"], verifyYml: info({ hasServe: true, hasUrl: true }), effectiveRisk: "high" }).tier).toBe("services");
    expect(selectVerifyTier({ changedPaths: ["a.ts"], verifyYml: info({ hasServe: true, hasUrl: true }), effectiveRisk: "critical" }).floor).toBe("services");
  });
  it("policy.minVerifyTier + forceTierGlobs force up", () => {
    expect(selectVerifyTier({ changedPaths: ["a.ts"], verifyYml: info({ hasServe: true, hasUrl: true }), policy: { minVerifyTier: "services" } }).tier).toBe("services");
    expect(selectVerifyTier({ changedPaths: ["infra/x.tf"], verifyYml: info({ hasServe: true, hasUrl: true }), policy: { forceTierGlobs: [{ glob: "infra/**", tier: "dind" }] } }).tier).toBe("dind");
  });
  it("allowDind:false caps a dind diff at services (then human-gated)", () => {
    const d = selectVerifyTier({ changedPaths: ["docker-compose.yml"], verifyYml: info({ hasServe: true, serveUsesDocker: true }), policy: { allowDind: false } });
    expect(d.tier).toBe("services");
  });
});

describe("parseVerifyYmlInfo", () => {
  it("extracts tier/serve/services/url + detects docker in serve", () => {
    const raw = `tier: auto
serve: |
  docker compose -f docker-compose.dev.yml up -d
url: http://localhost:3001
services:
  postgres: { image: postgres:16 }
`;
    const i = parseVerifyYmlInfo(raw);
    expect(i.tier).toBe("auto");
    expect(i.hasServe).toBe(true);
    expect(i.serveUsesDocker).toBe(true);
    expect(i.hasServices).toBe(true);
    expect(i.hasUrl).toBe(true);
  });
  it("single-process serve is NOT flagged as docker", () => {
    const i = parseVerifyYmlInfo("serve: npm run dev\nurl: http://localhost:3001\n");
    expect(i.serveUsesDocker).toBe(false);
    expect(i.hasServices).toBe(false);
    expect(i.hasUrl).toBe(true);
  });
  it("malformed yaml → empty info (never throws)", () => {
    expect(parseVerifyYmlInfo(":\n  - [unbalanced").hasServe).toBe(false);
    expect(parseVerifyYmlInfo(null).tier).toBe(null);
  });
});

describe("clawhub's own .clawhub/verify.yml resolves to the cheap tiers", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../../.clawhub/verify.yml", import.meta.url)), "utf8");
  const info = parseVerifyYmlInfo(raw);
  it("the node `serve` is not flagged as docker (so the selector won't force dind)", () => {
    expect(info.serveUsesDocker).toBe(false);
    expect(info.hasServices).toBe(true);
    expect(info.tier).toBe("auto");
  });
  const tier = (paths: string[]) => selectVerifyTier({ changedPaths: paths, verifyYml: info }).tier;
  it("docs → static, dashboard/api → services, compose → dind", () => {
    expect(tier(["docs/x.md", "README.md"])).toBe("static");
    expect(tier(["packages/dashboard/src/app/page.tsx"])).toBe("services");
    expect(tier(["packages/api/src/routes/changes.ts"])).toBe("services");
    expect(tier(["packages/api/drizzle/0033_x.sql"])).toBe("services");
    expect(tier(["docker-compose.dev.yml"])).toBe("dind");
  });
});
