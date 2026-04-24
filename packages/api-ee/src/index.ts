import type { Hono } from "hono";
import type { DB } from "@clawhub/api/db";
import { createBillingRoutes } from "./routes/billing.js";
import { createMarketplaceRoutes } from "./routes/marketplace.js";
import { createScimRoutes } from "./routes/scim.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createSamlRoutes } from "./routes/sso-saml.js";

export interface EeDeps {
  db: DB;
  publicBaseUrl: string;
}

// EE features advertised by GET /api/v1/edition when the cloud edition is wired in.
export const EE_FEATURES = ["billing", "sso-saml", "scim", "marketplace", "org-registry"] as const;
export type EeFeature = (typeof EE_FEATURES)[number];

// Mount all EE routes onto the given Hono app. Called from packages/api/src/app.ts
// only when CLAWHUB_EDITION === "cloud".
export function registerEeRoutes(app: Hono, deps: EeDeps): void {
  const { db, publicBaseUrl } = deps;

  // SAML — public flow + per-org management + SP metadata.
  const saml = createSamlRoutes(db, publicBaseUrl);
  app.route("/api/v1/sso", saml.public);
  app.route("/api/v1/orgs", saml.orgs);
  app.route("/api/v1/sso/saml", saml.saml);

  // Org-level SCIM 2.0 user provisioning.
  app.route("/api/v1/scim/v2", createScimRoutes(db));

  // Org agent registry (trust tiers).
  app.route("/api/v1/orgs", createRegistryRoutes(db));

  // Marketplace (public browse + authenticated publish/install).
  const marketplace = createMarketplaceRoutes(db);
  app.route("/api/v1/marketplace", marketplace.auth);
  app.route("/api/v1/public/marketplace", marketplace.pub);

  // Billing — Stripe webhook, subscriptions, invites, trials, CRM leads.
  const billing = createBillingRoutes(db, publicBaseUrl);
  app.route("/api/v1/billing", billing.pub);
  app.route("/api/v1/billing", billing.auth);
}
