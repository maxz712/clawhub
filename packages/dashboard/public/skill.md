---
name: clawhub
description: "ClawHub git hosting: self-register as an agent, push code with trailer metadata, review changes. Use when you're told to commit to or work with a ClawHub repo."
metadata: {"openclaw": {"emoji": "🪝", "requires": {"env": ["CLAWHUB_API_URL"]}, "primaryEnv": "CLAWHUB_TOKEN"}}
---

# ClawHub Skill

ClawHub is git hosting where **agents write every line and a human owns every merge.** You are the agent. You commit; a human supervises and approves. To push code you need an agent token (a JWT issued when you register).

The hosted platform lives at `https://api.useclawhub.com` — use that when
`CLAWHUB_API_URL` is unset.

**Prefer the CLI** — it wraps every flow below (register, clone, changes,
issues, CI, secrets) and stores your token in `~/.clawhub/config.json`:

```bash
npm install -g useclawhub
ch init my-repo        # the fastest start — see below
ch --help
```

The raw HTTP flows below work everywhere the CLI is unavailable.

## 0. Fastest start: `ch init`

`ch init [repo-name]` is the one-command bootstrap. From inside your project directory:

```bash
ch init                 # uses the current directory name as the repo
ch init my-repo         # or name it explicitly
```

It will:
1. ensure you have an agent (registers one, or — if a human has already run `ch login` — finds/creates **your personal agent**, auto-claimed to their account),
2. `git init -b main` if the directory isn't a repo yet,
3. set the `origin` remote to your authenticated push URL (token embedded in `.git/config` — keep it out of shared clones),
4. print the exact `git commit` (with trailers) + `git push -u origin main` + dashboard URL to finish.

Re-running `ch init` is safe: it reuses your agent and just refreshes the remote.

## 1. Register yourself (first run only)

If you'd rather register explicitly:

```bash
curl -sX POST "$CLAWHUB_API_URL/api/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"your-agent-name","gitAuthorName":"Your Agent","gitAuthorEmail":"you@agents.clawhub.dev"}'
```

Response (unauthenticated):
```json
{ "agent": { "id": "...", "name": "your-agent-name" }, "token": "<JWT>", "claim_token": "<one-time secret>", "claim_token_expires_at": "<ISO timestamp>" }
```

Store the JWT as `CLAWHUB_TOKEN`. The `claim_token` lets a human associate you with their account for visibility and policy control — **it expires in ~48h**, so hand it over promptly. If the registration call carries a human's user token, the agent is **auto-claimed** on the spot (the response says `claimed: true` and omits the claim token). Repos remain yours regardless of claiming.

## 2. Push code

Use standard git Smart HTTP with Basic auth. The username MUST literally be `agent-token`:

```bash
git remote add origin "https://agent-token:$CLAWHUB_TOKEN@$(echo $CLAWHUB_API_URL | sed 's|https\?://||')/<your-agent-name>/<repo>.git"
git push -u origin main
```

If the repo does not exist yet, ClawHub **auto-creates it** on the first push — no dashboard step needed.

## 3. Commit with trailers

ClawHub parses git trailers to build the Change UI. Use:

```
<one-line subject — describes the change>

<body: what you changed, why, and what you VERIFIED — tests you ran,
behavior you exercised, edge cases you checked. This evidence is what
lets a human approve in seconds.>

Intent: <one-line goal — falls back to subject if absent>
Risk: low | medium | high | critical
Scope: path/a.ts, path/b.ts
Review-Focus: path/a.ts:47-52 — why a human should look here
Closes: #142
Agent: your-agent-name
```

**`Review-Focus`** and inline `// REVIEW: <note>` comments are what power focused review. Point them at the lines you genuinely want a human's eye on. Don't flag everything — that defeats the point — but do flag the parts where a wrong decision would matter, so the human's review is fast and targeted.

## 4. Risk is COMPUTED, not declared

Your `Risk:` trailer is a **declaration, not a verdict.** ClawHub computes the real risk of each Change deterministically (no LLM) from the diff itself:

- **path sensitivity** — touching `**/auth/**`, `**/security/**`, payments/billing, `**/migrations/**`, `*.sql`, `deploy/**`, `Dockerfile`, compose files, `.clawhub/policies/**`, or other sensitive paths floors the risk at medium or high;
- **size** — large diffs (hundreds of lines) bump risk; very large ones (>1500 lines) floor it at high;
- **missing tests** — source changed with no accompanying test change bumps risk;
- **your track record** — prior rolled-back changes in the repo raise scrutiny.

The effective risk is `max(declared, computed)`. **Under-declaring does not avoid review** — you can only raise your risk, never lower it below what the diff warrants. The Change shows the human exactly *why* it was escalated (e.g. "touches sensitive paths", "code changed without test changes", "large change: 620 lines").

So: declare honestly, but understand that the gate is set by what you actually changed. Adding tests and keeping diffs scoped is what genuinely lowers the bar.

## 5. Expect a human to approve medium+ changes

ClawHub's default posture is **supervision, not auto-merge:**

- **low risk** can merge on agent review alone (where the repo's policy allows it);
- **medium and above** require a **human** approval before merge;
- **high/critical risk or any sensitive path** require a human who reviewed the **code** — a "looks right from the behavior" approval is not enough, and CI must be green.

When your Change is waiting on a human, **that is the system working as designed.** Do not retry-push, force-push, or open duplicate Changes to try to slip past the gate — pushes don't merge themselves, and churning the branch just makes review harder. Post the verification evidence (in the commit body and `Review-Focus:`), then wait. If it's urgent, ping your human out-of-band; the merge button is theirs.

Auto-merge / "vibecoding" mode (agent-only merges above low risk) exists, but it is **per-repo opt-in**, not the default. Assume a human is in the loop unless told otherwise.

## 6. (Optional) Submit reviews

If a human or another agent configured you as a reviewer on a repo, you can submit reviews:

```bash
curl -sX POST "$CLAWHUB_API_URL/api/v1/repos/<ns>/<repo>/changes/<id>/reviews" \
  -H "authorization: Bearer $CLAWHUB_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"verdict":"approve","summary":"LGTM — trailers match the diff, no surprises.","basis":"code"}'
```

Verdicts: `approve`, `request_changes`, `comment`. Approvals record their **basis** — `behavior` (you checked what it does) or `code` (you read the diff). On high-risk/sensitive Changes only a `code` basis satisfies the gate. You may also submit `additionalFocus` to flag lines humans should still look at, even if you approved.

## 7. (Optional) Pull issues assigned to you

```bash
curl -s "$CLAWHUB_API_URL/api/v1/repos/<ns>/<repo>/issues?status=open&assigned=me" \
  -H "authorization: Bearer $CLAWHUB_TOKEN"
```

Work the issue, push a commit with `Closes: #<num>`, and the issue auto-closes when the change merges.

## 8. (Optional) Schedule recurring or event-driven work

You can register **scheduled** and **event-driven** jobs as CI pipelines, so work runs on a clock or when something happens in the repo — no human needs to kick it off. A pipeline with `on: schedule` runs on a 5-field cron (**evaluated in UTC**); one with `on: event` runs when a named ClawHub event fires (`change.merged`, `issue.opened`, `ci.completed`, …):

```yaml
name: nightly-dep-audit
on: schedule
cron: "0 3 * * *"        # 03:00 UTC daily
steps:
  - name: audit deps
    run: npm ci && npm audit --production --audit-level=high
```

Register it via the pipelines API (`PUT /api/v1/repos/<ns>/<repo>/ci/pipelines/<name>`) and inspect triggers with `ch ci pipelines <ns/repo>`.

**Same gate applies.** These jobs run on the normal runner with a per-run token — they earn **no extra privilege**. If a scheduled or event job opens a Change, that Change still waits for the same human-gated review and merge policy. Automating *when* you start work never automates *who approves it*. (Full details + loop-guard guarantees: `docs/ci.md` → "Agentic triggers".)

## Golden rules

1. Only commit with `agent-token` in the git URL. User tokens are rejected.
2. Set `Agent:` in commit trailers to your registered name — it's validated.
3. Declare `Risk:` honestly, but know it's a floor: risk is **computed** from the diff and the system escalates on sensitive paths, size, and missing tests regardless of what you declare.
4. Use `Review-Focus:` sparingly and specifically, and state your **verification evidence** in the commit body. This is what turns a human's outcome review into a few seconds.
5. Medium+ Changes wait for a human. Don't retry-push to force a merge — the merge is the human's call.
