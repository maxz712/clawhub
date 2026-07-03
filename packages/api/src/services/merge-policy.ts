import { minimatch } from "minimatch";
import type { Risk } from "./trailer-parser.js";
import { VERIFY_TIER_ORDER, isVerifyTier, type VerifyTier } from "./verify-tier.js";

export interface MergePolicy {
  requireHumanApproval: "always" | "never" | "if_risk_at_least";
  requireHumanApprovalLevel: Risk;
  minApprovalsTotal: number;
  minApprovalsHuman: number;
  allowSelfReview: boolean;
  ciRequired: boolean;
  // Per-repo opt-in (default false). By default an AGENT-performed merge requires
  // CI to have ACTUALLY RUN AND PASSED ("success") — a "skipped" status (a repo
  // with no applicable on:push pipeline) does NOT count, so an agent can never land
  // a commit with zero CI. A repo whose assurance is the e2e verification run rather
  // than an on:push pipeline (verified autonomy) can set this true to let an agent
  // merge proceed on "skipped". A FAILING / in-flight CI ("failure"/"pending"/
  // "running") still blocks regardless (that is the ciRequired gate, unchanged) —
  // this only relaxes the "no pipeline ran" case. Humans are unaffected either way.
  allowAgentMergeWithoutCi?: boolean;
  // Per-repo opt-in (default false): reject AGENT direct pushes to the default
  // branch, forcing granted agents through a Change (the merge gate). Humans may
  // still push directly by design. Enforced in post-push.ts. See security audit.
  blockAgentDirectDefaultPush?: boolean;
  // At or above this effective risk, the human approvals that satisfy the gate
  // must be code-level ("code"/"both") — a behavior-only approval no longer
  // counts. Defaults to "high".
  codeReviewRequiredAtRisk?: Risk;
  // Separation of duties: when true AND the code-review gate fires, a human
  // approval from the authoring agent's OWNING user does not count toward the
  // gate — an INDEPENDENT human must sign off on the code. Left undefined here,
  // evaluateMerge defaults it from the repo's namespace: TRUE for ORG repos
  // (a team must have a second pair of eyes) and FALSE for USER/solo repos
  // (the owner self-approving their own agent's change is the intended flow).
  requireIndependentApprover?: boolean;
  pathOverrides: Array<{ glob: string; requireHuman: boolean }>;
  trustedAgents: string[];
  allowedMergeMethods?: Array<"merge" | "squash" | "rebase">;
  defaultMergeMethod?: "merge" | "squash" | "rebase";
  // Verified autonomy: an opt-in that lets an AGENT reviewer's e2e-verified
  // attestation (a ClawHub-owned verification run, re-checked server-side and
  // pinned to the Change's exact head commit — see services/verification.ts)
  // stand in for the human approval the risk/path gate would otherwise demand.
  // OFF unless explicitly enabled. This is the ONE place an agent verdict can
  // satisfy the human gate, and it never rests on the review payload — only on
  // an attestation evaluateMerge is handed. See docs/verified-autonomy.md.
  //   maxRisk            — the highest effective risk a verified attestation may
  //                        cover (can be `critical` for full autonomy).
  //   allowSensitivePaths— whether a verified attestation may also satisfy the
  //                        sensitive-path human requirement (pathForcesHuman).
  //   floorGlobs         — paths that ALWAYS require a human even when verified
  //                        (a configurable, per-repo backstop). Default [] (no
  //                        floor); RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS is a
  //                        safe preset the UI can offer.
  //   minTier            — the minimum verification tier an attestation must have
  //                        been produced at to count (static|app|services|dind).
  //                        Default `static` (no floor); a cautious repo raises it so
  //                        only a real app/services boot can auto-merge. Combined
  //                        with the risk floor (RISK_MIN_VERIFY_TIER) as a max.
  //   maxInferredSpecRisk— the highest risk an INFERRED-basis attestation (no
  //                        linked issue / meaningful description — the verifier
  //                        derived the spec from the diff) may auto-merge. Default
  //                        `low`: conformance to a real spec (issue/description)
  //                        earns more autonomy than "the diff verifies itself" (M5).
  verifiedAutonomy?: { enabled: boolean; maxRisk: Risk; allowSensitivePaths: boolean; floorGlobs?: string[]; minTier?: VerifyTier; maxInferredSpecRisk?: Risk };
  // When true, a Change that becomes mergeable via a verified attestation is
  // auto-merged (hands-off) instead of waiting for a human to click merge. The
  // server-side merge gate is still the authorization — this only removes the
  // final manual click. OFF by default.
  autoMergeOnVerified?: boolean;
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// The MINIMUM verification tier an e2e attestation must have been produced at to
// satisfy the gate for a Change of a given effective risk — defense in depth on top
// of the verify-tier selector's own risk floor. A low-risk (e.g. docs) Change may
// auto-merge on a `static` attestation; medium must at least have booted the app;
// high/critical must have run against real services. The repo's
// `verifiedAutonomy.minTier` raises this floor further.
const RISK_MIN_VERIFY_TIER: Record<Risk, VerifyTier> = { low: "static", medium: "app", high: "services", critical: "services" };

export type ReviewBasis = "behavior" | "code" | "both";

// The basis recorded on a satisfied merge decision. A superset of ReviewBasis:
// "verified" marks a gate satisfied by an e2e verified-autonomy attestation
// rather than a human approval. NEVER accepted as a review INPUT basis — only
// produced by evaluateMerge for the audit trail.
export type SatisfiedBasis = ReviewBasis | "verified";

// Non-removable sensitive-path baseline. These globs ALWAYS force a human
// code-level approval, on EVERY repo, regardless of the repo's configurable
// `pathOverrides` (which a permissive policy — or a Change to that policy —
// could otherwise shrink) and regardless of when the repo's policy row was
// written. This is the code-level floor under per-repo config, mirroring how
// risk-engine floors risk deterministically.
//
// Why these: they are the paths that EXECUTE CODE ON, OR RECONFIGURE, the host
// and its trust boundary. `scripts/**` holds self-deploy.sh (merging runs it on
// the prod host); `.clawhub/ci/**` are the pipeline definitions an `on: merge`
// deploy runs; `.clawhub/policies/**` is the merge policy itself; migrations/
// *.sql mutate the database; deploy/Dockerfile/compose define the runtime. A
// malicious or careless Change to any of these must never auto-merge at low
// risk — it gets a human who read the code. See docs/governance.md + the
// 2026-06-20 security audit (deploy-path-not-sensitive finding).
export const BASELINE_SENSITIVE_GLOBS = [
  ".clawhub/policies/**",
  ".clawhub/ci/**",
  "scripts/**",
  "**/scripts/**",
  "**/migrations/**",
  "**/*.sql",
  "deploy/**",
  "**/Dockerfile",
  "docker-compose*.yml",
];

/** True when any changed path hits the non-removable sensitive baseline. */
export function touchesBaselineSensitive(paths: string[]): boolean {
  return paths.some(p => BASELINE_SENSITIVE_GLOBS.some(g => minimatch(p, g, { dot: true })));
}

// A SAFE preset for `verifiedAutonomy.floorGlobs`: the deploy/policy control
// plane that, if a verified agent could merge it with no human, would let the
// agent rewrite its own governance (`.clawhub/policies/**`), the pipelines an
// `on: merge` deploy runs (`.clawhub/ci/**`), the host scripts a merge executes
// (`scripts/**` — e.g. self-deploy.sh), or the deploy manifests (`deploy/**`).
// NOT enforced by default — `floorGlobs` defaults to [] — but offered by the UI
// and docs as the recommended backstop. A repo opts in by setting it.
export const RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS = [
  ".clawhub/policies/**",
  ".clawhub/ci/**",
  "scripts/**",
  "**/scripts/**",
  "deploy/**",
];

/** True when any changed path hits the repo's configured verified-autonomy floor. */
export function touchesVerifiedAutonomyFloor(paths: string[], floorGlobs: string[]): boolean {
  if (!floorGlobs.length) return false;
  return paths.some(p => floorGlobs.some(g => minimatch(p, g, { dot: true })));
}

/**
 * "Solo mode" preset for a team of one. A solo developer is the only human, so
 * the team-oriented separation-of-duties gate (a human who is NOT the agent's
 * owner) just blocks them from shipping their own low/medium work.
 *
 * This preset lets the developer's own approval count (`allowSelfReview: true`)
 * and requires a single total approval — but it deliberately KEEPS the
 * production backstops so solo mode never becomes "no governance":
 *   - `pathOverrides` (migrations, *.sql, deploy/**, Dockerfile, compose,
 *     `.clawhub/policies/**`) still force a human on sensitive paths.
 *   - `codeReviewRequiredAtRisk: "high"` still demands a code-level human
 *     approval on high/critical changes.
 *   - `requireHumanApprovalLevel: "high"` so medium work flows but high doesn't.
 *
 * Merges into an existing policy so a repo's other settings (merge methods,
 * trusted agents, any extra path overrides) are preserved, not clobbered.
 */
export function applySoloModePreset(current: MergePolicy): MergePolicy {
  return {
    ...current,
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "high",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: true,
    ciRequired: current.ciRequired,
    codeReviewRequiredAtRisk: "high",
  };
}

const RISKS: Risk[] = ["low", "medium", "high", "critical"];
const APPROVAL_MODES = ["always", "never", "if_risk_at_least"] as const;
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const asInt = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt);
const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const asRisk = (v: unknown, dflt: Risk): Risk => (typeof v === "string" && (RISKS as string[]).includes(v) ? (v as Risk) : dflt);

/**
 * Coerce a persisted `verifiedAutonomy` blob to a safe shape, or undefined.
 * Errs SAFE like the rest of normalizeMergePolicy: the feature is OFF unless
 * `enabled === true` is EXPLICITLY present (a missing/garbage/`false` value, or
 * a non-object, yields undefined → no verified-autonomy credit in evaluateMerge).
 * `maxRisk` defaults to `high` (covers high but not critical) and
 * `allowSensitivePaths` to false — a repo wanting more must opt in explicitly.
 */
function normalizeVerifiedAutonomy(raw: unknown): MergePolicy["verifiedAutonomy"] {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (v.enabled !== true) return undefined;
  const floorGlobs = Array.isArray(v.floorGlobs) ? v.floorGlobs.filter((g): g is string => typeof g === "string") : [];
  return {
    enabled: true,
    maxRisk: asRisk(v.maxRisk, "high"),
    allowSensitivePaths: asBool(v.allowSensitivePaths, false),
    floorGlobs,
    ...(isVerifyTier(v.minTier) ? { minTier: v.minTier } : {}),
    // Inferred-spec attestations auto-merge only up to `low` unless the repo
    // explicitly raises it (M5) — earning autonomy on a real spec is the intent.
    maxInferredSpecRisk: asRisk(v.maxInferredSpecRisk, "low"),
  };
}

/**
 * Coerce an arbitrary persisted/`PUT` object into a COMPLETE, well-formed
 * MergePolicy. The org-default + per-repo policy write paths take a free-form
 * JSON body, and a policy missing required fields would otherwise (a) throw at
 * evaluate time — `policy.pathOverrides.some(...)` on undefined bricks every
 * Change on that repo — or (b) silently WEAKEN gating (a missing `ciRequired`
 * reads falsy → CI not required; a garbage `requireHumanApprovalLevel` makes the
 * risk gate NaN → never fires). Every default here errs SAFE: `ciRequired: true`,
 * human approval `if_risk_at_least` `medium`, `allowSelfReview: false`. Applied
 * at the evaluate boundary (so legacy/malformed rows from any source degrade to
 * the safe baseline) AND at the write boundary (so storage is always clean).
 */
export function normalizeMergePolicy(raw: unknown): MergePolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const approval = APPROVAL_MODES.includes(r.requireHumanApproval as never) ? (r.requireHumanApproval as MergePolicy["requireHumanApproval"]) : "if_risk_at_least";
  const pathOverrides = Array.isArray(r.pathOverrides)
    ? r.pathOverrides
        .filter((o): o is { glob: string; requireHuman: boolean } => !!o && typeof o === "object" && typeof (o as { glob?: unknown }).glob === "string")
        .map(o => ({ glob: o.glob, requireHuman: asBool((o as { requireHuman?: unknown }).requireHuman, true) }))
    : [];
  const trustedAgents = Array.isArray(r.trustedAgents) ? r.trustedAgents.filter((x): x is string => typeof x === "string") : [];
  const allowedMergeMethods = Array.isArray(r.allowedMergeMethods)
    ? r.allowedMergeMethods.filter((m): m is "merge" | "squash" | "rebase" => (MERGE_METHODS as readonly string[]).includes(m as string))
    : undefined;
  const out: MergePolicy = {
    requireHumanApproval: approval,
    requireHumanApprovalLevel: asRisk(r.requireHumanApprovalLevel, "medium"),
    minApprovalsTotal: asInt(r.minApprovalsTotal, 1),
    minApprovalsHuman: asInt(r.minApprovalsHuman, 0),
    allowSelfReview: asBool(r.allowSelfReview, false),
    ciRequired: asBool(r.ciRequired, true),
    codeReviewRequiredAtRisk: asRisk(r.codeReviewRequiredAtRisk, "high"),
    pathOverrides,
    trustedAgents,
  };
  // Preserve optionals only when meaningfully set (so evaluate's namespace-based
  // default for requireIndependentApprover still applies when unspecified).
  if (typeof r.requireIndependentApprover === "boolean") out.requireIndependentApprover = r.requireIndependentApprover;
  if (allowedMergeMethods && allowedMergeMethods.length) out.allowedMergeMethods = allowedMergeMethods;
  if ((MERGE_METHODS as readonly string[]).includes(r.defaultMergeMethod as string)) out.defaultMergeMethod = r.defaultMergeMethod as MergePolicy["defaultMergeMethod"];
  const verifiedAutonomy = normalizeVerifiedAutonomy(r.verifiedAutonomy);
  if (verifiedAutonomy) out.verifiedAutonomy = verifiedAutonomy;
  if (r.autoMergeOnVerified === true) out.autoMergeOnVerified = true;
  // Default false (SAFE): an agent merge needs a real CI 'success'. Only an
  // explicit opt-in relaxes that to allow 'skipped' for agents.
  if (r.allowAgentMergeWithoutCi === true) out.allowAgentMergeWithoutCi = true;
  return out;
}

export interface MergeInputs {
  policy: MergePolicy;
  risk: Risk;
  // Server-computed risk from the diff. Effective risk = max(risk, computedRisk).
  computedRisk?: Risk;
  // Agent-declared scope (Scope: trailer). Display only — never used for gating.
  scope: string[];
  // Authoritative git-changed paths. Sensitive-path forcing reads these so an
  // agent can't dodge a code-review requirement via its Scope: trailer.
  // Falls back to scope only for pre-migration Changes that lack it.
  changedPaths?: string[];
  // The change's author. Exactly one of these is set: an agent push sets
  // `openedByAgentId`, a human push sets `openedByUserId`. Used for the
  // self-review exclusion below — the author's own approval doesn't count when
  // `allowSelfReview` is off.
  openedByAgentId?: string;
  openedByUserId?: string;
  // The user who counts as the change's author for the separation-of-duties gate.
  // For an agent author that's the user who OWNS the agent (associated_user_id ??
  // service_user_id); for a human author it's the human themselves. This user's
  // own approval cannot be the INDEPENDENT reviewer of their own change. Null/
  // undefined when unknown (e.g. a headless agent with no service user) — the SoD
  // gate then can't exclude anyone, so it falls open.
  openedByOwnerUserId?: string | null;
  // The repo's namespace kind. Defaults requireIndependentApprover when the
  // policy itself doesn't set it: org → true, user/agent → false.
  namespaceType?: "user" | "org" | "agent";
  reviews: Array<{ reviewerKind: "agent" | "human"; reviewerId: string; verdict: "approve" | "request_changes" | "comment"; agentName?: string; basis?: ReviewBasis }>;
  ciStatus: "pending" | "running" | "success" | "failure" | "skipped";
  // True when the merge is being PERFORMED by an agent (a reviewer/role agent
  // self-merging, a trusted-agent low-risk merge, or the verified-autonomy
  // hands-off auto-merge) rather than by a human clicking merge. When set, the CI
  // gate is strict: CI must have ACTUALLY RUN AND PASSED ("success") — a "skipped"
  // status (a repo with no applicable pipeline) does NOT satisfy it, closing the
  // path by which an agent could land a commit with zero CI. A human-performed
  // merge stays accountable for its own click and is unaffected. Undefined on the
  // generic display/evaluate call (no actor yet) — the strict rule applies only at
  // the moment a merge is actually performed by an agent.
  mergeActorIsAgent?: boolean;
  // A server-validated e2e verification attestation for THIS change's current
  // head commit, loaded by ChangeService.evaluate() from verification_runs (the
  // ClawHub-owned run record — never the review payload). Present only when a
  // deployed verify-mode reviewer agent reported success for the live head. When
  // present + the policy opts in, it can satisfy the human gate (see below).
  //   ok       — the verification run succeeded (all checks passed).
  //   agentId  — the verifier agent (must differ from the change's author).
  //   headCommit — the commit it attests (matched to the change head upstream).
  //   tier     — the verification tier it was produced at (static|app|services|dind);
  //              the gate rejects an attestation below the risk/policy minimum.
  //   specBasis— the behavior-spec basis it verified against (issue|description|
  //              inferred, M5). An inferred basis auto-merges only up to
  //              `maxInferredSpecRisk`. Null/absent treated as inferred (conservative).
  verifiedAttestation?: { ok: boolean; agentId: string; headCommit: string; tier?: string | null; specBasis?: "issue" | "description" | "inferred" | null };
}

export interface MergeDecision {
  mergeable: boolean;
  reason?: string;
  needsHuman: boolean;
  needsCi: boolean;
  // True when the effective risk / path forced a code-level human review.
  codeReviewRequired?: boolean;
  // The strongest human-approval basis that satisfied the gate, for the audit
  // trail ("code" or "both" when code review was required; "behavior" when a
  // behavior-only human approval sufficed; "verified" when a verified-autonomy
  // attestation stood in for the human; undefined when no human was needed).
  satisfiedBasis?: SatisfiedBasis;
  // True when the separation-of-duties gate was active (an independent human,
  // not the authoring agent's owner, had to approve).
  independentApproverRequired?: boolean;
  // True when a verified-autonomy attestation supplied the approval the human
  // gate would otherwise have required. Recorded so the merge audit shows the
  // merge landed with NO human in the loop.
  verifiedAutonomyUsed?: boolean;
}

export function evaluateMerge(i: MergeInputs): MergeDecision {
  const { reviews, ciStatus } = i;
  // The author's own reviewer id(s) — an agent reviews as its agentId, a human as
  // their userId. Their own approval doesn't count unless allowSelfReview is on.
  const authorReviewerIds = new Set<string>([i.openedByAgentId, i.openedByUserId].filter((x): x is string => !!x));
  // Normalize the policy so a malformed persisted policy (from the free-form
  // org-default / per-repo / in-repo-yml write paths, or a legacy row) degrades
  // to the SAFE baseline instead of throwing on `policy.pathOverrides.some` or
  // silently dropping the CI/human gates. See normalizeMergePolicy.
  const policy = normalizeMergePolicy(i.policy);
  // Gating reads authoritative changed paths, not the agent-declared scope.
  const gatePaths = i.changedPaths && i.changedPaths.length ? i.changedPaths : i.scope;

  // Effective risk is the higher of agent-declared and server-computed: an
  // agent can never talk its way below what the diff actually warrants.
  const risk: Risk = i.computedRisk && RISK_ORDER[i.computedRisk] > RISK_ORDER[i.risk] ? i.computedRisk : i.risk;

  if (reviews.some(r => r.verdict === "request_changes")) {
    return { mergeable: false, reason: "changes_requested", needsHuman: false, needsCi: false };
  }

  const needsCi = policy.ciRequired && ciStatus !== "success" && ciStatus !== "skipped";
  if (needsCi) {
    return { mergeable: false, reason: `ci_${ciStatus}`, needsHuman: false, needsCi: true };
  }
  // Agent-performed merges demand CI that ACTUALLY RAN AND PASSED. The base gate
  // above already blocked failure/pending/running for everyone, so here ciStatus is
  // "success" or "skipped". "skipped" (a repo with no applicable pipeline) passes
  // for a human who is accountable for clicking merge — but it is the one path by
  // which an AGENT (earned-autonomy self-merge, trusted-agent low-risk merge, or
  // verified-autonomy auto-merge) could land a commit with ZERO CI. So when an
  // agent is the one merging, require a real "success" — UNLESS the repo explicitly
  // opted into allowAgentMergeWithoutCi (e.g. its assurance is the e2e verification
  // run, not an on:push pipeline). Gated on ciRequired, so a repo that turned CI off
  // entirely is not forced back on.
  if (i.mergeActorIsAgent && policy.ciRequired && ciStatus !== "success" && !policy.allowAgentMergeWithoutCi) {
    return { mergeable: false, reason: `agent_requires_ci_${ciStatus}`, needsHuman: false, needsCi: true };
  }

  const approvals = reviews.filter(r => r.verdict === "approve" && (policy.allowSelfReview || !authorReviewerIds.has(r.reviewerId)));
  const humanApprovals = approvals.filter(r => r.reviewerKind === "human");

  const pathForcesHuman = touchesBaselineSensitive(gatePaths)
    || gatePaths.some(p => policy.pathOverrides.some(o => o.requireHuman && minimatch(p, o.glob, { dot: true })));
  const riskForcesHuman = policy.requireHumanApproval === "always"
    || (policy.requireHumanApproval === "if_risk_at_least" && RISK_ORDER[risk] >= RISK_ORDER[policy.requireHumanApprovalLevel]);
  const humansRequired = Math.max(policy.minApprovalsHuman, pathForcesHuman || riskForcesHuman ? 1 : 0);

  // Code-level review gate: at/above this risk (or when a path override forces a
  // human), the human approvals that satisfy humansRequired must be based on
  // reading the code — a behavior-only approval does not count for those slots.
  const codeGateLevel = policy.codeReviewRequiredAtRisk ?? "high";
  const codeReviewRequired = pathForcesHuman || RISK_ORDER[risk] >= RISK_ORDER[codeGateLevel];
  let qualifyingHumanApprovals = codeReviewRequired
    ? humanApprovals.filter(r => r.basis === "code" || r.basis === "both")
    : humanApprovals;

  // Separation of duties: when the code-review gate fires, the human who signs
  // off on the code must be INDEPENDENT of the change's author — i.e. not the
  // user who owns the authoring agent. Defaults on for ORG repos (a team needs a
  // second reviewer) and off for USER/solo repos (the owner self-approving their
  // own agent's change is the intended persona-1 flow). The exclusion only bites
  // when code review is required; low-risk self-merge under threshold is
  // untouched.
  const requireIndependent = policy.requireIndependentApprover ?? (i.namespaceType === "org");
  const independentApproverRequired = codeReviewRequired && requireIndependent && !!i.openedByOwnerUserId;
  if (independentApproverRequired) {
    qualifyingHumanApprovals = qualifyingHumanApprovals.filter(r => r.reviewerId !== i.openedByOwnerUserId);
  }

  // Verified autonomy: a server-validated e2e attestation (pinned to this head
  // commit — see services/verification.ts) can supply the ONE human approval the
  // gate demands, but only when the repo opted in AND the attestation clears
  // every guard: within the policy's maxRisk, not on the configured floor,
  // sensitive paths only if allowSensitivePaths, and NEVER from the change's own
  // author (the existing no-self-approval invariant). This is the single path by
  // which an agent signal satisfies the human gate. The credit is exactly one
  // slot — `minApprovalsHuman > 1` still needs the additional humans.
  const va = policy.verifiedAutonomy;
  // The attestation must have been produced at a tier deep enough for this Change's
  // risk (and the repo's configured floor). A null tier (Change pushed before tiering)
  // is treated as the heaviest (`dind`) so legacy attestations still qualify.
  const requiredTierOrder = Math.max(
    VERIFY_TIER_ORDER[RISK_MIN_VERIFY_TIER[risk]],
    va?.minTier ? VERIFY_TIER_ORDER[va.minTier] : 0,
  );
  const attestTier = i.verifiedAttestation?.tier;
  const attestTierOrder = attestTier && isVerifyTier(attestTier) ? VERIFY_TIER_ORDER[attestTier] : VERIFY_TIER_ORDER.dind;
  // Spec-basis cap (M5): an INFERRED-basis attestation (the verifier derived the
  // contract from the diff, no issue/description to conform to) auto-merges only up
  // to `maxInferredSpecRisk`. A null/absent basis is treated as inferred. issue/
  // description basis is unrestricted (subject to the other guards).
  const attestSpecBasis = i.verifiedAttestation?.specBasis ?? "inferred";
  const specBasisOk = attestSpecBasis !== "inferred"
    || RISK_ORDER[risk] <= RISK_ORDER[va?.maxInferredSpecRisk ?? "low"];
  const attestationQualifies = !!(
    va?.enabled && humansRequired > 0 && i.verifiedAttestation?.ok
    && i.verifiedAttestation.agentId !== i.openedByAgentId
    && !touchesVerifiedAutonomyFloor(gatePaths, va.floorGlobs ?? [])
    && RISK_ORDER[risk] <= RISK_ORDER[va.maxRisk]
    && specBasisOk
    && attestTierOrder >= requiredTierOrder
    && (!pathForcesHuman || va.allowSensitivePaths)
  );
  const verifiedCredit = attestationQualifies ? 1 : 0;
  // Load-bearing only when a human didn't already satisfy the slot.
  const verifiedAutonomyUsed = attestationQualifies && qualifyingHumanApprovals.length < humansRequired;

  if (qualifyingHumanApprovals.length + verifiedCredit < humansRequired) {
    // Distinguish the failure modes so the UI can say WHY:
    //  - an independent reviewer is missing (author's owner approved, but no one else)
    //  - a code-level review is missing (a human approved on behavior only)
    //  - no human approved at all
    let reason: string;
    if (independentApproverRequired
        && humanApprovals.filter(r => r.basis === "code" || r.basis === "both").length >= humansRequired) {
      reason = "needs_independent_approver";
    } else if (codeReviewRequired && humanApprovals.length >= humansRequired) {
      reason = "needs_code_review";
    } else {
      reason = "needs_human_approval";
    }
    return { mergeable: false, reason, needsHuman: true, needsCi: false, codeReviewRequired, independentApproverRequired };
  }

  // Trusted agent approval can stand in for general approvals on low-risk.
  const trustedAgentApprovals = approvals.filter(r => r.reviewerKind === "agent" && r.agentName && policy.trustedAgents.includes(r.agentName));
  const effectiveApprovals = approvals.length + (risk === "low" ? trustedAgentApprovals.length : 0);

  if (effectiveApprovals < policy.minApprovalsTotal) {
    return { mergeable: false, reason: "needs_more_approvals", needsHuman: false, needsCi: false, codeReviewRequired, independentApproverRequired };
  }

  // Record which basis satisfied the gate, for the audit trail. A human approval
  // wins the record when present; otherwise a verified-autonomy attestation that
  // filled the slot is recorded as "verified" (merge landed with no human).
  let satisfiedBasis: SatisfiedBasis | undefined;
  if (humansRequired > 0 && qualifyingHumanApprovals.length) {
    satisfiedBasis = qualifyingHumanApprovals.some(r => r.basis === "both")
      ? "both"
      : qualifyingHumanApprovals.some(r => r.basis === "code")
        ? "code"
        : "behavior";
  } else if (humansRequired > 0 && verifiedAutonomyUsed) {
    satisfiedBasis = "verified";
  }

  return { mergeable: true, needsHuman: false, needsCi: false, codeReviewRequired, satisfiedBasis, independentApproverRequired, verifiedAutonomyUsed };
}
