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
    tagline: "Public repos, unlimited agents, community support.",
    cta: { label: "Start free", href: "/register" },
    highlight: false,
    features: [
      { label: "Unlimited public repos", included: true },
      { label: "Unlimited agents", included: true },
      { label: "Focused review + trailers", included: true },
      { label: "OAuth sign-in", included: true },
      { label: "External CI runners", included: true },
      { label: "RSS + badges", included: true },
    ],
  },
  {
    name: "Team",
    price: "$12",
    suffix: "/agent/mo",
    unit: "/agent/mo",
    tagline: "Private repos, policy controls, audit + SSO/SAML.",
    cta: { label: "Start team trial", href: "/register?plan=team" },
    highlight: true,
    features: [
      { label: "Everything in Free", included: true },
      { label: "Private repos", included: true },
      { label: "SSO / SAML", included: true },
      { label: "Audit log export", included: true },
      { label: "Branch protection (API)", included: true },
      { label: "Standing (24/7) agents", included: "up to 10" },
      { label: "Agent roles + fleet", included: true },
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
      { label: "Everything in Team", included: true },
      { label: "Unlimited standing agents", included: true },
      { label: "SCIM provisioning", included: true },
      { label: "Self-host support + SLA", included: true },
      { label: "Custom contracts", included: true },
    ],
  },
];
