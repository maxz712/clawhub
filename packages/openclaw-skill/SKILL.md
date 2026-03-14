---
name: clawforge
description: "ClawForge code hosting: create repos, push code changes with intent, browse files, and check change status. Use when asked to create repositories, submit code, or manage code on ClawForge."
metadata: {"openclaw": {"emoji": "🔨", "requires": {"env": ["CLAWFORGE_API_URL", "CLAWFORGE_TOKEN"]}, "primaryEnv": "CLAWFORGE_TOKEN"}}
---

# ClawForge Skill

Interact with ClawForge, an AI-native code hosting platform. All requests use `curl` with Bearer token auth.

## Environment

- `CLAWFORGE_API_URL` — base URL (e.g., `http://localhost:3000`)
- `CLAWFORGE_TOKEN` — agent auth token

## API Reference

All endpoints use:

```bash
curl -s -X <METHOD> "$CLAWFORGE_API_URL<path>" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN" \
  -d '<json-body>'
```

### List Repositories

```bash
curl -s "$CLAWFORGE_API_URL/api/v1/dashboard/repos" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"
```

Returns: `[{ "id": "uuid", "name": "repo-name", "description": "..." }, ...]`

### Create a Repository

```bash
curl -s -X POST "$CLAWFORGE_API_URL/api/v1/repos" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN" \
  -d '{"name": "my-repo", "description": "Optional description"}'
```

Returns: `{ "id": "uuid", "name": "my-repo", ... }`

### Push a Code Change

Submit files with an intent description. Changes go through review before merging.

```bash
curl -s -X POST "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>/changes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN" \
  -d '{
    "intent": "What this change does and why",
    "branch": "main",
    "files": [
      {"path": "src/index.ts", "action": "create", "content": "console.log(\"hello\");"},
      {"path": "README.md", "action": "update", "content": "# Updated readme"},
      {"path": "old-file.txt", "action": "delete"}
    ],
    "description": "Optional longer description"
  }'
```

- `action` must be `create`, `update`, or `delete`
- `content` is required for `create` and `update`, omitted for `delete`
- `intent` is required — describe what the change does and why

Returns: `{ "id": "change-uuid", "status": "pending", ... }`

### Check Change Status

```bash
# All changes for a repo
curl -s "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>/changes" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"

# Specific change
curl -s "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>/changes/<change-id>" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"
```

Returns change objects with `status` field (pending, approved, rejected, merged).

### Browse Repository Files

```bash
# List all files
curl -s "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>/files" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"

# Read a specific file
curl -s "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>/files/<file-path>" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"
```

### Get Repository Info

```bash
curl -s "$CLAWFORGE_API_URL/api/v1/repos/<repo-id>" \
  -H "Authorization: Bearer $CLAWFORGE_TOKEN"
```

## Workflow

1. **Create a repo** or **list repos** to get a repo ID
2. **Push changes** with a clear intent — changes are queued for human review
3. **Check status** to see if changes were approved/rejected
4. **Browse files** to see current repo contents

## Notes

- All changes go through ClawForge's Intent Engine for risk classification
- Humans approve/reject changes via the ClawForge dashboard
- Always provide a clear, descriptive `intent` when pushing changes
- Use `jq` to format JSON output when helpful
