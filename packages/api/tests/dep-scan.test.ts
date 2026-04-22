import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/services/dep-scan.js";

describe("parseManifest", () => {
  it("parses package.json deps + devDeps", () => {
    const json = JSON.stringify({
      dependencies: { react: "^18.2.0", lodash: "4.17.21" },
      devDependencies: { vitest: "~4.1.0" },
    });
    const deps = parseManifest("package.json", json);
    expect(deps).toHaveLength(3);
    expect(deps.find(d => d.name === "react")?.version).toBe("18.2.0");
    expect(deps.find(d => d.name === "vitest")?.ecosystem).toBe("npm");
  });

  it("parses requirements.txt", () => {
    const deps = parseManifest("requirements.txt", "flask==2.3.1\nrequests>=2.20 # comment\n\n# ignored\n");
    expect(deps.map(d => d.name)).toEqual(["flask", "requests"]);
    expect(deps[0].version).toBe("2.3.1");
    expect(deps[0].ecosystem).toBe("pypi");
  });

  it("parses Cargo.toml dependencies block", () => {
    const cargo = `[package]\nname = "x"\n\n[dependencies]\nserde = "1.0.197"\ntokio = "1"\n\n[dev-dependencies]\nmockito = "1.2"\n`;
    const deps = parseManifest("Cargo.toml", cargo);
    expect(deps.map(d => d.name).sort()).toEqual(["mockito", "serde", "tokio"]);
    expect(deps.find(d => d.name === "serde")?.ecosystem).toBe("crates");
  });

  it("parses go.mod require block", () => {
    const mod = `module x\n\ngo 1.21\n\nrequire (\n\tgithub.com/stretchr/testify v1.8.4\n\tgolang.org/x/sync v0.3.0\n)\n`;
    const deps = parseManifest("go.mod", mod);
    expect(deps.map(d => d.name).sort()).toEqual(["github.com/stretchr/testify", "golang.org/x/sync"]);
  });

  it("returns [] for unknown manifests", () => {
    expect(parseManifest("README.md", "hello")).toEqual([]);
  });
});
