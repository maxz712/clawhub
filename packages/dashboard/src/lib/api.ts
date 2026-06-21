import { getAgentToken, getToken, logout } from "./auth";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

// Guard so a burst of concurrent 401s only triggers one logout + redirect.
let unauthorizedHandled = false;
function handleUnauthorized() {
  if (unauthorizedHandled) return;
  unauthorizedHandled = true;
  logout();
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

export type Risk = "low" | "medium" | "high" | "critical";
export type ChangeStatus = "pending" | "approved" | "changes_requested" | "merged" | "rolled_back";
export type CiStatus = "pending" | "running" | "success" | "failure" | "skipped";
export type IssueStatus = "open" | "closed";
export type Verdict = "approve" | "request_changes" | "comment";
export type ReviewBasis = "behavior" | "code" | "both";
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
  id: string; name: string; namespaceType: "agent" | "org" | "user"; namespaceId: string;
  namespaceName?: string | null;
  description: string | null; defaultBranch: string; isPublic: boolean;
  mergePolicy: MergePolicy; createdAt: string; updatedAt: string;
  forkOfRepoId?: string | null;
  topics?: string[];
  language?: string | null;
  starsCount?: number;
  watchersCount?: number;
}
export type MergeMethod = "merge" | "squash" | "rebase";
export interface TreeEntry {
  name: string; path: string; type: "dir" | "file"; size: number | null;
  // Optional last-commit info per entry — rendered by the tree listing when the
  // tree API includes it (graceful no-op until then).
  lastCommit?: { sha: string; message: string; authoredAt: string } | null;
}
export interface Change {
  id: string; repoId: string; branch: string; headCommit: string;
  intent: string; risk: Risk; scope: string[]; reviewFocus: ReviewFocus[];
  trailers: Record<string, string[]>; status: ChangeStatus;
  hasConflicts: boolean; escalated: boolean; escalationReason: string | null;
  openedByAgentId: string; ciStatus: CiStatus; createdAt: string; updatedAt: string;
  // Server-computed risk from the diff (may be null on changes pushed before
  // the risk engine shipped) + the explainable reasons behind it. The
  // effective risk shown in the UI is `computedRisk ?? risk`.
  computedRisk?: Risk | null; riskReasons?: string[];
  isDraft?: boolean; requestedReviewers?: Array<{ kind: "agent" | "human"; id: string }>;
  mergedAt?: string | null; mergedBy?: string | null; mergeMethod?: MergeMethod | null; mergeCommit?: string | null;
}

/** The effective risk shown to humans: server-computed wins over agent-declared. */
export function effectiveRisk(change: Pick<Change, "risk" | "computedRisk">): Risk {
  return change.computedRisk ?? change.risk;
}
export interface AttentionItem { change: Change; repo: { ns: string; name: string }; reasons: string[] }
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
export interface TrendingRepo { id: string; namespaceType: "agent" | "org" | "user"; namespace: string; name: string; description: string | null; stars: number; language: string | null; changesThisWeek: number; topAgent: string | null }
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

export interface Attestation { id: string; repoId: string; changeId: string | null; commitSha: string; agentId: string; agentVersion: string | null; modelName: string | null; modelVersion: string | null; promptHash: string | null; framework: string | null; toolsUsed: string[]; testsRun: boolean; typechecked: boolean; signature: string | null; signingKeyId: string | null; extra: Record<string, unknown>; createdAt: string; verified?: boolean }
export interface AgentVersionRow { id: string; agentId: string; version: string; modelName: string | null; promptHash: string | null; notes: string | null; trustTier: "untrusted"|"sandbox"|"standard"|"trusted"; createdAt: string }
export interface EvalSuiteRow { id: string; name: string; description: string | null; cases: unknown[]; passingThreshold: number; createdAt: string }
export interface EvalRunRow { id: string; suiteId: string; agentId: string; agentVersionId: string | null; status: "queued"|"running"|"finished"|"failed"; score: number | null; results: unknown[]; startedAt: string | null; finishedAt: string | null; createdAt: string }
export interface SandboxRow { id: string; agentId: string; repoId: string; ref: string | null; image: string; command: string; status: "pending"|"running"|"finished"|"failed"|"killed"; containerId: string | null; stdout: string; stderr: string; exitCode: number | null; startedAt: string | null; finishedAt: string | null; createdAt: string }
export interface CostEntryRow { id: string; agentId: string; repoId: string | null; changeId: string | null; inputTokens: number; outputTokens: number; cachedTokens: number; costCents: number; model: string | null; kind: string; createdAt: string }
export interface BlastRadius { agentId: string; since: string; changesOpened: Array<{ id: string; repoId: string; branch: string; intent: string; status: string; createdAt: string }>; changesMerged: Array<{ id: string; repoId: string; branch: string; intent: string; mergedAt: string | null; mergeCommit: string | null }>; reviewsSubmitted: number; commentsAuthored: number; reposTouched: Array<{ id: string; name: string }> }
export interface AgentMessageRow { id: string; toAgentId: string; fromKind: "agent"|"human"|"system"; fromId: string; changeId: string | null; kind: string; body: Record<string, unknown>; read: boolean; createdAt: string }
export interface FlagRow { id: string; repoId: string | null; key: string; description: string | null; enabled: boolean; rolloutPercent: number; rules: unknown[]; updatedAt: string; createdAt: string }
export interface WebhookDeliveryRow { id: string; webhookId: string; payload: Record<string, unknown>; attempts: number; status: "pending"|"retrying"|"delivered"|"dead"; lastError: string | null; nextAttemptAt: string; createdAt: string; finishedAt: string | null }
export interface QualityScoreRow { agentId: string; mergeRate: number; revertRate: number; timeToGreenCiP50: number; reviewHitRate: number; driftScore: number; updatedAt: string }
export interface RegisteredOrgAgent { id: string; agentId: string; trustTier: string; approvedAt: string; name: string; gitAuthorName: string; gitAuthorEmail: string }
export type MergeReason =
  | "changes_requested" | "needs_human_approval" | "needs_code_review"
  | "needs_more_approvals" | `ci_${CiStatus}` | (string & {});
export interface MergeDecision { mergeable: boolean; reason?: MergeReason; needsHuman: boolean; needsCi: boolean }
export type ReviewEvidenceKind = "test_output" | "cli_output" | "screenshot" | "log" | "link";
export interface ReviewEvidence {
  id: string; reviewId: string; repoId: string; kind: ReviewEvidenceKind;
  label: string | null; content: string | null; url: string | null; runId: string | null; createdAt: string;
}
export interface ReviewEvidenceInput { kind: ReviewEvidenceKind; label?: string; content?: string; url?: string; runId?: string }
export interface Review {
  id: string; changeId: string; reviewerKind: "agent" | "human"; reviewerId: string;
  verdict: Verdict; basis?: ReviewBasis; summary: string | null; additionalFocus: ReviewFocus[]; submittedAt: string;
  evidence?: ReviewEvidence[];
}
export interface Issue {
  id: string; repoId: string; number: number; title: string; body: string | null;
  status: IssueStatus; assignedAgentId: string | null; labels: string[];
  createdByKind: "agent" | "human" | "system"; createdById: string;
  closingChangeId: string | null; createdAt: string; updatedAt: string;
}
export interface IssueChangeLink { id: string; branch: string; intent: string | null; status: string }
export interface LinkedIssue { number: number; title: string; status: IssueStatus }
export interface IssueComment {
  id: string; issueId: string; body: string;
  authorKind: "agent" | "human" | "system"; authorId: string;
  createdAt: string;
}
export type TriggerKind = "push" | "merge" | "schedule" | "event";
export interface TriggerConfig { cron?: string; event?: string }
export interface CiPipeline {
  id: string; repoId: string; name: string; yaml: string; enabled: boolean;
  triggerKind: TriggerKind; triggerConfig: TriggerConfig;
  lastScheduledRunAt: string | null; createdAt: string;
}
export interface CiRun {
  // pipelineId is null for standing-agent runs (origin "agent" — they run a BYO
  // container, not a repo pipeline); standingAgentId is set instead.
  id: string; repoId: string; changeId: string | null; pipelineId: string | null; standingAgentId: string | null; status: CiStatus;
  origin: TriggerKind | "agent" | null; triggerDepth: number; triggerEvent: string | null; commit: string | null;
  logUrl: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string;
}
/**
 * Rewrite a pipeline YAML's trigger header so the server (which derives
 * triggerKind/triggerConfig from the `on:` field) persists the requested kind.
 * Strips any existing `on:`/`cron:`/`event:` top-level lines, then prepends the
 * canonical trigger block. Keeps the rest of the YAML (name, steps) intact.
 */
export function applyTriggerToYaml(yaml: string, kind: TriggerKind, config: TriggerConfig): string {
  const kept = yaml
    .split(/\r?\n/)
    .filter(l => !/^(on|cron|event)\s*:/.test(l.trim()))
    .join("\n")
    .replace(/^\n+/, "");
  const header =
    kind === "schedule" ? `on: schedule\ncron: "${(config.cron ?? "").trim()}"\n`
      : kind === "event" ? `on: event\nevent: ${(config.event ?? "").trim()}\n`
        : `on: ${kind}\n`;
  return header + kept;
}

export interface SecretRow { name: string; createdAt: string }
export type StandingTrigger = "manual" | "continuous" | "schedule" | "event";
export interface StandingAgent {
  id: string; repoId: string; agentId: string; name: string; image: string; command: string | null;
  trigger: StandingTrigger; cron: string | null; event: string | null; intervalSec: number; mode: string; task: string;
  llmProvider: "anthropic" | "openrouter" | "openai" | "custom"; llmBaseUrl: string | null; hasLlmKey: boolean;
  memoryMb: number; cpus: number; timeoutSec: number; enabled: boolean; status: string;
  lastError: string | null; lastRunId: string | null; lastRunAt: string | null; createdAt: string;
}
export type RoleCapability = "worker" | "reviewer" | "triager" | "specialist";
export interface AgentRoleRow {
  id: string; ownerType: string; ownerId: string | null; name: string; slug: string | null;
  description: string | null; capability: RoleCapability; specialization: string | null;
  image: string; mode: string; trigger: string; cron: string | null; event: string | null;
  intervalSec: number; task: string; llmProvider: string; minTrustTier: string;
  earnedAutonomy: boolean; isTemplate: boolean; isPublic: boolean; hasLlmKey?: boolean;
  deployments?: number; createdAt: string;
}
export interface FleetAgent {
  agentId: string; name: string; trustTier: string;
  quality: { mergeRate: number; revertRate: number; driftScore: number } | null;
  monthCostCents: number; killed: boolean; earnedAutonomy: boolean;
}
export interface FleetRole { id: string; name: string; capability: RoleCapability; specialization: string | null; deployments: number; earnedAutonomy: boolean }
export interface OrgFleet { orgSpendCents: number; roles: FleetRole[]; agents: FleetAgent[] }
export type MemoryKind = "episode" | "convention" | "failure" | "decision" | "expertise";
export interface Memory {
  id: string; kind: MemoryKind; scope: string; title: string; body: string;
  facts: Record<string, unknown>; tags: string[]; importance: number; confidence: number;
  pinned: boolean; useCount: number; validTo: string | null; archivedAt: string | null;
  createdByAgentId: string | null; sourceRunId: string | null; reviewedBy: string | null;
  createdAt: string; hasEmbedding: boolean; agentName?: string | null;
}
export interface StandingAgentInput {
  name?: string; image?: string; command?: string | null; trigger?: StandingTrigger;
  cron?: string | null; event?: string | null; intervalSec?: number; mode?: string; task?: string;
  llmProvider?: string; llmBaseUrl?: string | null; llmApiKey?: string; memoryMb?: number; cpus?: number; timeoutSec?: number;
  enabled?: boolean; agentToken?: string; agentName?: string;
}
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
  // At/above this risk, a human approval must be code/both basis (behavior-only
  // won't satisfy the gate). Defaults to "high" server-side.
  codeReviewRequiredAtRisk?: Risk;
  pathOverrides: Array<{ glob: string; requireHuman: boolean }>;
  trustedAgents: string[];
  // Optional method constraints honored by the change page if present.
  defaultMergeMethod?: MergeMethod;
  allowedMergeMethods?: MergeMethod[];
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
      // Global session-expiry handling: a 401 on a user-token request means the
      // stored JWT is gone/expired/revoked. Clear it and bounce to login so the
      // user isn't stuck staring at a broken page.
      if (res.status === 401 && tokenKind === "user" && token && typeof window !== "undefined") {
        handleUnauthorized();
      }
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
  listOAuthProviders() { return this.request<{ providers: string[] }>("GET", "/api/v1/oauth/providers"); }

  // Agents
  registerAgent(body: { name: string; gitAuthorName?: string; gitAuthorEmail?: string; capabilities?: { push?: boolean; review?: boolean } }) {
    // When a logged-in user registers, the API auto-claims the agent and omits
    // the claim token (claimed:true). Anonymous registrations get a claim_token
    // + expiry (~48h) instead.
    return this.request<{ agent: { id: string; name: string; capabilities: Agent["capabilities"] }; token: string; claimed: boolean; claim_token?: string; claim_token_expires_at?: string }>("POST", "/api/v1/agents", body);
  }
  // User-only: get-or-create the caller's personal agent. A token comes back on
  // creation, or on an existing agent only when rotate:true is passed (a fresh
  // token is minted — older copies stop working). Without rotate, an existing
  // agent returns no token, so repeated calls never silently invalidate one.
  personalAgent(rotate = false) {
    // `owner` is the user's namespace handle (the repo owner) — present on every
    // response path, so the onboarding card can wire the remote to <owner>/<repo>.
    return this.request<{ agent: { id: string; name: string; capabilities?: Agent["capabilities"]; isPersonal?: boolean }; owner: string; token?: string; created: boolean; rotated?: boolean }>("POST", "/api/v1/agents/personal", rotate ? { rotate: true } : undefined);
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
  /**
   * Turn on "Solo mode" for a team of one — applies the canonical solo preset
   * server-side (self-approval allowed at low/medium) while KEEPING the
   * sensitive-path + high-risk code-review backstops. Returns the new policy.
   */
  enableSoloMode(ns: string, repo: string) {
    return this.request<{ ok: true; mergePolicy: MergePolicy }>("POST", `/api/v1/repos/${ns}/${repo}/merge-policy/solo-mode`);
  }
  getTree(ns: string, repo: string, opts: { ref?: string; path?: string } = {}) {
    const q = new URLSearchParams(); if (opts.ref) q.set("ref", opts.ref); if (opts.path) q.set("path", opts.path);
    return this.request<{ ref: string; path: string; entries: TreeEntry[] }>("GET", `/api/v1/repos/${ns}/${repo}/tree?${q}`);
  }
  getBlob(ns: string, repo: string, path: string, ref?: string) {
    const q = new URLSearchParams({ path }); if (ref) q.set("ref", ref);
    return this.request<{ ref: string; path: string; size: number; binary: boolean; truncated: boolean; content: string | null }>("GET", `/api/v1/repos/${ns}/${repo}/blob?${q}`);
  }
  getReadme(ns: string, repo: string, ref?: string) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<{ ref: string; name: string | null; html: string | null }>("GET", `/api/v1/repos/${ns}/${repo}/readme${q}`);
  }
  getAttention() { return this.request<{ items: AttentionItem[] }>("GET", "/api/v1/attention"); }
  getBranches(ns: string, repo: string) { return this.request<{ branches: Array<{ name: string; headCommit: string; isDefault: boolean }> }>("GET", `/api/v1/repos/${ns}/${repo}/branches`); }
  getSocial(ns: string, repo: string) { return this.request<{ starred: boolean; watching: boolean; stars: number; watchers: number; forks: number }>("GET", `/api/v1/repos/${ns}/${repo}/social`); }
  star(ns: string, repo: string, on: boolean) { return this.request<{ ok: true }>(on ? "POST" : "DELETE", `/api/v1/repos/${ns}/${repo}/star`); }
  watch(ns: string, repo: string, on: boolean) { return this.request<{ ok: true }>(on ? "POST" : "DELETE", `/api/v1/repos/${ns}/${repo}/watch`); }

  listCollaborators(ns: string, repo: string) { return this.request<{ collaborators: Array<{ id: string; agentId: string; role: "writer" | "reviewer" }> }>("GET", `/api/v1/repos/${ns}/${repo}/collaborators`); }
  addCollaborator(ns: string, repo: string, agentName: string, role?: "writer" | "reviewer") { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/collaborators`, { agentName, role }); }

  // Changes
  listChanges(ns: string, repo: string) { return this.request<{ changes: Change[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes`); }
  getChange(ns: string, repo: string, id: string) { return this.request<{ change: Change; mergeable: MergeDecision; linkedIssues: LinkedIssue[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}`); }
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

  // Attestations
  listAttestationsByCommit(sha: string) { return this.request<{ attestations: Attestation[] }>("GET", `/api/v1/attestations/commit/${sha}`); }
  listAttestationsByChange(id: string) { return this.request<{ attestations: Attestation[] }>("GET", `/api/v1/attestations/change/${id}`); }
  rotateSigningKey() { return this.request<{ keyId: string }>("POST", `/api/v1/attestations/keys/rotate`); }

  // Sandbox
  launchSandbox(body: { repoId: string; ref?: string; image?: string; command: string; timeoutMs?: number }) { return this.request<{ sandbox: SandboxRow }>("POST", `/api/v1/sandbox`, body, "agent"); }
  getSandbox(id: string) { return this.request<{ sandbox: SandboxRow }>("GET", `/api/v1/sandbox/${id}`); }
  listSandboxes() { return this.request<{ sandboxes: SandboxRow[] }>("GET", `/api/v1/sandbox`); }
  killSandbox(id: string) { return this.request<{ ok: true }>("POST", `/api/v1/sandbox/${id}/kill`); }

  // Cost + budgets
  recordCost(body: { repoId?: string; changeId?: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number; costCents?: number; model?: string; kind?: string }) { return this.request<{ entry: CostEntryRow; budget: { ok: boolean; spentCents: number; limitCents: number; percentUsed: number; shouldAlert: boolean } }>("POST", `/api/v1/cost/self`, body, "agent"); }
  agentCost(agentId: string) { return this.request<{ entries: CostEntryRow[]; monthCents: number }>("GET", `/api/v1/cost/agent/${agentId}`); }
  setAgentBudget(agentId: string, body: { monthlyLimitCents: number; hardLimit?: boolean; alertAtPercent?: number }) { return this.request<{ budget: unknown }>("PUT", `/api/v1/cost/agent/${agentId}/budget`, body); }
  costLeaderboard(opts: { orgId?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.orgId) q.set("orgId", opts.orgId);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.request<{ leaderboard: Array<{ agentId: string; costCents: number; inputTokens: number; outputTokens: number }> }>("GET", `/api/v1/cost/leaderboard${q.size ? "?" + q : ""}`);
  }

  // Ops
  killSwitchStatus(agentId: string) { return this.request<{ engaged: boolean; row: unknown }>("GET", `/api/v1/agents/${agentId}/kill-switch`); }
  engageKillSwitch(agentId: string, reason?: string) { return this.request<{ ok: true }>("POST", `/api/v1/agents/${agentId}/kill-switch`, { reason }); }
  releaseKillSwitch(agentId: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/agents/${agentId}/kill-switch`); }
  blastRadius(agentId: string, hours = 24) { return this.request<{ report: BlastRadius }>("GET", `/api/v1/agents/${agentId}/blast-radius?hours=${hours}`); }
  bulkRollback(agentId: string, changeIds: string[]) { return this.request<{ rolled: string[]; failed: Array<{ id: string; error: string }> }>("POST", `/api/v1/agents/${agentId}/bulk-rollback`, { changeIds }); }

  // A2A messaging
  inbox(unread = false) { return this.request<{ messages: AgentMessageRow[] }>("GET", `/api/v1/agents/inbox${unread ? "?unread=1" : ""}`, undefined, "agent"); }
  markInboxRead(ids: string[]) { return this.request<{ ok: true }>("POST", `/api/v1/agents/inbox/read`, { ids }, "agent"); }
  sendAgentMessage(body: { toAgentId: string; changeId?: string; kind?: string; body: Record<string, unknown> }) { return this.request<{ message: AgentMessageRow }>("POST", `/api/v1/agents/messages`, body); }

  // Agent versions + evals
  listAgentVersions(agentId: string) { return this.request<{ versions: AgentVersionRow[] }>("GET", `/api/v1/agents/${agentId}/versions`); }
  registerAgentVersion(agentId: string, body: { version: string; modelName?: string; promptHash?: string; notes?: string; trustTier?: "untrusted"|"sandbox"|"standard"|"trusted" }) {
    return this.request<{ version: AgentVersionRow }>("POST", `/api/v1/agents/${agentId}/versions`, body);
  }
  promoteAgentTier(agentId: string, versionId: string, trustTier: "untrusted"|"sandbox"|"standard"|"trusted") {
    return this.request<{ version: AgentVersionRow }>("POST", `/api/v1/agents/${agentId}/versions/${versionId}/tier`, { trustTier });
  }
  listEvalSuites() { return this.request<{ suites: EvalSuiteRow[] }>("GET", `/api/v1/evals/suites`); }
  createEvalSuite(body: { name: string; description?: string; cases: unknown[]; passingThreshold?: number }) { return this.request<{ suite: EvalSuiteRow }>("POST", `/api/v1/evals/suites`, body); }
  queueEvalRun(body: { suiteId: string; agentId: string; agentVersionId?: string }) { return this.request<{ run: EvalRunRow }>("POST", `/api/v1/evals/runs`, body); }
  agentEvalRuns(agentId: string) { return this.request<{ runs: EvalRunRow[] }>("GET", `/api/v1/agents/${agentId}/evals`); }

  // Quality
  agentQuality(agentId: string) { return this.request<{ quality: QualityScoreRow; cached?: boolean }>("GET", `/api/v1/agents/${agentId}/quality`); }
  recomputeAgentQuality(agentId: string) { return this.request<{ quality: QualityScoreRow }>("POST", `/api/v1/agents/${agentId}/quality/recompute`); }

  // Flags
  listRepoFlags(ns: string, repo: string) { return this.request<{ flags: FlagRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/flags`); }
  upsertRepoFlag(ns: string, repo: string, key: string, body: { description?: string; enabled?: boolean; rolloutPercent?: number; rules?: unknown[] }) { return this.request<{ flag: FlagRow }>("PUT", `/api/v1/repos/${ns}/${repo}/flags/${key}`, body); }
  evaluateFlag(body: { key: string; repoId?: string; context?: { userId?: string; email?: string; agentId?: string } }) { return this.request<{ enabled: boolean; reason: string }>("POST", `/api/v1/flags/evaluate`, body); }

  // Webhook deliveries
  listWebhookDeliveries(ns: string, repo: string, webhookId: string, status?: string) { return this.request<{ deliveries: WebhookDeliveryRow[] }>("GET", `/api/v1/repos/${ns}/${repo}/webhooks/${webhookId}/deliveries${status ? `?status=${status}` : ""}`); }
  replayDelivery(ns: string, repo: string, webhookId: string, deliveryId: string) { return this.request<{ ok: true }>("POST", `/api/v1/repos/${ns}/${repo}/webhooks/${webhookId}/deliveries/${deliveryId}/replay`); }

  // Migration
  importGithub(body: { githubToken: string; sourceOwner: string; sourceRepo: string; targetRepoName?: string; includeIssues?: boolean; includeComments?: boolean; ghHost?: string }) {
    return this.request<{ repoId: string; repoName: string; cloned: boolean; issuesImported: number; commentsImported: number }>("POST", `/api/v1/migrate/github`, body, "agent");
  }

  // SBOM
  getSbom(ns: string, repo: string, releaseId: string) { return this.request<{ sbom: { format: string; document: unknown } | null }>("GET", `/api/v1/repos/${ns}/${repo}/releases/${releaseId}/sbom`); }
  generateSbom(ns: string, repo: string, releaseId: string) { return this.request<{ sbom: unknown }>("POST", `/api/v1/repos/${ns}/${repo}/releases/${releaseId}/sbom`); }

  // Code search
  codeSearch(ns: string, repo: string, q: string, max = 200) { return this.request<{ hits: Array<{ path: string; line: number; excerpt: string }> }>("GET", `/api/v1/repos/${ns}/${repo}/code/search?q=${encodeURIComponent(q)}&max=${max}`); }
  reindexCode(ns: string, repo: string) { return this.request<{ indexed: number }>("POST", `/api/v1/repos/${ns}/${repo}/code/reindex`); }

  // Presence
  heartbeat(ns: string, repo: string, changeId: string) { return this.request<{ viewers: Array<{ kind: string; id: string; lastSeen: string }> }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${changeId}/presence`); }

  // GDPR
  requestGdprExport() { return this.request<{ requestId: string }>("POST", `/api/v1/gdpr/export`); }
  requestGdprDelete() { return this.request<{ requestId: string }>("POST", `/api/v1/gdpr/delete`); }
  getGdprRequest(id: string) { return this.request<{ request: { id: string; kind: string; status: string; downloadUrl: string | null; createdAt: string; finishedAt: string | null } }>("GET", `/api/v1/gdpr/requests/${id}`); }

  // Org agent registry
  listOrgRegistry(orgId: string) { return this.request<{ agents: RegisteredOrgAgent[] }>("GET", `/api/v1/orgs/${orgId}/registry`); }
  enrollOrgAgent(orgId: string, agentId: string, trustTier: "sandbox"|"standard"|"trusted" = "sandbox") { return this.request<{ ok: true }>("POST", `/api/v1/orgs/${orgId}/registry`, { agentId, trustTier }); }
  revokeOrgAgent(orgId: string, agentId: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/orgs/${orgId}/registry/${agentId}`); }

  // Admin
  adminListUsers() { return this.request<{ users: Array<{ id: string; email: string; name: string | null; createdAt: string; totpEnabled: boolean }> }>("GET", `/api/v1/admin/users`); }
  adminListOrgs() { return this.request<{ orgs: Array<{ id: string; name: string; displayName: string | null; createdAt: string }> }>("GET", `/api/v1/admin/orgs`); }
  adminListAgents() { return this.request<{ agents: Array<{ id: string; name: string; createdAt: string; associatedUserId: string | null }> }>("GET", `/api/v1/admin/agents`); }
  adminListRepos() { return this.request<{ repos: Repo[] }>("GET", `/api/v1/admin/repos`); }
  adminStats() { return this.request<{ users: number; orgs: number; agents: number; repos: number }>("GET", `/api/v1/admin/stats`); }
  adminDeleteUser(id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/admin/users/${id}`); }
  adminAuditExportUrl(limit = 10000): string { return `${this.base}/api/v1/admin/audit/export?limit=${limit}`; }

  // Marketplace
  marketplaceList(q?: string) { return this.request<{ agents: Array<{ id: string; slug: string; name: string; tagline: string | null; description: string | null; capabilities: string[]; pricingModel: string; installs: number; verified: boolean }> }>("GET", `/api/v1/public/marketplace${q ? `?q=${encodeURIComponent(q)}` : ""}`); }
  marketplaceGet(slug: string) { return this.request<{ agent: { slug: string; name: string; tagline: string | null; description: string | null; capabilities: string[]; pricingModel: string; installs: number; verified: boolean } }>("GET", `/api/v1/public/marketplace/${slug}`); }
  marketplacePublish(body: { slug: string; agentId?: string; name: string; tagline?: string; description?: string; capabilities?: string[]; pricingModel?: string }) { return this.request<{ agent: unknown }>("POST", `/api/v1/marketplace/publish`, body); }
  marketplaceInstall(slug: string, body: { orgId?: string; repoId?: string } = {}) { return this.request<{ ok: true }>("POST", `/api/v1/marketplace/${slug}/install`, body); }

  // Billing + invites
  orgSubscription(orgId: string) { return this.request<{ subscription: unknown; trial: unknown }>("GET", `/api/v1/billing/orgs/${orgId}/subscription`); }
  startOrgTrial(orgId: string) { return this.request<{ ok: true }>("POST", `/api/v1/billing/orgs/${orgId}/trial/start`); }
  listOrgInvites(orgId: string) { return this.request<{ invites: Array<{ id: string; email: string; role: string; acceptedAt: string | null; expiresAt: string; createdAt: string }> }>("GET", `/api/v1/billing/orgs/${orgId}/invites`); }
  createOrgInvite(orgId: string, email: string, role: "admin" | "member" = "member") { return this.request<{ invite: { inviteId: string; url: string } }>("POST", `/api/v1/billing/orgs/${orgId}/invites`, { email, role }); }
  revokeOrgInvite(orgId: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/billing/orgs/${orgId}/invites/${id}`); }
  acceptInvite(token: string) { return this.request<{ ok: boolean; orgId?: string; role?: string }>("POST", `/api/v1/billing/invites/accept`, { token }); }
  captureLead(body: { email: string; name?: string; company?: string; note?: string; source?: string }) { return this.request<{ ok: true; id: string }>("POST", `/api/v1/billing/leads`, body); }

  // Status
  publicStatus() { return this.request<{ overall: string; active: Array<{ title: string; severity: string }>; recent: Array<{ id: string; title: string; body: string; severity: string; status: string; startedAt: string; resolvedAt: string | null }> }>("GET", `/api/v1/public/status`); }

  // Auth flows
  requestPasswordReset(email: string) { return this.request<{ ok: true }>("POST", `/api/v1/account/password/reset/request`, { email }); }
  consumePasswordReset(token: string, newPassword: string) { return this.request<{ ok: boolean }>("POST", `/api/v1/account/password/reset/consume`, { token, newPassword }); }
  requestEmailVerify(email: string) { return this.request<{ ok: true }>("POST", `/api/v1/account/email/verify/request`, { email }); }
  consumeEmailVerify(token: string) { return this.request<{ ok: boolean; userId?: string }>("POST", `/api/v1/account/email/verify/consume`, { token }); }

  // GraphQL
  graphql(query: string) { return this.request<{ data?: unknown; errors?: Array<{ message: string }> }>("POST", `/api/v1/graphql`, { query }); }

  // Playground (no auth)
  playgroundParse(commitMessage: string) {
    return this.request<{ parsed: { intent?: string; risk?: string; scope: string[]; reviewFocus: ReviewFocus[]; closes: number[]; agent?: string; raw: Record<string, string[]> } }>("POST", "/api/v1/playground/parse", { commitMessage });
  }
  playgroundFocusedDiff(body: { commitMessage?: string; diff: string; files?: Array<{ path: string; content: string }> }) {
    return this.request<{ parsed: { intent?: string; risk?: string; reviewFocus: ReviewFocus[] }; focus: ReviewFocus[]; focused: string; fullDiffLines: number; focusedDiffLines: number }>("POST", "/api/v1/playground/focused-diff", body);
  }

  // Reviews
  listReviews(ns: string, repo: string, id: string) { return this.request<{ reviews: Review[] }>("GET", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`); }
  submitReview(ns: string, repo: string, id: string, body: { verdict: Verdict; basis?: ReviewBasis; summary?: string; additionalFocus?: ReviewFocus[]; evidence?: ReviewEvidenceInput[] }) {
    return this.request<{ review: Review }>("POST", `/api/v1/repos/${ns}/${repo}/changes/${id}/reviews`, body);
  }

  // Issues
  listIssues(ns: string, repo: string, query?: { status?: IssueStatus; assigned?: "me" }) {
    const q = new URLSearchParams();
    if (query?.status) q.set("status", query.status);
    if (query?.assigned) q.set("assigned", query.assigned);
    return this.request<{ issues: Issue[] }>("GET", `/api/v1/repos/${ns}/${repo}/issues${q.size ? "?" + q : ""}`);
  }
  // The detail endpoint returns the issue + its comment thread + milestone in
  // one call, so the issue page fetches a single issue directly (no O(N) scan of
  // every issue) and gets the comments alongside it.
  getIssue(ns: string, repo: string, num: number) {
    return this.request<{ issue: Issue; comments: IssueComment[]; milestone: Milestone | null; links: IssueChangeLink[] }>("GET", `/api/v1/repos/${ns}/${repo}/issues/${num}`);
  }
  linkIssueChange(ns: string, repo: string, num: number, ref: { changeId?: string; branch?: string }) {
    return this.request<{ ok: true; link: IssueChangeLink }>("POST", `/api/v1/repos/${ns}/${repo}/issues/${num}/changes`, ref);
  }
  unlinkIssueChange(ns: string, repo: string, num: number, changeId: string) {
    return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/issues/${num}/changes/${changeId}`);
  }
  listIssueComments(ns: string, repo: string, num: number) {
    return this.getIssue(ns, repo, num).then(r => ({ comments: r.comments }));
  }
  createIssue(ns: string, repo: string, body: { title: string; body?: string; assignedAgentId?: string; labels?: string[] }) {
    return this.request<{ issue: Issue }>("POST", `/api/v1/repos/${ns}/${repo}/issues`, body);
  }
  patchIssue(ns: string, repo: string, num: number, patch: { title?: string; body?: string; status?: IssueStatus; assignedAgentId?: string | null }) {
    return this.request<{ ok: true }>("PATCH", `/api/v1/repos/${ns}/${repo}/issues/${num}`, patch);
  }
  addIssueComment(ns: string, repo: string, num: number, body: string) {
    return this.request<{ comment: IssueComment }>("POST", `/api/v1/repos/${ns}/${repo}/issues/${num}/comments`, { body });
  }

  // CI
  listPipelines(ns: string, repo: string) { return this.request<{ pipelines: CiPipeline[] }>("GET", `/api/v1/repos/${ns}/${repo}/ci/pipelines`); }
  // The server derives triggerKind/triggerConfig from the YAML `on:` field, so the
  // structured trigger is carried by rewriting the YAML's `on:`/`cron:`/`event:`
  // header before sending. Pass `trigger` to set it explicitly; otherwise the
  // YAML's own `on:` wins.
  upsertPipeline(
    ns: string, repo: string, name: string, yaml: string, enabled = true,
    trigger?: { kind: TriggerKind; config?: TriggerConfig },
  ) {
    const body = trigger ? applyTriggerToYaml(yaml, trigger.kind, trigger.config ?? {}) : yaml;
    return this.request<{ pipeline?: CiPipeline; ok?: true }>("PUT", `/api/v1/repos/${ns}/${repo}/ci/pipelines/${name}`, { yaml: body, enabled });
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

  // Standing agents (BYO autonomous agents). The key is write-only — sealed on
  // submit, never returned.
  listStandingAgents(ns: string, repo: string) { return this.request<{ standingAgents: StandingAgent[] }>("GET", `/api/v1/repos/${ns}/${repo}/standing-agents`); }
  createStandingAgent(ns: string, repo: string, body: StandingAgentInput) { return this.request<{ standingAgent: StandingAgent }>("POST", `/api/v1/repos/${ns}/${repo}/standing-agents`, body); }
  updateStandingAgent(ns: string, repo: string, id: string, body: StandingAgentInput) { return this.request<{ standingAgent: StandingAgent }>("PATCH", `/api/v1/repos/${ns}/${repo}/standing-agents/${id}`, body); }
  deleteStandingAgent(ns: string, repo: string, id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/repos/${ns}/${repo}/standing-agents/${id}`); }
  runStandingAgent(ns: string, repo: string, id: string) { return this.request<{ ok: boolean; runId?: string; reason?: string }>("POST", `/api/v1/repos/${ns}/${repo}/standing-agents/${id}/run`, {}); }

  // Agent roles + fleet.
  listRoleTemplates() { return this.request<{ templates: AgentRoleRow[] }>("GET", "/api/v1/roles/templates"); }
  listRoles(org?: string) { return this.request<{ roles: AgentRoleRow[] }>("GET", `/api/v1/roles${org ? `?org=${org}` : ""}`); }
  createRole(body: Record<string, unknown>) { return this.request<{ role: AgentRoleRow }>("POST", "/api/v1/roles", body); }
  deleteRole(id: string) { return this.request<{ ok: true }>("DELETE", `/api/v1/roles/${id}`); }
  deployRole(id: string, target: { repo?: string; org?: string; topic?: string }) { return this.request<{ deployed: number; alreadyDeployed?: number; skipped?: Array<{ repo: string; reason: string }> }>("POST", `/api/v1/roles/${id}/deploy`, target); }
  listRoleDeployments(id: string) { return this.request<{ deployments: StandingAgent[] }>("GET", `/api/v1/roles/${id}/deployments`); }
  undeployRole(id: string, repo?: string) { return this.request<{ removed: number; revoked: number }>("DELETE", `/api/v1/roles/${id}/deployments${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`); }
  getOrgFleet(orgId: string) { return this.request<OrgFleet>("GET", `/api/v1/fleet?org=${orgId}`); }

  // Agent memory (human view + supervision). Agents write via the API directly.
  listMemory(ns: string, repo: string, opts: { kind?: string; archived?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.kind) q.set("kind", opts.kind);
    if (opts.archived) q.set("archived", "1");
    return this.request<{ memories: Memory[] }>("GET", `/api/v1/repos/${ns}/${repo}/memory?${q}`);
  }
  superviseMemory(ns: string, repo: string, id: string, action: "pin" | "unpin" | "archive" | "unarchive") {
    return this.request<{ memory: Memory }>("PATCH", `/api/v1/repos/${ns}/${repo}/memory/${id}`, { action });
  }
}

export const api = new ApiClient();
export { ApiError };
