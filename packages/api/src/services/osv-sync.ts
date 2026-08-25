import { sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { vulnAdvisories } from "../models/schema.js";
import { log } from "./logger.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

// The rows land in the GLOBAL, unscoped advisory table dep-scan reads for every
// repo, so an unbounded caller-supplied packageNames list is server-side request
// amplification. Cap it, and only ever contact an operator-allowlisted host.
const MAX_PACKAGE_NAMES = 100;
const DEFAULT_OSV_BASE_URL = "https://api.osv.dev/v1";
function allowedOsvBaseUrls(): Set<string> {
  const extra = (process.env.CLAWHUB_OSV_ALLOWED_BASE_URLS ?? "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return new Set([DEFAULT_OSV_BASE_URL, ...extra]);
}

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

export async function syncFromOsv(db: DB, opts: { ecosystem?: unknown; packageNames?: unknown; baseUrl?: unknown }): Promise<{ inserted: number; updated: number; failed: number }> {
  // Validate the shape up front so a bad body is a 400, not a raw 500 from a
  // for-of over a non-array (the loop sat outside the per-item try).
  if (typeof opts.ecosystem !== "string" || !opts.ecosystem.trim()) throw new ValidationError("ecosystem required");
  if (!Array.isArray(opts.packageNames) || opts.packageNames.some(n => typeof n !== "string" || !n.trim())) {
    throw new ValidationError("packageNames must be a non-empty array of strings");
  }
  if (opts.packageNames.length === 0) throw new ValidationError("packageNames must be a non-empty array of strings");
  if (opts.packageNames.length > MAX_PACKAGE_NAMES) throw new ValidationError(`packageNames capped at ${MAX_PACKAGE_NAMES}`);
  if (opts.baseUrl !== undefined && typeof opts.baseUrl !== "string") throw new ValidationError("baseUrl must be a string");
  const ecosystem = opts.ecosystem;
  const packageNames = opts.packageNames as string[];
  const base = (opts.baseUrl as string | undefined)?.trim().replace(/\/+$/, "") || DEFAULT_OSV_BASE_URL;
  // The advisory table is global platform state — restrict WHICH host may author
  // it to an operator allowlist (assertPublicHttpHost alone would let any public
  // attacker host through). SSRF guard still applies as defense in depth.
  if (!allowedOsvBaseUrls().has(base)) throw new ValidationError(`osv baseUrl not allowlisted: ${base}`);
  const blocked = await assertPublicHttpHost(`${base}/query`);
  if (blocked) throw new ValidationError(`osv baseUrl rejected: ${blocked}`);
  let inserted = 0, updated = 0, failed = 0;
  for (const name of packageNames) {
    try {
      const res = await fetch(`${base}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { ecosystem, name } }),
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
            const values = {
              identifier,
              ecosystem: a.package.ecosystem.toLowerCase() === "crates.io" ? "crates" : a.package.ecosystem.toLowerCase(),
              packageName: a.package.name,
              vulnerableRange: rangeString(intro, fixed),
              patchedRange: patchedString(fixed),
              severity: severity(v),
              summary: v.summary ?? v.details?.slice(0, 240) ?? v.id,
              url: (v.references ?? [])[0]?.url ?? null,
              publishedAt: v.published ? new Date(v.published) : null,
            };
            // Real upsert on `identifier` so a corrected advisory SUPERSEDES a
            // stale one (onConflictDoNothing froze the first write forever and
            // still counted it as `updated` — a lie). `xmax = 0` distinguishes a
            // fresh insert from an update so the counters are truthful.
            const row = await db.insert(vulnAdvisories).values(values)
              .onConflictDoUpdate({
                target: vulnAdvisories.identifier,
                set: {
                  ecosystem: values.ecosystem, packageName: values.packageName,
                  vulnerableRange: values.vulnerableRange, patchedRange: values.patchedRange,
                  severity: values.severity, summary: values.summary, url: values.url,
                  publishedAt: values.publishedAt,
                },
              })
              .returning({ isInsert: sql<boolean>`(xmax = 0)` });
            if (row[0]?.isInsert) inserted++; else updated++;
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
