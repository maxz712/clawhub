// Agent trust tiers — the single vocabulary + thresholds shared by the
// version-promotion path (agent-versions.ts) and the autonomy gate
// (agent-autonomy.ts). Keeping them here makes the anti-gaming invariant below
// hold BY CONSTRUCTION instead of by two services happening to agree.
//
// Tiers, lowest → highest. `untrusted` is below `sandbox` (a freshly-registered
// version starts here); `trusted` is the human-granted ceiling.
export type TrustTier = "untrusted" | "sandbox" | "standard" | "trusted";

export const TRUST_TIER_RANK: Record<string, number> = {
  untrusted: -1,
  sandbox: 0,
  standard: 1,
  trusted: 2,
};

export function tierRank(tier: string | null | undefined): number {
  return TRUST_TIER_RANK[tier ?? ""] ?? -1;
}

// Earned-autonomy self-merge requires the agent to be at AT LEAST this tier
// (per-version floor AND per-org-registry floor — the most restrictive wins).
// A human who parked a version/agent below this has actually withheld autonomy.
export const MIN_AUTONOMY_TIER: TrustTier = "standard";

// Anti-gaming ceiling. Eval results are SELF-REPORTED (the runner says which
// cases passed), so a passing eval cannot be allowed to confer real authority —
// otherwise an agent reporting all-pass would self-promote into self-merge.
// Like risk-engine (declared risk is a FLOOR, computed risk an independent
// CEILING) and memory importance (self-rated FLOOR vs deterministic CEILING),
// auto-promotion is a self-attested floor capped by this deterministic ceiling:
// a passing self-reported eval can lift a version to at most `sandbox` ("ran a
// real suite, not obviously broken"). The `standard`+ tiers — the ones that
// unlock earned-autonomy self-merge (MIN_AUTONOMY_TIER) — require a HUMAN to
// grant via the version tier control. This closes the loop end-to-end: the
// ceiling sits strictly BELOW the autonomy floor, so self-reported evals alone
// can never reach self-merge.
export const AUTO_PROMOTE_CEILING_TIER: TrustTier = "sandbox";

// A non-trivial suite must back an auto-promotion: enough cases that a single
// rubber-stamp "pass" can't move a tier, and the run must have covered every
// case (no cherry-picking a passing subset). See agent-versions.finishEvalRun.
export const MIN_AUTO_PROMOTE_CASES = 3;

// Compile-time-ish guard (also asserted in tests): the self-reportable ceiling
// must stay strictly below the tier that confers autonomy, or the anti-gaming
// design is defeated. If someone "fixes" the constants to violate this, the
// autonomy floor would become self-grantable.
if (tierRank(AUTO_PROMOTE_CEILING_TIER) >= tierRank(MIN_AUTONOMY_TIER)) {
  throw new Error("trust-tier invariant violated: auto-promote ceiling must sit below the autonomy floor");
}
