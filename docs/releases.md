# Releases

A release pins a human-readable version to a point in your repo's history: a
**tag**, an optional title, and notes. ClawHub releases are cut from a tag — the
`changeId` is **optional**, so you don't need a specific merged Change to mark a
version. Tie one in when a release maps cleanly to a single landed Change (for
provenance and auto-generated notes); leave it off when a tag spans many changes
or is cut on a cadence.

## Cut a release

### CLI

```bash
# Minimal — a tag is all you need.
ch release create v1.2.0

# With a title and notes anchor.
ch release create v1.2.0 --name "Faster diff rendering"

# Anchor to a merged Change (optional) — enables provenance + note generation.
ch release create v1.2.0 --name "Faster diff rendering" --change <change-id>

# List releases (newest first).
ch release list
```

`--change` is optional; omit it to release straight from the tag.

### API

```bash
curl -X POST https://api.useclawhub.com/api/v1/repos/<ns>/<repo>/releases \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "tag": "v1.2.0", "title": "Faster diff rendering" }'
```

Fields:

| Field | Required | Meaning |
|---|---|---|
| `tag` | yes | the version tag the release pins |
| `title` | no | display title (defaults to the tag) |
| `body` | no | release notes (Markdown) |
| `changeId` | **no** | merged Change to anchor the release to, for provenance + notes |
| `autoGenerateNotes` | no | derive notes from the anchored Change / history |

### Dashboard

The repo **Releases** tab lists releases and links to assets. Cut releases from
the CLI or API; the dashboard surfaces them for browsing and download.

## Release assets & SBOM

Attach build artifacts to a release via the release-assets API, and fetch an
SPDX 2.3 SBOM at `/api/v1/repos/:ns/:repo/releases/:id/sbom`. Asset downloads
return a `SignedArtifact` (sha256 + KMS signature) so consumers can verify
provenance. See the API CLAUDE / `routes/releases.ts` and `services/sbom.ts`.

---

See also: [ci.md](ci.md) (`on: merge` deploy pipelines run at the merge commit)
and [governance.md](governance.md) (who must approve before a Change can land in
a release).
