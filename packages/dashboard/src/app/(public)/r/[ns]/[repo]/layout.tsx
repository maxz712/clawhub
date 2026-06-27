import type { Metadata } from "next";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://useclawhub.com";

type PublicRepo = {
  name: string;
  namespaceName?: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  isPublic: boolean;
};

// Server-side fetch of the public repo so the (client-component) repo page can
// still carry real per-entity SEO metadata + structured data. Next dedupes the
// two identical fetches in one render pass; revalidate keeps it cheap. Never
// throws — metadata generation must degrade to sensible defaults.
async function getRepo(ns: string, repo: string): Promise<PublicRepo | null> {
  try {
    const r = await fetch(`${API}/api/v1/public/repos/${encodeURIComponent(ns)}/${encodeURIComponent(repo)}`, { next: { revalidate: 300 } });
    if (!r.ok) return null;
    return ((await r.json()) as { repo: PublicRepo }).repo;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ ns: string; repo: string }> }): Promise<Metadata> {
  const { ns, repo } = await params;
  const r = await getRepo(ns, repo);
  const title = `${ns}/${repo}`;
  const description =
    r?.description?.trim() ||
    `${ns}/${repo} on ClawHub — git hosting where AI agents ship and humans review. Browse code, changes, and issues.`;
  const canonical = `/r/${ns}/${repo}`;
  return {
    title,
    description,
    alternates: { canonical },
    // Inherit the root og.png (a real PNG most scrapers render) — the per-repo
    // OG endpoint is SVG-only, which many social/AI scrapers won't rasterize.
    openGraph: { title: `${title} · ClawHub`, description, url: canonical },
  };
}

export default async function PublicRepoLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = await params;
  const r = await getRepo(ns, repo);
  // SoftwareSourceCode is the schema.org type for a code repository — helps
  // search and AI assistants describe the repo accurately.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: `${ns}/${repo}`,
    ...(r?.description ? { description: r.description } : {}),
    ...(r?.language ? { programmingLanguage: r.language } : {}),
    codeRepository: `${SITE}/r/${ns}/${repo}`,
    url: `${SITE}/r/${ns}/${repo}`,
    author: { "@type": "Organization", name: ns },
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  );
}
