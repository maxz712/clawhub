import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines } from "../models/schema.js";
import type { GitService } from "./git.js";
import { parsePipelineTrigger, parseYamlSubset } from "./ci-yaml.js";
import { parseCron } from "./cron.js";
import { log } from "./logger.js";

// CI as config-as-code. Pipelines may be defined in-repo under
//   .clawhub/ci/*.yml   (one file per pipeline)
//   .clawhub/ci.yml      (a single pipeline)
// mirroring how merge policy lives at .clawhub/policies/merge.yml. On a
// default-branch push we read these from the pushed commit and UPSERT each as a
// pipeline so repo-defined CI is version-controlled.
//
// Trust model: like policy-as-code, this is read ONLY from the default branch —
// i.e. after the CI change has itself been reviewed and merged. Reading it from
// a feature head would let an agent self-define the gate that protects its own
// Change.
//
// Additive: a DB-only pipeline (configured via the API/dashboard) that is NOT
// present in-repo is left untouched. We never delete pipelines on push.

const CI_DIR = ".clawhub/ci";
const CI_SINGLE = ".clawhub/ci.yml";

export interface RepoPipelineFile {
  /** Pipeline name (the file's `name:` field, else the filename stem). */
  name: string;
  yaml: string;
}

/**
 * Collect the in-repo pipeline definitions at a commit. Returns one entry per
 * `.clawhub/ci/*.yml` file plus `.clawhub/ci.yml` if present. The pipeline name
 * is the YAML `name:` field when set, otherwise the filename without extension.
 * Files without a usable name are skipped (a pipeline needs a stable key to
 * upsert against).
 */
export async function readRepoPipelines(git: GitService, ns: string, repo: string, commit: string): Promise<RepoPipelineFile[]> {
  const out: RepoPipelineFile[] = [];
  const seen = new Set<string>();

  const ingest = (yaml: string, fallbackName: string) => {
    let declaredName: string | undefined;
    try { declaredName = parseYamlSubset(yaml).name as string | undefined; } catch { declaredName = undefined; }
    const name = (typeof declaredName === "string" && declaredName.trim()) ? declaredName.trim() : fallbackName;
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, yaml });
  };

  // Single-file form.
  try {
    const single = await git.fileAt(ns, repo, commit, CI_SINGLE);
    if (single) ingest(single, "ci");
  } catch { /* absent → skip */ }

  // Directory form: one pipeline per *.yml / *.yaml file.
  let entries: Array<{ name: string; path: string; type: "dir" | "file" }> = [];
  try { entries = await git.listTree(ns, repo, commit, CI_DIR); } catch { entries = []; }
  const ymlFiles = entries.filter(e => e.type === "file" && /\.ya?ml$/i.test(e.name));
  if (ymlFiles.length) {
    const contents = await git.filesAt(ns, repo, commit, ymlFiles.map(f => f.path));
    for (const f of ymlFiles) {
      const yaml = contents.get(f.path);
      if (!yaml) continue;
      ingest(yaml, f.name.replace(/\.ya?ml$/i, ""));
    }
  }

  return out;
}

/**
 * Upsert one repo-defined pipeline. Derives triggerKind + triggerConfig from the
 * YAML `on:` (same path routes/ci.ts PUT uses). A schedule pipeline with no
 * parseable cron, or an event pipeline with no event, is skipped rather than
 * persisted as an inert gate — and logged so the agent can find out why.
 * Returns true when a row was written.
 */
export async function upsertRepoPipeline(db: DB, repoId: string, file: RepoPipelineFile): Promise<boolean> {
  const trigger = parsePipelineTrigger(file.yaml);
  if (trigger.kind === "schedule") {
    if (!trigger.config.cron) { log("warn", "ci_repo_pipeline_skipped", { repoId, name: file.name, reason: "schedule_missing_cron" }); return false; }
    try { parseCron(trigger.config.cron); }
    catch (e) { log("warn", "ci_repo_pipeline_skipped", { repoId, name: file.name, reason: `invalid_cron:${(e as Error).message}` }); return false; }
  }
  if (trigger.kind === "event" && !trigger.config.event) {
    log("warn", "ci_repo_pipeline_skipped", { repoId, name: file.name, reason: "event_missing_type" });
    return false;
  }
  const existing = (await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repoId), eq(ciPipelines.name, file.name))).limit(1))[0];
  if (existing) {
    await db.update(ciPipelines).set({ yaml: file.yaml, triggerKind: trigger.kind, triggerConfig: trigger.config }).where(eq(ciPipelines.id, existing.id));
  } else {
    await db.insert(ciPipelines).values({ repoId, name: file.name, yaml: file.yaml, enabled: true, triggerKind: trigger.kind, triggerConfig: trigger.config });
  }
  return true;
}

/**
 * Sync all in-repo pipeline definitions at `commit` into the DB for `repoId`.
 * Additive — pipelines absent from the repo are left alone. Returns the names of
 * the pipelines that were upserted.
 */
export async function syncRepoPipelines(db: DB, git: GitService, ns: string, repo: string, repoId: string, commit: string): Promise<string[]> {
  const files = await readRepoPipelines(git, ns, repo, commit);
  const synced: string[] = [];
  for (const f of files) {
    if (await upsertRepoPipeline(db, repoId, f)) synced.push(f.name);
  }
  return synced;
}
