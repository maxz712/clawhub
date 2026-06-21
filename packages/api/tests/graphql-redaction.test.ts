import { describe, it, expect } from "vitest";
import { executeGraphQL } from "../src/services/graphql.js";

// The GraphQL `agents`/`agent` resolvers must project an explicit, non-secret
// column set — never `select *` over the agents table, which carries tokenHash
// + claimToken. This is the defense-in-depth half of the 2026-06-20 audit fix
// (the route is also disabled by default; see routes/graphql.ts).
describe("GraphQL agent resolver redaction", () => {
  function captureSelect() {
    let captured: Record<string, unknown> | undefined;
    const leaf = {
      from: () => leaf,
      where: () => leaf,
      orderBy: () => leaf,
      limit: () => Promise.resolve([]),
    };
    const db = {
      select: (cols?: Record<string, unknown>) => {
        if (cols) captured = cols;
        return leaf;
      },
    };
    return { db, get: () => captured };
  }

  it("agents resolver selects an explicit projection without secret columns", async () => {
    const cap = captureSelect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeGraphQL("{ agents { id name } }", { db: cap.db as any });
    const cols = cap.get();
    expect(cols, "agents resolver must pass an explicit column projection").toBeDefined();
    const keys = Object.keys(cols!);
    expect(keys).not.toContain("tokenHash");
    expect(keys).not.toContain("claimToken");
    expect(keys).toContain("id");
    expect(keys).toContain("name");
  });

  it("agent(id) resolver also uses the redacted projection", async () => {
    const cap = captureSelect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeGraphQL('{ agent(id: "x") { id } }', { db: cap.db as any });
    const cols = cap.get();
    expect(cols).toBeDefined();
    expect(Object.keys(cols!)).not.toContain("tokenHash");
    expect(Object.keys(cols!)).not.toContain("claimToken");
  });
});
