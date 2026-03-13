export interface FileChange {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
}

export interface SubmitChangeParams {
  intent: string;
  branch: string;
  files: FileChange[];
  description?: string;
  risk_assessment?: string;
}

export interface RepoInfo {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  created_at: string;
}

export interface ChangeInfo {
  id: string;
  repo_id: string;
  intent: string;
  description?: string;
  branch: string;
  status: string;
  created_at: string;
}

export interface AgentRegistration {
  agent: {
    id: string;
    name: string;
    owner_id: string;
  };
  token: string;
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

  async createRepo(
    name: string,
    description?: string,
  ): Promise<RepoInfo> {
    return this.request<RepoInfo>("POST", "/api/v1/repos", {
      name,
      description,
    });
  }

  async submitChange(
    repoId: string,
    params: SubmitChangeParams,
  ): Promise<ChangeInfo> {
    return this.request<ChangeInfo>(
      "POST",
      `/api/v1/repos/${repoId}/changes`,
      params,
    );
  }

  async getChangeStatus(
    repoId: string,
    changeId?: string,
  ): Promise<ChangeInfo | ChangeInfo[]> {
    if (changeId) {
      return this.request<ChangeInfo>(
        "GET",
        `/api/v1/repos/${repoId}/changes/${changeId}`,
      );
    }
    return this.request<ChangeInfo[]>(
      "GET",
      `/api/v1/repos/${repoId}/changes`,
    );
  }

  async listRepos(): Promise<RepoInfo[]> {
    return this.request<RepoInfo[]>("GET", "/api/v1/dashboard/repos");
  }

  async getRepoInfo(repoId: string): Promise<RepoInfo> {
    return this.request<RepoInfo>("GET", `/api/v1/repos/${repoId}`);
  }

  async listFiles(repoId: string): Promise<string[]> {
    const result = await this.request<{ files: string[] }>(
      "GET",
      `/api/v1/repos/${repoId}/files`,
    );
    return result.files;
  }

  async getFileContents(
    repoId: string,
    path: string,
  ): Promise<string> {
    const encodedPath = path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const result = await this.request<{ content: string }>(
      "GET",
      `/api/v1/repos/${repoId}/files/${encodedPath}`,
    );
    return result.content;
  }

  static async registerAgent(
    baseUrl: string,
    ownerId: string,
    agentName: string,
  ): Promise<AgentRegistration> {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/agents`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: agentName,
        owner_id: ownerId,
      }),
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
