"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

export type Edition = "oss" | "cloud";
export type EeFeature = "billing" | "sso-saml" | "scim" | "marketplace" | "org-registry";

export interface EditionInfo {
  edition: Edition;
  features: EeFeature[];
}

// In-memory cache so multiple hooks don't each refetch. Edition doesn't change
// between reloads, so a single promise per page load is plenty.
let inFlight: Promise<EditionInfo> | null = null;
let cached: EditionInfo | null = null;

async function load(): Promise<EditionInfo> {
  if (cached) return cached;
  if (!inFlight) {
    inFlight = api.edition()
      .then(r => ({ edition: r.edition, features: r.features as EeFeature[] }))
      .catch(() => ({ edition: "oss" as Edition, features: [] as EeFeature[] }));
    inFlight.then(r => { cached = r; });
  }
  return inFlight;
}

export function useEdition(): EditionInfo | null {
  const [state, setState] = useState<EditionInfo | null>(cached);
  useEffect(() => {
    let alive = true;
    void load().then(r => { if (alive) setState(r); });
    return () => { alive = false; };
  }, []);
  return state;
}

// For server components / non-React callers.
export function getEdition(): Promise<EditionInfo> { return load(); }

// Small helper — returns true once the fetch resolves with the feature present.
// Used to gate nav entries + routes. During the initial fetch it returns null,
// which components should treat as "hide while we figure it out" to avoid flicker.
export function useEeFeature(feature: EeFeature): boolean | null {
  const info = useEdition();
  if (info === null) return null;
  return info.features.includes(feature);
}
