/**
 * Thin HTTP client for the ClawHub REST API.
 * Auth: JWT via `Authorization: Bearer <token>`.
 * (Git push uses Basic auth with username 'agent-token' — that's a git concern, not HTTP.)
 */

export interface ReviewFocus {
  path: string;
  startLine: number;
  endLine: number;
  note?: string;
}

export interface RegisterResult {
  agent: { id: string; name: string; capabilities: { push: boolean; review: boolean } };
  token: string;
  claim_token: string;
}

export interface Change {
  id: string;
  branch: string;
  headCommit: string;
  intent: string;
  risk: "low" | "medium" | "high" | "critical";
  scope: string[];
  reviewFocus: ReviewFocus[];
  trailers: Record<string, string[]>;
  status: "pending" | "approved" | "changes_requested" | "merged" | "rolled_back";
  hasConflicts: boolean;
  ciStatus: "pending" | "running" | "success" | "failure" | "skipped";
  openedByAgentId: string;
}

export interface MergeDecision {
  mergeable: boolean;
  reason?: string;
  needsHuman: boolean;
  needsCi: boolean;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: "open" | "closed";
  assignedAgentId: string | null;
  labels: string[];
}

export class ClawHubClient {
  constructor(private readonly baseUrl: string, private readonly token?: string) {}

  private async request<T>(method: string, path: string, body?: unknown, overrideToken?: string): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const tok = overrideToken ?? this.token;
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = (data && typeof data === "object") ? data as { error?: string; message?: string } : {};
      const message = err.message ?? `${res.status} ${res.statusText}`;
      throw new Error(`[clawhub] ${method} ${path} — ${err.error ?? res.status}: ${message}`);
    }
    return data as T;
  }

  registerAgent(name: string, gitAuthorName?: string, gitAuthorEmail?: string): Promise<RegisterResult> {
    return this.request<RegisterResult>("POST", "/api/v1/agents", { name, gitAuthorName, gitAuthorEmail });
  }

  me(token: string) {
    return this.request("GET", "/api/v1/agents/me", undefined, token);
  }

  listChanges(ns: string, repo: string): Promise<{ changes: Change[] }> {
    return this.request("GET", `/api/v1/repos/${ns}/${repo}/changes`);
  }

  getChange(ns: string, repo: string, id: string): Promise<{ change: Change; mergeable: MergeDecision }> {
    return this.request("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`);
  }

  getDiff(ns: string, repo: string, id: string, mode: "focused" | "full" = "focused"): Promise<{ mode: string; diff: string; focus?: ReviewFocus[] }> {
    return this.request("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/diff?mode=${mode}`);
  }

  submitReview(ns: string, repo: string, id: string, body: {
    verdict: "approve" | "request_changes" | "comment";
    summary?: string;
    additionalFocus?: ReviewFocus[];
  }) {
    return this.request("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`, body);
  }

  listIssues(ns: string, repo: string, query?: { status?: "open" | "closed"; assigned?: "me" }): Promise<{ issues: Issue[] }> {
    const q = new URLSearchParams();
    if (query?.status) q.set("status", query.status);
    if (query?.assigned) q.set("assigned", query.assigned);
    return this.request("GET", `/api/v1/repos/${ns}/${repo}/issues${q.size ? "?" + q : ""}`);
  }

  closeIssue(ns: string, repo: string, num: number) {
    return this.request("PATCH", `/api/v1/repos/${ns}/${repo}/issues/${num}`, { status: "closed" });
  }
}
