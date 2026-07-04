// Legal surface (M3). Single-sourced so the /terms + /privacy pages and the
// register-flow acceptance can't drift. Bump LEGAL_VERSION on any material
// change to trigger the re-acceptance banner.

export const LEGAL_VERSION = "2026-07-03";

export interface Subprocessor { name: string; purpose: string; location: string }

// The subprocessors ClawHub relies on to run the platform-keyed features (M3).
// For the open-model path (D8) we name the INFERENCE HOST, not the aggregator:
// the trust story is about where the model runs, and every host below is a
// qualified US-jurisdiction provider pinned server-side. NB: bump LEGAL_VERSION
// when the open-model path is turned on for a tenant (a subprocessor change).
export const SUBPROCESSORS: Subprocessor[] = [
  { name: "Anthropic", purpose: "Platform-keyed LLM inference for advisory review + verification (metered through ClawHub's gateway).", location: "USA" },
  { name: "DeepInfra", purpose: "Open-model LLM inference for advisory review + verification when the open-model path is enabled — US-host-pinned, no-training, zero-retention.", location: "USA" },
  { name: "OpenRouter", purpose: "LLM request routing to the pinned US inference host for the open-model path (no inference of its own).", location: "USA" },
  { name: "Stripe", purpose: "Subscription + metered billing and payment processing.", location: "USA" },
  { name: "Amazon Web Services (S3)", purpose: "Object storage for repositories, LFS, packages, backups, and evidence blobs.", location: "USA / customer region" },
  { name: "Resend", purpose: "Transactional email (verification, password reset, notifications).", location: "USA" },
];
