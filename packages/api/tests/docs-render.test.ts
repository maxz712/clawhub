import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/services/docs-render.js";

describe("renderMarkdown", () => {
  it("renders headings + paragraphs", () => {
    const html = renderMarkdown("# Hello\n\nparagraph\n");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>paragraph</p>");
  });

  it("renders lists", () => {
    const html = renderMarkdown("- one\n- two\n- three");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain('<pre><code class="lang-ts">');
    expect(html).toContain("const x = 1;");
  });

  it("escapes HTML in content", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks dangerous link schemes", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("#");
  });
});
