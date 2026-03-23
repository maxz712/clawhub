import { eq, and, ne } from "drizzle-orm";
import { agents } from "../models/schema.js";
import type { Database } from "../models/db.js";

export interface ReviewerConfig {
  reviewer_mode: "designated" | "round_robin" | "owner_agents" | "any";
  designated_reviewers?: string[];
  fallback?: string;
  auto_assign: boolean;
}

export const DEFAULT_REVIEWER_CONFIG: ReviewerConfig = {
  reviewer_mode: "owner_agents",
  auto_assign: true,
};

// In-memory round-robin index per repo owner. Resets on process restart,
// which is acceptable -- the goal is rough distribution, not perfect fairness.
const roundRobinState = new Map<string, number>();

/**
 * Determine which agent(s) should review a change, based on the repo's
 * reviewer configuration.
 *
 * Returns an array of agent IDs to notify for review.
 */
export async function assignReviewers(
  db: Database,
  config: ReviewerConfig,
  repoOwnerId: string,
  authorId: string
): Promise<string[]> {
  if (!config.auto_assign) {
    return [];
  }

  switch (config.reviewer_mode) {
    case "designated": {
      // Return the explicit list, filtering out the change author
      const reviewers = (config.designated_reviewers ?? []).filter(
        (id) => id !== authorId
      );
      if (reviewers.length === 0 && config.fallback) {
        return config.fallback !== authorId ? [config.fallback] : [];
      }
      return reviewers;
    }

    case "round_robin": {
      const eligible = await queryEligibleAgents(db, repoOwnerId, authorId);
      if (eligible.length === 0) return [];

      const key = repoOwnerId;
      const idx = roundRobinState.get(key) ?? 0;
      const selected = eligible[idx % eligible.length];
      roundRobinState.set(key, idx + 1);
      return [selected];
    }

    case "owner_agents": {
      return queryEligibleAgents(db, repoOwnerId, authorId);
    }

    case "any": {
      // For now, same as owner_agents. Full platform-wide search is future work.
      return queryEligibleAgents(db, repoOwnerId, authorId);
    }

    default:
      return [];
  }
}

/**
 * Query agents owned by `repoOwnerId` that have canReview=true,
 * excluding the change author.
 */
async function queryEligibleAgents(
  db: Database,
  repoOwnerId: string,
  authorId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, repoOwnerId),
        eq(agents.canReview, true),
        ne(agents.id, authorId)
      )
    );

  return rows.map((r) => r.id);
}
