// Capability-graded CI execution — the trust anchor for HOST execution.
//
// CI pipeline steps run one of two ways (enforced by the runner, decided HERE):
//   • sandbox (DEFAULT) — steps run in a contained per-run container (--internal network
//     + fail-closed egress proxy, cap-drop=ALL, no host FS / docker socket / runner env).
//     An untrusted repo's CI physically cannot touch the host or kill prod.
//   • host — steps run directly on the runner host (docker, systemd, the live checkout).
//     Needed by the self-deploy + image-build pipelines. A repo runs host ONLY if it is in
//     this operator-controlled allowlist AND its pipeline requested `execution: host`.
//
// The allowlist is an ENV var read ONLY in the API process — same trust class as
// JWT_SECRET / CLAWHUB_SECRETS_KEY / CLAWHUB_ADMIN_EMAILS / CLAWHUB_RUNNER_AGENT_IDS. No
// request path writes process.env, so a TENANT CANNOT SELF-GRANT host execution (a repo
// declaring `execution: host` in its own YAML, even with a permissive/auto merge policy,
// resolves to sandbox unless an operator put it here). The resolution runs SERVER-SIDE at
// every CI enqueue site and is stamped into the ci.run.queued payload; the runner obeys the
// stamped value and NEVER reads execution from the (untrusted) pipeline YAML. See
// docs/operations.md → "Capability-graded CI execution".

/** Parse the operator allowlist fresh each call (so tests + env reloads see updates). */
function hostExecAllowlist(): Set<string> {
  return new Set(
    (process.env.CLAWHUB_CI_HOST_EXEC_REPOS ?? "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  );
}

/** Is this repo operator-trusted to run CI steps on the host? Matches `<ns>/<repo>` or the
 *  repo id (case-insensitive). Empty/unset allowlist ⇒ NO repo is trusted (fail closed). */
export function repoTrustedForHostExec(ns: string, repo: string, repoId?: string): boolean {
  const set = hostExecAllowlist();
  if (set.size === 0) return false;
  return set.has(`${ns}/${repo}`.toLowerCase()) || (!!repoId && set.has(repoId.toLowerCase()));
}

export type CiExecution = "host" | "deploy" | "build" | "sandbox";

/** The server-authoritative execution mode for a CI run. `requested` is the pipeline's
 *  REQUEST (triggerConfig.execution: "host" | "deploy" | undefined). Returns the requested
 *  privileged mode ONLY when an allowlisted repo asked for it; EVERYTHING else — including a
 *  non-allowlisted repo that wrote `execution: host`/`deploy` — resolves to the contained
 *  "sandbox". Stamp the result into the ci.run.queued payload so the runner never decides trust.
 *  ("host" = the pipeline's YAML steps run on the host; "deploy" = the runner runs ONLY the
 *  fixed reviewed deploy entrypoint, not the YAML — a narrower, un-injectable host capability.) */
export function resolveCiExecution(requested: "host" | "deploy" | "build" | undefined, ns: string, repo: string, repoId?: string): CiExecution {
  return requested && repoTrustedForHostExec(ns, repo, repoId) ? requested : "sandbox";
}
