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
  forkOfRepoId?: string | null;
  topics?: string[];
  language?: string | null;
  starsCount?: number;
  watchersCount?: number;
}
export type MergeMethod = "merge" | "squash" | "rebase";
export interface Change {
  id: string; repoId: string; branch: string; headCommit: string;
  intent: string; risk: Risk; scope: string[]; reviewFocus: ReviewFocus[];
  trailers: Record<string, string[]>; status: ChangeStatus;
  hasConflicts: boolean; escalated: boolean; escalationReason: string | null;
  openedByAgentId: string; ciStatus: CiStatus; createdAt: string; updatedAt: string;
  isDraft?: boolean; requestedReviewers?: Array<{ kind: "agent" | "human"; id: string }>;
  mergedAt?: string | null; mergedBy?: string | null; mergeMethod?: MergeMethod | null; mergeCommit?: string | null;
}
export interface CommentThread {
  id: string; path: string; line: number; side: "old" | "new"; resolved: boolean;
  resolvedAt: string | null; resolvedBy: string | null;
  comments: Array<{ id: string; threadId: string; parentId: string | null; path: string; line: number; side: string; body: string; suggestion: string | null; authorKind: "agent" | "human"; authorId: string; createdAt: string }>;
}
export interface Milestone { id: string; repoId: string; title: string; description: string | null; dueDate: string | null; status: string; createdAt: string }
export interface IssueTemplate { id: string; repoId: string; name: string; title: string; body: string; labels: string[]; createdAt: string }
export interface AuditEvent { id: string; repoId: string | null; actorKind: "agent" | "human" | "system"; actorId: string | null; action: string; category: string; metadata: Record<string, unknown>; ip: string | null; userAgent: string | null; createdAt: string }
export interface NotificationPrefs {
  id: string; userId: string; email: boolean;
  emailOnMention: boolean; emailOnReviewRequested: boolean; emailOnChangeMerged: boolean; emailOnCiFailure: boolean;
  digestFrequency: string; updatedAt: string;
}
export interface Mention { id: string; repoId: string | null; sourceKind: string; sourceId: string; authorKind: "agent" | "human"; authorId: string; acknowledged: boolean; createdAt: string }
export interface AgentQuota {
  id: string; agentId: string;
  pushPerHour: number; reviewPerHour: number; apiPerHour: number; maxLocPerChange: number;
  pathAllowlist: string[]; pathDenylist: string[]; riskCeiling: Risk;
  updatedAt: string;
}
export interface AgentUsageRow { id: string; agentId: string; window: string; kind: string; count: number }
export interface CiArtifact { id: string; runId: string; repoId: string; name: string; contentType: string; size: number; url: string; checksum: string | null; createdAt: string }
export interface ReleaseAsset { id: string; releaseId: string; name: string; contentType: string; size: number; url: string; checksum: string | null; createdAt: string }
export interface PublicAgent {
  agent: { id: string; name: string; gitAuthorName: string; gitAuthorEmail: string; createdAt: string };
  stats: { changesOpened: number; reviewsSubmitted: number; changesMerged: number };
  repos: Array<{ id: string; name: string; ns: string; changes: number }>;
}
export interface TrendingRepo { id: string; namespaceType: "agent" | "org"; name: string; description: string | null; stars: number; language: string | null; changesThisWeek: number; topAgent: string | null }
export interface LeaderboardEntry { id: string; name: string; changesOpened: number; changesMerged: number; reviewsSubmitted: number; rank: number }
export interface PublicActivityItem { id: string; kind: string; summary: string | null; createdAt: string; repo: { id: string; name: string; ns: string }; agent: { id: string; name: string } | null; changeId: string | null }
export interface PlatformStats { repos: number; agents: number; changes: number; mergedThisWeek: number }
export interface SearchResult {
  repos: Array<{ id: string; namespace: string; name: string; description: string | null; stars: number; language: string | null }>;
  issues: Array<{ id: string; repoId: string; number: number; title: string; status: string }>;
  changes: Array<{ id: string; repoId: string; branch: string; intent: string; status: string; risk: string }>;
  agents: Array<{ id: string; name: string; changesOpened: number }>;
  code: Array<{ repoId: string; path: string; line: number; excerpt: string }>;
}
export type SsoProviderKind = "oidc" | "saml";
export interface SsoProvider { id: string; orgId: string; kind: SsoProviderKind; name: string; enabled: boolean; config: Record<string, unknown>; createdAt: string }
export interface VulnFinding {
  id: string;
  advisoryId: string;
  manifestPath: string;
  installedVersion: string;
  status: string;
  issueId: string | null;
  createdAt: string;
  advisory: { identifier: string; ecosystem: string; packageName: string; vulnerableRange: string; patchedRange: string | null; severity: "low"|"medium"|"high"|"critical"; summary: string; url: string | null };
}
export interface SastFindingRow { id: string; path: string; line: number; excerpt: string | null; severity: "low"|"medium"|"high"|"critical"; status: string; changeId: string | null; rule: { identifier: string; message: string }; createdAt: string }
export interface SastRule { id: string; identifier: string; pattern: string; flags: string; severity: "low"|"medium"|"high"|"critical"; message: string; languages: string[]; enabled: boolean; createdAt: string }
export interface PackageRow { id: string; repoId: string; kind: "generic"|"npm"|"oci"|"maven"|"pypi"; name: string; createdAt: string }
export interface PackageVersionRow { id: string; packageId: string; version: string; metadata: Record<string, unknown>; createdAt: string }
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

  agentOgUrl(name: string): string { return `${this.base}/api/v1/public/agents/${encodeURIComponent(name)}/og.svg`; }
  agentBadgeUrl(name: string): string { return `${this.base}/api/v1/public/agents/${encodeURIComponent(name)}/badge.svg`; }
  repoOgUrl(ns: string, repo: string): string { return `${this.base}/api/v1/public/repos/${encodeURIComponent(ns)}/${encodeURIComponent(repo)}/og.svg`; }
  changeOgUrl(ns: string, repo: string, id: string): string { return `${this.base}/api/v1/public/repos/${encodeURIComponent(ns)}/${encodeURIComponent(repo)}/changes/${encodeURIComponent(id)}/og.svg`; }
  defaultOgUrl(): string { return `${this.base}/api/v1/public/og.svg`; }
  rssUrl(): string { return `${this.base}/api/v1/public/rss.xml`; }

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
  mergeChange(ns: string, repo: string, id: string, method: MergeMethod = "merge") {
    return this.request<{ ok: true; mergeCommit: string; method: MergeMethod }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/merge`, { method });
  }
  rollbackChange(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/rollback`); }
  markDraft(ns: string, repo: string, id: string, draft: boolean) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/draft`, { draft }); }
  requestReviewers(ns: string, repo: string, id: string, reviewers: Array<{ kind: "agent" | "human"; id: string }>) {
    return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviewers`, { reviewers });
  }

  // Comments (inline threads)
  listComments(ns: string, repo: string, id: string) { return this.request<{ threads: CommentThread[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/comments`); }
  addComment(ns: string, repo: string, id: string, body: { threadId?: string; parentId?: string; path?: string; line?: number; side?: "old" | "new"; body: string; suggestion?: string }) {
    return this.request<{ comment: CommentThread["comments"][number] }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/comments`, body);
  }
  resolveThread(ns: string, repo: string, id: string, threadId: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/comments/${threadId}/resolve`); }
  unresolveThread(ns: string, repo: string, id: string, threadId: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/comments/${threadId}/unresolve`); }

  // Milestones + issue templates
  listMilestones(ns: string, repo: string) { return this.request<{ milestones: Milestone[] }>("GET", `/api/v1/repos/${ns}/${repo}/milestones`); }
  createMilestone(ns: string, repo: string, body: { title: string; description?: string; dueDate?: string }) { return this.request<{ milestone: Milestone }>("POST", `/api/v1/repos/${ns}/${repo}/milestones`, body); }
  patchMilestone(ns: string, repo: string, id: string, body: { title?: string; description?: string; dueDate?: string; status?: "open" | "closed" }) { return this.request<{ milestone: Milestone }>("PATCH", `/api/v1/repos/${ns}/${repo}/milestones/${id}`, body); }
  deleteMilestone(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/milestones/${id}`); }

  listIssueTemplates(ns: string, repo: string) { return this.request<{ templates: IssueTemplate[] }>("GET", `/api/v1/repos/${ns}/${repo}/issue-templates`); }
  upsertIssueTemplate(ns: string, repo: string, name: string, body: { title?: string; body?: string; labels?: string[] }) { return this.request<{ template: IssueTemplate }>("PUT", `/api/v1/repos/${ns}/${repo}/issue-templates/${name}`, body); }
  deleteIssueTemplate(ns: string, repo: string, name: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/issue-templates/${name}`); }

  // Audit
  listAudit(ns: string, repo: string, opts: { category?: string; action?: string; before?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.category) q.set("category", opts.category);
    if (opts.action) q.set("action", opts.action);
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.request<{ events: AuditEvent[]; total: number }>("GET", `/api/v1/repos/${ns}/${repo}/audit${q.size ? "?" + q : ""}`);
  }

  // Search
  search(q: string, opts: { publicOnly?: boolean; limit?: number } = {}) {
    const p = new URLSearchParams();
    p.set("q", q);
    if (opts.publicOnly) p.set("public", "1");
    if (opts.limit) p.set("limit", String(opts.limit));
    return this.request<SearchResult>("GET", `/api/v1/search?${p}`);
  }
  platformStats() { return this.request<PlatformStats>("GET", `/api/v1/search/stats`); }

  // Notifications + mentions
  getNotificationPrefs() { return this.request<{ prefs: NotificationPrefs }>("GET", "/api/v1/notifications/prefs"); }
  updateNotificationPrefs(patch: Partial<Omit<NotificationPrefs, "id" | "userId" | "updatedAt">>) { return this.request<{ prefs: NotificationPrefs }>("PATCH", "/api/v1/notifications/prefs", patch); }
  listMentions() { return this.request<{ mentions: Mention[] }>("GET", "/api/v1/notifications/mentions"); }
  ackMention(id: string) { return this.request<{ ok: true }>("POST", `/api/v1/notifications/mentions/${id}/ack`); }

  // Quotas + usage
  getQuota(agentId: string) { return this.request<{ quota: AgentQuota }>("GET", `/api/v1/agents/${agentId}/quota`); }
  updateQuota(agentId: string, patch: Partial<Omit<AgentQuota, "id" | "agentId" | "updatedAt">>) { return this.request<{ quota: AgentQuota }>("PATCH", `/api/v1/agents/${agentId}/quota`, patch); }
  getAgentUsage(agentId: string) { return this.request<{ usage: AgentUsageRow[] }>("GET", `/api/v1/agents/${agentId}/usage`); }

  // 2FA
  setupTotp() { return this.request<{ secret: string; otpauth: string }>("POST", "/api/v1/totp/setup"); }
  verifyTotp(code: string) { return this.request<{ ok: true }>("POST", "/api/v1/totp/verify", { code }); }
  disableTotp(code?: string) { return this.request<{ ok: true }>("POST", "/api/v1/totp/disable", { code }); }

  // CI artifacts
  listArtifacts(ns: string, repo: string, runId: string) { return this.request<{ artifacts: CiArtifact[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/runs/${runId}/artifacts`); }
  addArtifact(ns: string, repo: string, runId: string, body: { name: string; url: string; size?: number; contentType?: string; checksum?: string }) { return this.request<{ artifact: CiArtifact }>("POST", `/api/v1/repos/${ns}/${repo}/ci/runs/${runId}/artifacts`, body); }
  deleteArtifact(ns: string, repo: string, runId: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/ci/runs/${runId}/artifacts/${id}`); }

  // Release assets + auto notes
  listReleaseAssets(ns: string, repo: string, releaseId: string) { return this.request<{ assets: ReleaseAsset[] }>("GET", `/api/v1/repos/${ns}/${repo}/releases/${releaseId}/assets`); }
  addReleaseAsset(ns: string, repo: string, releaseId: string, body: { name: string; url: string; size?: number; contentType?: string; checksum?: string }) { return this.request<{ asset: ReleaseAsset }>("POST", `/api/v1/repos/${ns}/${repo}/releases/${releaseId}/assets`, body); }
  deleteReleaseAsset(ns: string, repo: string, releaseId: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/releases/${releaseId}/assets/${id}`); }
  generateReleaseNotes(ns: string, repo: string, since: "all" | "previous" = "previous") { return this.request<{ body: string }>("GET", `/api/v1/repos/${ns}/${repo}/releases/generate-notes?since=${since}`); }

  // Social
  starRepo(ns: string, repo: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/star`); }
  unstarRepo(ns: string, repo: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/star`); }
  watchRepo(ns: string, repo: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/watch`); }
  unwatchRepo(ns: string, repo: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/watch`); }
  followAgent(name: string) { return this.request<{ ok: true }>("POST", `/api/v1/agents/${name}/follow`); }
  unfollowAgent(name: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/agents/${name}/follow`); }

  // Public (no auth)
  publicStats() { return this.request<PlatformStats>("GET", "/api/v1/public/stats"); }
  publicTrending(limit = 20) { return this.request<{ repos: TrendingRepo[] }>("GET", `/api/v1/public/trending?limit=${limit}`); }
  publicFeed(limit = 50) { return this.request<{ items: PublicActivityItem[] }>("GET", `/api/v1/public/feed?limit=${limit}`); }
  publicLeaderboard(limit = 50) { return this.request<{ agents: LeaderboardEntry[] }>("GET", `/api/v1/public/leaderboard?limit=${limit}`); }
  publicAgent(name: string) { return this.request<PublicAgent>("GET", `/api/v1/public/agents/${name}`); }
  publicChangelog() { return this.request<{ entries: Array<{ id: string; title: string; body: string; tag: string | null; publishedAt: string }> }>("GET", "/api/v1/public/changelog"); }

  // SSO
  listSsoProviders(orgId: string) { return this.request<{ providers: SsoProvider[] }>("GET", `/api/v1/orgs/${orgId}/sso`); }
  createSsoProvider(orgId: string, body: { name: string; kind: SsoProviderKind; config: Record<string, unknown>; enabled?: boolean }) {
    return this.request<{ provider: SsoProvider }>("POST", `/api/v1/orgs/${orgId}/sso`, body);
  }
  deleteSsoProvider(orgId: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/orgs/${orgId}/sso/${id}`); }
  ssoLoginUrl(providerId: string, redirectTo?: string): string {
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
    return `${this.base}/api/v1/sso/start/${providerId}${q}`;
  }

  // Security — dependency + SAST findings
  listVulns(ns: string, repo: string) { return this.request<{ findings: VulnFinding[] }>("GET", `/api/v1/repos/${ns}/${repo}/security/vulns`); }
  resolveVuln(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/security/vulns/${id}/resolve`); }
  listSast(ns: string, repo: string) { return this.request<{ findings: SastFindingRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/security/sast`); }
  resolveSast(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/security/sast/${id}/resolve`); }
  listSastRules(ns: string, repo: string) { return this.request<{ rules: SastRule[]; defaults: Array<Omit<SastRule, "id" | "enabled" | "createdAt">> }>("GET", `/api/v1/repos/${ns}/${repo}/security/rules`); }
  createSastRule(ns: string, repo: string, body: { identifier: string; pattern: string; flags?: string; severity?: "low"|"medium"|"high"|"critical"; message: string; languages?: string[] }) {
    return this.request<{ rule: SastRule }>("POST", `/api/v1/repos/${ns}/${repo}/security/rules`, body);
  }
  deleteSastRule(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/security/rules/${id}`); }
  seedSastDefaults() { return this.request<{ ok: true; seeded: number }>("POST", `/api/v1/security/seed-defaults`); }
  uploadAdvisories(advisories: Array<{ identifier: string; ecosystem: string; packageName: string; vulnerableRange: string; patchedRange?: string; severity?: "low"|"medium"|"high"|"critical"; summary: string; url?: string }>) {
    return this.request<{ inserted: number }>("POST", `/api/v1/advisories`, { advisories });
  }

  // Packages
  listPackages(ns: string, repo: string) { return this.request<{ packages: PackageRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/packages`); }
  listPackageVersions(ns: string, repo: string, kind: string, name: string) { return this.request<{ versions: PackageVersionRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/packages/${kind}/${encodeURIComponent(name)}/versions`); }
  deletePackageVersion(ns: string, repo: string, kind: string, name: string, version: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/packages/${kind}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`); }

  // Forks
  forkRepo(ns: string, repo: string, name?: string) {
    return this.request<{ repoId: string; name: string }>("POST", `/api/v1/repos/${ns}/${repo}/fork`, name ? { name } : {});
  }
  listForks(ns: string, repo: string) {
    return this.request<{ forks: Repo[] }>("GET", `/api/v1/repos/${ns}/${repo}/forks`);
  }
  proposeCrossRepo(ns: string, repo: string, changeId: string, target: { targetNs: string; targetRepo: string; targetBranch: string }) {
    return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${changeId}/propose`, target);
  }

  // Playground (no auth)
  playgroundParse(commitMessage: string) {
    return this.request<{ parsed: { intent?: string; risk?: string; scope: string[]; reviewFocus: ReviewFocus[]; closes: number[]; agent?: string; raw: Record<string, string[]> } }>("POST", "/api/v1/playground/parse", { commitMessage });
  }
  playgroundFocusedDiff(body: { commitMessage?: string; diff: string; files?: Array<{ path: string; content: string }> }) {
    return this.request<{ parsed: { intent?: string; risk?: string; reviewFocus: ReviewFocus[] }; focus: ReviewFocus[]; focused: string; fullDiffLines: number; focusedDiffLines: number }>("POST", "/api/v1/playground/focused-diff", body);
  }

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
