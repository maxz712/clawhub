const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

class ApiClient {
  private getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('clawforge_token');
  }

  private async fetch(path: string, options?: RequestInit) {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> || {}),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(error.message || error.error || res.statusText);
    }
    return res.json();
  }

  // Auth
  async register(email: string, password: string) {
    return this.fetch('/api/v1/users/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async login(email: string, password: string) {
    return this.fetch('/api/v1/users/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async getMe() {
    return this.fetch('/api/v1/users/me');
  }

  // Dashboard
  async getStats() {
    return this.fetch('/api/v1/dashboard/stats');
  }

  async getActivity() {
    return this.fetch('/api/v1/dashboard/activity');
  }

  async getRepos() {
    return this.fetch('/api/v1/dashboard/repos');
  }

  async getAgents() {
    return this.fetch('/api/v1/dashboard/agents');
  }

  // Repos
  async createRepo(name: string, description?: string) {
    return this.fetch('/api/v1/repos', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  }

  async getRepo(id: string) {
    return this.fetch(`/api/v1/repos/${id}`);
  }

  async getChanges(repoId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes`);
  }

  async getChange(repoId: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}`);
  }

  async approveChange(repoId: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}/approve`, {
      method: 'POST',
    });
  }

  async rejectChange(repoId: string, changeId: string, reason?: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async mergeChange(repoId: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}/merge`, {
      method: 'POST',
    });
  }

  async rollbackChange(repoId: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}/rollback`, {
      method: 'POST',
    });
  }

  // Files
  async listFiles(repoId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/files`);
  }

  async getFile(repoId: string, path: string) {
    return this.fetch(`/api/v1/repos/${repoId}/files/${path}`);
  }

  // Agents
  async registerAgent(name: string, type: string, ownerId: string) {
    return this.fetch('/api/v1/agents', {
      method: 'POST',
      body: JSON.stringify({ name, type, owner_id: ownerId }),
    });
  }

  // Permissions
  async getPermissions(repoId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/permissions`);
  }

  async createPermission(repoId: string, rule: Record<string, unknown>) {
    return this.fetch(`/api/v1/repos/${repoId}/permissions`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  }

  async deletePermission(repoId: string, ruleId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/permissions/${ruleId}`, {
      method: 'DELETE',
    });
  }

  // SSE
  getEventStreamUrl(): string {
    return `${API_BASE}/api/v1/events/stream`;
  }
}

export const api = new ApiClient();
