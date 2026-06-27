"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

/**
 * Render user-authored markdown safely (issue bodies, comments). GFM (tables,
 * task lists, strikethrough, autolinks) via remark-gfm; rehype-sanitize strips
 * anything unsafe. Images (`![](url)`) render, so screenshots-by-URL work. The
 * `prose` classes style the output; `break-words` keeps long URLs in bounds.
 */
export function Markdown({ children }: { children: string }) {
  if (!children?.trim()) return null;
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words prose-pre:bg-muted prose-pre:text-foreground prose-pre:overflow-x-auto prose-pre:max-w-full prose-img:rounded prose-img:border prose-img:border-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
