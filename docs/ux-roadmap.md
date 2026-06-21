# ClawHub UX/Feature Roadmap

> Generated from the 4-persona UX audit (new-user, solo-dev, work-project/team, fleet-manager).
> Captures everything that was **deferred / not yet implemented** after the audit's fix commits
> (`c9e1e77` p0, `33c5ed8` p1, `17017c7` p2, `6df9792` p3 — all merged & deployed to production).
> Each item is self-contained enough to pick up cold. Effort is relative; verify file refs before starting.

## Executive summary

The backlog splits cleanly into ~15 net-new surfaces/subsystems ("large features") and ~25 smaller themed fixes, recurring across four personas but reducing to a smaller set after merging duplicates (branch protection, notifications, marketplace-install, ops-fleet-blindness, and the eval/trust-tier governance gaps each appear in 2-3 personas as one underlying gap). Three forces should drive sequencing. First, SECURITY/CORRECTNESS-CRITICAL items that silently mislead operators must go first: the OIDC SSO callback is a hard blocker (employees never sign in), and two "governance theater" controls — the per-version trust tier and the org-registry trust tier — render UI buttons that gate nothing at merge time, which is the most dangerous UX class because an operator believes a control is active when it is inert. Second, the highest end-to-end USER VALUE is the public read-only repo view: it is the load-bearing dependency that makes trending, leaderboard, and profile links actually reach code for logged-out visitors, and nothing in the pre-signup funnel works without it. Third, many high-value items are CHEAP because the backend and even the api.ts client method already exist and only the UI wiring is missing (request-reviewers control, webhook-delivery log, fork/propose buttons, marketplace target picker, eval-suite UI) — these are "wire the existing client method to a button" tasks that punch above their effort. The notification subsystem (durable inbox + actually-sending review-requested/@-mention signals) is the single biggest cross-persona multiplier and should anchor an early batch since the delivery plumbing is shared by reviewer-routing, mentions, and CI-failure signals. Branch protection recurs as the top solo+team ask and is half-built (enforcement of allowedMergeMethods/requireCiSuccess exists; requiredApprovals/requirePullRequest are declared-but-unread and there is no write route or editor). Recommended logic: ship the blocker + the two inert-governance fixes first (trust + safety), then the public repo view (funnel), then the notification subsystem and the cluster of cheap "wire-the-existing-method" items, then the heavier net-new surfaces (integrations UI, fork/cross-repo flow, eval authoring, org-default policy, human collaborators), with the structural cleanups (shared public layout, IA gating) interleaved as capacity allows.

## Recommended implementation order

1. **Batch 1 — Trust & sign-in correctness (P0): Fix OIDC SSO callback 302-redirect; wire agentVersions.trustTier into merge/dispatch (or remove buttons); wire org-registry trustTier into evaluateMerge (or drop the claim); add eval auto-promotion anti-gaming ceiling.**
   - _Two of these are 'governance theater' — a control the operator believes is active but that gates nothing — the single most dangerous UX class. The OIDC fix is a hard blocker (the headline Team feature signs no one in) and is small. Highest safety value, mostly small effort._
2. **Batch 2 — Public discovery funnel: Public read-only repo view + shared public header/footer (built together).**
   - _The load-bearing dependency for the entire pre-signup funnel — trending/leaderboard/profile links currently dead-end at /login. Highest top-of-funnel user value; the shared header naturally covers the new public pages._
3. **Batch 3 — Notification subsystem: send review-requested + @-mention signals (delivery), then the durable in-app inbox.**
   - _Biggest cross-persona multiplier — default-on toggles currently gate delivery paths that don't exist. Shared write-on-event plumbing feeds reviewer-routing, mentions, and CI-failure signals consumed by later batches; delivery half ships independently first._
4. **Batch 4 — Cheap high-value wiring + security hardening: request-reviewers control, webhook delivery-log/replay UI, marketplace target picker; bind CI secrets-pull to claiming agent, Jira/Linear HMAC auth, webhook event-name validation, secrets legibility copy.**
   - _Backend + client methods already exist — these are 'wire the method to a button' tasks that punch above their effort, bundled with the remaining CI/secrets security hardening so the security-relevant work front-loads._
5. **Batch 5 — Branch protection (editor + requiredApprovals/requirePullRequest enforcement).**
   - _Top recurring solo+team ask, half-built already (enforcement of merge-methods/CI exists). Sequenced after notifications so approval signals can notify; before org-default policy so the per-repo policy model is complete first._
6. **Batch 6 — Live freshness + review-loop usability: Home/attention re-fetch + activity backlog replay, change-detail refresh, undo 'request changes', binary file serve/preview.**
   - _Removes daily friction in the core review/merge loop for the solo persona; depends on the SSE event plumbing touched in earlier batches._
7. **Batch 7 — Fleet manager console correctness + RBAC: ops org-fleet visibility, org cost budgets, org repos health columns, org auto-repo role gate, collaborator-role vocabulary.**
   - _Makes the fleet/governance surfaces actually reflect the org they govern and closes the privilege gap where any org member can create company-namespace repos._
8. **Batch 8 — Heavier net-new surfaces: Integrations UI, forks/cross-repo end-to-end, eval-suite authoring UI, in-repo Security tab seeding, marketplace real-install + catalog seeding, custom/personal Role authoring.**
   - _Large multi-file subsystems that benefit from the notification, attention, and merge-policy primitives built earlier; each is independently shippable once its dependencies (notifications, repo-access) are stable._
9. **Batch 9 — Authz-core extensions + governance at scale: per-repo human collaborators, org-default merge policy.**
   - _These touch the central access model (repo-access.ts) and policy resolution — sequenced last among large features to avoid churning the authz core while the public-repo-view edits to repoAccessFor settle, and to build the org-policy precedence chain once branch protection + trust tiers are complete._
10. **Batch 10 — IA polish + low-priority cleanups: pricing single-source, /u route reconciliation, playground // REVIEW: wiring, email-verification messaging, solo IA fixes (attention error state, actor-name resolution, search deep-link, import personal-agent, /issues redirect, issue priority/milestone, operator-surface scoping), tree latest-commit, standing-agent mode selector.**
   - _Low-severity, mostly small/trivial quality-of-life items that can be batched opportunistically or used as fillers between the heavier batches; none block other work._

## Large features (net-new surfaces / subsystems)

### Public read-only repo browse surface (logged-out)  `[large]`

**What.** Build an unauthenticated repo browse surface OUTSIDE the (app) route group so logged-out visitors arriving from /trending, /leaderboard, or a public profile can read code. Today every /repos/[ns]/[repo] route (plus tree/blob/changes/issues sub-routes) lives only under packages/dashboard/src/app/(app)/ whose layout.tsx (line ~13) redirects any non-logged-in visitor to /login. Create read-only tree/blob/readme/changes views (new public route group, e.g. app/(public)/r/[ns]/[repo]/...), back them with anonymous-safe API endpoints, and rewire every public repo link (u/[name] Top repos, trending links, leaderboard) to the new surface.

**Why.** Audit rank 5, severity high. The most natural pre-signup exploration path dead-ends at /login. The prior fix only added a ?next= redirect (returns the visitor after login) — it did NOT create a public surface. This is the load-bearing dependency that makes trending/profile links actually reach code; without it the entire discovery funnel is broken.

**Key files.** NEW public route group under packages/dashboard/src/app/ (mirror of the (app) repo routes, no login gate); packages/dashboard/src/app/(app)/layout.tsx:~13 (login gate to leave intact for app routes); packages/api/src/routes/public.ts + routes/code.ts (add/confirm anonymous-readable tree/blob/readme/changes endpoints); packages/api/src/services/repo-access.ts (repoAccessFor already grants public repos to authenticated callers — extend to anonymous/no-token callers for public repos only, denied read -> 404 to avoid existence leak); link sites: packages/dashboard/src/app/u/[name]/page.tsx, app/trending/page.tsx, app/leaderboard/page.tsx

**Dependencies.** None hard, but should precede/accompany the shared public header/footer item so the public repo pages get consistent nav. Reuses code.ts tree/blob endpoints (already exist for the file explorer).

**Acceptance / verify.** A logged-out visitor can open a public repo from /trending, see its README/tree/blob/changes read-only with NO redirect to /login, and a private repo returns 404 (no existence leak) for an anonymous caller. Verify repo-access.repoAccessFor denies anonymous read of private repos and allows anonymous read of public ones. All public repo links resolve to the new surface, not into (app).

### Branch protection editor + full enforcement (unified solo+team)  `[large]`

**What.** Add a per-branch protection editor UI in repo Settings, a Team+ entitlement-gated write route, an api.ts client method, AND complete the enforcement of the two declared-but-unread fields. Backend already enforces allowedMergeMethods and requireCiSuccess (services/changes.ts:147-152) and reads protection jsonb from the branches row; but requiredApprovals and requirePullRequest are only declared in the BranchProtection interface (changes.ts:22-23) and read nowhere. There is no write route in routes/repos.ts and no api.ts setter.

**Why.** Audit: high severity, recurs as the #1 ask for BOTH the solo-developer (P1) and team (P2) personas. A solo dev cannot protect their default branch; a team cannot require approvals or a PR. Settings page currently shows only a 'planned but not yet editable here' placeholder. Entitlements already list branchProtection as a Team feature.

**Key files.** packages/dashboard/src/app/(app)/repos/[ns]/[repo]/settings/page.tsx:255 (replace placeholder with editor: requireCiSuccess, blockForcePush, blockDeletion, allowedMergeMethods, requiredApprovals, requirePullRequest); NEW PATCH /repos/:ns/:repo/branches/:name/protection in packages/api/src/routes/repos.ts (entitlement-gated via services/entitlements.ts requireEntitlement Team+, authz via resolveRepoForAdmin); packages/dashboard/src/lib/api.ts (add setBranchProtection method); packages/api/src/services/changes.ts:mergeLocked (~126) — ADD enforcement of requiredApprovals (count basis-valid approvals) and requirePullRequest; schema.ts branches.protection jsonb (already exists)

**Dependencies.** None. Enforcement of requiredApprovals should reuse the existing approval-counting + basis logic already in merge-policy.ts/changes.ts.

**Acceptance / verify.** From Settings a repo admin can set protection on a branch; the PATCH route rejects non-Team callers with 403 upgrade_required and non-admins with 403; setting requiredApprovals=2 blocks merge until two basis-valid approvals exist; requirePullRequest blocks direct merges; force-push/deletion blocked when toggled. Tests assert mergeLocked throws branch_protection for under-approved and PR-required cases.

### Notification subsystem: delivery + durable in-app inbox  `[large]`

**What.** Two coupled gaps unified: (1) ACTUALLY SEND the review-requested and @-mention signals — requestReviewers (changes.ts:343) currently only does db.update + events.publish and never calls queueEmail; every resolveAndRecordMentions call site discards the return and never queues anything. (2) Build a durable notifications inbox: a persisted notifications table (or reuse attention), a list/read/mark-read API, an SSE/poll feed, and an inbox UI behind the Bell. Today /notifications is only an email-preferences form and notifications.ts exposes only /prefs and /mentions.

**Why.** Audit: the two highest-value team collaboration signals (review requested, @-mention) have NO sender — the default-on toggles gate delivery paths that do not exist, so an offline reviewer/mentionee gets nothing. The Bell leads to email settings, not a 'what happened' feed. Highest cross-persona multiplier: the same write-on-event plumbing feeds reviewer-routing, mentions, and CI-failure signals.

**Key files.** packages/api/src/services/changes.ts:~343 requestReviewers (resolve human recipients, queueEmail with 'emailOnReviewRequested', AND write a durable notification row); packages/api/src/services/mentions.ts resolveAndRecordMentions; call sites packages/api/src/routes/comments.ts:84, reviews.ts:118, issues.ts:75/126 (consume the return, queueEmail 'emailOnMention' + write notification); packages/api/src/services/notifications.ts (queueEmail exists at :30); NEW notifications table + list/mark-read endpoints in routes/notifications.ts; packages/dashboard/src/app/(app)/notifications/page.tsx (build inbox list, relocate email toggles under a settings sub-tab); packages/dashboard/src/components/nav-sidebar.tsx Bell

**Dependencies.** The delivery half (queueEmail wiring) can ship independently and first; the inbox UI depends on the durable-notification table the delivery half introduces. Coordinate with the 'Request reviewers UI' item (same review-requested event).

**Acceptance / verify.** Requesting a reviewer queues an email to the human recipient AND writes a durable notification row (test asserts an email is queued for emailOnReviewRequested). An @-mention in a comment/review/issue queues an email + notification. The Bell opens a feed of received notifications with read/unread state and working deep links; marking read persists. Email toggles still work, relocated under a settings sub-section.

### Integrations configuration surface (Slack/Discord/Jira/Linear)  `[large]`

**What.** Build a net-new Integrations surface (repo or org Settings tab) to discover and configure chatops + external-sync providers, plus the missing auth path for inbound provider webhooks. Today these are endpoint-only (routes/chatops.ts, routes/external-sync.ts) with zero dashboard references. Includes: per-provider config storage + forms + secret handling + status; fixing external-sync /jira and /linear to authenticate via a per-repo HMAC/shared-secret (they currently require a user JWT at external-sync.ts:15,24, which real provider webhooks cannot present); and either implementing the Slack/Discord slash commands against real repo/change context (chatops.ts handleSlashCommand is no-op stubs) or removing the misleading 'approve' affordance, plus creating the /docs/slack page the help URL 404s to.

**Why.** Audit: high severity (P2 team). A team cannot discover or configure these from the product — they must read source for endpoint paths, env vars, and payload shapes. The Jira/Linear user-JWT requirement means the documented 'configure your provider to POST here' flow cannot work end-to-end. Slash command stubs are a governance concern ('/clawhub approve' looks like it approves but is a no-op).

**Key files.** NEW Integrations tab under packages/dashboard/src/app/(app)/repos/[ns]/[repo]/settings/ or an org settings surface; packages/api/src/routes/external-sync.ts:15,24 (replace user-JWT gate with per-repo signing-secret/HMAC verification, attribute synced issues to a system actor); packages/api/src/services/chatops.ts:23-34 (implement commands against real repo/change context with Slack-identity->ClawHub-user authz mapping before any approve, OR remove approve); packages/dashboard/src/app/docs/ (create /docs/slack); NEW provider-config storage (schema + secret sealing via CLAWHUB_SECRETS_KEY)

**Dependencies.** The HMAC-auth fix for Jira/Linear and the chatops stub fix are separable sub-items that can ship before the full config UI. Mirror the existing Slack/Discord HMAC/Ed25519 verification already in chatops.ts for the external-sync secret path.

**Acceptance / verify.** A team admin can configure each provider from Settings (signing secret stored sealed). A real Jira/Linear outbound webhook POST authenticates via the per-repo HMAC header (no user JWT) and creates a synced issue attributed to a system actor. /clawhub approve either approves a real change with proper authz or no longer claims to. /docs/slack resolves (no 404).

### Forks + cross-repo proposals end-to-end UI + target-side accept/merge  `[large]`

**What.** Wire the existing-but-uncalled fork/propose client methods into UI AND build the missing target-side flow. api.ts already has forkRepo/listForks/proposeCrossRepo with zero UI callers; services/forks.ts createCrossRepoProposal (forks.ts:71-88) only inserts a row; routes/forks.ts:43 only has a source-side GET by change id. There is no way for a target repo's maintainers to discover, review, or merge an incoming proposal — the proposal never materializes as a reviewable Change in the target.

**Why.** Audit: high severity (P2 team). Open-source-style contribution is impossible from the product: no fork button, no 'propose to upstream' action, and crucially no incoming-proposals listing or accept/merge path. Write-only dead-end.

**Key files.** packages/dashboard/src/components/repo-header.tsx (Fork button + forks list, wiring api.forkRepo/listForks); change-detail page (a 'Propose to upstream' action wiring api.proposeCrossRepo); packages/api/src/services/forks.ts:71-88 (extend createCrossRepoProposal to materialize a reviewable Change under the target's merge policy on accept); packages/api/src/routes/forks.ts (ADD target-side: list incoming crossRepoProposals + accept/merge endpoint); attention queue integration (routes/attention.ts) so incoming proposals surface to target maintainers

**Dependencies.** Benefits from the notification subsystem (notify target maintainers of an incoming proposal) and the attention-queue refresh item. The accept path must route through the normal merge policy (services/merge-policy.ts).

**Acceptance / verify.** A user can fork a public repo into their namespace from the UI; on a change in the fork they can 'Propose to upstream'; the target repo's maintainers see the incoming proposal in a list AND in their attention queue; accepting materializes it as a normal reviewable Change in the target that obeys the target's merge policy.

### Eval suite authoring + run UI  `[medium-large]`

**What.** Build a suites CRUD UI (create suite with cases + passingThreshold) and a 'Run eval' action wiring api.queueEvalRun({suiteId, agentId, agentVersionId}), plus version/suite pickers. The api methods createEvalSuite/listEvalSuites/queueEvalRun exist in lib/api.ts with no component callers; the agents/[id]/ops Evals tab only shows a note that suites/runs are 'created out-of-band via the API/CLI'.

**Why.** Audit: high severity (P3 fleet-manager). The persona's stated job — 'promote agent versions on eval score' — is impossible from the product; no suite-management surface, no Run button, no pickers anywhere.

**Key files.** packages/dashboard/src/app/(app)/agents/[id]/ops/page.tsx:190-194 (Evals tab — replace note with suite list + Run action) OR a new /evals page; packages/dashboard/src/lib/api.ts (createEvalSuite/listEvalSuites/queueEvalRun already present); packages/api/src/services/agent-versions.ts (eval-run lifecycle already exists)

**Dependencies.** Pairs with the 'eval auto-promotion anti-gaming ceiling + visibility' themed item (surfacing 'auto-promoted X->Y'). Lower business value if the per-version trust tier still gates nothing — so the 'per-version trust tier enforcement' item should land first to make eval scores meaningful.

**Acceptance / verify.** A manager can create an eval suite with cases + a passing threshold, then click 'Run eval' selecting an agent + version; the run appears with its score; the Evals tab lists suites and prior runs. No CLI/API round-trip required.

### In-repo Security tab made functional (SAST-rule + advisory seeding)  `[large]`

**What.** Make the per-repo Security tab actually return findings on a fresh account. SAST + dep-scan run on every push but match against SAST-rules and vulnAdvisories tables that are EMPTY for a fresh account (seeding lives only at the GLOBAL /security page via POST /security/seed-defaults). Auto-seed default SAST rules on repo creation (or add a repo-scoped seed control) and add an OSV advisory ingest so a default scan has data to match.

**Why.** Audit: high severity (P1 solo). The repo Security tab is effectively dead until the user stumbles onto an unrelated global page. The prior fix corrected the misleading 'all clear' copy and restored the tab bar but did not make it functional.

**Key files.** packages/api/src/services/sast.ts + post-push.ts:298-306 (SAST runs, matches only seeded rules); packages/api/src/services/dep-scan.ts (matches only vulnAdvisories rows); packages/api/src/routes/security.ts (POST /security/seed-defaults is global — add repo-scoped seeding, call it on repo creation in services/auto-repo.ts); packages/api/src/services/osv-sync.ts (wire an advisory ingest so vulnAdvisories is populated); packages/dashboard/src/app/(app)/repos/[ns]/[repo]/security/page.tsx (add a 'Scan now / seed defaults' control)

**Dependencies.** OSV ingest (services/osv-sync.ts already exists) should be scheduled/triggered so advisory data is present. Auto-seed-on-create touches services/auto-repo.ts.

**Acceptance / verify.** On a freshly created repo, the Security tab shows real SAST findings against default rules after a push (or a 'Scan now' control runs them), and dep-scan matches against populated vulnAdvisories. A clean repo shows an honest 'no findings, scanned at <time>' state distinct from 'not scanned'.

### Marketplace: real install (target picker + deploy) + catalog seeding/publish  `[large]`

**What.** Two coupled gaps. (1) Make 'Install' actually deploy: add a target picker (org/repo) and have the handler call createStandingAgent and/or deployRoleToRepo/deployRoleToOrg + grant a repo_collaborators row, returning the created entity id. Today marketplace.ts:62 just inserts a null-scoped install row + bumps a counter; the page passes no target. (2) Seed/publish the catalog: app.ts:209 seeds Role templates but never marketplace_agents, so the marketplace is permanently empty; a /publish route exists but has no UI. Decide whether to unify the two 'marketplace' surfaces (Roles template marketplace vs marketplace_agents) or seed marketplace_agents from curated Role templates on boot, and add a publish form.

**Why.** Audit: high severity (P3 fleet-manager, also P1). 'Install one into an org or repo with one click' wires nothing — a manager who installs a curated agent gets nothing running. For a normal user the catalog is permanently empty.

**Key files.** packages/api/src/routes/marketplace.ts:56-68 (install handler — call createStandingAgent/deployRoleToRepo, grant collaborator, return id); packages/dashboard/src/app/(app)/marketplace/page.tsx:38,99-111 (add target picker + success toast); packages/dashboard/src/lib/api.ts:644 (marketplaceInstall already accepts orgId/repoId); packages/api/src/app.ts:209 (seed marketplace_agents OR unify with Role templates); packages/api/src/services/agent-roles.ts (deployRoleToRepo/deployRoleToOrg), services/standing-agents.ts (createStandingAgent)

**Dependencies.** Requires a product decision on unifying the two marketplace surfaces. Reuses createStandingAgent + deployRoleToRepo from the Roles subsystem. Pairs with 'Create custom Role' item.

**Acceptance / verify.** Installing a marketplace agent prompts for a target org/repo, then creates a standing agent (or deploys the Role) and a collaborator grant, returns the entity id, and shows a success toast. The catalog is non-empty on a fresh boot (seeded), and a user can publish an agent via a form.

### Per-repo human collaborators  `[large]`

**What.** Add userId to repo_collaborators (nullable, mutually exclusive with agentId) + migration; resolve human grants in repo-access.repoAccessFor; extend the collaborators route/UI to add humans by handle/email with a DELETE/PATCH. Today repo_collaborators has only repoId+agentId (schema.ts:150-154) and the collaborators UI/routes add agents only — so granting one human access to one private repo requires whole-org membership (which grants ALL org repos).

**Why.** Audit: medium severity (P2 team). No path to give a single human (auditor, contractor, outside reviewer) access to one private repo without org-wide access. Touches the central access model.

**Key files.** packages/api/src/models/schema.ts:150-154 repo_collaborators (add nullable userId) + NEW migration; packages/api/src/services/repo-access.ts:repoAccessFor (resolve human collaborator grants — membership currently = owner/org-member/agent-collaborator/agent's user); packages/api/src/routes/repos.ts collaborator routes (add humans by handle/email + DELETE/PATCH for human grants); collaborators UI in settings

**Dependencies.** Touches the authz core (repo-access.ts) — sequence after the public-repo-view work that also touches repoAccessFor to avoid conflicting edits. The collaboratorRole vocabulary item (admin role) is a related smaller cleanup.

**Acceptance / verify.** A repo admin can grant a single human read/write/reviewer access to one repo by handle/email without org membership; repoAccessFor honors the grant; the human sees only that repo; DELETE/PATCH on the human grant works; a private repo is NOT visible to a non-granted org-outsider.

### Org-level / fleet-wide default merge policy  `[large]`

**What.** Add an org-level default merge policy (schema + route + UI) that applies to org repos unless overridden, with precedence rules vs the in-repo .clawhub/policies/merge.yml and the per-repo repositories.mergePolicy. Today merge policy is strictly per-repo; no org-policy mechanism exists in services/ or routes/.

**Why.** Audit: medium severity (P3 fleet-manager). A manager governing N repos must hand-edit each repo or drop a merge.yml into each. New subsystem touching schema, policy resolution, and UI.

**Key files.** packages/api/src/services/policy-dsl.ts + services/merge-policy.ts (add org-default resolution + precedence: in-repo merge.yml > per-repo DB policy > org default); NEW org_merge_policy storage (schema) + route; repositories.mergePolicy (per-repo, exists); org settings UI

**Dependencies.** Should land after branch-protection enforcement and the trust-tier wiring so the precedence chain is built once against a complete policy model.

**Acceptance / verify.** An org admin sets a default merge policy; a new org repo inherits it without per-repo config; an in-repo .clawhub/policies/merge.yml or explicit per-repo policy overrides it per the documented precedence; tests assert resolution order.

### Create custom / personal Role authoring UI  `[medium-large]`

**What.** A 'Create custom role' dialog wired to api.createRole with the full field set (capability, image, mode, trigger/cron/event, task, minTrustTier), plus a personal/solo roles view (listRoles with no org). Today role creation only clones a curated template into an org (fleet/page.tsx:232 passes {template: slug, org}); there is no custom-authoring form and no personal roles view.

**Why.** Audit: high severity (P3 fleet-manager). A team wanting a bespoke agent, or a solo user (N=1), cannot compose one from the product. New authoring surface.

**Key files.** packages/dashboard/src/app/(app)/orgs/[id]/fleet/page.tsx:232 (createRole only clones template — add full custom-field dialog); NEW personal roles view (listRoles with no org); packages/api/src/services/agent-roles.ts createRole (mints dedicated agent + sealed creds — already supports custom fields); packages/dashboard/src/lib/api.ts createRole

**Dependencies.** Pairs with the standing-agent attach Mode-selector item (same mode/trigger field set). Reuses the existing createRole service.

**Acceptance / verify.** A user can author a fully custom Role (all fields) from a dialog and deploy it; a solo user with no org sees a personal roles view listing their roles; the custom Role deploys to a repo and runs.

### Shared public header/footer + public layout group  `[medium]`

**What.** Extract a shared PublicHeader/PublicNav (logo home + consistent links + Sign in/Sign up CTAs) and a public layout group, then migrate every public page onto it. Root layout.tsx has no shared header/footer; ~10 public pages (trending, leaderboard, changelog, status, docs, help, blog, playground, pricing, u/[name]) hand-roll divergent navs. No PublicHeader component exists.

**Why.** Audit rank 30, low severity but structural. Navs drift, several still miss a consistent Sign in/Sign up path and home affordance. The prior fix patched individual symptoms without extracting a shared component, so they will drift again.

**Key files.** packages/dashboard/src/app/layout.tsx (root, no nav today); NEW PublicHeader/PublicNav component + a public layout group; migrate packages/dashboard/src/app/{trending,leaderboard,changelog,status,docs,help,blog,playground,pricing,u/[name]}/page.tsx

**Dependencies.** Best sequenced WITH the public repo view (which adds more public pages that should use the same header). Low risk, can interleave.

**Acceptance / verify.** Every public (non-app) page renders one shared header (logo->home, consistent links, Sign in/Sign up) and footer; removing a per-page hand-rolled nav causes no visual regression; the public repo view uses the same header.

## Themed improvements (smaller, grouped)

### [P0] Inert governance controls (security-of-trust — controls that gate nothing)

- **Wire agentVersions.trustTier into merge/dispatch as a per-version floor (the 4 promote buttons + eval auto-promotion currently change only a badge — grep confirms zero consumers in merge-policy.ts/changes.ts/standing-agents.ts/agent-autonomy.ts). Either feed it into evaluateMerge/dispatch or remove the buttons and label the tier informational.** `[medium]` — packages/api/src/services/agent-versions.ts; enforcement absent from services/merge-policy.ts, changes.ts, standing-agents.ts, agent-autonomy.ts; packages/dashboard/src/app/(app)/agents/[id]/ops/page.tsx:138-139
- **Wire org-registry trustTier into evaluateMerge ('trusted'-tier agents count like policy.trustedAgents for their org's repos), or remove the 'merge policies can key off this list' claim. Currently merge-policy.ts honors only policy.trustedAgents; org-registry trustTier is consumed only by agent-roles + fleet display + agent-autonomy.** `[medium]` — packages/api/src/services/merge-policy.ts (no trustTier/registry import); packages/api/src/services/org-registry.ts; packages/dashboard/src/app/(app)/orgs/[id]/registry/page.tsx
- **Add a deterministic anti-gaming ceiling to eval auto-promotion (score is derived entirely from self-reported results[].passed with no cross-check, unlike risk-engine/memory-importance) and surface 'auto-promoted untrusted->sandbox via eval <suite>' in the Evals/Versions tab.** `[medium]` — packages/api/src/services/agent-versions.ts:60-86 (finishEvalRun); packages/dashboard/src/app/(app)/agents/[id]/ops/page.tsx (Evals tab)

### [P0] Auth / sign-in blockers

- **Fix OIDC SSO callback dead-end: GET /sso/oidc/callback returns c.json({token,redirectTo}) (sso.ts:34) so the employee lands on a raw JSON token blob and is never signed in. Make it 302-redirect to ${publicBaseUrl}/login/oauth#token=<jwt> honoring redirectTo (the hash-reading contract the dashboard's login/oauth page expects), and reconcile the SAML shim's sessionStorage 'clawhub_token' key (sso.ts:47) with the localStorage key the app actually reads.** `[small]` — packages/api/src/routes/sso.ts:33-34 (OIDC), :42-51 (SAML shim); packages/dashboard/src/app/login/oauth/page.tsx (reads #token=...)

### [P1] CI/secrets security hardening

- **Bind the per-run secrets pull to the claiming agent: record the claiming agentId on the run and require the GET /runs/:id/secrets caller's token to match it (currently authorizes on runnerToken alone — a transferable credential). Also surface a self-host warning to set CLAWHUB_RUNNER_AGENT_IDS in multi-tenant deployments.** `[medium]` — packages/api/src/routes/ci.ts:40 (run.runnerToken !== token); packages/api/src/routes/events.ts (mayReceiveRunDispatch); services/ci-secrets.ts
- **Authenticate Jira/Linear inbound webhooks via per-repo HMAC instead of a user JWT (external-sync.ts:15,24 throw 'users only' — real provider webhooks can't present a rotating user JWT). Mirror the chatops Slack/Discord signature scheme; add a configurable per-repo secret; attribute synced issues to a system actor. (Also covered under Integrations large feature.)** `[medium]` — packages/api/src/routes/external-sync.ts:15,24
- **Add Secrets-tab legibility copy: state that push-triggered pipelines inject the FULL decrypted secret set into run env (pipeline-edit access == secret-read access) and show the access tier required; consider an environment/protected-secret concept that only injects on protected-branch (on:merge) runs.** `[small]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/settings/page.tsx (Secrets tab + SecretAddForm); enforced by packages/api/src/routes/secrets.ts via repo-access.ts

### [P1] Wire existing-but-unused client methods to UI (high value / low effort)

- **Request-reviewers control on the Change actions sidebar wiring api.requestReviewers (defined at lib/api.ts:418, zero callers) + render change.requestedReviewers in the sidebar. Pairs with notification delivery.** `[small]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/changes/[id]/page.tsx; packages/api/src/routes/changes.ts (POST .../changes/:id/reviewers exists)
- **Webhook delivery log/replay/DLQ panel wiring api.listWebhookDeliveries + replayDelivery (lib/api.ts:602-603, unused; backend webhook-admin.ts GET deliveries + replay exist). Expandable per-webhook panel: status/attempts/lastError/timestamps + Replay button + status=dead DLQ filter.** `[medium]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/settings/page.tsx (Webhooks tab, URL+delete only today); packages/api/src/routes/webhook-admin.ts
- **Marketplace install target picker wiring the orgId/repoId the API already accepts (marketplaceInstall at lib/api.ts:644; route accepts them at marketplace.ts:61-66 but caller passes none). Note: the deploy-on-install backend work is the marketplace large-feature item; this is the picker UI half.** `[small]` — packages/dashboard/src/app/(app)/marketplace/page.tsx:38

### [P1] Live freshness / staleness (SSE replay + refetch)

- **Make Home stay live: re-run getAttention() on relevant SSE events (or poll) so the 'Needs your attention' queue refreshes after a push/CI flip; AND replay the last N retained Redis stream entries on SSE connect (repo-read filtered) so the activity feed isn't empty on mount. events.ts startPoll uses lastId='$' (live-only); the SSE handler never replays the retained stream.** `[medium]` — packages/dashboard/src/app/(app)/feed/page.tsx:17-22; packages/api/src/services/events.ts:48 (lastId='$'); packages/api/src/routes/events.ts; packages/dashboard/src/components/activity-feed.tsx
- **Change detail page: add a manual Refresh button at minimum, or re-fetch on ci.completed/review.submitted SSE events — CI status + mergeability currently never update while watching.** `[small]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/changes/[id]/page.tsx

### [P1] Review/merge loop usability

- **Add an undo/reopen path for a mis-clicked 'request changes' verdict: a server transition that clears/supersedes a changes_requested verdict and returns the change to pending, plus a UI control. Only a confirm() warning exists today; reviews.ts has only pending->approved.** `[medium]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/changes/[id]/page.tsx:109-118; packages/api/src/routes/reviews.ts
- **Serve + preview binary files: a new streaming raw/download endpoint (byte stream + content-type/Content-Disposition headers) in code.ts, plus a Download button + inline <img> for image content-types in blob-view. Today code.ts returns content:null for binary (code.ts:103) with no raw route; blob-view shows only 'Binary file (size).'** `[medium]` — packages/api/src/routes/code.ts:96-103; packages/dashboard/src/components/blob-view.tsx

### [P1] Fleet manager console correctness

- **Make the Incident Ops console (/ops) see the whole org fleet: it loads via api.listAgents() (caller-CLAIMED agents only) so role-fanout/standing-attach agents are unselectable for kill/blast-radius/bulk-rollback. Load from an org-scoped source (getOrgFleet/listOrgAgents) with an org selector.** `[medium]` — packages/dashboard/src/app/(app)/ops/page.tsx:21-22; packages/api/src/routes/agents.ts (GET /agents filters by associatedUserId); packages/api/src/services/fleet.ts getOrgFleet
- **Implement org-level cost budgets: cost_budgets.orgId is a dead column, checkAgentBudget queries by agentId only, no org-budget route. Add an org-budget route + UI and enforce min(agent cap, org cap) on dispatch — or remove the 'or org' claim + dead column.** `[medium]` — packages/api/src/models/schema.ts (cost_budgets.orgId); packages/api/src/services/cost-ledger.ts (checkAgentBudget); packages/api/src/routes/cost.ts
- **Add org repos health columns (open changes, CI status, highest open risk): a new org-scoped aggregate endpoint returning per-repo {openChanges, ciStatus, maxOpenRisk, lastActivity}; the rollup exists but surfaces only updatedAt.** `[medium]` — packages/dashboard/src/app/(app)/orgs/[id]/page.tsx:101-110; new org-scoped aggregate endpoint

### [P1] Org RBAC enforcement

- **Enforce role==='admin' (or an 'owner') in the org branch of auto-repo's create gate: auto-repo.ts:71-73 admits any org member regardless of role, so a plain member can spin up repos under the company namespace. Decide the member capability matrix; consider adding an 'owner' role with a last-owner guard.** `[medium]` — packages/api/src/services/auto-repo.ts:68-73; schema.ts orgRole enum ['admin','member']
- **Resolve the collaborator role vocabulary mismatch: enum is writer|reviewer only (schema.ts) but docs/UI imply an 'admin' collaborator role. Either add an 'admin' collaborator role honored in repoAccessFor, or correct docs/UI to say collaborators are writer|reviewer and repo-admin is via org admin/ownership.** `[small]` — packages/api/src/models/schema.ts (collaboratorRole enum:22); packages/api/src/services/repo-access.ts

### [P2] SSO / enterprise sign-in polish

- **Add SSO 'Test connection' (server-side OIDC discovery / SAML metadata+cert validation before saving), plus edit and enable/disable toggles on the provider list — today fixing a typo means delete + recreate (no validate/discovery endpoint exists).** `[medium]` — packages/dashboard/src/app/(app)/orgs/[id]/sso/page.tsx; packages/api/src/routes/sso.ts (no test/discovery/validate endpoint)

### [P2] Agent inbox / A2A supervision

- **Give a human supervisor a user-scoped read of A2A inbox across their claimed/owned agents: /inbox routes throw 'agents only' for non-agent tokens (a2a.ts:15,23). Add a user-token endpoint that unions inbox messages across the caller's claimed/owned agents + corresponding UI.** `[medium]` — packages/api/src/routes/a2a.ts:15,23; packages/dashboard/src/app/(app)/inbox/page.tsx

### [P2] Integrations correctness sub-items (separable from the Integrations UI surface)

- **Validate webhook event names against the canonical catalog: the events field is free-text, the POST handler stores body.events unvalidated, and dispatch filters by exact-string match — so 'change.merge' or 'pr.opened' silently never fires. Add a multi-select from the event-name catalog or server-side validation rejecting unknown names.** `[small]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/settings/page.tsx (Add-webhook events Input); packages/api/src/routes/webhooks.ts (no validation); packages/api/src/services/webhook-queue.ts (exact-string match)
- **Implement Slack/Discord slash commands against real repo/change context with Slack-identity->ClawHub-user authz before any approve (chatops.ts:23-34 returns stub strings; '/clawhub approve' is a no-op), or remove the misleading 'approve' affordance; create the /docs/slack page the help URL 404s to.** `[medium]` — packages/api/src/services/chatops.ts:23-34; packages/dashboard/src/app/docs/ (no /docs/slack)

### [P2] Source import completeness

- **Add a target-namespace selector (user vs a member org) to import — migration.ts:29 always passes targetNamespace: p.name, so a team's repo silently lands in one agent's personal service-user namespace. Resolve/authorize the target via repo-access. Also add GitLab/Bitbucket client methods + a source-provider selector (services exist; only importGithub is in api.ts).** `[medium]` — packages/dashboard/src/app/(app)/import/page.tsx; packages/dashboard/src/lib/api.ts (only importGithub); packages/api/src/routes/migration.ts:29; services/{github,gitlab,bitbucket}-import.ts

### [P2] Pre-signup demo / public-page polish

- **Playground: client-side parse the pasted diff's changed (+) lines into the per-file files structure the API expects (path + line numbers) so inline // REVIEW: comments are honored — run() never sends files, so the seeded '// REVIEW: audit log?' line is dead. One of three advertised focus mechanisms is unexercised.** `[medium]` — packages/dashboard/src/app/playground/page.tsx:~57; packages/api/src/routes/playground.ts:26
- **Communicate email-verification state on password signup: register/page.tsx silently pushes to /feed; the backend models verification (emailVerifications table) but password signup neither triggers a verification email nor messages the user. Decide whether verification is required, then add a verification email + 'check your inbox' banner, or document that password signups are pre-verified.** `[medium]` — packages/dashboard/src/app/register/page.tsx; packages/api/src/routes/users.ts; packages/api/src/services/auth-hardening.ts + emailVerifications
- **Reconcile /u/[name] route (PublicAgentPage, queries only the agents table at public.ts:62-64) with its agent-only data source: either rename to /agents/[name] (update inbound links) or broaden the endpoint+page to resolve user and org namespaces too — a real user/org username 404s today.** `[medium]` — packages/dashboard/src/app/u/[name]/page.tsx; packages/api/src/routes/public.ts:62-64
- **Extract one shared pricing data source and render both the landing PricingSection and /pricing from it — two independent hardcoded literals (page.tsx:401 string[] vs pricing/page.tsx:10-24 [label,boolean][]) can drift again.** `[small]` — packages/dashboard/src/app/page.tsx:401; packages/dashboard/src/app/pricing/page.tsx:10-24

### [P2] Solo-dev IA + quality-of-life fixes

- **Distinguish attention-API failure from an empty queue: feed/page.tsx:18 does getAttention().catch(() => setItems([])) so a network/500/expired-session error renders a false 'nothing needs you' all-clear. Track a load error separately and show a 'Couldn't load your queue — retry' state.** `[trivial]` — packages/dashboard/src/app/(app)/feed/page.tsx:18
- **Resolve activity-stream actor UUID to the agent name (activity-feed.tsx:45-52 slices actorId to 8 chars). Carry the name in the event payload or look it up client-side.** `[small]` — packages/dashboard/src/components/activity-feed.tsx:45-52
- **Deep-link searched agents to /agents/${a.id} instead of the static /agents list (search/page.tsx:66) — repo results already deep-link correctly.** `[trivial]` — packages/dashboard/src/app/(app)/search/page.tsx:66
- **Add an 'Use my personal agent' button to Import calling api.personalAgent() (mirroring ConnectAgentCard) and pre-fill/hide the token field — the once-shown agent token is not retrievable, so import dead-ends.** `[small]` — packages/dashboard/src/app/(app)/import/page.tsx:72
- **Auto-redirect /issues to the sole repo's queue when the user has exactly one repo (remove the one-row interstitial).** `[small]` — packages/dashboard/src/app/(app)/issues/page.tsx
- **Add priority + milestone selects to the issue create/edit forms and render them on the row/detail — the API accepts assignedAgentId/priority/milestoneId and GET returns milestone, but the UI sends only title/body/labels and the returned milestone is dead data.** `[small]` — packages/dashboard/src/app/(app)/repos/[ns]/[repo]/issues/page.tsx:41; .../issues/[num]/page.tsx; packages/api/src/routes/issues.ts
- **Gate the global top-level Security control plane (seed-all-repos + paste-advisory-JSON) and fleet Incident-ops behind admin/org scope rather than exposing operator chores to a one-agent solo dev (nav collapse already shipped; page-level scoping remains).** `[medium]` — packages/dashboard/src/app/(app)/security/page.tsx; packages/dashboard/src/app/(app)/ops/page.tsx

### [P3] Code browsing fidelity

- **Populate per-file 'latest commit' in the tree listing (server never sets TreeEntry.lastCommit, so the UI's 'latest commit per file' column is a permanently-false branch) via a batched git-log walk, or delete the rendering branch.** `[medium]` — packages/api/src/services/git.ts (listTree); packages/api/src/routes/code.ts (serveTree); packages/dashboard/src/components/tree-listing.tsx

### [P3] Standing-agent attach polish

- **Add a Mode select (worker/review/triage/reflect — CLAWHUB_MODE) and an optional Command override to the standing-agent Attach dialog, or remove the dead command? field and document that mode/command come from Roles — today the panel can only create worker-mode agents.** `[small]` — packages/dashboard/src/components/standing-agents-panel.tsx:209
