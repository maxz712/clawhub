import type { DB } from "../models/db.js";
import { vulnAdvisories } from "../models/schema.js";
import { log } from "./logger.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

// OSV exposes per-ecosystem zip archives. For a lightweight sync, we fetch a
// small page of the API at a time (one package name per call). Operators run
// this via a cron or the admin console. Large-scale mirroring should use the
// gs://osv-vulnerabilities bucket directly.

interface OsvAdvisory {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
  references?: Array<{ type?: string; url?: string }>;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{ type: "ECOSYSTEM" | "SEMVER" | "GIT"; events?: Array<{ introduced?: string; fixed?: string; limit?: string }> }>;
  }>;
  database_specific?: { severity?: string };
}

function rangeString(introduced: string | undefined, fixed: string | undefined): string {
  if (introduced && fixed) return `>=${introduced},<${fixed}`;
  if (fixed) return `<${fixed}`;
  if (introduced) return `>=${introduced}`;
  return ">=0";
}

function patchedString(fixed: string | undefined): string | null {
  return fixed ? `>=${fixed}` : null;
}

function severity(a: OsvAdvisory): "low" | "medium" | "high" | "critical" {
  const dbSev = a.database_specific?.severity?.toLowerCase();
  if (dbSev === "critical" || dbSev === "high" || dbSev === "medium" || dbSev === "low") return dbSev;
  // Fallback: CVSS 3.1 score (severity[].score = vector).
  const s = a.severity?.find(x => x.type === "CVSS_V3")?.score;
  if (s?.includes("/A:H") && s.includes("/C:H")) return "critical";
  if (s?.includes("/C:H") || s?.includes("/I:H")) return "high";
  return "medium";
}

export async function syncFromOsv(db: DB, opts: { ecosystem: string; packageNames: string[]; baseUrl?: string }): Promise<{ inserted: number; updated: number; failed: number }> {
  const base = opts.baseUrl ?? "https://api.osv.dev/v1";
  // SSRF guard: the baseUrl is operator-supplied — refuse a private/internal target.
  const blocked = await assertPublicHttpHost(`${base}/query`);
  if (blocked) throw new ValidationError(`osv baseUrl rejected: ${blocked}`);
  let inserted = 0, updated = 0, failed = 0;
  for (const name of opts.packageNames) {
    try {
      const res = await fetch(`${base}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { ecosystem: opts.ecosystem, name } }),
      });
      if (!res.ok) { failed++; continue; }
      const j = (await res.json()) as { vulns?: OsvAdvisory[] };
      for (const v of j.vulns ?? []) {
        for (const a of v.affected ?? []) {
          if (!a.package?.ecosystem || !a.package?.name) continue;
          for (const r of a.ranges ?? []) {
            const events = r.events ?? [];
            const intro = events.find(e => e.introduced)?.introduced;
            const fixed = events.find(e => e.fixed)?.fixed;
            const identifier = `${v.id}:${a.package.ecosystem}:${a.package.name}:${intro ?? "0"}-${fixed ?? "∞"}`;
            const row = await db.insert(vulnAdvisories).values({
              identifier,
              ecosystem: a.package.ecosystem.toLowerCase() === "crates.io" ? "crates" : a.package.ecosystem.toLowerCase(),
              packageName: a.package.name,
              vulnerableRange: rangeString(intro, fixed),
              patchedRange: patchedString(fixed),
              severity: severity(v),
              summary: v.summary ?? v.details?.slice(0, 240) ?? v.id,
              url: (v.references ?? [])[0]?.url ?? null,
              publishedAt: v.published ? new Date(v.published) : null,
            }).onConflictDoNothing().returning();
            if (row.length) inserted++; else updated++;
          }
        }
      }
    } catch (e) {
      failed++;
      log("warn", "osv_sync_failed", { pkg: name, err: (e as Error).message });
    }
  }
  return { inserted, updated, failed };
}
