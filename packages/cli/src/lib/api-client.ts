import { getApiUrl, getToken } from "./config.js";

export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(apiUrl: string, token: string) {
    this.baseUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    if (!res.ok) {
      let message = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errorBody = (await res.json()) as { error?: string; message?: string };
        if (errorBody.error) message = errorBody.error;
        else if (errorBody.message) message = errorBody.message;
      } catch {
        // ignore parse errors
      }
      throw new Error(message);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ── Repos ──────────────────────────────────────────────────────────

  async listRepos(): Promise<unknown> {
    return this.request("GET", "/api/v1/dashboard/repos");
  }

  async getRepo(owner: string, repo: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${owner}/${repo}`);
  }

  // ── Changes (owner/repo scheme) ───────────────────────────────────

  async listChanges(owner: string, repo: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${owner}/${repo}/changes`);
  }

  async getChange(owner: string, repo: string, changeId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${owner}/${repo}/changes/${changeId}`);
  }

  async getChangeDecisions(owner: string, repo: string, changeId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${owner}/${repo}/changes/${changeId}/decisions`);
  }

  async getChangeDiff(owner: string, repo: string, changeId: string, full = false): Promise<unknown> {
    const qs = full ? "?full=true" : "";
    return this.request("GET", `/api/v1/repos/${owner}/${repo}/changes/${changeId}/diff${qs}`);
  }

  async mergeChange(owner: string, repo: string, changeId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${owner}/${repo}/changes/${changeId}/merge`);
  }

  // ── Reviews ────────────────────────────────────────────────────────

  async submitReview(
    owner: string,
    repo: string,
    changeId: string,
    data: { verdict: string; body?: string },
  ): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${owner}/${repo}/changes/${changeId}/reviews`, data);
  }

  // ── Attention (human oversight) ────────────────────────────────────

  async listAttentionItems(): Promise<unknown> {
    return this.request("GET", "/api/v1/attention");
  }

  async getAttentionItem(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/attention/${id}`);
  }

  async approveAttentionItem(id: string): Promise<unknown> {
    return this.request("POST", `/api/v1/attention/${id}/approve`);
  }

  async rejectAttentionItem(id: string, reason: string): Promise<unknown> {
    return this.request("POST", `/api/v1/attention/${id}/reject`, { reason });
  }

  // ── Dashboard ──────────────────────────────────────────────────────

  async getDashboard(): Promise<unknown> {
    return this.request("GET", "/api/v1/dashboard/repos");
  }
}

export function createClient(): ApiClient {
  const apiUrl = getApiUrl();
  const token = getToken();
  return new ApiClient(apiUrl, token);
}
