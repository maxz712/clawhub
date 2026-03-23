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
      throw new Error(error?.error?.message || error?.message || res.statusText);
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

  async getRepo(ownerAndRepo: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}`);
  }

  async getChanges(ownerAndRepo: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes`);
  }

  async getChange(ownerAndRepo: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}`);
  }

  async approveChange(ownerAndRepo: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/approve`, {
      method: 'POST',
    });
  }

  async rejectChange(ownerAndRepo: string, changeId: string, reason?: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  async mergeChange(ownerAndRepo: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/merge`, {
      method: 'POST',
    });
  }

  async rollbackChange(ownerAndRepo: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/rollback`, {
      method: 'POST',
    });
  }

  // Commits
  async getCommits(ownerAndRepo: string, branch?: string) {
    const ref = branch || 'main';
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/commits/${ref}`);
  }

  // Reviews
  async getReviews(ownerAndRepo: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/reviews`);
  }

  async submitReview(ownerAndRepo: string, changeId: string, data: { verdict: string; summary: string; comments?: Array<{ path: string; line?: number; body: string }> }) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/changes/${changeId}/reviews`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Files
  async listFiles(ownerAndRepo: string, branch?: string) {
    const ref = branch || 'main';
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/tree/${ref}`);
  }

  async getFile(ownerAndRepo: string, path: string, branch?: string) {
    const ref = branch || 'main';
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/file/${ref}/${path}`);
  }

  // Agents
  async registerAgent(name: string, type: string, ownerId: string) {
    return this.fetch('/api/v1/agents', {
      method: 'POST',
      body: JSON.stringify({ name, type, owner_id: ownerId }),
    });
  }

  async claimAgent(claimToken: string) {
    return this.fetch('/api/v1/agents/claim', {
      method: 'POST',
      body: JSON.stringify({ claim_token: claimToken }),
    });
  }

  async getAgent(id: string) {
    return this.fetch(`/api/v1/agents/${id}`);
  }

  // Permissions
  async getPermissions(ownerAndRepo: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/permissions`);
  }

  async createPermission(ownerAndRepo: string, rule: Record<string, unknown>) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/permissions`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
  }

  async deletePermission(ownerAndRepo: string, ruleId: string) {
    return this.fetch(`/api/v1/repos/${ownerAndRepo}/permissions/${ruleId}`, {
      method: 'DELETE',
    });
  }

  // OAuth
  async oauthGitHub(code: string) {
    return this.fetch('/api/v1/users/oauth/github', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async oauthGoogle(code: string, redirectUri: string) {
    return this.fetch('/api/v1/users/oauth/google', {
      method: 'POST',
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
  }

  // Merge Policy
  async getMergePolicy(repoId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/merge-policy`);
  }

  async updateMergePolicy(repoId: string, policy: Record<string, unknown>) {
    return this.fetch(`/api/v1/repos/${repoId}/merge-policy`, {
      method: 'PUT',
      body: JSON.stringify(policy),
    });
  }

  // Focused Diff
  async getFocusedDiff(repoId: string, changeId: string) {
    return this.fetch(`/api/v1/repos/${repoId}/changes/${changeId}/focused`);
  }

  // Attention feed
  async getAttentionItems() {
    return this.fetch('/api/v1/attention');
  }

  async getAttentionItem(id: string) {
    return this.fetch(`/api/v1/attention/${id}`);
  }

  // Governance settings
  async getGovernanceSettings() {
    return this.fetch('/api/v1/settings/governance');
  }

  async updateGovernanceSettings(settings: Record<string, unknown>) {
    return this.fetch('/api/v1/settings/governance', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  // SSE
  getEventStreamUrl(): string {
    return `${API_BASE}/api/v1/events/stream`;
  }

  getApiBase(): string {
    return API_BASE;
  }
}

export const api = new ApiClient();
