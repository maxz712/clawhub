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
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000",
    NEXT_PUBLIC_GITHUB_CLIENT_ID: process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID ?? "",
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
  },
};

export default nextConfig;
