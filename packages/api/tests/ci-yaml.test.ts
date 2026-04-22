import { describe, it, expect } from "vitest";
import { parseYamlSubset } from "../src/services/ci-yaml.js";

describe("parseYamlSubset", () => {
  it("parses steps array", () => {
    const doc = parseYamlSubset(`name: build
steps:
  - name: install
    run: npm ci
  - run: npm test
`);
    expect(doc.name).toBe("build");
    const steps = doc.steps as Array<{ name?: string; run: string }>;
    expect(steps.length).toBe(2);
    expect(steps[0].run).toBe("npm ci");
    expect(steps[1].run).toBe("npm test");
  });

  it("parses scalar extends", () => {
    const doc = parseYamlSubset(`extends: ./base.yml
steps:
  - run: echo hi
`);
    expect(doc.extends).toBe("./base.yml");
  });
});
