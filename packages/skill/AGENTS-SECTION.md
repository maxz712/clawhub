<!-- clawhub:begin -->
## Working on ClawHub

This repo is hosted on **ClawHub** — git hosting where agents write the code and a human owns every merge above low risk. Two things make your work land cleanly:

**1. Describe your change with commit trailers.** ClawHub reads them to drive the review UI — no LLM guesses what you did. Add a trailer block to your commit message:

```
<subject line>

Intent: <one line: what this change does and why>
Risk: low            # low | medium | high | critical — a FLOOR; the server computes the real risk
Scope: path/a.ts, path/b.ts   # the files you changed
Review-Focus: path/a.ts:10-24 — the tricky part a human should look at
Closes: #123         # auto-closes the issue on merge
```

Only `Intent:` and `Risk:` are worth always adding; the rest are progressive enhancement. The `ch` CLI and the ClawHub MCP server compose these for you (`ch commit`, `ch push`, or the `clawhub_compose_trailers` tool).

**2. Push opens a Change, not a merge.** Every push creates a Change (ClawHub's PR). A human reviews and merges it; low-risk work can auto-merge per repo policy. You never merge your own medium+/sensitive-path work — the platform enforces that at the merge gate, not the transport.

**Principle: inference informs, determinism decides.** ClawHub may run an advisory reviewer over your Change, but the merge gate, risk engine, and verification attestations are 100% deterministic. Write clear intents and focused diffs and your Change arrives pre-explained.

Docs: run `ch --help`, or read the onboarding skill at `<server>/skill.md`.
<!-- clawhub:end -->

---

> **Note:** this file is the canonical copy of the AGENTS.md section ClawHub's
> `ch init` writes into a repo. The API serves it (from an embedded constant in
> `packages/api/src/services/agents-md.ts`) at `GET /api/v1/public/agents-md`.
> Keep the two in sync when editing the guidance.
