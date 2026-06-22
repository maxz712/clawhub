// The canonical set of event types a repo webhook may subscribe to (and the
// source the dashboard multi-select renders from). Keeping ONE list here stops
// the silent-failure class the audit found: the webhook `events` field was
// free-text and dispatch matches by exact string, so a typo like "change.merge"
// or a non-event like "pr.opened" was accepted at create time and then never
// fired. Validate against this catalog on create; render the same catalog in the
// UI so users pick rather than type.
//
// Internal/infra events are deliberately EXCLUDED: `ci.run.queued` carries the
// per-run runnerToken (dispatch-only, scoped to runners) and `shard.*` are
// cluster-internal — neither is a meaningful repo webhook subscription.
export const WEBHOOK_EVENT_TYPES = [
  "change.opened",
  "change.updated",
  "change.review_requested",
  "change.drafted",
  "change.ready",
  "change.merged",
  "change.rolled_back",
  "review.submitted",
  "review.approved",
  "comment.created",
  "comment.resolved",
  "issue.opened",
  "issue.closed",
  "issue.commented",
  "issue.linked",
  "ci.running",
  "ci.completed",
  "push.default",
  "release.created",
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

const SET = new Set<string>(WEBHOOK_EVENT_TYPES);

/** `*` (all events) and any catalog member are valid; everything else is rejected. */
export function isValidWebhookEvent(t: string): boolean {
  return t === "*" || SET.has(t);
}
