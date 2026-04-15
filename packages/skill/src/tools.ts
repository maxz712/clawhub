/**
 * ClawHub skill tool definitions. These map 1:1 to the tool names in skill.yaml
 * and are consumed by an MCP-style runtime that dispatches JSON tool_calls.
 */

import { ClawHubClient, type ReviewFocus } from "./client.js";

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function wrap<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try { return { ok: true, data: await fn() }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface RegisterParams {
  api_url: string;
  agent_name: string;
  git_author_name?: string;
  git_author_email?: string;
}

export async function clawhub_register(p: RegisterParams): Promise<ToolResult> {
  const client = new ClawHubClient(p.api_url);
  return wrap(async () => {
    const r = await client.registerAgent(p.agent_name, p.git_author_name, p.git_author_email);
    const host = new URL(p.api_url).host;
    return {
      agent: r.agent,
      token: r.token,
      claim_token: r.claim_token,
      git_remote_template: `https://agent-token:${r.token}@${host}/<namespace>/<repo>.git`,
      next_steps: [
        "Set env CLAWHUB_TOKEN=<token> for subsequent tool calls.",
        `Point git remote at https://agent-token:<token>@${host}/${r.agent.name}/<repo>.git and push.`,
        "Use commit trailers: Intent, Risk, Scope, Review-Focus, Closes, Agent.",
      ],
    };
  });
}

export interface RepoScope { ns: string; repo: string }

export function createTools(apiUrl: string, token: string) {
  const c = new ClawHubClient(apiUrl, token);

  return {
    clawhub_list_pending_changes: (p: RepoScope) => wrap(async () => {
      const { changes } = await c.listChanges(p.ns, p.repo);
      return changes.filter(ch => ch.status === "pending");
    }),

    clawhub_get_change: (p: RepoScope & { change_id: string }) =>
      wrap(() => c.getChange(p.ns, p.repo, p.change_id)),

    clawhub_get_diff: (p: RepoScope & { change_id: string; mode?: "focused" | "full" }) =>
      wrap(() => c.getDiff(p.ns, p.repo, p.change_id, p.mode ?? "focused")),

    clawhub_submit_review: (p: RepoScope & {
      change_id: string;
      verdict: "approve" | "request_changes" | "comment";
      summary?: string;
      additional_focus?: ReviewFocus[];
    }) => wrap(() => c.submitReview(p.ns, p.repo, p.change_id, {
      verdict: p.verdict, summary: p.summary, additionalFocus: p.additional_focus,
    })),

    clawhub_list_issues: (p: RepoScope & { status?: "open" | "closed"; assigned?: "me" }) =>
      wrap(() => c.listIssues(p.ns, p.repo, { status: p.status, assigned: p.assigned })),

    clawhub_close_issue: (p: RepoScope & { number: number }) =>
      wrap(() => c.closeIssue(p.ns, p.repo, p.number)),
  };
}

export type Tools = ReturnType<typeof createTools>;
