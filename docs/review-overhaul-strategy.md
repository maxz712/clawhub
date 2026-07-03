# Review-System Overhaul — Strategy (July 2026)

**Principle: inference informs, determinism decides.**

This memo records the direction decision for ClawHub's review system and platform positioning, produced 2026-07-02 from a multi-agent research pass (codebase audit, market research, adoption-pattern research, cost modeling; three competing strategies; two judges; one completeness critic). The companion implementation plan is [review-overhaul-plan.md](review-overhaul-plan.md).

## The decision, in five moves

1. **Ship a deterministic focus floor first.** The empty-focus state becomes structurally impossible. Zero inference — mostly rendering work over data the server already computes on every push.
2. **Retire the blanket "ClawHub never runs an LLM"; narrow it to its founded form.** The merge gate, risk engine, and attestation chain stay 100% deterministic. Inference enters only the *focus and evidence* layer: a native, platform-keyed reviewer runs on every published Change, advisory-only, capped at ~5 flags, risk-routed between Haiku and Sonnet. Cost is not the blocker — **~$0.06 per review** against a market anchor of **~$1.00**.
3. **Verify is the product; meter it.** Boot-the-app-and-click-through-it as a server-validated, head-pinned, merge-gating attestation is the one artifact nobody else sells. Collapse the 5-step opt-in to one toggle; price ~$2.00/run against ~$1.06 COGS. Never bundle it unlimited — flat-seat verify breaks even at ~53 changes/dev/month and one standing agent exceeds that in a week.
4. **Keep BYO-key at every tier and self-host as the neutrality story.** That is where "ClawHub never runs an LLM" survives as a deployment truth. It is the counter-position to Cursor's vertical stack and the budget-cap fallback.
5. **Stop expecting humans to migrate; recruit agents and their operators.** Target agent-fleet operators and greenfield repos born on ClawHub; keep GitHub import frictionless; ship a GitHub App (advisory verified check with screenshot evidence) as the distribution hedge that funnels into the platform, where the gate lives.

## 1. What was actually true in the codebase (July 2026)

The behavior-first review vision was ~70% built and already the default UI. Key findings:

- **The trailer-less fallback was "GitHub plus an apology banner."** No trailers → `reviewFocus = []` → the diff tab force-renders every file in full with a banner teaching a convention the pushing agent will never read.
- **Focus source #3 was stored but dead.** `reviews.additionalFocus` was persisted but never rendered, and the harness never emitted it. Wiring it is the single highest-leverage fix in the repo.
- **Verified autonomy was complete server-side but ~5 opt-in steps deep** — structurally unreachable for the drive-by agents causing the trailer gap.
- **A native reviewer was ~70–80% built** (dispatch spine, sandboxed runner, key-injection channel, reviews/evidence APIs, merge gate). The genuinely new work: token metering, key custody, quotas, billing.
- **The principle was narrower than its folklore.** design.md bans running an LLM "to guess what an agent did" — a rule about the trust layer. The hard guarantees all live below the focus/display layer and survive an LLM entering it.

## 2. The trailer bet, judged by history

Writer-side conventions never reach adoption; tool-generated metadata always wins:

- Conventional Commits: ~95% presence where commitlint/semantic-release enforce it; ~1 in 10 voluntary elsewhere.
- PR templates: 1.2% of GitHub repositories.
- The one mass-adopted agent trailer — `Co-Authored-By: Claude`, 7.78M commits in 13 months — exists only because Claude Code emits it by default.
- AGENTS.md hit 60k+ repos and 30+ tools in five months; repo-side instruction files are the channel foreign agents obey.

**Verdict:** generate metadata in three places — server-side derivation from the diff, tool-side emission (MCP + `ch` auto-compose trailers), and an AGENTS.md section. Trailers demote from load-bearing input to progressive enhancement.

## 3. Market evidence (mid-2026)

- Zero-config AI review is table stakes: Copilot review bundled into ~2.4M seats, Codex review in every paid ChatGPT plan, Bugbot at 2M+ PRs/month, GitLab at $0.25/MR.
- **No AI-review business with material revenue is BYO-key-first.** CodeRabbit went ~$5M→$40M ARR in 12 months bundling inference. Cline (the only funded BYO-first devtool) says outright "inference cannot be the business model."
- The market-clearing price of one AI review is **$0.25–$1.50**; seats cluster $19–40.
- The #1 user complaint is **noise**, not absence of intelligence ("one critical catch buried in 20 speculative comments") — a hard ≤5-flag precision cap is the wedge.
- **Cursor Origin** (announced June 2026, shipping fall) is the same thesis with ~$25B behind it. The window is months.
- GitHub is visibly strained (~"one nine" reliability under agent load) but humans still don't migrate hosts — the wedges that work are layers (Graphite → Cursor exit) and agent-native infrastructure (Pierre's code.storage pivot).
- Greptile's independence thesis: the same agent writing and approving code is "absurd and perhaps non-compliant" — an argument for review as a separate, platform-level function. ClawHub's server-enforced no-self-verify is exactly this.

## 4. Cost model (verified Anthropic pricing, July 2026)

Haiku 4.5 $1/$5 per MTok; Sonnet 5 $3/$15 (intro $2/$10 through 2026-08-31); cache reads 0.1×; Batch −50%.

| Unit | Cost |
|---|---|
| Review, medium Change (12k-tok diff + 30k context, 10k cached) | Haiku $0.046 / Sonnet $0.137 |
| Blended review, risk-routed 80/20 | **≈ $0.06** |
| Verify run (agentic boot+browse+attest, 300–800k cum. input @70% cache) | $0.63–1.49 (mid ≈ $1.06) |
| Monthly: team (300 reviews + 90 verifies) | $108–135 |
| Monthly: org (1,500 reviews + 375 verifies) | $463–593 |

Structural facts: verify is **84–88% of COGS** when enabled — reviews are nearly free, verification is the metered good. Flat-seat unlimited verify breaks even at ~53 changes/dev/month — uninsurable under agent fleets. A free tier of 50 Haiku reviews/repo/month costs ≤ ~$2.20/repo.

**The image cost envelope (dogfood finding):** screenshots compound — ~2k tokens each at 1080p, re-sent every turn in a naive loop. An undisciplined full-res Opus loop is $20–30/run; the same verification disciplined is under $1 (~30–70× envelope). Levers: snapshot/text-assert first with screenshots only at checkpoints; evidence to disk, not context; plan-then-playback (scripted replay costs zero tokens); context editing; 1080p not full-res.

**What vision can and can't verify:** models are reliable at *functional* browser verification and weak at *design judgment*. Encode the line: `ui` claims (functional) are machine-attestable; `design` claims are explicitly human — the agent supplies before/after screenshots and a deterministic visual-regression diff; computed-style assertions cover spec'd values. Humans keep taste; agents keep proof.

## 5. The review system

On a trailer-less push, three layers fire with zero setup:

- **Layer 0 — deterministic focus floor** (always, free): auto-flag hunks in sensitive paths, churn × sensitivity ordering, generated-file suppression, line-anchored risk reasons, memory-graph co-change/rollback callouts. ~60–70% of triage value; makes the empty state impossible. (Skip AST/tree-sitter: per-language work that reaches structure, not decisions, vs a $0.06 LLM call.)
- **Layer 1 — native reviewer** (default-on, advisory, precision-capped): a system-owned standing agent on the existing change.opened dispatch; review-only (never executes repo code); verdict + intent-vs-diff summary + ≤5 `additionalFocus` decisions; deterministic risk-routing with anti-gaming (max of computed risk and track record, plus hash-seeded random Sonnet audits of low-risk changes).
- **Layer 2 — conformance verify** (the metered good): verifies the Change against a resolved behavior **spec hierarchy** — linked issue → Change description (Intent + commit bodies) → inferred-from-diff — with `specBasis` stamped on the attestation. The gate reads basis deterministically: an inferred-basis attestation satisfies verified autonomy only at low risk. Claims taxonomy: `ui/api/cli/script/config/migration`, each with a server-validated evidence requirement. **Bidirectional:** verify declared behavior AND flag undeclared scope (description–diff divergence is the signature of a sneaky change). The incentive loop this creates: better descriptions → higher basis → more autonomy — metadata becomes self-interested.

## 6. The autonomous loop

The zero-human pipeline already exists as disconnected roles: triager → developer (grabs issue, builds, browses, opens Change with `Closes: #N` + evidence) → verified-reviewer (independent attest; no-self-verify server-enforced) → verified autonomy → auto-merge → rollback capture. What's missing is **packaging** (a one-click Loop bundle) and the conformance contract. Zero human involvement is a *policy dial* (earned autonomy low / verified autonomy medium with floor globs / human above), not an architectural gap. Environments are the cheap part ($0.005–0.01/run compute); the full autonomous cycle's platform COGS is ~$1.10–1.60 per shipped feature — a 5–15% overhead on the generation spend it verifies.

## 7. Pricing

| Tier | Contents | Economics |
|---|---|---|
| Free | Deterministic focused review forever · 50 platform-keyed Haiku reviews/repo/mo · unlimited BYO-key | ≤$2.20/repo/mo max COGS |
| Pro $20/human seat/mo | Risk-routed review on every Change (500/seat pool) · 10 verify credits/seat · governance plane | ~85–90% review margin |
| Metered | Verify $2.00/run · review overage $0.10 | 47% / 23–77% margin |
| Enterprise/self-host | BYO-key or BYO-endpoint everything, license + support | where "never runs an LLM" stays literally true |

*Price the humans, meter the machines* — per-agent pricing taxes exactly the behavior the product exists to create.

## 8. Tripwires and honest unknowns

Before trusting the plan: measure ClawHub's own funnel (is trailer-less volume real?); run a 30-Change quality audit (does Haiku-tier review catch real bugs at usable precision?); sample verify boot-success on ~20 real-world repos; confirm Anthropic terms for platform-keyed inference (resolved — see decision D2 in the plan).

Re-open this memo when: Cursor Origin's GA feature list lands; Sonnet intro pricing expires (2026-08-31); metadata standardization (Entire Checkpoints, vendor-emitted commit metadata) reaches AGENTS.md-speed adoption; or buyers start disabling the human gate entirely (which would favor the governance/attestation-API pivot this plan partially builds anyway).

**Named risk of the composite:** a single trust incident — a prompt-injected diff exfiltrating a platform key, or a gamed attestation auto-merging a bad change — is near-fatal for a product sold on governance. Hence: gateway key custody (key never enters containers), review-only mode, schema-enforced output, metering/quota firewalls before scale, attestation hardening, and the human floor ON by default for tenant repos.
