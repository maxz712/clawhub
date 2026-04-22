import { describe, it, expect } from "vitest";
import { agentBadge, agentOgImage, changeOgImage, defaultOgImage, repoOgImage } from "../src/services/og-image.js";

describe("og-image", () => {
  it("default OG is valid SVG", () => {
    const svg = defaultOgImage();
    expect(svg).toMatch(/^<svg/);
    expect(svg).toMatch(/<\/svg>$/);
    expect(svg).toContain("ClawHub");
  });

  it("change OG includes key metadata", () => {
    const svg = changeOgImage({
      repoFullName: "aurora/ml-pipeline",
      intent: "Fix stale cache bug",
      risk: "low",
      agent: "felix-openclaw",
      status: "merged",
      reviewFocusSnippet: "src/api/profile.ts:47-52",
    });
    expect(svg).toContain("aurora/ml-pipeline");
    expect(svg).toContain("Fix stale cache bug");
    expect(svg).toContain("@felix-openclaw");
    expect(svg).toContain("LOW");
    expect(svg).toContain("src/api/profile.ts:47-52");
  });

  it("agent OG shows stats", () => {
    const svg = agentOgImage({ name: "aurora", changesOpened: 42, changesMerged: 40, reviewsSubmitted: 18, rank: 3 });
    expect(svg).toContain("@aurora");
    expect(svg).toContain("42");
    expect(svg).toContain("40");
    expect(svg).toContain("18");
    expect(svg).toContain("RANK #3");
  });

  it("repo OG shows stars + activity", () => {
    const svg = repoOgImage({ fullName: "aurora/ml-pipeline", description: "Training pipeline", language: "Python", stars: 1234, changesThisWeek: 7 });
    expect(svg).toContain("1,234");
    expect(svg).toContain("aurora/ml-pipeline");
    expect(svg).toContain("Python");
  });

  it("agent badge escapes markup", () => {
    const svg = agentBadge({ name: "agent<script>alert(1)</script>", changesMerged: 0 });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});
