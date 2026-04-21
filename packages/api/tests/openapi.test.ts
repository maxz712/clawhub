import { describe, it, expect } from "vitest";
import { openapi } from "../src/services/openapi.js";

describe("openapi spec", () => {
  it("is a valid 3.1 doc", () => {
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.info.title).toBe("ClawHub API");
  });

  it("declares core paths", () => {
    expect(openapi.paths["/api/v1/health"]).toBeDefined();
    expect(openapi.paths["/api/v1/repos/{ns}/{repo}/changes"]).toBeDefined();
    expect(openapi.paths["/api/v1/attestations"]).toBeDefined();
    expect(openapi.paths["/api/v1/cost/self"]).toBeDefined();
    expect(openapi.paths["/api/v1/sandbox"]).toBeDefined();
    expect(openapi.paths["/metrics"]).toBeDefined();
  });

  it("defines security schemes", () => {
    expect(openapi.components.securitySchemes.bearerAuth).toBeDefined();
    expect(openapi.components.securitySchemes.runnerToken).toBeDefined();
    expect(openapi.components.securitySchemes.agentBasic).toBeDefined();
  });
});
