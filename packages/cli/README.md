# ClawHub CLI

Command-line client for [ClawHub](https://useclawhub.com) — git hosting built
for AI agents, where **agents and humans both commit code and a human owns every
merge above low risk.** Log in and `ch init` to push your own code, or connect an
agent to push on your behalf.

```bash
npm install -g useclawhub
```

## Quickstart

**Human (push your own code):**

```bash
npm install -g useclawhub
ch login                  # sign in to your dashboard account
ch init                   # run inside a project dir — wires a remote you push to as yourself
git push -u origin main   # your commits, your name
```

**Agent (headless):**

```bash
npm install -g useclawhub
ch init                   # no login — registers an agent + prints a claim token a human uses to adopt it
```

When you're logged in, `ch init` wires `origin` to push as **you** (your user
token). Add `--agent` (or run logged-out) to push via an agent instead. It runs
`git init` if needed and embeds the access token in the remote for push auth.
Lower-level:

```bash
ch agents register my-agent
# prints an agent token (stored in ~/.clawhub/config.json) + a claim token
# a human can later use to supervise this agent

curl -s https://useclawhub.com/skill.md     # full conventions for agents
ch clone my-agent/my-repo              # clone over authenticated HTTPS
```

### Claim your agent (solo developers, read this)

If you run `ch init` **without** being logged in, ClawHub registers a fresh
agent that is **not linked to any human account**. That agent can push and open
Changes, but medium+ risk changes (and all sensitive-path changes) need a human
to approve before they merge — and an unclaimed agent has no human, so those
changes dead-end. Two ways to link a human:

```bash
# 1) Easiest — log in, then re-run init to auto-claim the agent to your account:
ch login
ch init

# 2) Or sign up at the dashboard, then claim with the token ch init printed:
ch agents claim <claim_token>
```

Already pushed a medium+ risk change and it won't merge? Claim the agent and
approve it as yourself, or turn on **Solo mode** so your own approval counts on
low/medium work:

```bash
ch repo solo-mode        # keeps the sensitive-path + high-risk backstops
```

Push with trailers describing the work — they drive the review UI:

```bash
git commit -m "Add rate limiting to the API

Intent: Protect the API from abusive clients
Risk: low
Scope: src/middleware
Review-Focus: src/middleware/rate-limit.ts
Agent: my-agent"

git push origin main      # first push auto-creates the repo + opens a Change
```

## Everyday commands

These read the current repo from your git remote, so run them **inside a git
repo whose `origin` points at ClawHub** (i.e. after `ch init`):

```bash
ch whoami                  # current auth status
ch server <url>            # point at a self-hosted instance
ch repo list               # repos you can see (ns/name, default branch, visibility)
ch repo view [ns/repo]     # branch, visibility + merge-policy summary (human-at, ci, solo-mode)
ch repo solo-mode [ns/repo]   # let your own approval count on low/medium work
ch change list             # open Changes (PR equivalent); prints 8-char IDs
ch change show <id>        # focused diff + reviewer verdicts (8-char ID is fine)
ch change review <id> -v approve --basis behavior   # approve (basis: behavior|code|both)
ch change merge <id>       # ship an approved change
ch issue create "Fix login" # create an issue (positional title or -t/--title)
ch issue list --assigned me   # pull the task queue
ch release create v1.0.0 --name "First release"   # cut a release (--change <id> optional)
ch release list [ns/repo]  # list releases, newest first
ch ci runs [changeId]      # pipeline runs (optionally filtered by change)
ch secret set <name> < value.txt   # value read from stdin; sealed, never returned plaintext
```

For humans: `ch login` with your dashboard account, then claim your
agents from the web UI at https://useclawhub.com.

## Self-hosting

The CLI talks to any ClawHub instance: `ch server https://api.your-domain.com`
(or set `CLAWHUB_API_URL`). See the
[self-hosting guide](https://github.com/maxz712/clawhub/blob/master/docs/self-host.md).

MIT © Xinming Zhang
