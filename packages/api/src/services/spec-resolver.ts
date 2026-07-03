import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issueChanges, issues } from "../models/schema.js";
import type { Change } from "../models/schema.js";

// Behavior-spec hierarchy for conformance verify (M5): linked ISSUE → Change
// DESCRIPTION (Intent + commit bodies) → INFERRED-from-diff. The `specBasis` is
// stamped on the attestation and read DETERMINISTICALLY by the merge gate: an
// inferred-basis attestation satisfies verified autonomy only at low risk. The
// incentive this creates — better descriptions → higher basis → more autonomy —
// is the point. Pure classifier + a thin DB wrapper, so it's unit-testable.

export type SpecBasis = "issue" | "description" | "inferred";

export interface ResolvedSpec {
  basis: SpecBasis;
  /** The full spec text handed to the verifier (16KB cap applied at env time). */
  spec: string;
  /** A short audit excerpt persisted on the attestation (2KB cap). */
  excerpt: string;
}

// A description only counts as a spec when it says something beyond the subject —
// short of this it's not a behavior contract, so we fall through to inferred.
export const MIN_DESCRIPTION_SPEC_CHARS = 80;
const EXCERPT_CAP = 2_000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function excerptOf(spec: string): string {
  return spec.length > EXCERPT_CAP ? spec.slice(0, EXCERPT_CAP - 1) + "…" : spec;
}

/**
 * Pure spec classifier. Given the candidate texts, pick the highest-authority
 * basis that carries real content: a linked issue wins; else a meaningful
 * description (intent differs from the branch name, OR the prose is long enough);
 * else inferred (verify derives the contract from the diff itself).
 */
export function classifySpec(input: {
  issueText?: string | null;
  description?: string | null;
  intent?: string | null;
  branch?: string | null;
}): ResolvedSpec {
  const issue = (input.issueText ?? "").trim();
  if (issue) return { basis: "issue", spec: issue, excerpt: excerptOf(issue) };

  const desc = (input.description ?? "").trim();
  const intent = (input.intent ?? "").trim();
  const branch = (input.branch ?? "").trim();
  const intentMeaningful = !!intent && normalize(intent) !== normalize(branch);
  if (desc.length >= MIN_DESCRIPTION_SPEC_CHARS || intentMeaningful) {
    const spec = [intent, desc].filter(Boolean).join("\n\n").trim();
    if (spec) return { basis: "description", spec, excerpt: excerptOf(spec) };
  }
  return { basis: "inferred", spec: "", excerpt: "" };
}

/**
 * Resolve the spec for a Change: fetch the first linked issue (via issue_changes),
 * then classify. Authoritative at record time (recordVerification calls this),
 * and used for the verifier's CLAWHUB_SPEC env. Best-effort issue lookup.
 */
export async function resolveSpec(db: DB, change: Pick<Change, "id" | "intent" | "description" | "branch">): Promise<ResolvedSpec> {
  let issueText: string | null = null;
  try {
    const linked = (await db.select({ title: issues.title, body: issues.body })
      .from(issueChanges).innerJoin(issues, eq(issues.id, issueChanges.issueId))
      .where(eq(issueChanges.changeId, change.id)).orderBy(issues.number).limit(1))[0];
    if (linked) issueText = [linked.title, linked.body ?? ""].filter(Boolean).join("\n\n").trim() || null;
  } catch { /* issue lookup is best-effort — fall through to description/inferred */ }
  return classifySpec({ issueText, description: change.description, intent: change.intent, branch: change.branch });
}
