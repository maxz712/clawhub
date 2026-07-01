import type { Command } from "commander";
import chalk from "chalk";
import { ApiClient } from "../lib/api.js";
import { parseRepo, resolveIdPrefix } from "../lib/repo.js";

interface Memory {
  id: string; kind: string; scope: string; title: string; body: string;
  importance: number; confidence: number; pinned: boolean; useCount: number;
  createdByAgentId: string | null; createdAt: string; archivedAt: string | null;
}

const KIND_COLOR: Record<string, (s: string) => string> = {
  decision: chalk.magenta, convention: chalk.green, failure: chalk.red, expertise: chalk.blue, episode: chalk.gray,
};

function render(m: Memory) {
  const k = (KIND_COLOR[m.kind] ?? chalk.white)(m.kind.padEnd(10));
  const pin = m.pinned ? chalk.yellow("📌") : "  ";
  console.log(`${chalk.cyan(m.id.slice(0, 8))} ${pin} ${k} ${chalk.gray(`imp${m.importance}`)} ${m.title}`);
}

interface Edge {
  id: string; srcMemoryId: string; dstKind: string; dstMemoryId: string | null;
  dstPath: string | null; relation: string; weight: number; origin: string;
}

function renderEdge(e: Edge) {
  const dst = e.dstKind === "code" ? chalk.blue(e.dstPath ?? "?") : chalk.cyan((e.dstMemoryId ?? "?").slice(0, 8));
  console.log(`${chalk.cyan(e.srcMemoryId.slice(0, 8))} ${chalk.gray(`--${e.relation}-->`)} ${dst} ${chalk.gray(`w${e.weight} ${e.origin}`)}`);
}

export function registerMemoryCommands(program: Command) {
  const g = program.command("memory").description("Agent memory — what an agent has learned about a repo (see docs/memory.md)");

  g.command("search <query> [ns/repo]")
    .description("Search memory (ranked by relevance · importance · recency)")
    .option("--kind <kind>", "episode|convention|failure|decision|expertise")
    .option("--fingerprint <fp>", "exact failure lookup by errorFingerprint")
    .action(async (query: string, repoArg: string | undefined, opts: Record<string, string>) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const qs = new URLSearchParams({ q: query, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}) });
      const { memories } = await client.request<{ memories: Memory[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory?${qs}`);
      if (!memories.length) { console.log(chalk.gray("(no memories)")); return; }
      for (const m of memories) render(m);
    });

  g.command("list [ns/repo]")
    .description("List a repo's memories (newest first)")
    .option("--kind <kind>", "filter by kind")
    .option("--archived", "include archived")
    .action(async (repoArg: string | undefined, opts: Record<string, string | boolean>) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const qs = new URLSearchParams({ ...(opts.kind ? { kind: String(opts.kind) } : {}), ...(opts.archived ? { archived: "1" } : {}) });
      const { memories } = await client.request<{ memories: Memory[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory?${qs}`);
      if (!memories.length) { console.log(chalk.gray("(no memories)")); return; }
      for (const m of memories) render(m);
    });

  g.command("write [ns/repo]")
    .description("Write a memory (agent token; body from stdin or --body)")
    .requiredOption("--kind <kind>", "episode|convention|failure|decision|expertise")
    .requiredOption("--title <title>", "short title")
    .option("--body <text>", "body text (else read from stdin)")
    .option("--scope <scope>", "agent|agent_repo|repo", "agent_repo")
    .option("--importance <n>", "1..10 self-rating", "3")
    .option("--tags <a,b>", "comma-separated tags")
    .option("--about <a,b>", "file paths this memory is about (creates memory→code edges)")
    .option("--relates-to <ids>", "comma-separated memory ids to relate this memory to")
    .action(async (repoArg: string | undefined, opts: Record<string, string>) => {
      const { ns, repo } = parseRepo(repoArg);
      let body = opts.body;
      if (!body) body = await new Promise<string>(res => { let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => d += c); process.stdin.on("end", () => res(d.replace(/\n$/, ""))); });
      if (!body) { console.error(chalk.red("no body (pass --body or pipe stdin)")); process.exit(1); }
      const edges = [
        ...(opts.about ? opts.about.split(",").map(s => s.trim()).filter(Boolean).map(p => ({ relation: "about", dstPath: p })) : []),
        ...(opts.relatesTo ? opts.relatesTo.split(",").map(s => s.trim()).filter(Boolean).map(d => ({ relation: "relates_to", dstMemoryId: d })) : []),
      ];
      const client = new ApiClient();
      const { memory } = await client.request<{ memory: Memory | null }>("POST", `/api/v1/repos/${ns}/${repo}/memory`, {
        body: { kind: opts.kind, title: opts.title, body, scope: opts.scope, importance: Number(opts.importance), tags: opts.tags ? opts.tags.split(",").map(s => s.trim()) : [], ...(edges.length ? { edges } : {}) },
        tokenKind: "agent",
      });
      if (memory) { console.log(chalk.green("✓ remembered") + chalk.gray(` (${memory.id.slice(0, 8)})`)); }
      else console.log(chalk.gray("already remembered (idempotent)"));
    });

  g.command("forget <id> [ns/repo]")
    .description("Invalidate a memory (agent token)")
    .action(async (id: string, repoArg: string | undefined) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { memories } = await client.request<{ memories: Memory[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory`);
      const fullId = resolveIdPrefix(memories, id, "memory");
      await client.request("DELETE", `/api/v1/repos/${ns}/${repo}/memory/${fullId}`, { tokenKind: "agent" });
      console.log(chalk.green("✓ forgotten"));
    });

  g.command("graph [ns/repo]")
    .description("Show the repo's memory graph — nodes + edges (user token)")
    .option("--kind <kind>", "filter nodes by kind")
    .action(async (repoArg: string | undefined, opts: Record<string, string>) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const qs = new URLSearchParams({ ...(opts.kind ? { kind: opts.kind } : {}) });
      const { nodes, edges } = await client.request<{ nodes: Memory[]; edges: Edge[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory/graph?${qs}`);
      console.log(chalk.bold(`${nodes.length} memories · ${edges.length} edges`));
      for (const m of nodes) render(m);
      if (edges.length) { console.log(chalk.bold("\nedges:")); for (const e of edges) renderEdge(e); }
    });

  g.command("edges <id> [ns/repo]")
    .description("Show a memory's graph neighbors (edges in + out)")
    .action(async (id: string, repoArg: string | undefined) => {
      const { ns, repo } = parseRepo(repoArg);
      const client = new ApiClient();
      const { memories } = await client.request<{ memories: Memory[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory`);
      const fullId = resolveIdPrefix(memories, id, "memory");
      const { edges } = await client.request<{ edges: Edge[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory/${fullId}/edges`);
      if (!edges.length) { console.log(chalk.gray("(no edges)")); return; }
      for (const e of edges) renderEdge(e);
    });
}
