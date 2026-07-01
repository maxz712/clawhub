import { describe, it, expect } from "vitest";
import { qualityClearsBar, EARNED } from "../src/services/agent-autonomy.js";
import { ROLE_TEMPLATES, slugify } from "../src/services/agent-roles.js";
import { NAME_RE } from "../src/services/standing-agents.js";
import type { QualityScore } from "../src/services/agent-quality.js";

function q(over: Partial<QualityScore> = {}): QualityScore {
  return { mergeRate: 95, revertRate: 1, timeToGreenCiP50: 120, reviewHitRate: 90, driftScore: 5, ...over } as QualityScore;
}

describe("earned autonomy — qualityClearsBar", () => {
  it("clears the bar for a proven agent with track record", () => {
    expect(qualityClearsBar(q(), EARNED.minMergedVolume)).toBe(true);
  });
  it("requires a minimum merged volume (anti-fluke)", () => {
    // A 100% merge rate on too few merges does NOT earn autonomy.
    expect(qualityClearsBar(q({ mergeRate: 100 }), EARNED.minMergedVolume - 1)).toBe(false);
  });
  it("rejects a low merge rate", () => {
    expect(qualityClearsBar(q({ mergeRate: EARNED.minMergeRate - 1 }), 100)).toBe(false);
  });
  it("rejects a high revert rate", () => {
    expect(qualityClearsBar(q({ revertRate: EARNED.maxRevertRate + 1 }), 100)).toBe(false);
  });
  it("rejects a drifting agent", () => {
    expect(qualityClearsBar(q({ driftScore: EARNED.maxDrift + 1 }), 100)).toBe(false);
  });
});

describe("role templates", () => {
  it("ships the curated set with sane capabilities", () => {
    const bySlug = Object.fromEntries(ROLE_TEMPLATES.map(t => [t.slug, t]));
    expect(bySlug["security-reviewer"].capability).toBe("reviewer");
    expect(bySlug["security-reviewer"].event).toBe("change.opened");
    expect(bySlug["worker"].capability).toBe("worker");
    expect(bySlug["dependency-bot"].capability).toBe("specialist");
    expect(bySlug["triager"].capability).toBe("triager");
    expect(bySlug["developer"].capability).toBe("worker");
    expect(bySlug["developer"].mode).toBe("develop");
    // every template has a slug + name; every template has a task EXCEPT the develop-mode
    // developer, whose goal is supplied at runtime (an assigned issue or a task override) —
    // an empty template task is what makes run_develop fall through to grab an issue.
    for (const t of ROLE_TEMPLATES) {
      expect(t.slug).toBeTruthy(); expect(t.name).toBeTruthy();
      if (t.mode === "develop") expect(t.task).toBe("");
      else expect(t.task.length).toBeGreaterThan(10);
    }
  });

  // Regression: deployRoleToRepo derives the standing-agent name from the role's
  // human-facing name via slugify(). Role names like "Issue triager" have spaces
  // and capitals; passing them raw to createStandingAgent failed NAME_RE with
  // "bad name", so 4 of 6 curated templates could not be deployed at all.
  it("every curated template name slugifies to a valid standing-agent name", () => {
    for (const t of ROLE_TEMPLATES) {
      const derived = slugify(t.name);
      expect(NAME_RE.test(derived), `template "${t.name}" → "${derived}"`).toBe(true);
    }
  });

  it("slugify normalizes spaces and capitals", () => {
    expect(slugify("Issue triager")).toBe("issue-triager");
    expect(slugify("Performance reviewer")).toBe("performance-reviewer");
    expect(NAME_RE.test(slugify("Issue triager"))).toBe(true);
  });
});
