"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { AuthedImg, isApiHostedBlob } from "@/components/authed-img";

// Images embedded in markdown (`![](url)`). An uploaded screenshot (#12) lives
// behind repo-read auth, so it must be fetched WITH the token — AuthedImg does
// that; external URLs render as a plain <img>. Styled by the parent `.prose`
// (prose-img:*).
function MarkdownImg({ src, alt }: { src?: unknown; alt?: string }) {
  const url = typeof src === "string" ? src : "";
  if (!url) return null;
  if (isApiHostedBlob(url)) return <AuthedImg url={url} alt={alt ?? ""} className="rounded border border-border max-h-96" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt ?? ""} />;
}

/**
 * Render user-authored markdown safely (issue bodies, comments). GFM (tables,
 * task lists, strikethrough, autolinks) via remark-gfm; rehype-sanitize strips
 * anything unsafe. Images (`![](url)`) render — an uploaded screenshot (#12) is
 * fetched with auth via AuthedImg. The `prose` classes style the output;
 * `break-words` keeps long URLs in bounds.
 */
export function Markdown({ children }: { children: string }) {
  if (!children?.trim()) return null;
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words prose-pre:bg-muted prose-pre:text-foreground prose-pre:overflow-x-auto prose-pre:max-w-full prose-img:rounded prose-img:border prose-img:border-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={{ img: MarkdownImg }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
