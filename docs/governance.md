# Governance: who must approve, and on what basis

> **v3 (2026-07-06).** Merge rights are now **role-based and uniform** — see
> `docs/redesign-v3.md` §2. WHO may merge is a role question (`change:merge`,
> enforced by `repo-access.ts:requireMergeRights`), identical for humans and
> agents; WHAT a merge requires is per-repo policy, evaluated with **no
> actor-kind input**. The old kind-keyed machinery (`mergeActorIsAgent`,
> agent-only CI strictness, `allowAgentMergeWithoutCi`, earned autonomy as the
> agent path to merge rights) is removed. "A human owns every merge above low
> risk" is the **default configuration posture**, not a hardcoded rule — this
> page describes those defaults and how to change them.

**Agents and humans both write code. By default, a human approves every merge above low risk.**

ClawHub's default posture is supervision. Agents produce the bulk of the code and humans can push their own code directly — and under the default roles and default merge policy, a human approves anything that carries real risk. Since v3 that is **configuration, not a kind gate**: default roles hand agents no merge permission, and default policy requires human review at medium+ risk — but an owner who grants an agent a role with `change:merge` on a repo whose policy allows it gets full agent-autonomy merges at any risk, by design. This page is for the human setting policy: how risk is computed, what each tier requires by default, how approvals record their basis, and how to (deliberately) loosen the gate.

You never have to trust an agent's self-assessment. Risk is **computed** from the diff, deterministically, with no LLM in the loop. The agent's `Risk:` trailer is only a floor — it can raise the result, never lower it.

## The risk ladder (default policy)

Every Change gets an effective risk of `max(declared, computed)`. Under the default policy, that risk decides who must approve and how.

| Effective risk | Who must approve | Basis required |
|---|---|---|
| **low** | An agent review is enough (where the repo's policy allows agent-only low-risk merges). | any |
| **medium** | A **human** must approve. A behavior-level check ("I ran it, it does the right thing") is acceptable. | `behavior` OK |
| **high / critical** | A **human** must approve, and the approval must be based on **reading the code**. | `code` (or `both`) |
| **any sensitive path** | A **human who reviewed the code**, regardless of declared or computed risk. | `code` (or `both`) |

CI must also be green when `ciRequired` is set (the default).

**CI strictness is uniform (v3).** A failing or in-flight CI (`failure`/`pending`/`running`) blocks everyone. Whether a `skipped` status (a repo with no `on:push` pipeline) satisfies the gate is the **`requireCiRun`** knob, applied identically to every merge actor: when `requireCiRun: true`, CI must have *actually run and passed* (`ciStatus === "success"`) — `skipped` blocks humans and agents alike; when unset (the default), `skipped` passes for everyone. The old kind-keyed rule (agents blocked on `skipped`, humans allowed; `allowAgentMergeWithoutCi` as the opt-out) is gone. The gate is re-checked under the repo lock immediately before the merge, so CI going red mid-merge aborts it.

**Who may merge is a separate, role question (v3).** `requireMergeRights` enforces a write-access floor for every actor; an identity holding a role must also hold `change:merge` in it (the default Developer/Reviewer/Auditor roles do not — only Admin does); role-less identities keep the legacy write-admits-merge behavior. Granting an agent `change:merge` is the explicit, auditable act that enables agent merges — there is no track-record side door (earned autonomy is retired as a merge-rights mechanism).

### What "computed risk" looks like

`risk-engine.ts` floors, bumps, and explains. Each trigger appends a human-readable reason, surfaced on the Change so you see *why* it was gated:

- **Sensitive paths floor at HIGH** — `**/auth/**`, `**/security/**`, payments/billing, `**/migrations/**`, `*.sql`, `.clawhub/policies/**`, `scripts/**`, `.clawhub/ci/**`, `**/secrets*`, `**/middleware/auth*`.
  → reason: `touches sensitive paths (auth/security/payments/migrations/policies)`
  → `scripts/**` + `.clawhub/ci/**` are the deploy/CI control plane: merging them runs code on the host (`scripts/self-deploy.sh`, `on: merge` pipelines), so they must never auto-merge at low risk.
- **Build/deploy/dependency paths floor at MEDIUM** — `deploy/**`, `**/Dockerfile`, `docker-compose*.yml`, `.github/**`, `package.json` + lockfile, `*.tf`, `deploy/helm/**`.
  → reason: `touches build/deploy/dependency paths`
- **Size** — `> 1500` lines floors at high; `> 400` lines bumps one level.
  → reason: `very large change: 2010 lines` / `large change: 620 lines`
- **Mass deletion** — `> 200` deletions and `> 3×` additions floors at medium.
  → reason: `mass deletion: 450 lines removed`
- **Missing tests** — source changed with no test change bumps (capped at high).
  → reason: `code changed without test changes`
- **Track record** — prior rolled-back changes by the author agent in this repo bump (capped at high).
  → reason: `author agent has 2 rolled-back changes in this repo`
- **Declared floor** — the agent's `Risk:` trailer, when higher than the computed value.
  → reason: `agent-declared risk: critical`

Effective risk is the maximum of these. An agent that declares `low` on a migration still lands at `high` — under-declaring never avoids review.

## How approvals record their basis

Every review carries a `basis`: `behavior`, `code`, or `both`.

- **`behavior`** — the reviewer checked what the change *does* (ran it, exercised the feature) without necessarily reading every line.
- **`code`** — the reviewer read the diff.
- **`both`** — read the code *and* verified behavior.

This is recorded on the Change so the merge record shows *how* each approval was reached. At or above `codeReviewRequiredAtRisk` (default `high`), or on a forced/sensitive path, **only `code`/`both` human approvals satisfy the gate** — a behavior-only approval leaves the Change blocked with `needs_code_review`. Below that threshold, a `behavior` approval is enough.

To make outcome review fast, agents are asked to state their verification evidence in the commit body and point `Review-Focus:` at the lines that actually matter — so a `behavior`-basis approval at medium risk takes seconds.

## Setting policy

Merge policy is per-repo JSON on `repositories.merge_policy_json`, evaluated server-side by `merge-policy.ts` on every review, CI update, or policy change. The knobs that govern the ladder:

| Field | Meaning | Default posture |
|---|---|---|
| `requireHumanApproval` | `always` \| `never` \| `if_risk_at_least` | a human is required at/above medium |
| `requireHumanApprovalLevel` | the risk threshold for `if_risk_at_least` | `medium` |
| `minApprovalsHuman` | human approvals required outright | — |
| `minApprovalsTotal` | total approvals required | — |
| `ciRequired` | block merge unless required CI is green | **true** |
| `requireCiRun` | v3, uniform: when true, `skipped` CI blocks EVERY actor (a real run must pass) | false — `skipped` passes for everyone |
| `codeReviewRequiredAtRisk` | at/above this risk, human approvals must be `code`/`both` | `high` |
| `sensitiveBaseline` | v3: apply the `BASELINE_SENSITIVE_GLOBS` sensitive-path forcing | **true** (editable — set `false` to disable) |
| `pathOverrides` | per-glob `requireHuman` overrides | sensitive paths require human code review by default |
| `allowSelfReview` | may the opening agent approve its own Change? | — |
| `trustedAgents` | agents whose approval is sufficient on low-risk Changes | — |

### Sensitive-path defaults

These paths require a human who reviewed the code, no matter what risk is declared or computed. They are a **default-on baseline** (`merge-policy.ts:BASELINE_SENSITIVE_GLOBS`, applied while `sensitiveBaseline` is unset or `true` — v3 demoted it from a non-removable floor to default policy content): a repo's `pathOverrides` can *add* to them, and an owner who genuinely wants the guardrails off sets `sensitiveBaseline: false` — an explicit, audited policy edit (and `.clawhub/policies/**` is itself a sensitive path, so loosening the policy is a human-reviewed Change under the defaults).

```
**/migrations/**   *.sql   deploy/**   scripts/**   .clawhub/ci/**   **/Dockerfile   docker-compose*.yml   .clawhub/policies/**
```

Touching them floors the Change at high and forces a `code`-basis human approval. Treat this as the production backstop: under the defaults, schema, deploy, and policy changes never auto-merge — and it stays in force unless an owner explicitly sets `sensitiveBaseline: false`.

## Solo mode (team of one)

Separation of duties assumes the agent's owner and the approving human are different people. For a **team of one**, they aren't — the solo developer is the only human, so the team-oriented gate just blocks them from shipping their own low/medium work. **Solo mode** is the discoverable, governance-aware opt-in for that case: it lets your own approval count (you approve your agent's Change *as the human*) on low and medium risk, while **keeping the production backstops**:

- Sensitive paths (migrations, `*.sql`, `deploy/**`, Dockerfile, compose, `.clawhub/policies/**`) still force a human who reviewed the code.
- High/critical risk still requires a human `code`-basis approval (`codeReviewRequiredAtRisk: high`).
- CI still gates (`ciRequired` unchanged).

Solo mode is **not** the same as vibecoding (below): vibecoding removes the human entirely at medium; Solo mode keeps a human approval required — it just stops insisting that human be someone *other* than you.

Turn it on three equivalent ways (all apply the same canonical preset — `allowSelfReview: true`, `requireHumanApproval: if_risk_at_least` at `high`, `minApprovalsTotal: 1`, `minApprovalsHuman: 0`, sensitive-path + high-risk backstops preserved):

```bash
# CLI
ch repo solo-mode <ns>/<repo>

# API
curl -X POST https://api.useclawhub.com/api/v1/repos/<ns>/<repo>/merge-policy/solo-mode \
  -H "Authorization: Bearer <token>"
```

Or click **Enable Solo mode** in the repo **Settings → Merge policy** tab, which shows the current state (`allowSelfReview`) and the same one-line backstop explanation. Because it merges into the existing policy, other settings (merge methods, trusted agents, extra path overrides) are preserved.

## Opting a repo INTO auto-merge ("vibecoding" mode)

Auto-merge — agents approving and merging their own work above low risk — is a deliberate per-repo opt-in, **not** the default. Use it only for repos where the blast radius is genuinely low (scratch repos, internal tooling, prototypes you can roll back freely).

Drop a `.clawhub/policies/merge.yml` into the repo (re-read on every push, overrides the DB policy):

```yaml
# .clawhub/policies/merge.yml
# WARNING: vibecoding mode — agents merge their own work without a human.
# Only use this on low-blast-radius repos. Sensitive paths still require a human.
minApprovalsHuman: 0            # no human approval required...
requireHumanApprovalLevel: high # ...until a Change computes to high or above
allowSelfReview: true
ciRequired: true               # keep CI as the one remaining gate
```

> **Warning.** This lets agents merge medium-risk changes with no human in the loop. The sensitive-path backstop above still applies — migrations, `*.sql`, `deploy/**`, Dockerfiles, compose, and `.clawhub/policies/**` continue to require a human who reviewed the code, because those paths floor at high and `requireHumanApprovalLevel: high` re-engages the human there. Leave `ciRequired: true` so failing tests still block. Editing `.clawhub/policies/**` is itself a sensitive-path change, so loosening the policy is a human-reviewed Change.

To stay supervised (the default), simply ship no policy file, or set `requireHumanApprovalLevel: medium`.

## Verified autonomy (an *agent* that ran the code can merge it)

Vibecoding above removes the human at medium risk on trust. **Verified autonomy** goes further — it lets an agent satisfy the high/critical/sensitive **code-review** gate — but only when ClawHub can attest, server-side, that the change was actually **run end-to-end** (API + UI + CLI, with screenshots). The attestation is anchored on a ClawHub-owned verification run pinned to the change's exact head commit, not on the agent's word, and it's a per-repo opt-in that is OFF by default:

```jsonc
// repositories.mergePolicy (PATCH /api/v1/repos/:ns/:repo)
{
  "verifiedAutonomy": {
    "enabled": true,
    "maxRisk": "critical",        // how far up the risk ladder a verified attestation may reach
    "allowSensitivePaths": true,  // may it also cover sensitive paths?
    "floorGlobs": [".clawhub/policies/**", "scripts/**", "deploy/**"]  // ALWAYS human, even verified
  },
  "autoMergeOnVerified": true      // hands-off: auto-merge a verified + CI-green change
}
```

> **Warning.** With `floorGlobs: []` a verified agent can merge `scripts/self-deploy.sh`, the merge policy itself, and `critical`-risk changes with **no human ever in the loop**. Set `floorGlobs` (the `RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS` preset keeps the deploy/policy control plane human-only) unless you genuinely want full autonomy. CI still gates. Deploy a verifier with `ch role verified-reviewer --repo <ns>/<repo> --cli <claude|copilot|codex|gemini>`. Full detail: [verified-autonomy.md](verified-autonomy.md).

---

See also: [design.md](../design.md) (Computed Risk + Merge Policies sections), [`packages/skill/SKILL.md`](../packages/skill/SKILL.md) (the agent's view of all this), and [ci.md](ci.md) for the CI gate.
