# Agents UX — the two-kinds model

Decided 2026-07-05 after a full click-through audit of the product (walked as a
fresh user through signup → agent → import → review → merge → loop install).
This doc is the information architecture for everything agent-shaped in the
dashboard. It changes PRESENTATION only — no API contracts, merge gates, or
agent plumbing move.

## The problem it solves

Agent management had accreted five surfaces (global Agents tab with 10
destinations, per-repo Settings → Standing agents, org Fleet, Roles
marketplace, claim tokens) and five verbs (register, claim, attach, use &
deploy, install). Installing one Loop minted three random-suffixed agent
identities (`ui-developer-mjol`, …) that appeared as PEERS of the user's
personal agent in the identity roster. A user managing "my coding agent" and a
user operating "a deployed 24/7 fleet" were served by the same undifferentiated
UI, and neither felt simple.

## The model: exactly two kinds

**1. My agents — identities (people-like).**
The personal agent and claimed external agents (Claude Code on your laptop,
a teammate's harness). They push code when *you* prompt them. They need almost
no management: a profile (git author, capabilities, activity), a token
lifecycle (rotate/archive), and attribution everywhere their work shows up
(commits, Changes, reviews, leaderboards). Treat them the way GitHub treats a
user account: identity first, knobs nearly zero.

**2. Deployed agents — infrastructure (machine-like).**
Standing agents, roles, and Loops that *ClawHub runs for you* on a
trigger — BYO-key or platform-keyed. These are the things with config
(trigger, cadence, mode, egress), budgets, health, circuit breakers, and kill
switches. One deployment can mint its own worker identity; that identity
belongs to the deployment, not to the user's roster.

Everything in the UI hangs off this split. The claim-token flow is an
*identity* affordance (adopting an external agent as yours); the Loop is a
*deployment* affordance (hiring infrastructure). They never mix surfaces.

## Where things live

- **`/agents` (the hub) stays the ONE home for agent management.** Repo
  Settings → Standing agents remains a thin repo-scoped view: the Loop card,
  the repo's deployed list, and a link INTO the hub (already true; kept).
- **Overview = the identity roster, grouped.** "My agents" (personal +
  claimed) renders first, people-style. Agents minted by role deployments
  render in a separate collapsed **"Deployed by roles"** group with a `role`
  chip — visible for transparency (they authored real commits) but never
  intermixed as peers. The roster API now tags each agent with its
  role-membership so the split is server-truth, not name-pattern guessing.
- **Fleet stays the health/cost lens** (quality, spend, kill) and stays behind
  progressive disclosure. Overview answers "who are my agents"; Fleet answers
  "how are they doing". Chips there say what an agent IS (`personal`,
  `claimed`) — fixed in the audit batch.
- **Roles is the deploy catalog** — and it now leads with the Loop (the
  highest-leverage deployment: scout → dev → verified-reviewer → merge),
  pointing at the per-repo installer. Deploying a single role stays one click.

## The verbs (exactly three)

| Verb | Applies to | Meaning |
|------|-----------|---------|
| **Register / Claim** | identities | create or adopt an agent that pushes as you prompt it |
| **Deploy** | infrastructure | make ClawHub run an agent (a role template, a custom standing agent, or the Loop) |
| **Kill / Pause** | infrastructure | stop it |

"Attach" and "Use & deploy" are gone; both said "Deploy" in different accents.

## The deploy form: template-first, advanced-later

The one-off standing-agent form exposed 13 decisions (trigger, interval, mode,
egress, base URL, command override, …) as peers. The defaults are right for
almost everyone, so the form now shows: **repo, name, task, LLM key** — and
everything else lives under an explicit **Advanced** disclosure with the
defaults it already had. Power users lose nothing; first-time users see four
fields.

## What deliberately did NOT change

- The `agents` table, grants, claim flow, standing-agent scheduler, roles
  fan-out, Loop semantics, merge gates: untouched.
- Org Fleet (`/orgs/[id]/fleet`) stays canonical for teams.
- The hub's ops surfaces (Incident ops, Cost, Inbox, Sandboxes, Commit
  signatures) keep their progressive disclosure.
- Personal/claimed agents keep their full detail page, but power tabs with
  zero content (Versions, Evals) hide until they have something to show.

## Persona walk-throughs (how this was validated)

**Full autonomy (solo founder):** repo Settings → Standing agents → Loop card:
pick shape/autonomy/cadence, zero-setup or paste ONE key, Create loop. Watch
health per role on the same card; kill from there or from Fleet. The three
role identities the loop minted appear under "Deployed by roles" — not mixed
into "My agents".

**Prompted-agent developer:** onboarding card → personal agent minted with
copy-paste push commands; pushes open Changes; the Change page now shows risk
+ author up front. Their roster shows ONE agent (two if they claim their
laptop's Claude Code). They may never open Roles/Standing/Fleet at all.
