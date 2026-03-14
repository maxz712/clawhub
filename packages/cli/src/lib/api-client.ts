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
        const errorBody = await res.json() as { error?: string; message?: string };
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

  // Repos
  async createRepo(data: { name: string; description?: string; defaultBranch?: string }): Promise<unknown> {
    return this.request("POST", "/api/v1/repos", data);
  }

  async getRepo(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${id}`);
  }

  async deleteRepo(id: string): Promise<unknown> {
    return this.request("DELETE", `/api/v1/repos/${id}`);
  }

  async listRepos(): Promise<unknown> {
    return this.request("GET", "/api/v1/dashboard/repos");
  }

  // Changes
  async createChange(repoId: string, data: { branch: string; intent?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/changes`, data);
  }

  async listChanges(repoId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${repoId}/changes`);
  }

  async getChange(repoId: string, changeId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${repoId}/changes/${changeId}`);
  }

  async approveChange(repoId: string, changeId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/changes/${changeId}/approve`);
  }

  async rejectChange(repoId: string, changeId: string, reason?: string): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/changes/${changeId}/reject`, reason ? { reason } : undefined);
  }

  async mergeChange(repoId: string, changeId: string): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/changes/${changeId}/merge`);
  }

  // Reviews
  async submitReview(repoId: string, changeId: string, data: { status: string; body?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/changes/${changeId}/reviews`, data);
  }

  async listReviews(repoId: string, changeId: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${repoId}/changes/${changeId}/reviews`);
  }

  // Files
  async listFiles(repoId: string, branch: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${repoId}/tree/${encodeURIComponent(branch)}`);
  }

  async getFile(repoId: string, branch: string, path: string): Promise<unknown> {
    return this.request("GET", `/api/v1/repos/${repoId}/file/${encodeURIComponent(branch)}/${path}`);
  }

  // Agents
  async registerAgent(data: { name: string; type?: string }): Promise<unknown> {
    return this.request("POST", "/api/v1/agents", data);
  }

  async getAgent(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/agents/${id}`);
  }

  async listAgents(): Promise<unknown> {
    return this.request("GET", "/api/v1/dashboard/agents");
  }

  async getAgentActivity(id: string): Promise<unknown> {
    return this.request("GET", `/api/v1/agents/${id}/activity`);
  }

  async updateAgentPermissions(id: string, permissions: unknown): Promise<unknown> {
    return this.request("PUT", `/api/v1/agents/${id}/permissions`, permissions);
  }

  // Ask
  async askAboutCodebase(repoId: string, question: string): Promise<unknown> {
    return this.request("POST", `/api/v1/repos/${repoId}/ask`, { question });
  }
}

export function createClient(): ApiClient {
  const apiUrl = getApiUrl();
  const token = getToken();
  return new ApiClient(apiUrl, token);
}
