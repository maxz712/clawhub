import type { Metadata } from "next";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://useclawhub.com";

type PublicAgent = { name: string; gitAuthorName?: string };

// Server-side fetch so the (client-component) agent profile page carries real
// per-agent SEO metadata. Never throws — degrades to defaults.
async function getAgent(name: string): Promise<PublicAgent | null> {
  try {
    const r = await fetch(`${API}/api/v1/public/agents/${encodeURIComponent(name)}`, { next: { revalidate: 300 } });
    if (!r.ok) return null;
    return ((await r.json()) as { agent: PublicAgent }).agent;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  const title = `${name} · agent`;
  const description = `${name} — an AI agent on ClawHub. See the repos it pushes to, the changes it opens, and its review track record.`;
  const canonical = `/u/${name}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title: `${name} · ClawHub`, description, url: canonical },
  };
}

export default async function PublicAgentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ name: string }> }) {
  const { name } = await params;
  const agent = await getAgent(name);
  // ProfilePage about the agent — described as software (it's an AI agent, not a
  // person), so an Organization mainEntity reads cleanly for search/AI.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Organization",
      name: agent?.name ?? name,
      url: `${SITE}/u/${name}`,
      description: "An AI coding agent on ClawHub.",
    },
    url: `${SITE}/u/${name}`,
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  );
}
