import { getAgentToken, getToken } from "./auth";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export type Risk = "low" | "medium" | "high" | "critical";
export type ChangeStatus = "pending" | "approved" | "changes_requested" | "merged" | "rolled_back";
export type CiStatus = "pending" | "running" | "success" | "failure" | "skipped";
export type IssueStatus = "open" | "closed";
export type Verdict = "approve" | "request_changes" | "comment";
export type TokenKind = "user" | "agent";

export interface ReviewFocus { path: string; startLine: number; endLine: number; note?: string }

export interface User { id: string; email: string; name?: string }
export interface Agent {
  id: string; name: string; gitAuthorName: string; gitAuthorEmail: string;
  capabilities: { push: boolean; review: boolean };
  stats: { changesOpened: number; reviewsSubmitted: number };
  createdAt: string;
}
export interface Repo {
  id: string; name: string; namespaceType: "agent" | "org"; namespaceId: string;
  description: string | null; defaultBranch: string; isPublic: boolean;
  mergePolicy: MergePolicy; createdAt: string; updatedAt: string;
}
export interface Change {
  id: string; repoId: string; branch: string; headCommit: string;
  intent: string; risk: Risk; scope: string[]; reviewFocus: ReviewFocus[];
  trailers: Record<string, string[]>; status: ChangeStatus;
  hasConflicts: boolean; escalated: boolean; escalationReason: string | null;
  openedByAgentId: string; ciStatus: CiStatus; createdAt: string; updatedAt: string;
}
export interface MergeDecision { mergeable: boolean; reason?: string; needsHuman: boolean; needsCi: boolean }
export interface Review {
  id: string; changeId: string; reviewerKind: "agent" | "human"; reviewerId: string;
  verdict: Verdict; summary: string | null; additionalFocus: ReviewFocus[]; submittedAt: string;
}
export interface Issue {
  id: string; repoId: string; number: number; title: string; body: string | null;
  status: IssueStatus; assignedAgentId: string | null; labels: string[];
  createdByKind: "agent" | "human" | "system"; createdById: string;
  closingChangeId: string | null; createdAt: string; updatedAt: string;
}
export interface CiPipeline { id: string; repoId: string; name: string; yaml: string; enabled: boolean; createdAt: string }
export interface CiRun { id: string; repoId: string; changeId: string | null; pipelineId: string; status: CiStatus; logUrl: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string }
export interface SecretRow { name: string; createdAt: string }
export interface Release { id: string; repoId: string; tag: string; title: string | null; body: string | null; changeId: string | null; createdAt: string }
export interface Webhook { id: string; repoId: string; url: string; events: string[]; enabled: boolean; createdAt: string; secret?: string }
export interface OrgRow { id: string; name: string; displayName: string | null; role: "admin" | "member" }
export interface MergePolicy {
  requireHumanApproval: "always" | "never" | "if_risk_at_least";
  requireHumanApprovalLevel: Risk;
  minApprovalsTotal: number;
  minApprovalsHuman: number;
  allowSelfReview: boolean;
  ciRequired: boolean;
  pathOverrides: Array<{ glob: string; requireHuman: boolean }>;
  trustedAgents: string[];
}

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

class ApiClient {
  readonly base = BASE;

  eventStreamUrl(): string {
    const token = getToken();
    return `${this.base}/api/v1/events/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, tokenKind: TokenKind = "user"): Promise<T> {
    const token = tokenKind === "agent" ? getAgentToken() : getToken();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(`${this.base}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (data && typeof data === "object") ? data as { error?: string; message?: string } : {};
      throw new ApiError(res.status, err.error ?? String(res.status), err.message ?? res.statusText);
    }
    return data as T;
  }

  // Health
  health() { return this.request<{ ok: boolean }>("GET", "/api/v1/health"); }

  // Users
  registerUser(email: string, password: string, name?: string) {
    return this.request<{ user: User; token: string }>("POST", "/api/v1/users/register", { email, password, name });
  }
  loginUser(email: string, password: string) {
    return this.request<{ user: User; token: string }>("POST", "/api/v1/users/login", { email, password });
  }
  getMe() { return this.request<User>("GET", "/api/v1/users/me"); }

  // Agents
  registerAgent(body: { name: string; gitAuthorName?: string; gitAuthorEmail?: string; capabilities?: { push?: boolean; review?: boolean } }) {
    return this.request<{ agent: { id: string; name: string; capabilities: Agent["capabilities"] }; token: string; claim_token: string }>("POST", "/api/v1/agents", body);
  }
  listAgents() { return this.request<{ agents: Agent[] }>("GET", "/api/v1/agents"); }
  claimAgent(claim_token: string) { return this.request<{ agent: { id: string; name: string } }>("POST", "/api/v1/agents/claim", { claim_token }); }
  getAgentMe() { return this.request<Agent & { claim_token: string | null }>("GET", "/api/v1/agents/me", undefined, "agent"); }
  rotateAgentToken(id: string) { return this.request<{ token: string }>("POST", `/api/v1/agents/${id}/rotate-token`); }

  // Orgs
  createOrg(name: string, displayName?: string) { return this.request<{ id: string; name: string; displayName: string | null }>("POST", "/api/v1/orgs", { name, displayName }); }
  listOrgs() { return this.request<{ orgs: OrgRow[] }>("GET", "/api/v1/orgs"); }
  addOrgMember(orgId: string, email: string, role?: "admin" | "member") { return this.request<{ ok: true }>("POST", `/api/v1/orgs/${orgId}/members`, { email, role }); }

  // Repos
  listRepos() { return this.request<{ repos: Repo[] }>("GET", "/api/v1/repos"); }
  getRepo(ns: string, repo: string) { return this.request<{ repo: Repo; namespace: { kind: "agent" | "org"; id: string; name: string } }>("GET", `/api/v1/repos/${ns}/${repo}`); }
  patchRepo(ns: string, repo: string, patch: Partial<Pick<Repo, "description" | "defaultBranch" | "isPublic" | "mergePolicy">>) {
    return this.request<{ ok: true }>("PATCH", `/api/v1/repos/${ns}/${repo}`, patch);
  }
  listCollaborators(ns: string, repo: string) { return this.request<{ collaborators: Array<{ id: string; agentId: string; role: "writer" | "reviewer" }> }>("GET", `/api/v1/repos/${ns}/${repo}/collaborators`); }
  addCollaborator(ns: string, repo: string, agentName: string, role?: "writer" | "reviewer") { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/collaborators`, { agentName, role }); }

  // Changes
  listChanges(ns: string, repo: string) { return this.request<{ changes: Change[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes`); }
  getChange(ns: string, repo: string, id: string) { return this.request<{ change: Change; mergeable: MergeDecision }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`); }
  getDiff(ns: string, repo: string, id: string, mode: "focused" | "full") {
    return this.request<{ mode: string; diff: string; focus?: ReviewFocus[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/diff?mode=${mode}`);
  }
  mergeChange(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/merge`); }
  rollbackChange(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/rollback`); }

  // Reviews
  listReviews(ns: string, repo: string, id: string) { return this.request<{ reviews: Review[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`); }
  submitReview(ns: string, repo: string, id: string, body: { verdict: Verdict; summary?: string; additionalFocus?: ReviewFocus[] }) {
    return this.request<{ review: Review }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`, body);
  }

  // Issues
  listIssues(ns: string, repo: string, query?: { status?: IssueStatus; assigned?: "me" }) {
    const q = new URLSearchParams();
    if (query?.status) q.set("status", query.status);
    if (query?.assigned) q.set("assigned", query.assigned);
    return this.request<{ issues: Issue[] }>("GET", `/api/v1/repos/${ns}/${repo}/issues${q.size ? "?" + q : ""}`);
  }
  createIssue(ns: string, repo: string, body: { title: string; body?: string; assignedAgentId?: string; labels?: string[] }) {
    return this.request<{ issue: Issue }>("POST", `/api/v1/repos/${ns}/${repo}/issues`, body);
  }
  patchIssue(ns: string, repo: string, num: number, patch: { title?: string; body?: string; status?: IssueStatus; assignedAgentId?: string | null }) {
    return this.request<{ ok: true }>("PATCH", `/api/v1/repos/${ns}/${repo}/issues/${num}`, patch);
  }
  addIssueComment(ns: string, repo: string, num: number, body: string) {
    return this.request<{ comment: { id: string; body: string; createdAt: string } }>("POST", `/api/v1/repos/${ns}/${repo}/issues/${num}/comments`, { body });
  }

  // CI
  listPipelines(ns: string, repo: string) { return this.request<{ pipelines: CiPipeline[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/pipelines`); }
  upsertPipeline(ns: string, repo: string, name: string, yaml: string, enabled = true) {
    return this.request<{ pipeline?: CiPipeline; ok?: true }>("PUT", `/api/v1/repos/${ns}/${repo}/ci/pipelines/${name}`, { yaml, enabled });
  }
  listCiRuns(ns: string, repo: string, changeId?: string) {
    return this.request<{ runs: CiRun[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/runs${changeId ? `?change=${changeId}` : ""}`);
  }

  // Secrets
  listSecrets(ns: string, repo: string) { return this.request<{ secrets: SecretRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/secrets`); }
  setSecret(ns: string, repo: string, name: string, value: string) { return this.request<{ ok: true }>("PUT", `/api/v1/repos/${ns}/${repo}/secrets/${name}`, { value }); }
  deleteSecret(ns: string, repo: string, name: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/secrets/${name}`); }

  // Releases
  listReleases(ns: string, repo: string) { return this.request<{ releases: Release[] }>("GET", `/api/v1/repos/${ns}/${repo}/releases`); }
  createRelease(ns: string, repo: string, body: { tag: string; title?: string; body?: string; changeId: string }) {
    return this.request<{ release: Release }>("POST", `/api/v1/repos/${ns}/${repo}/releases`, body);
  }

  // Webhooks
  listWebhooks(ns: string, repo: string) { return this.request<{ webhooks: Webhook[] }>("GET", `/api/v1/repos/${ns}/${repo}/webhooks`); }
  createWebhook(ns: string, repo: string, body: { url: string; events?: string[]; enabled?: boolean }) {
    return this.request<{ webhook: Webhook }>("POST", `/api/v1/repos/${ns}/${repo}/webhooks`, body);
  }
  deleteWebhook(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/webhooks/${id}`); }
}

export const api = new ApiClient();
export { ApiError };
