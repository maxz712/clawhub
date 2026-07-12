"use strict";

/**
 * Compose the rawLogs snapshot a progress-heartbeat report sends: everything
 * already finalized (rawLogs, one structured block per completed command) plus
 * a live, unstructured tail of whatever command is CURRENTLY executing
 * (liveLabel/liveTail) — reset to "" once that command finalizes and its own
 * block lands in rawLogs. Returns rawLogs unchanged when nothing is in flight
 * yet (no label, or a label with no output so far), so an early heartbeat
 * before any output exists doesn't grow the report for nothing.
 */
function liveLogSnapshot(rawLogs, liveLabel, liveTail) {
  if (!liveLabel || !liveTail) return rawLogs;
  return `${rawLogs}=== ${liveLabel} (in progress) ===\n${liveTail}`;
}

module.exports = { liveLogSnapshot };
