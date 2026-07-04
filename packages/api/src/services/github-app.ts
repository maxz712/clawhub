// GitHub App (N2) — auth core. The App private key is read ONLY here in the API
// process (custody, exactly like the LLM gateway's platform key): it signs a
// short-lived App JWT, which is exchanged for an installation token used to read
// the PR + write a check-run/comment back. None of this ever enters a container.
import { createSign, createHmac, timingSafeEqual } from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  privateKey: string; // PEM
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
}

/** Reads the App config from env. Returns null when unconfigured (feature off). */
export function githubAppConfig(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId || !privateKey) return null;
  // The PEM survives .env transport either base64-encoded or with escaped \n.
  if (!privateKey.includes("BEGIN") && privateKey.length > 100) {
    try { privateKey = Buffer.from(privateKey, "base64").toString("utf8"); } catch { /* not base64 */ }
  }
  privateKey = privateKey.replace(/\\n/g, "\n");
  if (!privateKey.includes("BEGIN")) return null;
  return {
    appId,
    privateKey,
    webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
  };
}

export function githubAppConfigured(): boolean {
  return githubAppConfig() !== null;
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** Signs a ~9-minute App JWT (RS256, iss = App ID). GitHub caps App JWTs at 10m. */
export function appJwt(cfg: GithubAppConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const signingInput = b64url({ alg: "RS256", typ: "JWT" }) + "." + b64url({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: cfg.appId });
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return signingInput + "." + signer.sign(cfg.privateKey).toString("base64url");
}

/** Verifies a webhook body against the `x-hub-signature-256` header (timing-safe). */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined | null, secret: string): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

const GH_API = "https://api.github.com";

async function ghApi<T>(method: string, path: string, token: string, body?: unknown, tokenScheme: "Bearer" | "token" = "Bearer"): Promise<{ status: number; json: T }> {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      authorization: `${tokenScheme} ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "clawhub-app",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: T;
  try { json = (await res.json()) as T; } catch { json = {} as T; }
  return { status: res.status, json };
}

// ---- Installation tokens (cached ~50m; GitHub issues them for 1h) ----
interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

export async function installationToken(cfg: GithubAppConfig, installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const jwt = appJwt(cfg);
  const { status, json } = await ghApi<{ token?: string; expires_at?: string; message?: string }>(
    "POST", `/app/installations/${installationId}/access_tokens`, jwt,
  );
  if (status !== 201 || !json.token) {
    throw new Error(`installation token failed (${status}): ${json.message ?? "unknown"}`);
  }
  const expiresAt = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 55 * 60_000;
  tokenCache.set(installationId, { token: json.token, expiresAt });
  return json.token;
}

/** Test seam: drop a cached installation token. */
export function _clearInstallationTokenCache(): void { tokenCache.clear(); }

// ---- GitHub write helpers (installation-token scoped) ----
export interface CheckRunInput {
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "neutral" | "failure" | "action_required";
  title: string;
  summary: string;
  detailsUrl?: string;
}

export async function createCheckRun(token: string, owner: string, repo: string, input: CheckRunInput): Promise<string | null> {
  const { status, json } = await ghApi<{ id?: number; message?: string }>(
    "POST", `/repos/${owner}/${repo}/check-runs`, token,
    {
      name: "ClawHub review",
      head_sha: input.headSha,
      status: input.status,
      ...(input.conclusion ? { conclusion: input.conclusion } : {}),
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      output: { title: input.title, summary: input.summary },
    },
  );
  if (status >= 300 || !json.id) return null;
  return String(json.id);
}

export async function updateCheckRun(token: string, owner: string, repo: string, checkRunId: string, input: Partial<CheckRunInput>): Promise<boolean> {
  const { status } = await ghApi(
    "PATCH", `/repos/${owner}/${repo}/check-runs/${checkRunId}`, token,
    {
      ...(input.status ? { status: input.status } : {}),
      ...(input.conclusion ? { conclusion: input.conclusion } : {}),
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      ...(input.title || input.summary ? { output: { title: input.title ?? "ClawHub review", summary: input.summary ?? "" } } : {}),
    },
  );
  return status < 300;
}

export async function createIssueComment(token: string, owner: string, repo: string, prNumber: number, body: string): Promise<boolean> {
  const { status } = await ghApi("POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, token, { body });
  return status < 300;
}

export interface GithubPullRequest {
  number: number;
  head: { sha: string; ref: string; repo: { clone_url: string; full_name: string } | null };
  base: { ref: string };
  title: string;
  body: string | null;
  html_url: string;
}

export async function getPullRequest(token: string, owner: string, repo: string, prNumber: number): Promise<GithubPullRequest | null> {
  const { status, json } = await ghApi<GithubPullRequest>("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`, token);
  return status < 300 ? json : null;
}
