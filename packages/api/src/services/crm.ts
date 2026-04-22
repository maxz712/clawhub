import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { crmLeads } from "../models/schema.js";
import { log } from "./logger.js";

export interface LeadInput {
  email: string;
  name?: string;
  company?: string;
  source?: string;
  note?: string;
}

export async function captureLead(db: DB, input: LeadInput): Promise<string> {
  const [row] = await db.insert(crmLeads).values({
    email: input.email,
    name: input.name ?? null,
    company: input.company ?? null,
    source: input.source ?? "web",
    note: input.note ?? null,
  }).returning();

  // Fan out to CRM integrations (fire-and-forget).
  void forward(row);
  return row.id;
}

async function forward(lead: { id: string; email: string; name: string | null; company: string | null; note: string | null; source: string }): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  if (process.env.HUBSPOT_API_KEY) tasks.push(forwardHubspot(lead));
  if (process.env.SLACK_LEAD_WEBHOOK) tasks.push(forwardSlack(lead));
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

async function forwardHubspot(lead: { email: string; name: string | null; company: string | null; note: string | null }): Promise<void> {
  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ properties: { email: lead.email, firstname: lead.name, company: lead.company, notes_last_contacted: lead.note } }),
    });
    if (!res.ok) log("warn", "hubspot_lead_failed", { status: res.status });
  } catch (e) { log("warn", "hubspot_lead_error", { err: (e as Error).message }); }
}

async function forwardSlack(lead: { email: string; name: string | null; company: string | null; note: string | null; source: string }): Promise<void> {
  try {
    await fetch(process.env.SLACK_LEAD_WEBHOOK!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `New ClawHub lead · ${lead.email}${lead.company ? " @ " + lead.company : ""} (${lead.source})${lead.note ? "\n" + lead.note : ""}` }),
    });
  } catch (e) { log("warn", "slack_lead_error", { err: (e as Error).message }); }
}

export async function markSynced(db: DB, id: string): Promise<void> {
  await db.update(crmLeads).set({ syncedAt: new Date() }).where(eq(crmLeads.id, id));
}
