import { sql } from "drizzle-orm";
import type { DB } from "../models/db.js";

/**
 * Platform user metrics for the admin console. Computed deterministically from
 * existing domain tables — no LLM, no new schema, no third-party analytics.
 *
 * The load-bearing idea is the REAL-USER FILTER. ClawHub's user table is
 * polluted by two non-product populations that would otherwise inflate every
 * count: `service` users (the shadow owners auto-provisioned for headless
 * agents, who can never sign in) and verify-harness THROWAWAY users
 * (`clawhub-login` registers `verify-*@example.test` / name "Verify Bot" to
 * drive the UI during e2e checks). Neither is a real human signup.
 *
 * So a human is bucketed as:
 *   - `test`       — the verify-harness fingerprint (email @example.test OR name "Verify Bot")
 *   - `real`       — has a genuine engagement signal: an OAuth identity, a
 *                    verified email, OR a successful login on a later day than
 *                    signup (a throwaway never comes back)
 *   - `unverified` — registered, but none of the above yet (could be a brand-new
 *                    real human or leftover manual test data — surfaced honestly
 *                    rather than counted as real)
 * `service` users are reported separately and never counted as "users".
 *
 * Revenue metrics are intentionally ABSENT: subscriptions are only ever written
 * by the Stripe webhook and there is no checkout flow, so any "paid"/"MRR" tile
 * could only read 0 and would falsely imply the funnel is instrumented.
 */
export interface AdminMetrics {
  users: {
    real: number;
    unverified: number;
    test: number;
    service: number;
  };
  /** Real (engaged) human signups bucketed by ISO week, last 8 weeks incl. zero weeks. */
  signupsByWeek: Array<{ label: string; count: number }>;
  activity: {
    mergedTotal: number;
    merged30d: number;
    mergedByAgent: number;
    mergedByHuman: number;
    /** % of agent-vs-human merged Changes authored by an agent (0 when none). */
    agentAuthoredPct: number;
    reposTotal: number;
    /** Distinct repos with >= 1 merged Change in the trailing 30 days. */
    activeRepos30d: number;
  };
  /** All merged Changes bucketed by ISO week, last 8 weeks incl. zero weeks. */
  mergesByWeek: Array<{ label: string; count: number }>;
  generatedAt: string;
}

// `db.execute` returns the postgres-js RowList (array) on this driver, but can
// surface as `{ rows }` on others — normalize defensively, as the cost-ledger does.
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: unknown[] }).rows ?? []) as T[];
}

// Reusable SQL fragment: every human classified into a bucket. Inlined per query
// (rather than a DB VIEW) so this stays a zero-migration, purely-additive feature.
const CLASSIFIED_HUMANS = sql`
  select
    u.id,
    u.created_at,
    case
      when (u.email ilike '%@example.test' or coalesce(u.name, '') = 'Verify Bot') then 'test'
      when exists (select 1 from user_identities i where i.user_id = u.id)
        or exists (select 1 from email_verifications e where e.user_id = u.id and e.verified_at is not null)
        or exists (
          select 1 from login_attempts l
          where lower(l.email) = lower(u.email) and l.success
            and l.created_at::date > u.created_at::date
        )
      then 'real'
      else 'unverified'
    end as bucket
  from users u
  where u.kind = 'human'
`;

export async function computeAdminMetrics(db: DB): Promise<AdminMetrics> {
  // 1. User buckets (real / unverified / test) + service users.
  const userRows = rowsOf<{ real: number; unverified: number; test: number; service: number }>(
    await db.execute(sql`
      with classified as (${CLASSIFIED_HUMANS})
      select
        count(*) filter (where bucket = 'real')::int        as real,
        count(*) filter (where bucket = 'unverified')::int  as unverified,
        count(*) filter (where bucket = 'test')::int        as test,
        (select count(*)::int from users where kind = 'service') as service
      from classified
    `),
  );
  const u = userRows[0] ?? { real: 0, unverified: 0, test: 0, service: 0 };

  // 2. Real signups per ISO week (last 8 weeks, zero-filled).
  const signupRows = rowsOf<{ label: string; count: number }>(
    await db.execute(sql`
      with weeks as (
        select generate_series(
          date_trunc('week', now()) - interval '7 weeks',
          date_trunc('week', now()),
          interval '1 week'
        ) as wk
      ),
      classified as (${CLASSIFIED_HUMANS})
      select to_char(w.wk, 'MM-DD') as label,
             count(c.id) filter (where c.bucket = 'real')::int as count
      from weeks w
      left join classified c on date_trunc('week', c.created_at) = w.wk
      group by w.wk
      order by w.wk
    `),
  );

  // 3. Merge / activity counts (a merge is real activity regardless of signup bucket).
  const actRows = rowsOf<{
    merged_total: number; merged_30d: number; merged_by_agent: number;
    merged_by_human: number; repos_total: number; active_repos_30d: number;
  }>(
    await db.execute(sql`
      select
        count(*) filter (where status = 'merged')::int as merged_total,
        count(*) filter (where status = 'merged' and merged_at >= now() - interval '30 days')::int as merged_30d,
        count(*) filter (where status = 'merged' and opened_by_agent_id is not null)::int as merged_by_agent,
        count(*) filter (where status = 'merged' and opened_by_user_id is not null)::int as merged_by_human,
        (select count(*)::int from repositories) as repos_total,
        (select count(distinct repo_id)::int from changes
           where status = 'merged' and merged_at >= now() - interval '30 days') as active_repos_30d
      from changes
    `),
  );
  const a = actRows[0] ?? {
    merged_total: 0, merged_30d: 0, merged_by_agent: 0,
    merged_by_human: 0, repos_total: 0, active_repos_30d: 0,
  };
  const authoredDenom = a.merged_by_agent + a.merged_by_human;
  const agentAuthoredPct = authoredDenom > 0 ? Math.round((a.merged_by_agent / authoredDenom) * 100) : 0;

  // 4. Merged Changes per ISO week (last 8 weeks, zero-filled).
  const mergeWeekRows = rowsOf<{ label: string; count: number }>(
    await db.execute(sql`
      with weeks as (
        select generate_series(
          date_trunc('week', now()) - interval '7 weeks',
          date_trunc('week', now()),
          interval '1 week'
        ) as wk
      )
      select to_char(w.wk, 'MM-DD') as label,
             count(c.id) filter (where c.status = 'merged')::int as count
      from weeks w
      left join changes c on date_trunc('week', c.merged_at) = w.wk
      group by w.wk
      order by w.wk
    `),
  );

  return {
    users: {
      real: Number(u.real), unverified: Number(u.unverified),
      test: Number(u.test), service: Number(u.service),
    },
    signupsByWeek: signupRows.map(r => ({ label: r.label, count: Number(r.count) })),
    activity: {
      mergedTotal: Number(a.merged_total),
      merged30d: Number(a.merged_30d),
      mergedByAgent: Number(a.merged_by_agent),
      mergedByHuman: Number(a.merged_by_human),
      agentAuthoredPct,
      reposTotal: Number(a.repos_total),
      activeRepos30d: Number(a.active_repos_30d),
    },
    mergesByWeek: mergeWeekRows.map(r => ({ label: r.label, count: Number(r.count) })),
    generatedAt: new Date().toISOString(),
  };
}
