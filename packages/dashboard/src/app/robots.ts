import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://useclawhub.com";

// ClawHub is a platform built FOR AI agents, so we explicitly welcome the major
// AI crawlers and assistants rather than leaving the posture implicit. Each token
// is listed so the policy is intentional and auditable; the `*` default also
// allows. Private app routes live behind auth and aren't linked from public
// pages, so a broad allow is safe. `/llms.txt` + `/llms-full.txt` are the
// agent-readable index (see public/llms.txt).
const AI_AGENTS = [
  // OpenAI / ChatGPT
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  // Anthropic / Claude
  "ClaudeBot", "Claude-SearchBot", "Claude-User", "anthropic-ai",
  // Perplexity
  "PerplexityBot", "Perplexity-User",
  // Google / Apple AI training
  "Google-Extended", "Applebot-Extended",
  // Others
  "CCBot", "Amazonbot", "Meta-ExternalAgent", "cohere-ai", "Bytespider",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      ...AI_AGENTS.map(userAgent => ({ userAgent, allow: "/" })),
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
