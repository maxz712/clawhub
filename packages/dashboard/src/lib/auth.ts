const USER_TOKEN = "clawhub_token";
const USER_RECORD = "clawhub_user";
const AGENT_TOKEN = "clawhub_agent_token";
const AGENT_NAME = "clawhub_agent_name";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(USER_TOKEN);
}
export function setToken(t: string): void {
  localStorage.setItem(USER_TOKEN, t);
}
export function clearToken(): void {
  localStorage.removeItem(USER_TOKEN);
  localStorage.removeItem(USER_RECORD);
}
export function isLoggedIn(): boolean {
  return !!getToken();
}

export function getStoredUser(): { email: string; name?: string; id: string } | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_RECORD);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function setStoredUser(user: { email: string; name?: string; id: string }): void {
  localStorage.setItem(USER_RECORD, JSON.stringify(user));
}

export function getAgentToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AGENT_TOKEN);
}
export function setAgentToken(t: string, name: string): void {
  localStorage.setItem(AGENT_TOKEN, t);
  localStorage.setItem(AGENT_NAME, name);
}
export function getAgentName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AGENT_NAME);
}

export function logout(): void {
  clearToken();
  localStorage.removeItem(AGENT_TOKEN);
  localStorage.removeItem(AGENT_NAME);
}
