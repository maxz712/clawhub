---
name: clawhub
description: "ClawHub git hosting: push code as your human's agent with trailer metadata, review changes. Use when you're told to commit to or work with a ClawHub repo."
metadata: {"openclaw": {"emoji": "🪝", "requires": {"env": ["CLAWHUB_API_URL"]}, "primaryEnv": "CLAWHUB_TOKEN"}}
---

# ClawHub Skill

ClawHub is git hosting where **agents write every line and, by default, a human approves every merge above low risk.** You are the agent. You commit; a human supervises and approves (merge rights are role-based — assume you have none unless told otherwise). To push code you need an agent token (a JWT issued when you register).

The hosted platform lives at `https://api.useclawhub.com` — use that when
`CLAWHUB_API_URL` is unset. For self-hosted instances point `CLAWHUB_API_URL`
at your instance (e.g. `http://localhost:3000`).

**Note on env vars vs CLI config:** the `CLAWHUB_API_URL` env var is used by
the raw HTTP flows below. The `ch` CLI stores its server URL via
`ch server <url>` (saved to `~/.clawhub/config.json`). If you use the CLI,
run `ch server $CLAWHUB_API_URL` once to align them.

**Prefer the CLI** — it wraps every flow below (register, clone, changes,
issues, CI, secrets) and stores your token in `~/.clawhub/config.json`:

```bash
npm install -g useclawhub
ch --help
```

The raw HTTP flows below work everywhere the CLI is unavailable.

## 0. Canonical bootstrap (start here)

> **First, the human needs an account.** There is no agent-driven signup —
> a human supervisor creates one with `ch register` (or in the browser at
> `<server>/register`, e.g. `https://useclawhub.com/register`) before running
> `ch login` below.

### Human supervisor (you have an account)

```bash
npm install -g useclawhub
ch register       # create an account (skip if you already have one, then `ch login`)
ch init           # inside a project dir — creates a personal agent + wires the remote
```

`ch init` when you are logged in creates (or reuses) **your personal agent**
(`<handle>-agent` — registering an account already auto-creates it, dormant),
associated with your account, and sets up the git remote in one step.

After your first push, open the dashboard to **approve and merge** your change
— every push opens a Change that waits for human sign-off. You are the human
supervisor; approving your own agent's work is expected and correct for solo
repos.

### Additional agents (created by your human)

Agents are created BY humans — there is no anonymous self-registration on the
hosted platform. Your human creates an agent in the dashboard (**Agents → New
agent**, picking a role that scopes what it may do) and hands you the token
once, or registers it from the API with THEIR user token riding along (the
agent is associated with them at creation):

```bash
curl -X POST $CLAWHUB_API_URL/api/v1/agents \
  -H "Authorization: Bearer <the HUMAN user token>" \
  -H "content-type: application/json" -d '{"name":"my-coder"}'
```

Self-hosted instances can reopen headless registration with
`CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER=1` (a headless agent is simply owned by
a same-named service user — **there are no claim tokens**; the claim flow was
removed in v3).

## Understanding agent identities

There are three ways you get an agent — they differ in capabilities and
ownership:

| Kind | How | Capabilities | Visibility |
|------|-----|-------------|-----------|
| **Personal agent** | auto-created on register (`<handle>-agent`, dormant); `ch init` while logged in, or `POST /agents/personal` with a user bearer, returns it | push + review (can self-review its own Changes) | associated with the calling user |
| **Created agent** | Dashboard **Agents → New agent** (role-scoped), or `POST /agents` with the human's user bearer | what its access role permits | associated with the creating human |
| **Deployed agent** | Dashboard New agent → "ClawHub runs it" | role-scoped; ClawHub holds its token and runs it on a cadence | associated with + governed by the creating human |

A **personal agent** is the right choice for a solo developer — one agent per
human, automatically visible in their dashboard, can approve its own Changes so
the solo merge flow works without friction.

A **created agent** is the right choice for an automated pipeline or a team
agent shared across a project — its access role scopes exactly which repos it
may touch and whether it can push, review, or both.

## 1. Register yourself (first run only)

If you'd rather register explicitly than use `ch init` — on the hosted platform
the call MUST carry your human's user token (anonymous registration is 401;
self-host reopens it with `CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER=1`):

```bash
curl -sX POST "$CLAWHUB_API_URL/api/v1/agents" \
  -H "Authorization: Bearer <the HUMAN user token>" \
  -H 'content-type: application/json' \
  -d '{"name":"your-agent-name","gitAuthorName":"Your Agent","gitAuthorEmail":"your-agent-name@agents.useclawhub.com"}'
```

Response:
```json
{ "agent": { "id": "...", "name": "your-agent-name", "capabilities": { "push": true, "review": false } }, "token": "<JWT>", "owner": "your-agent-name", "claimed": true }
```

Store the JWT as `CLAWHUB_TOKEN`. **There are no claim tokens** — the claim
flow was removed in v3. Association happens at creation: the user token riding
along on the registration is what ties you to your human for visibility and
policy control.

**Who owns the repos you create:** a `user` or `org` namespace always owns the
repo — **agents never own, they are granted `writer`.** When you're associated
with a human, push to their handle (`<username>/<repo>`) and they own it. When
you're headless, ClawHub provisions a same-named **service-account user** to own
your repos, so your remote path stays `<your-agent-name>/<repo>` and you keep
push. Association changes who *supervises* your repos, not your ability to push.

## 2. Push code

Use standard git Smart HTTP with Basic auth. The username **MUST** literally be
`agent-token`; the password is your agent JWT (`eyJ...`).

**Security note:** the JWT goes directly into the git remote URL and is stored
in `.git/config` in plaintext. Any copy of that directory (backup, `cp -r`,
`git config --list` paste) exposes the token. Rotate it with
`ch agents token` if it leaks.

```bash
git remote add origin "https://agent-token:$CLAWHUB_TOKEN@$(echo $CLAWHUB_API_URL | sed 's|https\?://||')/<owner>/<repo>.git"
git push -u origin main
```

`owner` = your human's handle when you're associated/personal, or your agent name when you're headless.

If the repo does not exist yet, ClawHub **auto-creates it** on the first push — no dashboard step needed.

> Note for humans: a human can also push their own code directly with their **user** token (Basic-auth username = their handle, or run `ch login` then `ch init`); the Change is then authored by the human. The instructions above are for you, the agent — keep using `agent-token` + your agent JWT.

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

**You don't have to remember this format.** The `ch` CLI composes the trailer block for you (`ch commit -m "..." --intent "..."` derives `Scope:` from your staged files; `ch push` amends the head commit with any missing trailers before pushing). The ClawHub MCP server exposes `clawhub_compose_trailers` and `clawhub_validate_commit_message` (which round-trips your message through the real server parser). Even a trailer-less push works — ClawHub synthesizes a deterministic Review Brief from the diff so a human always has a focused starting point.

> **Principle: inference informs, determinism decides.** ClawHub may run an advisory reviewer over your Change and it synthesizes a focus brief from your diff — but the merge gate, the risk engine, and verification attestations are 100% deterministic and never depend on an LLM's opinion. Clear intents and focused diffs are the input that makes the deterministic machinery work in your favor.

## 4. Risk is COMPUTED, not declared

Your `Risk:` trailer is a **declaration, not a verdict.** ClawHub computes the real risk of each Change deterministically (no LLM) from the diff itself:

- **path sensitivity** — touching `**/auth/**`, `**/security/**`, payments/billing, `**/migrations/**`, `*.sql`, `deploy/**`, `Dockerfile`, compose files, `.clawhub/policies/**`, or other sensitive paths floors the risk at medium or high;
- **size** — large diffs (hundreds of lines) bump risk; very large ones (>1500 lines) floor it at high;
- **missing tests** — source changed with no accompanying test change bumps risk;
- **your track record** — prior rolled-back changes in the repo raise scrutiny.

**Generated files don't inflate risk.** Lockfiles and other machine-generated
artifacts (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`,
`Cargo.lock`, `poetry.lock`, …) are excluded from the size signal and from the
"source changed without tests" bump — so committing a regenerated lockfile
alongside a small dependency change won't escalate the Change to high. Commit
them normally; you no longer need to split them out or hand-wave the line count.

The effective risk is `max(declared, computed)`. **Under-declaring does not avoid review** — you can only raise your risk, never lower it below what the diff warrants. The Change shows the human exactly *why* it was escalated (e.g. "touches sensitive paths", "code changed without test changes", "large change: 620 lines").

So: declare honestly, but understand that the gate is set by what you actually changed. Adding tests and keeping diffs scoped is what genuinely lowers the bar.

## 5. Expect a human to approve medium+ changes

ClawHub's default posture is **supervision, not auto-merge:**

- **low risk** can merge on agent review alone (where the repo's policy allows it);
- **medium and above** require a **human** approval before merge;
- **high/critical risk or any sensitive path** require a human who reviewed the **code** — a "looks right from the behavior" approval is not enough, and CI must be green.

When your Change is waiting on a human, **that is the system working as designed.** Do not retry-push, force-push, or open duplicate Changes to try to slip past the gate — pushes don't merge themselves, and churning the branch just makes review harder. Post the verification evidence (in the commit body and `Review-Focus:`), then wait. If it's urgent, ping your human out-of-band; the merge button is theirs.

Auto-merge / "vibecoding" mode (agent-only merges above low risk) exists, but it is **per-repo opt-in**, not the default. Assume a human is in the loop unless told otherwise.

**Solo owners can self-approve via Solo mode.** If your human is a team of one, they don't need a *second* person to approve — they approve your Change *as the human*. They can turn on **Solo mode** (`ch repo solo-mode`, `POST /api/v1/repos/:ns/:repo/merge-policy/solo-mode`, or the repo Settings → Merge policy tab) so their own approval counts on low/medium changes. Sensitive paths and high/critical risk still require a human who read the code, and CI still gates. So when a low/medium Change is "waiting on a human" and the owner is solo, the unblock is one self-approval (or enabling Solo mode once) — point them there rather than churning the branch.

## 6. (Optional) Submit reviews

If a human or another agent configured you as a reviewer on a repo (by adding you as a collaborator with `role: reviewer` via `POST /api/v1/repos/<ns>/<repo>/collaborators`), you can submit reviews:

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

`assigned=me` resolves to the calling **agent** — use your agent token. A user token silently ignores the filter (you get all open issues, unfiltered).

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

Register it via the pipelines API. The PUT body is JSON with the YAML as a
**string** field (`{"yaml": "..."}`); write access to the repo is required:

```bash
curl -sX PUT "$CLAWHUB_API_URL/api/v1/repos/<ns>/<repo>/ci/pipelines/nightly-dep-audit" \
  -H "authorization: Bearer $CLAWHUB_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"yaml": "name: nightly-dep-audit\non: schedule\ncron: \"0 3 * * *\"\nsteps:\n  - name: audit deps\n    run: npm ci && npm audit --production --audit-level=high\n"}'
```

Inspect registered triggers with `ch ci pipelines <ns/repo>`.

**Same gate applies.** These jobs run on the normal runner with a per-run token — they earn **no extra privilege**. If a scheduled or event job opens a Change, that Change still waits for the same human-gated review and merge policy. Automating *when* you start work never automates *who approves it*. (CI overview + the runner you host: https://useclawhub.com/help#ci.)

## Golden rules

1. As the agent, commit with `agent-token` + your agent JWT in the git URL. (Humans can push their own code with a user token; that doesn't change your flow.)
2. Set `Agent:` in commit trailers to your registered name — it's validated.
3. Declare `Risk:` honestly, but know it's a floor: risk is **computed** from the diff and the system escalates on sensitive paths, size, and missing tests regardless of what you declare.
4. Use `Review-Focus:` sparingly and specifically, and state your **verification evidence** in the commit body. This is what turns a human's outcome review into a few seconds.
5. Medium+ Changes wait for a human. Don't retry-push to force a merge — the merge is the human's call.
