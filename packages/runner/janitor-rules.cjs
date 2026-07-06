// Pure staleness rules for the runner's egress-sandbox janitor (CommonJS so the
// node --test suite can require it directly, same pattern as egress-proxy.cjs).
//
// Why a janitor: per-run sandboxes (network clawhub-egr-<id18>, containers
// clawhub-prx-/clawhub-run-<id18>) leak when the runner process dies mid-run or a
// run is terminalized out from under a live attempt. Enough leaked networks
// exhaust Docker's IPv4 address pool and EVERY subsequent run fails at network
// create (seen live 2026-07-05: 27 orphans on the debian node). Setup is
// idempotent against a run's OWN debris; the janitor makes debris from crashed
// processes self-healing instead of a hand sweep.
//
// Conservative by construction: only resources matching the exact sandbox naming
// scheme, and only past an age no LEGITIMATE run can reach (default 3h — above
// the 2h standing-run reaper budget, so anything older has outlived every
// wall-clock kill the system has).

const CONTAINER_RE = /^clawhub-(run|prx)-[a-z0-9]{6,18}$/;
const NETWORK_RE = /^clawhub-egr-[a-z0-9]{6,18}$/;

const DEFAULT_MAX_AGE_MS = 3 * 3600_000;

/** Parse CLAWHUB_RUNNER_JANITOR_MAX_AGE_MS: unset/empty/garbage → default 3h;
 *  an explicit 0 (or negative) DISABLES the janitor. */
function janitorMaxAgeMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_AGE_MS;
  const n = Number(raw);
  if (Number.isNaN(n)) return DEFAULT_MAX_AGE_MS;
  return n > 0 ? n : 0;
}

function isSandboxContainerName(name) { return CONTAINER_RE.test(String(name ?? "")); }
function isSandboxNetworkName(name) { return NETWORK_RE.test(String(name ?? "")); }

/**
 * A sandbox container is stale when it is older than maxAge — running or not.
 * Every legitimate budget (CI wall-clock 15m, standing reaper 2h) is shorter than
 * the default 3h, so age alone is proof of abandonment.
 */
function isStaleSandboxContainer(c, nowMs, maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0) return false;
  if (!isSandboxContainerName(c?.name)) return false;
  const created = Number(c?.createdAtMs);
  if (!Number.isFinite(created) || created <= 0) return false;
  return nowMs - created > maxAgeMs;
}

/**
 * A sandbox network is stale when it has NO attached containers and is older
 * than maxAge. A network still holding containers is left for the next sweep —
 * the container pass runs first, so its endpoints drain within one cycle.
 */
function isStaleSandboxNetwork(n, nowMs, maxAgeMs) {
  if (!maxAgeMs || maxAgeMs <= 0) return false;
  if (!isSandboxNetworkName(n?.name)) return false;
  if (Number(n?.containerCount) !== 0) return false;
  const created = Number(n?.createdAtMs);
  if (!Number.isFinite(created) || created <= 0) return false;
  return nowMs - created > maxAgeMs;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  janitorMaxAgeMs,
  isSandboxContainerName,
  isSandboxNetworkName,
  isStaleSandboxContainer,
  isStaleSandboxNetwork,
};
