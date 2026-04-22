// Minimal GraphQL adapter. We don't need the full spec here — most enterprise
// buyers just want "your API in GraphQL shape so we can use our existing
// tooling". We parse a small subset of query documents (named operations,
// selection sets, scalar args) and execute them against a resolver map.
//
// For production scale, swap this for `graphql-yoga`. The interface is
// deliberately the same.

import type { DB } from "../models/db.js";
import { desc, eq } from "drizzle-orm";
import { agents, changes, issues, repositories } from "../models/schema.js";

export interface GraphQLContext {
  db: DB;
  userId?: string;
  agentId?: string;
}

export interface GraphQLResult {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

type Resolver = (args: Record<string, unknown>, ctx: GraphQLContext) => Promise<unknown> | unknown;

const schema: Record<string, Resolver> = {
  // Introspection-ish.
  __schema: () => ({
    types: [
      { name: "Query", kind: "OBJECT", fields: [
        "health", "me", "repo", "repos", "change", "changes", "issue", "issues", "agent", "agents",
      ].map(name => ({ name, type: { name: "Any" } })) },
    ],
  }),
  health: () => ({ ok: true }),
  me: async (_a, ctx) => {
    if (!ctx.userId && !ctx.agentId) return null;
    return ctx.userId ? { kind: "user", id: ctx.userId } : { kind: "agent", id: ctx.agentId };
  },
  repos: async (_a, ctx) => ctx.db.select().from(repositories).limit(100),
  repo: async (a, ctx) => {
    const id = String(a.id ?? "");
    const r = (await ctx.db.select().from(repositories).where(eq(repositories.id, id)).limit(1))[0];
    return r ?? null;
  },
  changes: async (a, ctx) => {
    const repoId = String(a.repoId ?? "");
    if (!repoId) return [];
    return ctx.db.select().from(changes).where(eq(changes.repoId, repoId)).orderBy(desc(changes.updatedAt)).limit(Number(a.limit ?? 50));
  },
  change: async (a, ctx) => {
    const r = (await ctx.db.select().from(changes).where(eq(changes.id, String(a.id))).limit(1))[0];
    return r ?? null;
  },
  issues: async (a, ctx) => {
    const repoId = String(a.repoId ?? "");
    if (!repoId) return [];
    return ctx.db.select().from(issues).where(eq(issues.repoId, repoId)).orderBy(desc(issues.updatedAt)).limit(Number(a.limit ?? 50));
  },
  issue: async (a, ctx) => {
    const r = (await ctx.db.select().from(issues).where(eq(issues.id, String(a.id))).limit(1))[0];
    return r ?? null;
  },
  agents: async (_a, ctx) => ctx.db.select().from(agents).limit(100),
  agent: async (a, ctx) => {
    const r = (await ctx.db.select().from(agents).where(eq(agents.id, String(a.id))).limit(1))[0];
    return r ?? null;
  },
};

// Query parser. Accepts: `{ field(a: "x", b: 1) { sub1 sub2 } }`
export function parseQuery(src: string): Array<{ name: string; args: Record<string, unknown>; fields: string[] | null }> {
  const trimmed = src.replace(/^\s*(query|mutation)(\s+[A-Za-z_][A-Za-z0-9_]*)?\s*/, "").trim();
  if (!trimmed.startsWith("{")) throw new Error("expected selection set");
  const body = trimmed.slice(1, trimmed.lastIndexOf("}"));
  const selections: Array<{ name: string; args: Record<string, unknown>; fields: string[] | null }> = [];

  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    const nameM = body.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!nameM) break;
    const name = nameM[0];
    i += name.length;
    while (i < body.length && /\s/.test(body[i])) i++;
    const args: Record<string, unknown> = {};
    if (body[i] === "(") {
      const end = body.indexOf(")", i);
      if (end === -1) throw new Error("unterminated args");
      for (const part of body.slice(i + 1, end).split(",")) {
        const m = part.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
        if (!m) continue;
        args[m[1]] = coerceGraphQLValue(m[2]);
      }
      i = end + 1;
    }
    while (i < body.length && /\s/.test(body[i])) i++;
    let fields: string[] | null = null;
    if (body[i] === "{") {
      const depthEnd = findMatching(body, i, "{", "}");
      fields = body.slice(i + 1, depthEnd).split(/\s+/).filter(Boolean);
      i = depthEnd + 1;
    }
    selections.push({ name, args, fields });
  }
  return selections;
}

function findMatching(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error("unmatched_brace");
}

function coerceGraphQLValue(v: string): unknown {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

function pick(obj: unknown, fields: string[] | null): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(o => pick(o, fields));
  if (!fields) return obj;
  if (typeof obj !== "object") return obj;
  const o = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = o[f];
  return out;
}

export async function executeGraphQL(query: string, ctx: GraphQLContext): Promise<GraphQLResult> {
  try {
    const selections = parseQuery(query);
    const data: Record<string, unknown> = {};
    for (const s of selections) {
      const resolver = schema[s.name];
      if (!resolver) { data[s.name] = null; continue; }
      const value = await resolver(s.args, ctx);
      data[s.name] = pick(value, s.fields);
    }
    return { data };
  } catch (e) {
    return { errors: [{ message: (e as Error).message ?? String(e) }] };
  }
}
