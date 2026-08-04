import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { externalIssueLinks, issues } from "../models/schema.js";
import { insertIssueWithNumber } from "./issue-number.js";

export interface JiraWebhookPayload {
  webhookEvent: string;
  issue?: {
    key: string;
    fields: {
      summary: string;
      description?: string | null;
      status?: { name: string };
      labels?: string[];
    };
    self?: string;
  };
}

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  data?: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
    state?: { name: string };
    url?: string;
    labels?: { nodes?: Array<{ name: string }> };
  };
  type: "Issue" | string;
}

export async function handleJira(db: DB, repoId: string, payload: JiraWebhookPayload, createdBy: { kind: "agent" | "human" | "system"; id: string }) {
  const gh = payload.issue;
  if (!gh) return { handled: false };
  const status = gh.fields.status?.name?.toLowerCase().includes("done") ? "closed" : "open";
  return upsertExternalIssue(db, {
    repoId,
    system: "jira",
    externalKey: gh.key,
    url: gh.self ?? `https://issues.atlassian.net/browse/${gh.key}`,
    title: gh.fields.summary,
    body: gh.fields.description ?? null,
    labels: gh.fields.labels ?? [],
    status,
    createdBy,
  });
}

export async function handleLinear(db: DB, repoId: string, payload: LinearWebhookPayload, createdBy: { kind: "agent" | "human" | "system"; id: string }) {
  if (payload.type !== "Issue" || !payload.data) return { handled: false };
  const d = payload.data;
  const status = d.state?.name?.toLowerCase().includes("done") ? "closed" : "open";
  return upsertExternalIssue(db, {
    repoId,
    system: "linear",
    externalKey: d.identifier,
    url: d.url ?? `https://linear.app/issue/${d.identifier}`,
    title: d.title,
    body: d.description ?? null,
    labels: (d.labels?.nodes ?? []).map(l => l.name),
    status,
    createdBy,
  });
}

async function upsertExternalIssue(db: DB, input: {
  repoId: string;
  system: "jira" | "linear";
  externalKey: string;
  url: string;
  title: string;
  body: string | null;
  labels: string[];
  status: "open" | "closed";
  createdBy: { kind: "agent" | "human" | "system"; id: string };
}) {
  const existingLink = (await db.select().from(externalIssueLinks).where(and(
    eq(externalIssueLinks.repoId, input.repoId),
    eq(externalIssueLinks.system, input.system),
    eq(externalIssueLinks.externalKey, input.externalKey),
  )).limit(1))[0];

  if (existingLink && existingLink.issueId) {
    await db.update(issues).set({
      title: input.title,
      body: input.body,
      status: input.status,
      labels: input.labels,
      updatedAt: new Date(),
    }).where(eq(issues.id, existingLink.issueId));
    return { handled: true, updated: true, issueId: existingLink.issueId };
  }

  // Webhooks burst and REDELIVER (Jira/Linear are both at-least-once), so two
  // syncs racing on the same repo used to lose one issue outright — nothing
  // retries a fire-and-forget webhook handler. The shared allocator (#119)
  // serializes + retries instead of dropping.
  const iss = await insertIssueWithNumber(db, {
    repoId: input.repoId,
    title: input.title,
    body: (input.body ?? "") + `\n\n_Synced from ${input.system.toUpperCase()} ${input.externalKey} — ${input.url}_`,
    status: input.status,
    labels: [...input.labels, `sync:${input.system}`],
    createdByKind: input.createdBy.kind,
    createdById: input.createdBy.id,
  });
  const number = iss.number;

  await db.insert(externalIssueLinks).values({
    repoId: input.repoId,
    issueId: iss.id,
    system: input.system,
    externalKey: input.externalKey,
    url: input.url,
  }).onConflictDoNothing();

  return { handled: true, created: true, issueId: iss.id, number };
}
