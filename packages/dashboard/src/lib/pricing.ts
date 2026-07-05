// Single source of truth for the pricing tiers. Two renderers consume this:
//   - the landing PricingSection (src/app/page.tsx) — compact feature labels
//   - the standalone /pricing page (src/app/pricing/page.tsx) — feature rows
//     with per-feature included/value state (Check vs Minus icons)
// Keeping both off this one module means the marketing surfaces can never drift.

// A feature row. `included` is `true` when the tier ships it, `false` when it
// doesn't (the /pricing page renders a muted Minus), or a string for a value/
// limit qualifier (e.g. "up to 10") rendered as a parenthetical.
export interface PricingFeature {
  label: string;
  included: boolean | string;
}

export interface PricingTier {
  name: string;
  /** Headline price, e.g. "$0", "$12", "Custom". */
  price: string;
  /** Landing-page suffix that hugs the price, e.g. "/agent/mo" (undefined when none). */
  suffix?: string;
  /** /pricing-page unit shown next to the price, e.g. "forever", "/agent/mo", "annual". */
  unit: string;
  /** One-line value prop used by both surfaces. */
  tagline: string;
  /** Call-to-action. */
  cta: { label: string; href: string };
  /** The accented tier (Team). */
  highlight: boolean;
  /** Feature rows. `included: true` rows double as the landing-page bullet list. */
  features: PricingFeature[];
}

export const PRICING_TIERS: PricingTier[] = [
  {
    name: "Free",
    price: "$0",
    unit: "forever",
    tagline: "Public repos, unlimited agents, deterministic focused review — forever.",
    cta: { label: "Start free", href: "/register" },
    highlight: false,
    features: [
      { label: "Unlimited public repos", included: true },
      { label: "Unlimited agents + BYO-key", included: true },
      { label: "Deterministic focused review", included: true },
      // D10: the free pool is per ACCOUNT (org or user), summed across repos —
      // never advertise a per-repo number (that's the unbounded-COGS framing D10 killed).
      { label: "Platform AI review", included: "100 / account / mo" },
      { label: "OAuth sign-in", included: true },
      { label: "External CI runners", included: true },
    ],
  },
  {
    // "Price the humans, meter the machines" (D1) — per human SEAT, not per agent.
    name: "Pro",
    price: "$20",
    suffix: "/seat/mo",
    unit: "/human seat/mo",
    tagline: "Risk-routed AI review on every Change, verify credits, private repos + governance.",
    cta: { label: "Upgrade to Pro", href: "/register?plan=pro" },
    highlight: true,
    features: [
      { label: "Everything in Free", included: true },
      { label: "Private repos", included: true },
      { label: "Platform AI review pool", included: "250 / seat / mo" },
      { label: "Verify credits", included: "10 / seat / mo" },
      { label: "Metered overage", included: "$0.10/review · $2.00/verify" },
      { label: "SSO / SAML + audit export", included: true },
      { label: "Standing (24/7) agents + fleet", included: "up to 10" },
      { label: "Priority support", included: true },
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    unit: "annual",
    tagline: "Self-hosted, SSO/SAML, SLA, procurement.",
    cta: { label: "Contact sales", href: "/help" },
    highlight: false,
    features: [
      { label: "Everything in Pro", included: true },
      { label: "BYO-key / BYO-endpoint everything", included: true },
      { label: "Unlimited standing agents", included: true },
      { label: "SCIM provisioning", included: true },
      { label: "Self-host support + SLA", included: true },
      { label: "Custom contracts", included: true },
    ],
  },
];
