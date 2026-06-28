import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// Load root .env so the monorepo's env vars are available to Next.js.
// In Docker the dashboard is mounted at /app with no parent .env, so skip if missing.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  config({ path: rootEnv });
}

const nextConfig: NextConfig = {
  // Local-only escape hatch: when running the dashboard from a git worktree
  // (whose node_modules live in the main checkout, an ancestor dir), Turbopack's
  // root inference picks the worktree and can't resolve `next`. Set
  // CLAWHUB_TURBOPACK_ROOT to the checkout that has node_modules. Turbopack
  // requires outputFileTracingRoot to match, so override both. No-op in prod.
  ...(process.env.CLAWHUB_TURBOPACK_ROOT ? { turbopack: { root: process.env.CLAWHUB_TURBOPACK_ROOT } } : {}),
  // Produces .next/standalone for the production Docker image (see Dockerfile).
  output: "standalone",
  // Trace deps from the monorepo root so the standalone bundle includes
  // workspace symlinks instead of complaining about multiple lockfiles.
  outputFileTracingRoot: process.env.CLAWHUB_TURBOPACK_ROOT ?? resolve(__dirname, "../.."),
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000",
    NEXT_PUBLIC_GITHUB_CLIENT_ID: process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? "",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
  },
  // Surface the API's machine-readable discovery descriptor at the apex domain
  // (humans share useclawhub.com; crawlers/agents land there) so a client that
  // only knows the web origin can still bootstrap. /llms.txt, /llms-full.txt,
  // and /skill.md are served statically from public/. The descriptor is dynamic
  // (origin-aware), so we proxy it to the API.
  async rewrites() {
    const api = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    return [
      { source: "/.well-known/clawhub", destination: `${api}/.well-known/clawhub` },
    ];
  },
  // Conservative security headers on every dashboard response. No CSP — it would
  // risk breaking the Next app's inline styles/scripts; these are header-only.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
