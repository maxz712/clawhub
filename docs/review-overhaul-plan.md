# Review-System Overhaul — Build Plan (Q3 2026)

Nine milestones, each ending in something demo-able. ~68–71 solo-days after the pre-flight addendum; M9 is the only slack. Strategy and evidence: [review-overhaul-strategy.md](review-overhaul-strategy.md). Produced 2026-07-02 by a multi-agent planning pass (six workstream planners reading this repo + an integration critic + a three-lens pre-flight review); file references were verified against the repo at planning time (latest migration then on disk: 0039).

## 0. Ground rules

1. **Custody rule (most important):** the platform LLM key **never enters a container**. The metering gateway lands first (M3); the native reviewer is born `keySource='platform'` and calls Anthropic through `ANTHROPIC_BASE_URL=<api>/api/v1/llm/anthropic` with a per-run gateway token as its "API key". Prompt-injection → key-exfiltration closed by construction; metering authoritative from day one.
2. **Contract freeze before M4:** harness result JSON is `{checks:[{kind, name, ok, command?, exitCode?, observed?, evidenceUrl?}], divergence:{undeclared:[]}, summary}` with kind ∈ `ui|api|cli|script|config|migration` (last two reserved this quarter). Focus-source enum: `author | derived | reviewer`.
3. **Layout contract:** M1's Review Brief defines named slots (evidence / critical decisions / verification / diff). Later milestones add cards into slots; nobody re-layouts.
4. **Harness changes are MERGE-batched** (corrected in pre-flight — the build-harness matrix auto-fires on any merge touching `packages/agent-harness/**` and runners pull-before-run, so "the rebuild waits" was fiction): harness-touching changes merge only at the M5 and M6 milestone boundaries, and every harness change is backward-compatible + flag-gated regardless. Add a smoke test to `assemble-harness-manifest.sh` (boot fused image, `command -v` CLIs, browse.mjs against a fixture) before retagging `:latest`; write the image-rollback runbook (retag previous `:<sha>` / pin `CLAWHUB_HARNESS_IMAGE` on both runner hosts).
5. **Migration numbers assigned at land time**, in milestone order (see §2).
6. **Compose-env rule:** the API container uses an explicit environment allowlist in docker-compose.yml — a var set only in `~/clawhub/.env` silently no-ops in prod. Every new env var's compose entry ships in the same Change as the code that reads it; each milestone's rollout step includes prod set-and-recreate commands. (Alternative: 0.5d in M1 for an `env_file` pass-through for `CLAWHUB_*`/`STRIPE_*`.)
7. **GDPR rule:** every migration adding a user-attributed table includes a `services/gdpr.ts` export/delete audit in the same Change.

**Day-0 (before M1, ~0.5d):** measure current post-push p95 on prod (denominator for the +150ms budget) and run the funnel queries — active repos, trailer-less push share, where users stall. If trailer-less volume is tens of pushes rather than hundreds, re-weigh M4's urgency against distribution work.

## 1. Milestones

### M1 — Focus floor + Review Brief (days 1–9, migration 0040)

Kill the empty-focus state for 100% of pushes with zero inference; set the page layout everything later plugs into.

- New `services/focus-synthesis.ts`: pure `synthesizeReviewBrief()` — sensitive-path hunk flags (export + reuse `HIGH/MEDIUM_FLOOR_GLOBS` from risk-engine, `BASELINE_SENSITIVE_GLOBS` from merge-policy), churn × sensitivity ordering from the numstat already run, generated-file demotion via `isGeneratedFile`, ~20-flag cap. Output `ReviewBrief {derivedFocus[], files[], callouts[]}` with `source: sensitive|risk|rollback|cochange`.
- `git.ts diffHunks()`: parse `@@` headers only, called only for the sensitive-matching subset of changed paths (0–5 files, one extra git process).
- **Data shape (decided):** synthesized focus lives in a parallel `changes.reviewBrief` jsonb, NOT merged into `reviewFocus` (author focus stays auditable; re-pushes idempotent). Migration 0040 also adds `changes.description` (commit bodies minus trailer block, 8KB cap) — same post-push insert/update, land together.
- Post-push wiring: best-effort try/catch; kill switch `CLAWHUB_DISABLE_FOCUS_SYNTHESIS=1`.
- Memory callouts: rollback episodes from memory-capture rows overlapping changed paths; co-change absent-companion analysis is a stretch goal (cut first if squeezed).
- **Wire the dead pipe:** merge `reviews.additionalFocus` into DiffReview's rendered focus set, source-tagged author/derived/reviewer.
- Review Brief restructure: evidence top, Critical Decisions card, focused diff in derived order, full diff one click; null-brief fallback renders today's layout.

**Demo:** a trailer-less push touching `scripts/` renders ranked, explained focus with a rollback callout. **Exit:** combined post-push p95 ≤ +150ms vs day-0 baseline (hard 400ms internal deadline → null brief).

### M2 — Distribution quick wins (days 10–12)

- `ch commit` / `ch push`: compose the trailer block; derive `Scope:` from `git diff --name-only`; prompt or `--intent`; default `Risk: low` (declared risk is only a floor); amend + exec push.
- MCP tools `clawhub_compose_trailers` + `clawhub_validate_commit_message` (deterministic; round-tripped through public `POST /playground/parse`).
- `packages/skill/AGENTS-SECTION.md` served at `GET /api/v1/public/agents-md`; `ch init` writes it idempotently between `<!-- clawhub:begin/end -->` markers.
- SKILL.md refresh — including the **new principle wording** ("inference informs, determinism decides") so nothing stale propagates into tenant repos.

### M3 — Metering + custody substrate (days 13–19, migration 0041)

Hard rule: metering and custody precede any default-on platform-keyed feature. The egress proxy is a CONNECT tunnel and sees no TLS plaintext — the meter is an **API-side LLM gateway**.

- Migration 0041: `platform_usage` (run/change/repo/org/user attribution **denormalized**, token counts, `costMicroUsd`, `billedSku`, `stripeReportedAt`; SET NULL FKs — billing rows must survive repo deletion; do not copy cost_ledger's cascade) + `standing_agents.keySource` + `agent_roles.keySource` + `ci_runs.gatewayTokenHash`.
- Gateway `POST /api/v1/llm/anthropic/v1/messages` (+ `GET /v1/models`): container's `ANTHROPIC_API_KEY` is a per-run gateway token (sha256 → running ci_runs row); inject real key, stream, tee SSE for usage (`message_start` + final `message_delta`), price via `MODEL_PRICES` (env-overridable), one platform_usage row per request + cost_ledger mirror. **Meter at `message_start`, finalize at `message_delta`** so severed streams still record input spend. Parse-fail dead-man alert. Routes shaped per protocol (`/llm/anthropic/*` now; `/llm/openai/*` reserved — see D7).
- Dispatch wiring: mint token under the existing advisory lock; `standingLlmEnv` baseUrl override (no harness changes); token dies at run-terminal. BYO agents untouched.
- Rate-limit carve-out: dedicated Redis bucket for `/api/v1/llm/*` + **Cloudflare edge exemption** for the same path; soak the stream from a container on the debian runner **through the production edge**, not localhost. SIGTERM drain + raised `stop_grace_period` for the api service.
- **Monitoring step (~1d, pre-flight):** minimal Prometheus/Alertmanager (or Grafana Cloud remote_write) scraping api:3000/metrics inside the compose network, notification route that actually reaches the founder, watchdog heartbeat. **Exit criterion: the parse-fail alert fires end-to-end in a drill.**
- **Legal surface starts here (~2d, parallel; pre-flight BLOCKER):** /terms + /privacy with subprocessor table (Anthropic, Stripe, S3, Resend), register-flow acceptance + versioned re-acceptance banner, DPA-on-request; ZDR/retention question included in the D2 email to Anthropic. Completion gates M4's flip.
- GDPR: extend gdpr.ts export for platform_usage; delete scrubs personal attribution, retains amounts (retention basis stated in the privacy policy).

### M4 — Native advisory reviewer, gateway-keyed (days 20–28, migration 0042)

Identity (decided): one system Role + lazy per-repo standing-agent rows provisioned on first published change event — reuses the dispatch spine's dedup/backoff/breaker; no backfill.

- Migration 0042: `agents.isSystem`, `standing_agents.isSystem`, `reviews.advisory` + `reviews.contract` jsonb, `ci_runs.dispatchModel`, `repositories.nativeReviewerEnabled` (UI: boolean opt-out; DB stays tri-state — force-on exists for the dogfood case).
- `services/native-reviewer.ts`: `ensureNativeReviewerRole` (boot), `ensureNativeReviewerForRepo` (lazy), `shouldDispatchNativeReview` (master flag + opt-out + BYO auto-suppress + quota hook + global daily cap), `selectReviewModel` — deterministic router: risk floored to high on sensitive globs, +1 level on author rollback history, **hash-seeded audit** (`sha256(changeId+head) % 100 < AUDIT_PCT`) promoting low-risk changes to Sonnet reproducibly.
- **Suppression rule narrowed (pre-flight):** BYO auto-suppress triggers only on BYO `mode=review` agents — a verify-mode agent complements advisory review (else every Loop install would silently disable it). **Dogfood:** the clawhub repo runs a BYO reviewer; set `nativeReviewerEnabled=true` (force-on) for the soak.
- Dispatch: payload stamped `reviewOnly:true` + server-forced egress `none` (runner obeys the stamp, never the row). Runner review-only mode: **skip the clone entirely** — no repo code in the container.
- Contract enforcement on POST /reviews for isSystem reviewers: force `advisory=true`; validate `native-review-v1` (verdict, intent_vs_diff ≤2000 chars, ≤5 additionalFocus {path,startLine,endLine,reason}) — reject, don't truncate; secret-scan the payload; skip Change status mutation. Filter `!advisory` at every approval-counting site. **Supersede prior advisory review on new head.**
- Infra-abort tagging (pre-flight): run failures within N seconds of a deploy don't count toward the breaker and are re-dispatched; self-deploy bounces the runner only when `packages/runner/**` changed.
- Harness `run_review` rewrite: result-file JSON on the verify pattern; widen change lookup to `pending|changes_requested` (real bug). Merges at the M5 boundary per ground rule 4.
- `scripts/reviewer-audit.ts` **moved here from M8** (D5's gates need it): 30-Change confusion table (flagged→rolled-back / approved→rolled-back / flagged→fine), per-model splits, tokens/review; API-driven (contained CI can't reach the DB); counts, not percentages.
- Dashboard: advisory card in the Critical Decisions slot with model badge + first-render explainer + inline disable; settings toggle. Ship dark → flip on clawhub only.

**Exit criteria:** advisory-filter audit complete; legal surface live; narrative sweep done (design.md principle section, README, landing copy, docs/governance.md, the dashboard "runs no inference" strings, `lib/pricing.ts` with new tiers marked "coming soon", pivot changelog post framed as returning to the founding scope).

### M5 — Conformance verify (days 29–37, migration 0043, harness merge-batch #1)

- `services/spec-resolver.ts`: issue (via `issue_changes`) → description (intent differs from branch name OR stripped bodies ≥ `MIN_DESCRIPTION_SPEC_CHARS`) → inferred. Pure classifier unit-tested.
- Env threading: `CLAWHUB_SPEC` (16KB cap + truncation marker) + `CLAWHUB_SPEC_BASIS`, best-effort like the memory pack.
- Migration 0043: `verification_runs.specBasis` + `specExcerpt` (2KB audit trail) + `divergence` jsonb.
- `evaluateCoverage` widened: `cli/script` need command + exitCode 0 + transcript; `api` tightened to require a request/response transcript; `ui` unchanged (head-pinned screenshot). `config`/`migration` enum reserved. **Version-skew guard:** `CLAWHUB_STRICT_CLAIMS` flag, flipped only after the rebuilt image is live. Honest limit in code: server validates evidence presence/shape, not truth — trust rests on the sandboxed run, no-self-verify, tier guard, screenshot pinning.
- `recordVerification`: resolves spec at record time (authoritative), stamps basis + excerpt, accepts normalized `divergence.undeclared`.
- Gate: `verifiedAutonomy.maxInferredSpecRisk` (default `low`); null/legacy basis = inferred (conservative); ship stamping + gating in one release.
- `run_verify`: spec block in prompt (one check per spec claim, both directions, undeclared behaviors → divergence), frozen result contract.
- Surface: change GET embeds head-matching verification; dashboard panel with per-check rows, spec-basis chip, amber undeclared-scope banner. Labeling: reviewer `intent_vs_diff` = LLM opinion; attestation `divergence` = sandboxed-run finding — two trust tiers, never merged.
- Calendar item: **2026-08-31 Sonnet intro pricing expires** — update `CLAWHUB_PLATFORM_MODEL_PRICES`, re-baseline cost dashboards.

### M6 — Cheap verify: plan-then-playback (days 38–46, migration 0044, harness merge-batch #2)

- `browse.mjs` step types: `snapshot` (accessibility.snapshot() + innerText fallback — Playwright 1.48 pin is load-bearing, don't bump casually), `expectVisible/expectUrl/expectValue/expectCount`, `expectStyle` (computed-style, px tolerance), `apiCheck` (in-driver request with transcript); full `trace.json`; 1920×1080 default.
- `clawhub-evidence --batch`: upload the evidence dir in one pass; filename→URL map so checks carry per-check `evidenceUrl`. Prompt discipline: evidence to disk, never Read back except final checkpoints.
- Migration 0044: `verify_plans` — server-validated step whitelist, goto restricted to relative/localhost, `checkMap` (steps → checks), `changedPathsHash` + `specHash`, failure counter, partial unique on active plan per change. `PUT/GET .../verify-plan` with recordVerification-style caller re-binding.
- Playback in `run_verify`: fresh plan + same paths → replay via `CLAWHUB_VERIFY_STEPS` (zero tokens), derive checks from `browse-result.json × checkMap`, attest, return **without invoking the CLI**. Staleness: paths hash, spec hash, 2 consecutive playback failures, tier change. Failure falls through to full model verify with context. `{"playback":true}` = metering discriminator.
- Context discipline (honest per-CLI): MCP `--image-responses omit` in verify mode; same-filename screenshot overwrites while iterating; snapshot-first prompts. Screenshot bloat is effectively claude-only.
- Capacity (pre-flight): cap the OCI runner at 1–2 concurrent; heavy-tier placement hint (mirroring `runs_on`) so app/services/dind verify runs prefer the debian node; provision its dep cache + service pool.

**Exit:** adversarial review of the playback trust chain before any verified-autonomy repo relies on playback attestations.

### M7 — Billing live (days 47–56, migration 0045)

Slippage rule: if anything slips, slide this block — never M3.

- Migration 0045: `platform_budgets` (org XOR user, monthly cap, `onExhaust: byo_fallback|queue|block`, alert threshold). Separate from cost_budgets (self-reported ≠ authoritative).
- Quotas + budget enforcement at dispatch: free-tier counter (50/repo/mo), per-tenant daily token cap (repo-minting backstop), global platform concurrency (retry-next-tick), budget-exhausted → BYO fallback or queue; gateway re-checks per request.
- Entitlements `pro` plan (500-review pool/seat, 10 verify credits/seat, overage prices) + Stripe checkout/portal/meter events (no-SDK form-encoded convention) + 5-min billing reporter on the partial unbilled index with Stripe-side idempotency + usage endpoint + billing dashboard.
- SKU stamping: one `review_overage` per review *run*; `verify_run` at terminal only if it booted (first gateway usage row = boot marker) and credits exhausted.
- Dispute story (pre-flight, ~1d): published credit-first refund policy + support contact; admin credit/void path (adjustment row excluded from the reporter); Stripe Tax + address collection.

**Exit:** slot-minute capacity math (expected reviews+verifies/day vs runner capacity) before the SKU is sold. Blockers cleared first: D1 pricing (done), Anthropic terms confirmation (D2 email sent in M3).

### M8 — The Loop + tripwires (days 57–63, migration 0046)

- Migration 0046 + `services/loop.ts`: `repo_loops` bundles developer + verified-reviewer (+ optional triager); `installLoop` creates/deploys roles from templates (developer gets `earnedAutonomy: true` explicitly), duplicates budget per agent, writes the policy dial through `normalizeMergePolicy` (review_only → nothing; low → earned autonomy; medium → `verifiedAutonomy {maxRisk: medium, floorGlobs: RECOMMENDED preset ON}` + auto-merge). `applied_policy_sha` guards uninstall from clobbering human edits. BYO-key only in v1. Honest limitation: issue-label filtering is task-string convention.
- Routes + `ch loop {install,status,kill,resume,rm}`; Loop card (status, per-role health, runs 7d, Changes shipped, spend vs budget — labeled "reported spend" until platform-keyed, red kill button) + install wizard.
- Tripwires: time-to-first-review histogram; verify funnel counters (dispatched/booted/attested); `POST /api/v1/telemetry` + M1 Review Brief retrofit firing focus events (~0.5d).

**Demo:** `ch loop install --autonomy medium` → file issue → developer ships → independent verifier attests → auto-merge behind the floor.

### M9 — Buffer + funnel extras (days 64–68+)

Signed public evidence URLs (HMAC, TTL) + the **recorded-replay** "file an issue, watch it ship" landing demo + docs/CLAUDE.md catch-up. Explicitly conditional — first cut under slippage.

## 2. Migrations (consolidated, assigned at land time)

| # | Milestone | Contents |
|---|---|---|
| 0040 | M1 | `changes.review_brief` jsonb + `changes.description` text |
| 0041 | M3 | `platform_usage` + `standing_agents.key_source` + `agent_roles.key_source` + `ci_runs.gateway_token_hash` |
| 0042 | M4 | `agents.is_system`, `standing_agents.is_system`, `reviews.advisory` + `contract`, `ci_runs.dispatch_model`, `repositories.native_reviewer_enabled` |
| 0043 | M5 | `verification_runs.spec_basis` + `spec_excerpt` + `divergence` |
| 0044 | M6 | `verify_plans` |
| 0045 | M7 | `platform_budgets` |
| 0046 | M8 | `repo_loops` |
| 0047 | deferred | `github_installations` + `github_pr_mirrors` (only if the GitHub App survives next-quarter triage) |

All additive, zero backfills. Pre-merge rehearsal each milestone: restore last night's dump to a scratch DB, run `dist/migrate.js`, manual pg_dump before the merge; "migration failed on boot" runbook in docs/operations.md.

## 3. Decisions (D1–D7, made 2026-07-02)

- **D1 · Pricing:** Free / **Pro $20 per human seat** / Enterprise. "$12/agent" dies — *price the humans, meter the machines* (per-agent pricing taxes the behavior the product exists to create). Free: 50 platform Haiku reviews/repo/mo + unlimited BYO. Pro: 500-review pool + 10 verify credits/seat. Metered: $0.10/review overage, $2.00/verify.
- **D2 · Anthropic terms:** proceed. v1 platform key powers ONLY ClawHub-owned system agents (first-party product feature — permitted as a value-add product under Anthropic's commercial terms; passthrough resale is what's prohibited). `keySource='platform'` closed to user-authored agents until written confirmation (email during M3). Fallback: org-connected keys through the same gateway. Flag: BYO `sk-ant-oat` subscription tokens in standing agents match the third-party-harness pattern Anthropic restricts — steer to API keys; oat = documented at-your-own-risk.
- **D3 · Latency budget:** synthesis ≤ +150ms p95 in post-push, 400ms hard deadline → null brief; time-to-Change-visible p95 ≤ 3s.
- **D4 · Floor globs:** `RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS` ON by default for tenant Loop installs at medium autonomy; removable deliberately. (The clawhub instance keeps its own floorless config.)
- **D5 · Native-reviewer rollout gates:** dark → clawhub 2-week soak (force-on past the BYO suppressor) → default-on for NEW repos when: (a) zero contract-rejection/secret-scan incidents; (b) ≥30-change audit shows noise (flagged→fine) under ~50% with no attributable approved→rolled-back misses; (c) blended cost ≤ $0.10/review; (d) p95 dispatch→review ≤ 5 min; (e) legal surface live + ≥7-day notice before any existing-repo cohort + first-render explainer with inline disable; (f) ≥N external users saw native review on their own code and ≥half called it useful. Existing repos in ~20% cohorts.
- **D6 · Locked parameters:** Haiku 4.5 low/medium, Sonnet 5 high/sensitive/audits; 5% hash-seeded audit; SKU prices as in D1. Revisit at the 2026-08-31 repricing or on audit evidence.
- **D7 · Multi-model catalog:** router routes by capability TIER (fast/balanced/frontier), never vendor. Gateway routes shaped per PROTOCOL (`/llm/anthropic` + `/llm/openai` covers hosted open models). Models admitted to the platform catalog PER ROLE only after qualification benchmarks (reviewer-audit for review; a verify-bench for verify; advisory = looser bar, verify = strict). BYO open models ≈ work today (`cli=claude + llmBaseUrl=Z.ai anthropic-compat + model=glm-5.2`) — M2 exposes `--llm-base-url`. Platform-run open models use an OSS harness path (codex CLI, Apache-2.0), not the claude CLI against competitor backends. Catalog entries name subprocessors; org policy can allowlist providers. GLM-5.2 ($1.40/$4.40 per MTok, cached input $0.26, open-weights, near-frontier long-horizon coding) is the first balanced/high-tier candidate: verify run ~$1.06 → ~$0.45–0.50 (margin 47% → ~75%).

## 4. Deferred to next quarter

GitHub App mirror-and-verify (design settled: mirror PR heads into shadow repos, reuse the whole post-push→verify pipeline, post advisory check + signed evidence links; gated on metering + trustworthy checks). Visual regression + baseline store. Live public demo endpoint (replay first). `config`/`migration` claim validation. Server-authored AGENTS.md Changes. Multi-provider platform catalog + selector UI (structure lands this quarter per D7; admission waits for the qualification instrument). Redis quota cache.

## 5. Standing risks

Single trust incident (prompt-injected diff → key exfil, or gamed attestation auto-merging) is near-fatal — hence gateway custody, review-only mode, schema-enforced output, metering firewalls before scale, the M4 advisory-filter audit and M6 playback adversarial pass as non-negotiable exit criteria. Distribution is the strategic risk (Cursor Origin ships fall 2026); speed and the "file an issue, watch it ship" narrative are the mitigation. Customer discovery is threaded through the soak windows — 5–8 conversations, not zero.

## 6. Next quarter (Q4 2026) — sequenced forecast

**Planning altitude, stated honestly:** Q3's nine milestones rewrite large parts of the codebase, so file-level Q4 steps written today would be fiction. This section is the milestone-level sequence with scope, entry gates, and estimates; **at quarter start, re-run the same planning pass** (per-workstream planners reading the then-current repo + an integration critic) to compile N2–N7 down to file-level steps. The two biggest blocks (N2, N4) already have settled designs in the Q3 planning output; their day estimates carry from there.

Budget: ~40–45 planned days against a ~65-day quarter — deliberately looser than Q3, because Q4 also carries Q3 spillover, operating a now-billing product (support, disputes, abuse), and the Cursor Origin response.

### N1 — Quarter gate: read the data before spending it (days 1–2)

Entry review against Q3's instruments, with explicit go/no-go for each block below:
- Reviewer-audit results (noise rate, miss rate, per-model splits) and verify boot-success rate → gates N2 (a vacuous GitHub check is anti-marketing) and re-tunes D6 routing.
- Funnel + discovery notes (trailer-less volume, activation, the 5–8 conversations, willingness-to-pay) → gates N6's enterprise motion vs more product-led work.
- Unit economics at real usage (platform_usage, playback hit-rate, margins post-Sonnet-repricing) → re-prices D1/D6 if needed.
- Tripwire check from the strategy memo: Cursor Origin GA feature list (ships during this quarter — write the response memo when it drops), vendor-bundled free review, metadata standardization (Entire Checkpoints), Anthropic written confirmation status from the M3 email.

### N2 — GitHub App: mirror-and-verify (days 3–11, migration 0047)

The distribution wedge, deferred from Q3 with the design settled: on `pull_request.opened/synchronize`, mint an installation token, mirror the PR head into a private shadow repo (`gh-mirror/<owner>--<repo>`, system service user), let the **normal post-push pipeline** open a Change, run the existing platform verified-reviewer on it, and post back a GitHub **check-run (advisory, never failure-blocking in MVP)** + a PR comment with screenshot evidence via the signed public evidence URLs from M9. Zero runner/harness changes — the entire Q3 stack is reused; the new work is App auth (JWT → installation token), the HMAC-verified webhook route, the mirror state machine (`github_installations` + `github_pr_mirrors`, migration 0047), and the check bridge. Rollout: allowlist first, then free verified checks on public repos as the distribution engine (the free-for-OSS playbook). Entry gates: verify boot-success above threshold on sampled real-world repos; graceful static-tier degradation confirmed for repos with no `verify.yml`; ops prerequisites done (registered App, public webhook URL, key in secrets). Mirror repos excluded from all public surfaces.

### N3 — Multi-model catalog GA (days 12–21)

Execute D7 beyond structure: the `/llm/openai/*` chat-completions gateway route with its usage parsing; the `MODEL_CATALOG` config (per-model protocol, upstream, prices, tier, permitted roles, subprocessor label); the **verify-bench** — the qualification instrument for the verify role (a suite of replayed verify plans with known outcomes, built on M6's plan format); qualify **GLM-5.2** for the balanced tier (review role first via the reviewer-audit methodology, verify role only after verify-bench); model-selector UI in repo/org settings + the Loop wizard, showing qualification scores and subprocessor per model, with an org-level provider allowlist; **org-connected keys** (the D2 fallback and a real enterprise ask): an org pastes its own provider key once, the same gateway holds and meters it. Platform-run open models ride the OSS harness path (codex CLI) per D7. Publishing the per-model qualification scores is the marketing artifact.

### N4 — Visual regression + design evidence (days 22–26)

Deferred WS4 Step 6, design settled: `clawhub-visual-diff` (pixelmatch — pure JS, no per-arch pain in the multi-arch image), base-branch baseline store in the object store behind read-authorized routes, baselines refreshed by a merge-triggered pipeline (documented recipe; degraded "baseline-candidate" mode until a repo registers it), side-by-side base/head/diff triptych in EvidencePanel, `--ignore-regions` for dynamic content. **Non-gating evidence by design** — a legit UI change always diffs; it's a signal for the human design pass, keeping "humans keep taste, agents keep proof."

### N5 — Loop v2 + autonomy hardening (days 27–35)

- Platform-key option for Loops (`keySource='platform'`), now that metering/budgets have a quarter of soak — the zero-setup Loop becomes real.
- Validate the reserved `config` and `migration` claim kinds (services tier + pooled per-run DB), completing the claims taxonomy.
- A real issue-routing mechanism replacing the task-string convention: deterministic label→assignment (the triager gets an assignment API, not a prompt suggestion).
- The server-authored-Change primitive (a Change born from a server-side commit under `withChangeUpsertLock`) — unlocks the AGENTS.md auto-PR on import/create and future product surfaces.
- The **live** "file an issue, watch it ship" demo endpoint (template-constrained, tight rate caps, egress none, hard budget, bundle kill switch) upgrading M9's recorded replay — only after the Loop has weeks of production soak.

### N6 — Enterprise/self-host motion (days 36–40, conditional on N1 discovery data)

Only if the conversations say this buyer exists now: DPA template + subprocessor page hardening, SOC2 evidence-pack refresh (`soc2-controls.md` gains the gateway/metering/billing controls), a versioned self-host release channel with upgrade notes (the deployment where "never runs an LLM" stays literally true is a sales asset), SSO sales enablement (the entitlement gate already exists). If discovery says otherwise, these days go to N7 and product polish.

### N7 — Scale & reliability (days 41–45, conditional on volume)

Second runner node / documented runner scale-out before SKU volume demands it; gateway resilience (a gateway outage stalls every platform-keyed run — evaluate a lightweight standby or fast-restart posture); Redis month-counter quota cache if the per-request SUM shows up in gateway p99; backup coverage audit for the seven new tables; revisit the 2-OCPU primary box if revenue justifies real hardware.

### Standing decision points through Q4

- **Cursor Origin GA** (expected mid-quarter): write the response memo within a week of the feature list dropping; the prepared counter-positions are vendor neutrality (D7 catalog with published qualification scores), the deterministic gate + head-pinned attestation, and self-host/BYO.
- **Pricing revisit** once real COGS + GLM-tier routing data exists (D6's revisit clause).
- **Anthropic terms**: if written confirmation hasn't arrived by N3, org-connected keys become the default platform-inference path rather than the fallback.
- **Migration numbering**: 0047 is claimed by N2; N3+ assigned at land time, same rule as Q3.
