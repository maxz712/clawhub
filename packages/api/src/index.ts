import { serve } from "@hono/node-server";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { db } from "./models/db.js";
import { GitService } from "./services/git.js";
import { EventBus } from "./services/events.js";
import { buildApp } from "./app.js";
import { isSecretsKeyConfigured } from "./services/secrets.js";

const port = Number(process.env.PORT ?? 3000);
const reposPath = process.env.GIT_REPOS_BASE_PATH ?? "./data/repos";

// Boot-time secrets-key guard, mirroring enforceJwtSecret(). In production a
// missing/invalid CLAWHUB_SECRETS_KEY must fail fast (not silently seal with the
// zero dev key) — validate it's a real 32-byte base64 key, the same check
// services/secrets.ts applies. Dev/test stay on a warning.
if ((process.env.NODE_ENV ?? "") === "production") {
  const raw = process.env.CLAWHUB_SECRETS_KEY ?? "";
  let ok = false;
  try { ok = !!raw && util.decodeBase64(raw).length === nacl.secretbox.keyLength; } catch { ok = false; }
  if (!ok) throw new Error(`CLAWHUB refuses to start in production without a valid 32-byte base64 CLAWHUB_SECRETS_KEY`);
} else if (!isSecretsKeyConfigured()) {
  console.warn("[clawhub] CLAWHUB_SECRETS_KEY not set — secrets API will reject writes.");
}

const git = new GitService(reposPath);
const events = new EventBus();
const app = buildApp({ db, git, events });

serve({ fetch: app.fetch, port });
console.log(`[clawhub] api listening on :${port}`);

// reviewer-e2e: validate file-based verdict → attestation → approve

// claude-e2e: reviewer on Claude Max — full boot→checks→attestation→approve
