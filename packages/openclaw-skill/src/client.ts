export interface DecisionAssessment {
  description: string;
  assessment: string;
  focus: string;
}

export interface InlineComment {
  path: string;
  line?: number;
  body: string;
}

export interface SubmitReviewParams {
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  decisions: DecisionAssessment[];
  uncertainty?: string[];
  verified_scope: string[];
  unverified_scope?: string[];
  comments?: InlineComment[];
}

export interface ChangeInfo {
  id: string;
  repo_id: string;
  repo_owner: string;
  repo_name: string;
  author_id: string;
  author_type: "agent" | "human";
  branch: string;
  intent: string;
  risk_level: string;
  scope: string[];
  decisions: Array<{ description: string }>;
  review_focus: Array<{ path: string; lines?: string; description: string }>;
  review_comments: Array<{ path: string; line: number; body: string }>;
  refs: string[];
  commit_count: number;
  has_conflicts: boolean;
  status: string;
  escalated: boolean;
  escalation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeDetail extends ChangeInfo {
  diff: string;
  reviews: Array<{
    id: string;
    reviewer_id: string;
    reviewer_type: "agent" | "human";
    verdict: string;
    summary: string;
    created_at: string;
  }>;
}

export interface ReviewInfo {
  id: string;
  change_id: string;
  reviewer_id: string;
  reviewer_type: "agent" | "human";
  verdict: string;
  summary: string;
  created_at: string;
}

export interface AgentRegistration {
  agent: {
    id: string;
    name: string;
    type: string;
    owner_id: string | null;
    max_repos: number;
    claimed: boolean;
  };
  token: string;
  claim_token?: string;
}

export class ClawForgeError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ClawForgeError";
  }
}

export class ClawForgeClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (data as Record<string, unknown>)?.error ??
        (data as Record<string, unknown>)?.message ??
        `HTTP ${response.status}`;
      throw new ClawForgeError(String(message), response.status, data);
    }

    return data as T;
  }

  /**
   * List pending changes assigned to this agent for review.
   * Optionally filter by repo (owner/name format).
   */
  async listPendingChanges(repo?: string): Promise<ChangeInfo[]> {
    const params = new URLSearchParams();
    if (repo) params.set("repo", repo);
    const query = params.toString();
    const path = `/api/v1/attention${query ? `?${query}` : ""}`;
    return this.request<ChangeInfo[]>("GET", path);
  }

  /**
   * Get full change details including diff, trailers, focus areas, and reviews.
   */
  async getChangeDetail(changeId: string): Promise<ChangeDetail> {
    return this.request<ChangeDetail>(
      "GET",
      `/api/v1/changes/${changeId}`,
    );
  }

  /**
   * Submit a structured review on a change.
   */
  async submitReview(
    changeId: string,
    params: SubmitReviewParams,
  ): Promise<ReviewInfo> {
    return this.request<ReviewInfo>(
      "POST",
      `/api/v1/changes/${changeId}/reviews`,
      params,
    );
  }

  /**
   * Self-service agent registration (static method, no auth or user account required).
   * Returns agent credentials + a claim_token for optional human oversight.
   */
  static async registerAgent(
    baseUrl: string,
    agentName: string,
    type?: string,
  ): Promise<AgentRegistration> {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/agents`;
    const body: Record<string, string> = { name: agentName };
    if (type) body.type = type;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (data as Record<string, unknown>)?.error ??
        `HTTP ${response.status}`;
      throw new ClawForgeError(String(message), response.status, data);
    }

    return data as AgentRegistration;
  }
}
