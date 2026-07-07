# Agent Workflow CLI Guide

This guide covers the `ch workflow` CLI commands for managing automated agent workflows in ClawHub.

## Overview

Workflows define **what** an agent does and **when** it does it. Each workflow is attached to a standing agent (deployment) and controls the trigger schedule, instructions, and repository scope.

## Commands

### `ch workflow list`

List all workflows you own.

```bash
ch workflow list
```

**Output columns:** ID (short), name, linked agent, trigger description, enabled/paused status, and instructions.

---

### `ch workflow add`

Create a new workflow.

```bash
ch workflow add \
  --name "Nightly code review" \
  --agent-id <standing-agent-id> \
  --instructions "/loop Review all open Changes and leave feedback" \
  --trigger schedule \
  --cron "0 6 * * *"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name <name>` | ✅ | Display name for the workflow |
| `--agent-id <id>` | ✅ | Standing agent (deployment) ID — full UUID or short prefix |
| `--instructions <text>` | | Agent instructions; defaults to `/loop` |
| `--trigger <kind>` | | `manual` (default), `continuous`, `schedule`, or `event` |
| `--cron <expr>` | | 5-field UTC cron expression (when `--trigger schedule`) |
| `--event <type>` | | ClawHub event type, e.g. `change.opened` (when `--trigger event`) |
| `--interval <sec>` | | Min seconds between ticks (when `--trigger continuous`); default `3600` |
| `--repo-scope <scope>` | | `all` (default) or `selected` |
| `--repo-id <id...>` | | Repo UUID(s) when `--repo-scope selected` (repeatable) |

**Example — event-triggered workflow:**

```bash
ch workflow add \
  --name "Auto-review on change" \
  --agent-id abc12345 \
  --instructions "Review the Change for correctness and style" \
  --trigger event \
  --event change.opened
```

---

### `ch workflow edit`

Edit an existing workflow's configuration. Only the fields you pass are updated.

```bash
ch workflow edit <id> [options]
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Update display name |
| `--agent-id <id>` | Re-point to a different standing agent |
| `--instructions <text>` | Update instructions |
| `--trigger <kind>` | Change trigger type |
| `--cron <expr>` | Update cron expression |
| `--event <type>` | Update event type |
| `--interval <sec>` | Update interval |
| `--repo-scope <scope>` | Update repo scope |
| `--repo-id <id...>` | Update selected repo IDs |

**Example:**

```bash
ch workflow edit 6c0eeda9 --instructions "/dev Fix all lint warnings" --cron "0 8 * * 1"
```

---

### `ch workflow run`

Trigger one execution of a workflow immediately, regardless of its schedule.

```bash
ch workflow run <id> [options]
```

| Flag | Description |
|------|-------------|
| `--repo-id <id>` | Override the workflow's repo scope for this run |
| `--issue <num>` | Point the agent at a specific issue number |
| `--focus <text>` | Ad-hoc instructions appended to the workflow's base instructions |

**Example — run targeting a specific issue:**

```bash
ch workflow run 6c0eeda9 --issue 42 --focus "Fix the bug described in issue #42, write tests, and open a Change"
```

---

### `ch workflow pause`

Pause a workflow. Scheduled and event triggers will stop firing until resumed.

```bash
ch workflow pause <id>
```

---

### `ch workflow resume`

Resume a paused workflow.

```bash
ch workflow resume <id>
```

---

### `ch workflow rm`

Delete a workflow permanently.

```bash
ch workflow rm <id>
```

## Typical Workflow Setup

1. **Create an agent identity** with `ch agent create` — this gives you a standing agent deployment.
2. **Create a workflow** with `ch workflow add` — attach it to the agent and define the schedule.
3. **Test it** with `ch workflow run` — trigger a one-off execution to verify it works.
4. **Monitor** with `ch ci runs` — watch the agent's runs and their results.

## Tips

- Use `--issue` with `ch workflow run` to point the agent at a specific issue for targeted work.
- Use `--focus` to give one-off context without permanently changing the workflow's instructions.
- Workflows can be edited after creation with `ch workflow edit` — no need to delete and recreate.
- Both the CLI and the dashboard UI support editing workflows and standing agents.
